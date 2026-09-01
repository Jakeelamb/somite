import { lstat, mkdir, open, readlink, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, platform as operatingSystem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { byteDigest, canonicalJsonDigest, canonicalJsonValue, createByteDigester } from "@somite/workflow/contentIdentity";
import { MAX_PIXI_LOCK_BYTES } from "@somite/workflow/limits";
import { atomicWrite, ensurePrivateDirectory, pathExists, regularDirectory, regularFile } from "./files.ts";
import { commandFailure, runCaptured } from "./process.ts";
import { executablePath } from "./system.ts";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ENTRYPOINT_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_ENTRYPOINTS = 8_192;
const MAX_ENTRYPOINT_DIRECTORY_ENTRIES = 16_384;
const MAX_ENTRYPOINT_NAME_BYTES = 1_024;
const MAX_ENTRYPOINT_BYTES = 512 * 1024 * 1024;
const MAX_ENTRYPOINT_TOTAL_BYTES = 512 * 1024 * 1024;
const PLATFORM = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MAX_WORKSPACE_ENVIRONMENTS = 512;
const BUILD_GRACE_MS = 30_000;
const CACHE_SCHEMA_VERSION = 3;
const ENTRYPOINT_RECEIPT_SCHEMA_VERSION = 1;
const encoder = new TextEncoder();

type BuilderMarker = Readonly<{
  builder_id?: string;
  pid: number;
  process_identity?: string;
  started_at_unix_ms: number;
}>;

type EntrypointRecord = Readonly<{
  environment: string;
  path: string;
  kind: "file" | "symlink";
  link_target?: string;
  mode: number;
  bytes: number;
  digest: string;
}>;

type EntrypointReceipt = Readonly<{
  schema_version: typeof ENTRYPOINT_RECEIPT_SCHEMA_VERSION;
  environments: readonly string[];
  entrypoints: readonly EntrypointRecord[];
}>;

export type LockedManifest = Readonly<{
  pixi: string;
  manifest: Uint8Array;
  lock: Uint8Array;
  manifest_digest: string;
  lock_digest: string;
}>;

type SharedOperation<T> = {
  controller: AbortController;
  promise: Promise<T>;
  settled: boolean;
  waiters: number;
};

export type RealizedPixiWorkspace = Readonly<{
  manifestPath: string;
  prefixes: ReadonlyMap<string, string>;
}>;

function hex(digest: string) {
  return digest.slice("blake3:".length);
}

export function pixiEnvironmentCacheRoot(
  environment: NodeJS.ProcessEnv = process.env,
  system: NodeJS.Platform = operatingSystem(),
  home: string = homedir(),
) {
  const override = environment.SOMITE_PIXI_CACHE_DIR;
  if (override !== undefined) {
    if (override.length === 0 || !isAbsolute(override)) {
      throw new Error("SOMITE_PIXI_CACHE_DIR must be an absolute path");
    }
    return resolve(override);
  }
  if (system === "darwin") return join(home, "Library", "Caches", "Somite", "pixi");
  if (system === "win32") {
    const local = environment.LOCALAPPDATA;
    return join(local && isAbsolute(local) ? local : join(home, "AppData", "Local"), "Somite", "pixi");
  }
  const xdg = environment.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".cache"), "somite", "pixi");
}

async function ensurePrivateCacheRoot(path: string) {
  const destination = resolve(path);
  let existing = destination;
  while (!await pathExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Pixi environment cache root ${destination} has no existing parent`);
    existing = parent;
  }
  const missing = relative(existing, destination).split(sep).filter(Boolean);
  if (existing === destination) await regularDirectory(existing, "Pixi environment cache root");
  const canonicalExisting = await realpath(existing);
  await regularDirectory(canonicalExisting, "Pixi environment cache parent");
  let current = canonicalExisting;
  for (const part of missing) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await regularDirectory(current, "Pixi environment cache path");
    if (await realpath(current) !== resolve(current)) {
      throw new Error(`Pixi environment cache root ${destination} contains a symbolic path`);
    }
  }
  const metadata = await lstat(current);
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) throw new Error(`Pixi environment cache root ${destination} is not owned by this user`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`Pixi environment cache root ${destination} must be private (mode 0700)`);
  }
  return current;
}

function normalizedEnvironmentNames(input: readonly string[]) {
  if (!input.length || input.length > MAX_WORKSPACE_ENVIRONMENTS) {
    throw new Error(`Pixi workspace must request between 1 and ${MAX_WORKSPACE_ENVIRONMENTS} environments`);
  }
  const names = [...input].sort();
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    if (!ENVIRONMENT_NAME.test(name)) throw new Error(`invalid Pixi environment name ${name}`);
    if (index > 0 && names[index - 1] === name) throw new Error(`duplicate Pixi environment name ${name}`);
  }
  return names;
}

function environmentKey(
  locked: LockedManifest,
  platform: string,
  environments: readonly string[],
  installAll: boolean,
) {
  return hex(canonicalJsonDigest({
    schema_version: CACHE_SCHEMA_VERSION,
    environments,
    install_all: installAll,
    platform,
    lock_digest: locked.lock_digest,
    manifest_digest: locked.manifest_digest,
  }));
}

async function sameBytes(path: string, expected: Uint8Array, maximumBytes: number, label: string) {
  const existing = await regularFile(path, maximumBytes, label);
  return byteDigest(existing) === byteDigest(expected);
}

function entrypointDirectories(platform: string) {
  return platform.startsWith("win-") ? ["Library/bin", "Scripts"] : ["bin"];
}

function safeEntrypointPath(path: string, platform: string) {
  if (!path || encoder.encode(path).byteLength > MAX_ENTRYPOINT_NAME_BYTES) return false;
  if ([...path].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  })) return false;
  return entrypointDirectories(platform).some((directory) => {
    if (!path.startsWith(`${directory}/`)) return false;
    const name = path.slice(directory.length + 1);
    return name.length > 0 && !name.includes("/");
  });
}

function insidePrefix(prefix: string, path: string) {
  const fromPrefix = relative(prefix, path);
  return fromPrefix !== ""
    && fromPrefix !== ".."
    && !fromPrefix.startsWith(`..${sep}`)
    && !isAbsolute(fromPrefix);
}

function sameFileMetadata(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function digestEntrypointFile(path: string, budget: { bytes: number }, label: string) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must resolve to a regular file`);
  if (before.size > MAX_ENTRYPOINT_BYTES) throw new Error(`${label} exceeds ${MAX_ENTRYPOINT_BYTES} bytes`);
  budget.bytes += before.size;
  if (budget.bytes > MAX_ENTRYPOINT_TOTAL_BYTES) {
    throw new Error(`Pixi entrypoint payload exceeds ${MAX_ENTRYPOINT_TOTAL_BYTES} bytes`);
  }
  const handle = await open(path, "r");
  const digester = createByteDigester();
  try {
    const opened = await handle.stat();
    if (!sameFileMetadata(before, opened)) throw new Error(`${label} changed before it was read`);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    do {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null));
      if (bytesRead) digester.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
    const after = await handle.stat();
    if (!sameFileMetadata(opened, after)) throw new Error(`${label} changed while it was read`);
  } finally {
    await handle.close();
  }
  const current = await lstat(path);
  if (!sameFileMetadata(before, current)) throw new Error(`${label} changed while it was read`);
  return {
    mode: before.mode & 0o777,
    bytes: before.size,
    digest: digester.digest(),
  };
}

async function inspectEntrypoint(
  environment: string,
  prefix: string,
  path: string,
  budget: { bytes: number },
): Promise<EntrypointRecord | undefined> {
  const absolute = join(prefix, ...path.split("/"));
  const metadata = await lstat(absolute);
  if (metadata.isDirectory()) return undefined;
  if (metadata.isFile()) {
    return { environment, path, kind: "file", ...await digestEntrypointFile(absolute, budget, `Pixi entrypoint ${environment}:${path}`) };
  }
  if (!metadata.isSymbolicLink()) throw new Error(`Pixi entrypoint ${environment}:${path} has an unsupported file type`);
  const linkTarget = await readlink(absolute);
  if (!linkTarget || encoder.encode(linkTarget).byteLength > MAX_ENTRYPOINT_NAME_BYTES) {
    throw new Error(`Pixi entrypoint ${environment}:${path} has an invalid symbolic-link target`);
  }
  const target = await realpath(absolute);
  if (!insidePrefix(prefix, target)) throw new Error(`Pixi entrypoint ${environment}:${path} escapes its environment prefix`);
  const identity = await digestEntrypointFile(target, budget, `Pixi entrypoint ${environment}:${path}`);
  if (await readlink(absolute) !== linkTarget) throw new Error(`Pixi entrypoint ${environment}:${path} changed while it was read`);
  return { environment, path, kind: "symlink", link_target: linkTarget, ...identity };
}

async function captureEntrypointReceipt(
  prefixes: ReadonlyMap<string, string>,
  environments: readonly string[],
  platform: string,
): Promise<EntrypointReceipt> {
  const budget = { bytes: 0 };
  const entrypoints: EntrypointRecord[] = [];
  let directoryEntries = 0;
  for (const environment of environments) {
    const prefix = prefixes.get(environment);
    if (!prefix) throw new Error(`installed Pixi environment ${environment} is missing`);
    for (const directory of entrypointDirectories(platform)) {
      const absoluteDirectory = join(prefix, ...directory.split("/"));
      if (!await pathExists(absoluteDirectory)) continue;
      await regularDirectory(absoluteDirectory, `Pixi entrypoint directory ${environment}:${directory}`);
      if (await realpath(absoluteDirectory) !== resolve(absoluteDirectory)) {
        throw new Error(`Pixi entrypoint directory ${environment}:${directory} contains a symbolic path`);
      }
      const entries = (await readdir(absoluteDirectory)).sort();
      directoryEntries += entries.length;
      if (directoryEntries > MAX_ENTRYPOINT_DIRECTORY_ENTRIES) {
        throw new Error(`Pixi entrypoint directories exceed ${MAX_ENTRYPOINT_DIRECTORY_ENTRIES} entries`);
      }
      for (const name of entries) {
        const path = `${directory}/${name}`;
        if (!safeEntrypointPath(path, platform)) throw new Error(`invalid Pixi entrypoint path ${environment}:${path}`);
        const entrypoint = await inspectEntrypoint(environment, prefix, path, budget);
        if (!entrypoint) continue;
        entrypoints.push(entrypoint);
        if (entrypoints.length > MAX_ENTRYPOINTS) throw new Error(`Pixi workspace exceeds ${MAX_ENTRYPOINTS} entrypoints`);
      }
    }
  }
  return { schema_version: ENTRYPOINT_RECEIPT_SCHEMA_VERSION, environments, entrypoints };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseEntrypointReceipt(bytes: Uint8Array, environments: readonly string[], platform: string): EntrypointReceipt {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, ["entrypoints", "environments", "schema_version"])
    || value.schema_version !== ENTRYPOINT_RECEIPT_SCHEMA_VERSION
    || !Array.isArray(value.environments)
    || value.environments.length !== environments.length
    || value.environments.some((environment, index) => environment !== environments[index])
    || !Array.isArray(value.entrypoints)
    || value.entrypoints.length > MAX_ENTRYPOINTS) {
    throw new Error("cached Pixi entrypoint receipt is invalid");
  }
  const entrypoints: EntrypointRecord[] = [];
  let previous = "";
  let totalBytes = 0;
  for (const raw of value.entrypoints) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("cached Pixi entrypoint receipt is invalid");
    const record = raw as Record<string, unknown>;
    const kind = record.kind;
    const expectedKeys = kind === "symlink"
      ? ["bytes", "digest", "environment", "kind", "link_target", "mode", "path"]
      : ["bytes", "digest", "environment", "kind", "mode", "path"];
    if (!exactKeys(record, expectedKeys)
      || (kind !== "file" && kind !== "symlink")
      || typeof record.environment !== "string"
      || !environments.includes(record.environment)
      || typeof record.path !== "string"
      || !safeEntrypointPath(record.path, platform)
      || (kind === "symlink" && (typeof record.link_target !== "string"
        || !record.link_target
        || encoder.encode(record.link_target).byteLength > MAX_ENTRYPOINT_NAME_BYTES))
      || !Number.isSafeInteger(record.mode)
      || (record.mode as number) < 0
      || (record.mode as number) > 0o777
      || !Number.isSafeInteger(record.bytes)
      || (record.bytes as number) < 0
      || (record.bytes as number) > MAX_ENTRYPOINT_BYTES
      || typeof record.digest !== "string"
      || !/^blake3:[a-f0-9]{64}$/.test(record.digest)) {
      throw new Error("cached Pixi entrypoint receipt is invalid");
    }
    const identity = `${record.environment}\0${record.path}`;
    if (identity <= previous) throw new Error("cached Pixi entrypoint receipt is not uniquely sorted");
    previous = identity;
    totalBytes += record.bytes as number;
    if (totalBytes > MAX_ENTRYPOINT_TOTAL_BYTES) throw new Error("cached Pixi entrypoint receipt exceeds its payload bound");
    entrypoints.push(record as EntrypointRecord);
  }
  return { schema_version: ENTRYPOINT_RECEIPT_SCHEMA_VERSION, environments, entrypoints };
}

async function verifyEntrypointReceipt(
  receipt: EntrypointReceipt,
  prefixes: ReadonlyMap<string, string>,
) {
  const budget = { bytes: 0 };
  for (const expected of receipt.entrypoints) {
    const prefix = prefixes.get(expected.environment)!;
    let current: EntrypointRecord | undefined;
    try {
      current = await inspectEntrypoint(expected.environment, prefix, expected.path, budget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`cached Pixi entrypoint ${expected.environment}:${expected.path} is missing`);
      }
      throw error;
    }
    if (!current) throw new Error(`cached Pixi entrypoint ${expected.environment}:${expected.path} is missing`);
    if (current.kind !== expected.kind || current.link_target !== expected.link_target) {
      throw new Error(`cached Pixi entrypoint ${expected.environment}:${expected.path} changed type or link target`);
    }
    if (current.mode !== expected.mode) throw new Error(`cached Pixi entrypoint ${expected.environment}:${expected.path} mode changed`);
    if (current.bytes !== expected.bytes) throw new Error(`cached Pixi entrypoint ${expected.environment}:${expected.path} size changed`);
    if (current.digest !== expected.digest) throw new Error(`cached Pixi entrypoint ${expected.environment}:${expected.path} digest changed`);
  }
}

export class PixiCache {
  readonly #projectRoot: string;
  readonly #environmentCacheRoot: string;
  readonly #locks = new Map<string, SharedOperation<LockedManifest>>();
  readonly #environments = new Map<string, SharedOperation<RealizedPixiWorkspace>>();

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
    this.#environmentCacheRoot = pixiEnvironmentCacheRoot();
  }

  async lock(manifestText: string, platform: string, signal?: AbortSignal): Promise<LockedManifest> {
    if (!PLATFORM.test(platform)) throw new Error(`invalid Pixi platform ${platform}`);
    const manifest = new TextEncoder().encode(manifestText);
    if (manifest.byteLength === 0 || manifest.byteLength > MAX_MANIFEST_BYTES) throw new Error("Pixi manifest size is invalid");
    const manifestDigest = byteDigest(manifest);
    const key = `${platform}:${manifestDigest}`;
    return this.#shared(this.#locks, key, (sharedSignal) => this.#lock(manifest, manifestDigest, platform, sharedSignal), signal);
  }

  async adoptLock(manifest: Uint8Array, lock: Uint8Array): Promise<LockedManifest> {
    if (!manifest.byteLength || manifest.byteLength > MAX_MANIFEST_BYTES) throw new Error("source Pixi manifest size is invalid");
    if (!lock.byteLength || lock.byteLength > MAX_PIXI_LOCK_BYTES) throw new Error("source Pixi lock size is invalid");
    const pixi = await executablePath(this.#projectRoot, "pixi");
    if (!pixi) throw new Error("Pixi is required to install this source workflow's frozen environment");
    return {
      pixi,
      manifest,
      lock,
      manifest_digest: byteDigest(manifest),
      lock_digest: byteDigest(lock),
    };
  }

  async environment(locked: LockedManifest, platform: string, signal?: AbortSignal) {
    if (!PLATFORM.test(platform)) throw new Error(`invalid Pixi platform ${platform}`);
    const environments = normalizedEnvironmentNames(["default"]);
    const key = `${platform}:${locked.lock_digest}:${locked.manifest_digest}:selected:${environments.join(",")}`;
    const workspace = await this.#shared(
      this.#environments,
      key,
      (sharedSignal) => this.#environment(locked, platform, environments, false, sharedSignal),
      signal,
    );
    return workspace.manifestPath;
  }

  async realizeWorkspace(
    locked: LockedManifest,
    platform: string,
    expectedEnvironments: readonly string[],
    signal?: AbortSignal,
  ): Promise<RealizedPixiWorkspace> {
    if (!PLATFORM.test(platform)) throw new Error(`invalid Pixi platform ${platform}`);
    const environments = normalizedEnvironmentNames(expectedEnvironments);
    const key = `${platform}:${locked.lock_digest}:${locked.manifest_digest}:all:${environments.join(",")}`;
    const workspace = await this.#shared(
      this.#environments,
      key,
      (sharedSignal) => this.#environment(locked, platform, environments, true, sharedSignal),
      signal,
    );
    return { manifestPath: workspace.manifestPath, prefixes: new Map(workspace.prefixes) };
  }

  async #shared<T>(
    operations: Map<string, SharedOperation<T>>,
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new Error("operation cancelled");
    let operation = operations.get(key);
    if (operation?.controller.signal.aborted && !operation.settled) {
      operations.delete(key);
      operation = undefined;
    }
    if (!operation) {
      const controller = new AbortController();
      const promise = start(controller.signal);
      operation = { controller, promise, settled: false, waiters: 0 };
      operations.set(key, operation);
      const completed = () => {
        operation!.settled = true;
        if (operations.get(key) === operation) operations.delete(key);
      };
      void operation.promise.then(completed, completed);
    }
    operation.waiters += 1;
    try {
      return await waitFor(operation.promise, signal);
    } finally {
      operation.waiters -= 1;
      if (operation.waiters === 0 && !operation.settled) operation.controller.abort();
    }
  }

  async #lock(manifest: Uint8Array, manifestDigest: string, platform: string, signal?: AbortSignal): Promise<LockedManifest> {
    const pixi = await executablePath(this.#projectRoot, "pixi");
    if (!pixi) throw new Error("Pixi is required to freeze and run this workflow");
    const parent = await ensurePrivateDirectory(this.#projectRoot, `.somite/pixi/locks/${platform}`);
    const destination = join(parent, hex(manifestDigest));
    if (await pathExists(destination)) return this.#readLock(destination, pixi, manifest, manifestDigest);

    const temporary = join(parent, `.${hex(manifestDigest)}.${randomUUID()}.partial`);
    await mkdir(temporary);
    try {
      await writeFile(join(temporary, "pixi.toml"), manifest, { flag: "wx", mode: 0o600 });
      const solved = await runCaptured(
        pixi,
        ["lock", "--no-install", "--no-progress", "--manifest-path", join(temporary, "pixi.toml")],
        temporary,
        signal,
      );
      if (solved.code !== 0) throw new Error(`Pixi lock failed: ${commandFailure("pixi lock", solved)}`);
      const lock = await regularFile(join(temporary, "pixi.lock"), MAX_PIXI_LOCK_BYTES, "Pixi lock");
      if (lock.byteLength === 0) throw new Error("Pixi lock is empty");
      try {
        await rename(temporary, destination);
      } catch (error) {
        if (!await pathExists(destination)) throw error;
        await regularDirectory(destination, "Pixi lock cache entry");
      }
      return this.#readLock(destination, pixi, manifest, manifestDigest);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #readLock(directory: string, pixi: string, manifest: Uint8Array, manifestDigest: string): Promise<LockedManifest> {
    await regularDirectory(directory, "Pixi lock cache entry");
    if (!await sameBytes(join(directory, "pixi.toml"), manifest, MAX_MANIFEST_BYTES, "cached Pixi manifest")) {
      throw new Error(`Pixi lock cache ${manifestDigest} does not match its content address`);
    }
    const lock = await regularFile(join(directory, "pixi.lock"), MAX_PIXI_LOCK_BYTES, "cached Pixi lock");
    if (lock.byteLength === 0) throw new Error("cached Pixi lock is empty");
    return { pixi, manifest, lock, manifest_digest: manifestDigest, lock_digest: byteDigest(lock) };
  }

  async #environment(
    locked: LockedManifest,
    platform: string,
    environments: readonly string[],
    installAll: boolean,
    signal?: AbortSignal,
  ): Promise<RealizedPixiWorkspace> {
    const root = await ensurePrivateCacheRoot(this.#environmentCacheRoot);
    const parent = await ensurePrivateDirectory(root, `v${CACHE_SCHEMA_VERSION}/${platform}`);
    const key = environmentKey(locked, platform, environments, installAll);
    const destination = join(parent, key);
    while (await pathExists(destination)) {
      if (await pathExists(join(destination, "environment.json"))) {
        return this.#verifyEnvironment(destination, locked, platform, environments, installAll);
      }
      const metadata = await lstat(destination);
      const builder = await this.#builder(join(destination, "building.json"));
      if ((builder && await builderIsActive(builder)) || Date.now() - metadata.mtimeMs < BUILD_GRACE_MS) {
        await pause(100, signal);
        continue;
      }
      await regularDirectory(destination, "incomplete Pixi environment cache entry");
      await this.#quarantineStaleEnvironment(destination, metadata, builder);
    }
    try {
      await mkdir(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return this.#environment(locked, platform, environments, installAll, signal);
      }
      throw error;
    }
    const builder: BuilderMarker = {
      builder_id: randomUUID(),
      pid: process.pid,
      process_identity: await processIdentity(process.pid),
      started_at_unix_ms: Date.now(),
    };
    try {
      await atomicWrite(join(destination, "building.json"), `${JSON.stringify(canonicalJsonValue(builder))}\n`);
      await writeFile(join(destination, "pixi.toml"), locked.manifest, { flag: "wx", mode: 0o600 });
      await writeFile(join(destination, "pixi.lock"), locked.lock, { flag: "wx", mode: 0o600 });
      const installed = await runCaptured(
        locked.pixi,
        [
          "install",
          ...(installAll ? ["--all"] : ["--environment", environments[0]!]),
          "--frozen",
          "--no-progress",
          "--manifest-path",
          join(destination, "pixi.toml"),
        ],
        destination,
        signal,
      );
      if (installed.code !== 0) throw new Error(`Pixi install failed: ${commandFailure("pixi install", installed)}`);
      if (!await this.#ownsBuild(destination, builder)) {
        throw new Error(`Pixi environment cache build ${key} lost ownership before publication`);
      }
      const prefixes = new Map<string, string>();
      for (const environment of environments) {
        const prefix = join(destination, ".pixi", "envs", environment);
        if (!await pathExists(prefix)) throw new Error(`installed Pixi environment ${environment} is missing`);
        await regularDirectory(prefix, `installed Pixi environment ${environment}`);
        prefixes.set(environment, prefix);
      }
      const entrypointReceipt = await captureEntrypointReceipt(prefixes, environments, platform);
      const entrypointReceiptBytes = encoder.encode(`${JSON.stringify(canonicalJsonValue(entrypointReceipt), null, 2)}\n`);
      if (entrypointReceiptBytes.byteLength > MAX_ENTRYPOINT_RECEIPT_BYTES) {
        throw new Error(`Pixi entrypoint receipt exceeds ${MAX_ENTRYPOINT_RECEIPT_BYTES} bytes`);
      }
      const entrypointReceiptDigest = byteDigest(entrypointReceiptBytes);
      await writeFile(join(destination, "entrypoints.json"), entrypointReceiptBytes, { flag: "wx", mode: 0o600 });
      await atomicWrite(join(destination, "environment.json"), `${JSON.stringify(canonicalJsonValue({
        schema_version: CACHE_SCHEMA_VERSION,
        cache_key: key,
        platform,
        lock_digest: locked.lock_digest,
        manifest_digest: locked.manifest_digest,
        environments,
        install_all: installAll,
        entrypoint_receipt_digest: entrypointReceiptDigest,
      }), null, 2)}\n`);
      await rm(join(destination, "building.json"), { force: true });
      return this.#verifyEnvironment(destination, locked, platform, environments, installAll);
    } catch (error) {
      await this.#removeOwnedBuild(destination, builder);
      throw error;
    }
  }

  async #builder(path: string): Promise<BuilderMarker | undefined> {
    try {
      const bytes = await regularFile(path, MAX_METADATA_BYTES, "Pixi environment build marker");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      const builderId = typeof value.builder_id === "string" && /^[A-Za-z0-9-]{1,128}$/.test(value.builder_id)
        ? value.builder_id
        : undefined;
      const processIdentityValue = typeof value.process_identity === "string" && value.process_identity.length <= 256
        ? value.process_identity
        : undefined;
      return Number.isSafeInteger(value.pid)
        && (value.pid as number) > 0
        && Number.isSafeInteger(value.started_at_unix_ms)
        && (value.started_at_unix_ms as number) >= 0
        ? {
          builder_id: builderId,
          pid: value.pid as number,
          process_identity: processIdentityValue,
          started_at_unix_ms: value.started_at_unix_ms as number,
        }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #ownsBuild(directory: string, expected: BuilderMarker) {
    const current = await this.#builder(join(directory, "building.json"));
    return expected.builder_id !== undefined && current?.builder_id === expected.builder_id;
  }

  async #removeOwnedBuild(directory: string, expected: BuilderMarker) {
    if (!await pathExists(directory) || !await this.#ownsBuild(directory, expected)) return;
    const metadata = await lstat(directory);
    const current = await this.#builder(join(directory, "building.json"));
    if (current?.builder_id !== expected.builder_id) return;
    await this.#quarantineStaleEnvironment(directory, metadata, current);
  }

  async #quarantineStaleEnvironment(
    directory: string,
    expectedMetadata: Awaited<ReturnType<typeof lstat>>,
    expectedBuilder: BuilderMarker | undefined,
  ) {
    const quarantine = `${directory}.${randomUUID()}.stale`;
    try {
      await rename(directory, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const movedMetadata = await lstat(quarantine);
    const movedBuilder = await this.#builder(join(quarantine, "building.json"));
    const sameBuilder = canonicalJsonDigest(movedBuilder) === canonicalJsonDigest(expectedBuilder);
    if (movedMetadata.dev !== expectedMetadata.dev || movedMetadata.ino !== expectedMetadata.ino || !sameBuilder) {
      if (!await pathExists(directory)) {
        try {
          await rename(quarantine, directory);
        } catch {
          // Preserve both entries and fail closed below rather than deleting either identity.
        }
      }
      throw new Error(`Pixi environment cache entry ${directory} changed during stale-builder cleanup; no replacement was removed`);
    }
    await rm(quarantine, { recursive: true });
  }

  async #verifyEnvironment(
    directory: string,
    locked: LockedManifest,
    platform: string,
    environments: readonly string[],
    installAll: boolean,
  ): Promise<RealizedPixiWorkspace> {
    await regularDirectory(directory, "Pixi environment cache entry");
    if (!await sameBytes(join(directory, "pixi.toml"), locked.manifest, MAX_MANIFEST_BYTES, "cached Pixi environment manifest")) {
      throw new Error(`Pixi environment ${locked.lock_digest} does not match its manifest`);
    }
    const lock = await regularFile(join(directory, "pixi.lock"), MAX_PIXI_LOCK_BYTES, "cached Pixi environment lock");
    if (byteDigest(lock) !== locked.lock_digest) throw new Error(`Pixi environment ${locked.lock_digest} does not match its lock`);
    const metadataBytes = await regularFile(join(directory, "environment.json"), MAX_METADATA_BYTES, "Pixi environment metadata");
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes)) as Record<string, unknown>;
    if (metadata.schema_version !== CACHE_SCHEMA_VERSION
      || metadata.cache_key !== environmentKey(locked, platform, environments, installAll)
      || metadata.lock_digest !== locked.lock_digest
      || metadata.manifest_digest !== locked.manifest_digest
      || metadata.platform !== platform
      || metadata.install_all !== installAll
      || typeof metadata.entrypoint_receipt_digest !== "string"
      || !/^blake3:[a-f0-9]{64}$/.test(metadata.entrypoint_receipt_digest)
      || !Array.isArray(metadata.environments)
      || metadata.environments.length !== environments.length
      || metadata.environments.some((environment, index) => environment !== environments[index])) {
      throw new Error(`Pixi environment ${locked.lock_digest} has invalid metadata`);
    }
    const prefixes = new Map<string, string>();
    for (const environment of environments) {
      const prefix = join(directory, ".pixi", "envs", environment);
      if (!await pathExists(prefix)) throw new Error(`cached Pixi environment ${environment} is missing`);
      await regularDirectory(prefix, `cached Pixi environment ${environment}`);
      if (await realpath(prefix) !== resolve(prefix)) {
        throw new Error(`Pixi environment ${locked.lock_digest}:${environment} contains a symbolic path`);
      }
      prefixes.set(environment, prefix);
    }
    const receiptBytes = await regularFile(
      join(directory, "entrypoints.json"),
      MAX_ENTRYPOINT_RECEIPT_BYTES,
      "cached Pixi entrypoint receipt",
    );
    if (byteDigest(receiptBytes) !== metadata.entrypoint_receipt_digest) {
      throw new Error(`Pixi environment ${locked.lock_digest} does not match its entrypoint receipt`);
    }
    const receipt = parseEntrypointReceipt(receiptBytes, environments, platform);
    await verifyEntrypointReceipt(receipt, prefixes);
    return { manifestPath: join(directory, "pixi.toml"), prefixes };
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function processIdentity(pid: number) {
  if (process.platform !== "linux") return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(`/proc/${pid}/stat`, "r");
    if (!(await handle.stat()).isFile()) return undefined;
    const bytes = Buffer.allocUnsafe(64 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (!bytesRead || bytesRead === bytes.byteLength) return undefined;
    const stat = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)).trim();
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fieldsFromState = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTicks = fieldsFromState[19];
    return startTicks && /^\d+$/.test(startTicks) ? `linux-proc-start:${startTicks}` : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function builderIsActive(builder: BuilderMarker) {
  if (!processAlive(builder.pid)) return false;
  if (!builder.process_identity) return true;
  return await processIdentity(builder.pid) === builder.process_identity;
}

async function pause(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("operation cancelled");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const completed = () => {
      signal?.removeEventListener("abort", cancelled);
      resolvePromise();
    };
    const timer = setTimeout(completed, milliseconds);
    const cancelled = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      rejectPromise(new Error("operation cancelled"));
    };
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("operation cancelled"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let finished = false;
    const settle = (action: () => void) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", cancelled);
      action();
    };
    const cancelled = () => settle(() => rejectPromise(new Error("operation cancelled")));
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    void promise.then(
      (value) => settle(() => resolvePromise(value)),
      (error) => settle(() => rejectPromise(error)),
    );
  });
}
