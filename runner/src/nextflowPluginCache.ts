import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, platform as operatingSystem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { byteDigest, canonicalJsonDigest, canonicalJsonValue } from "@somite/workflow/contentIdentity";
import type { SourceSpan } from "@somite/workflow/model";
import { MAX_NEXTFLOW_PLUGIN_REQUIREMENTS } from "@somite/workflow/taskEnvironment";

import { atomicWrite, containedPath, pathExists } from "./files.ts";
import { runAbortableProcess, withoutEnvironmentPrefix } from "./process.ts";
import { pixiPlatform } from "./system.ts";

export const NEXTFLOW_PLUGIN_FREEZER_REVISION = "nextflow-plugin-store-ts-v1";

export const NEXTFLOW_PLUGIN_STORE_LIMITS = Object.freeze({
  maximum_requirements: MAX_NEXTFLOW_PLUGIN_REQUIREMENTS,
  maximum_entries: 8_192,
  maximum_files: 4_096,
  maximum_component_bytes: 255,
  maximum_path_bytes: 4_096,
  maximum_file_bytes: 128 * 1024 * 1024,
  maximum_total_bytes: 512 * 1024 * 1024,
  maximum_runtime_manifest_bytes: 2 * 1024 * 1024,
  maximum_runtime_lock_bytes: 64 * 1024 * 1024,
  maximum_store_manifest_bytes: 8 * 1024 * 1024,
  maximum_process_output_bytes: 256 * 1024,
} as const);

export type NextflowPluginCacheErrorCode =
  | "plugin_requirement_invalid"
  | "plugin_runtime_invalid"
  | "plugin_install_failed"
  | "plugin_store_invalid"
  | "plugin_cache_invalid"
  | "plugin_cache_corrupt"
  | "plugin_freeze_cancelled";

export class NextflowPluginCacheError extends Error {
  readonly code: NextflowPluginCacheErrorCode;

  constructor(code: NextflowPluginCacheErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NextflowPluginCacheError";
    this.code = code;
  }
}

export type NextflowPluginRequirement = Readonly<{
  id: string;
  version: string;
  spec: string;
  span?: SourceSpan;
}>;

export type FrozenNextflowRuntime = Readonly<{
  pixi: string;
  manifestPath: string;
}>;

export type NextflowPluginInstallInvocation = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  signal: AbortSignal;
}>;

export type NextflowPluginInstallResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

/** The single external-process port. Tests can freeze synthetic stores without network access. */
export type NextflowPluginInstaller = (
  invocation: NextflowPluginInstallInvocation,
) => Promise<NextflowPluginInstallResult>;

export type FreezeNextflowPluginStoreInput = Readonly<{
  requirements: readonly NextflowPluginRequirement[];
  runtime: FrozenNextflowRuntime;
  signal: AbortSignal;
  platform?: string;
  cacheRoot?: string;
}>;

export type FrozenNextflowPluginFile = Readonly<{
  path: string;
  mode: 0o100644 | 0o100755;
  bytes: Uint8Array;
  digest: string;
}>;

export type FrozenNextflowPluginFileRecord = Readonly<{
  path: string;
  mode: 0o100644 | 0o100755;
  bytes: number;
  digest: string;
}>;

export type FrozenNextflowPluginRequirement = Readonly<{
  id: string;
  version: string;
  spec: string;
}>;

export type FrozenNextflowPluginStoreManifest = Readonly<{
  schema_version: 1;
  freezer_revision: typeof NEXTFLOW_PLUGIN_FREEZER_REVISION;
  request_digest: string;
  platform: string;
  runtime_manifest_digest: string;
  runtime_lock_digest: string;
  requirements: readonly FrozenNextflowPluginRequirement[];
  files: readonly FrozenNextflowPluginFileRecord[];
  total_bytes: number;
  store_digest: string;
}>;

export type FrozenNextflowPluginStore = Readonly<{
  digest: string;
  manifest: FrozenNextflowPluginStoreManifest;
  files: readonly FrozenNextflowPluginFile[];
  cache_path: string;
  cached: boolean;
}>;

type RuntimeIdentity = Readonly<{
  pixi: string;
  manifestPath: string;
  manifestDigest: string;
  lockDigest: string;
}>;

type PluginRequest = Readonly<{
  schema_version: 1;
  freezer_revision: typeof NEXTFLOW_PLUGIN_FREEZER_REVISION;
  platform: string;
  runtime_manifest_digest: string;
  runtime_lock_digest: string;
  requirements: readonly FrozenNextflowPluginRequirement[];
}>;

type SharedFreeze = {
  controller: AbortController;
  promise: Promise<FrozenNextflowPluginStore>;
  settled: boolean;
  waiters: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST = /^blake3:[a-f0-9]{64}$/;
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const PLUGIN_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const PLATFORM = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const inflight = new Map<string, SharedFreeze>();

function fail(code: NextflowPluginCacheErrorCode, message: string, cause?: unknown): never {
  throw new NextflowPluginCacheError(code, message, cause);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function object(value: unknown, label: string, code: NextflowPluginCacheErrorCode): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string, code: NextflowPluginCacheErrorCode) {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${label} has an invalid contract`);
  }
}

function checkedSpan(span: SourceSpan | undefined, spec: string) {
  if (span === undefined) return;
  if (!span || typeof span.path !== "string" || !span.path || encoder.encode(span.path).byteLength > NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_path_bytes
    || /[\u0000-\u001f\u007f]/.test(span.path)
    || !Number.isSafeInteger(span.start_line) || span.start_line < 1
    || !Number.isSafeInteger(span.end_line) || span.end_line < span.start_line) {
    fail("plugin_requirement_invalid", `Nextflow plugin ${spec} has an invalid source span`);
  }
}

function normalizedRequirements(input: readonly NextflowPluginRequirement[]): FrozenNextflowPluginRequirement[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_requirements) {
    fail(
      "plugin_requirement_invalid",
      `Nextflow plugin freeze requires between 1 and ${NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_requirements} exact requirements`,
    );
  }
  const requirements = input.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !PLUGIN_ID.test(entry.id) || entry.id.length > 128) {
      fail("plugin_requirement_invalid", "Nextflow plugin IDs must be bounded lowercase identifiers");
    }
    if (typeof entry.version !== "string" || !PLUGIN_VERSION.test(entry.version)
      || entry.version.toLowerCase() === "latest" || /[*^~<>=/:]/.test(entry.version)) {
      fail("plugin_requirement_invalid", `Nextflow plugin ${entry.id} must declare one exact bounded version`);
    }
    if (entry.spec !== `${entry.id}@${entry.version}`) {
      fail("plugin_requirement_invalid", `Nextflow plugin ${entry.id} spec must exactly equal ${entry.id}@${entry.version}`);
    }
    checkedSpan(entry.span, entry.spec);
    return { id: entry.id, version: entry.version, spec: entry.spec };
  }).sort((left, right) => compareText(left.id, right.id) || compareText(left.version, right.version));
  for (let index = 1; index < requirements.length; index += 1) {
    if (requirements[index - 1]!.id === requirements[index]!.id) {
      fail("plugin_requirement_invalid", `Nextflow plugin ${requirements[index]!.id} is declared more than once`);
    }
  }
  return requirements;
}

function checkedPlatform(value: string | undefined) {
  const platform = value ?? pixiPlatform();
  if (!PLATFORM.test(platform) || platform.length > 64) fail("plugin_runtime_invalid", `invalid plugin runtime platform ${platform}`);
  return platform;
}

function checkedPixi(value: string) {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("plugin_runtime_invalid", "Pixi binary must be one bounded command or path");
  }
  return value;
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function exactFileBytes(
  path: string,
  maximumBytes: number,
  label: string,
  code: NextflowPluginCacheErrorCode,
) {
  let inspected: Awaited<ReturnType<typeof lstat>>;
  try {
    inspected = await lstat(path);
    if (inspected.isSymbolicLink()) fail(code, `${label} must not be a symbolic link`);
    if (!inspected.isFile()) fail(code, `${label} must be a regular file`);
    if (inspected.size > maximumBytes) fail(code, `${label} exceeds the maximum file size of ${maximumBytes} bytes`);
    if (await realpath(path) !== resolve(path)) fail(code, `${label} crosses a symbolic path`);
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFileIdentity(inspected, opened)) fail(code, `${label} changed between inspection and open`);
      const bytes = await handle.readFile();
      const confirmed = await handle.stat();
      if (bytes.byteLength !== inspected.size || !sameFileIdentity(opened, confirmed)) fail(code, `${label} changed while it was read`);
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof NextflowPluginCacheError) throw error;
    fail(code, `${label} could not be read safely: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

async function runtimeIdentity(runtime: FrozenNextflowRuntime): Promise<RuntimeIdentity> {
  const pixi = checkedPixi(runtime?.pixi);
  if (!runtime || typeof runtime.manifestPath !== "string" || !isAbsolute(runtime.manifestPath)) {
    fail("plugin_runtime_invalid", "frozen Pixi manifest path must be absolute");
  }
  const manifestPath = resolve(runtime.manifestPath);
  const lockPath = join(dirname(manifestPath), "pixi.lock");
  const [manifest, lock] = await Promise.all([
    exactFileBytes(
      manifestPath,
      NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_runtime_manifest_bytes,
      "frozen Pixi manifest",
      "plugin_runtime_invalid",
    ),
    exactFileBytes(
      lockPath,
      NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_runtime_lock_bytes,
      "frozen Pixi lock",
      "plugin_runtime_invalid",
    ),
  ]);
  return {
    pixi,
    manifestPath,
    manifestDigest: byteDigest(manifest),
    lockDigest: byteDigest(lock),
  };
}

export function nextflowPluginCacheRoot(
  environment: NodeJS.ProcessEnv = process.env,
  system: NodeJS.Platform = operatingSystem(),
  home: string = homedir(),
) {
  const override = environment.SOMITE_NEXTFLOW_PLUGIN_CACHE_DIR;
  if (override !== undefined) {
    if (!override || !isAbsolute(override)) fail("plugin_cache_invalid", "SOMITE_NEXTFLOW_PLUGIN_CACHE_DIR must be an absolute path");
    return resolve(override);
  }
  if (system === "darwin") return join(home, "Library", "Caches", "Somite", "nextflow-plugins");
  if (system === "win32") {
    const local = environment.LOCALAPPDATA;
    return join(local && isAbsolute(local) ? local : join(home, "AppData", "Local"), "Somite", "nextflow-plugins");
  }
  const xdg = environment.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".cache"), "somite", "nextflow-plugins");
}

async function ensurePrivateCacheRoot(value: string) {
  if (!isAbsolute(value)) fail("plugin_cache_invalid", "Nextflow plugin cache root must be absolute");
  const destination = resolve(value);
  let existing = destination;
  while (!await pathExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) fail("plugin_cache_invalid", `Nextflow plugin cache root ${destination} has no existing parent`);
    existing = parent;
  }
  let current: string;
  try {
    const metadata = await lstat(existing);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("plugin_cache_invalid", `Nextflow plugin cache parent ${existing} must be a regular directory`);
    const canonical = await realpath(existing);
    if (canonical !== resolve(existing)) fail("plugin_cache_invalid", `Nextflow plugin cache root ${destination} crosses a symbolic path`);
    current = canonical;
    for (const part of relative(existing, destination).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const child = await lstat(current);
      if (child.isSymbolicLink() || !child.isDirectory() || await realpath(current) !== resolve(current)) {
        fail("plugin_cache_invalid", `Nextflow plugin cache root ${destination} contains a symbolic or non-directory path`);
      }
    }
    const root = await lstat(current);
    const uid = process.getuid?.();
    if (uid !== undefined && root.uid !== uid) fail("plugin_cache_invalid", `Nextflow plugin cache root ${destination} is not owned by this user`);
    if (process.platform !== "win32" && (root.mode & 0o077) !== 0) {
      fail("plugin_cache_invalid", `Nextflow plugin cache root ${destination} must be private (mode 0700)`);
    }
    return current;
  } catch (error) {
    if (error instanceof NextflowPluginCacheError) throw error;
    fail("plugin_cache_invalid", `Nextflow plugin cache root ${destination} could not be secured`, error);
  }
}

async function privateChild(root: string, name: string) {
  const path = join(root, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(path) !== resolve(path)) {
    fail("plugin_cache_invalid", `Nextflow plugin cache ${name} must be a regular directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) fail("plugin_cache_invalid", `Nextflow plugin cache ${name} is not owned by this user`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    fail("plugin_cache_invalid", `Nextflow plugin cache ${name} must be private (mode 0700)`);
  }
  return path;
}

function portableComponent(name: string) {
  return Boolean(name)
    && name !== "." && name !== ".."
    && name.normalize("NFC") === name
    && encoder.encode(name).byteLength <= NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_component_bytes
    && !/[\u0000-\u001f\u007f\\/<>:"|?*]/.test(name)
    && !/[. ]$/.test(name)
    && !WINDOWS_RESERVED.test(name);
}

function portableRelativePath(path: string) {
  return Boolean(path)
    && encoder.encode(path).byteLength <= NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_path_bytes
    && path.split("/").every(portableComponent);
}

async function exactDirectory(path: string, label: string, code: NextflowPluginCacheErrorCode) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(code, `${label} must be a regular directory`);
    if (await realpath(path) !== resolve(path)) fail(code, `${label} crosses a symbolic path`);
    return path;
  } catch (error) {
    if (error instanceof NextflowPluginCacheError) throw error;
    fail(code, `${label} could not be inspected`, error);
  }
}

async function captureStore(root: string, code: "plugin_store_invalid" | "plugin_cache_corrupt") {
  await exactDirectory(root, "Nextflow plugin store", code);
  const pending: Array<{ directory: string; prefix: string }> = [{ directory: root, prefix: "" }];
  const files: FrozenNextflowPluginFile[] = [];
  let entries = 0;
  let totalBytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    let directoryEntries: Dirent<string>[];
    try {
      directoryEntries = await readdir(current.directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      fail(code, `Nextflow plugin store directory ${current.prefix || "."} could not be read`, error);
    }
    directoryEntries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of directoryEntries) {
      entries += 1;
      if (entries > NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_entries) {
        fail(code, `Nextflow plugin store exceeds ${NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_entries} entries`);
      }
      const relativePath = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      if (!portableRelativePath(relativePath)) fail(code, `Nextflow plugin store path ${relativePath} is not portable`);
      const path = join(current.directory, entry.name);
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(path);
      } catch (error) {
        fail(code, `Nextflow plugin store entry ${relativePath} could not be inspected`, error);
      }
      if (metadata.isSymbolicLink()) fail(code, `Nextflow plugin store contains symbolic link ${relativePath}`);
      if (metadata.isDirectory()) {
        await exactDirectory(path, `Nextflow plugin store directory ${relativePath}`, code);
        pending.push({ directory: path, prefix: relativePath });
        continue;
      }
      if (!metadata.isFile()) fail(code, `Nextflow plugin store contains unsupported special file ${relativePath}`);
      if (files.length >= NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_files) {
        fail(code, `Nextflow plugin store exceeds ${NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_files} files`);
      }
      if (metadata.size > NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_file_bytes) {
        fail(code, `Nextflow plugin store file ${relativePath} exceeds the maximum file size of ${NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_file_bytes} bytes`);
      }
      totalBytes += metadata.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_total_bytes) {
        fail(code, `Nextflow plugin store exceeds ${NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_total_bytes} total bytes`);
      }
      const bytes = await exactFileBytes(
        path,
        NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_file_bytes,
        `Nextflow plugin store file ${relativePath}`,
        code,
      );
      files.push({
        path: relativePath,
        mode: process.platform !== "win32" && Boolean(metadata.mode & 0o111) ? 0o100755 : 0o100644,
        bytes,
        digest: byteDigest(bytes),
      });
    }
  }
  if (!files.length) fail(code, "Nextflow plugin installation produced an empty plugin store");
  files.sort((left, right) => compareText(left.path, right.path));
  const records = files.map(({ path, mode, bytes, digest }) => ({ path, mode, bytes: bytes.byteLength, digest }));
  return { files, records, totalBytes };
}

function storeManifest(
  request: PluginRequest,
  requestDigest: string,
  records: readonly FrozenNextflowPluginFileRecord[],
  totalBytes: number,
): FrozenNextflowPluginStoreManifest {
  const material: Omit<FrozenNextflowPluginStoreManifest, "store_digest"> = {
    schema_version: 1 as const,
    freezer_revision: NEXTFLOW_PLUGIN_FREEZER_REVISION,
    request_digest: requestDigest,
    platform: request.platform,
    runtime_manifest_digest: request.runtime_manifest_digest,
    runtime_lock_digest: request.runtime_lock_digest,
    requirements: request.requirements,
    files: records,
    total_bytes: totalBytes,
  };
  return { ...material, store_digest: canonicalJsonDigest(material) };
}

function decodeManifest(bytes: Uint8Array): FrozenNextflowPluginStoreManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    fail("plugin_cache_corrupt", "cached Nextflow plugin manifest is not valid UTF-8 JSON", error);
  }
  const value = object(raw, "cached Nextflow plugin manifest", "plugin_cache_corrupt");
  exactKeys(value, [
    "schema_version", "freezer_revision", "request_digest", "platform", "runtime_manifest_digest",
    "runtime_lock_digest", "requirements", "files", "total_bytes", "store_digest",
  ], "cached Nextflow plugin manifest", "plugin_cache_corrupt");
  if (value.schema_version !== 1 || value.freezer_revision !== NEXTFLOW_PLUGIN_FREEZER_REVISION
    || typeof value.request_digest !== "string" || !DIGEST.test(value.request_digest)
    || typeof value.platform !== "string" || !PLATFORM.test(value.platform)
    || typeof value.runtime_manifest_digest !== "string" || !DIGEST.test(value.runtime_manifest_digest)
    || typeof value.runtime_lock_digest !== "string" || !DIGEST.test(value.runtime_lock_digest)
    || typeof value.store_digest !== "string" || !DIGEST.test(value.store_digest)
    || !Number.isSafeInteger(value.total_bytes) || (value.total_bytes as number) < 0
    || !Array.isArray(value.requirements) || !Array.isArray(value.files)) {
    fail("plugin_cache_corrupt", "cached Nextflow plugin manifest has invalid fields");
  }
  const requirements: FrozenNextflowPluginRequirement[] = [];
  for (const [index, entry] of value.requirements.entries()) {
    const requirement = object(entry, `cached plugin requirement ${index}`, "plugin_cache_corrupt");
    exactKeys(requirement, ["id", "version", "spec"], `cached plugin requirement ${index}`, "plugin_cache_corrupt");
    if (typeof requirement.id !== "string" || !PLUGIN_ID.test(requirement.id)
      || typeof requirement.version !== "string" || !PLUGIN_VERSION.test(requirement.version)
      || requirement.spec !== `${requirement.id}@${requirement.version}`) {
      fail("plugin_cache_corrupt", `cached plugin requirement ${index} is invalid`);
    }
    requirements.push({ id: requirement.id, version: requirement.version, spec: requirement.spec });
  }
  if (!requirements.length || requirements.length > NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_requirements) {
    fail("plugin_cache_corrupt", "cached Nextflow plugin manifest has an invalid requirement count");
  }
  for (let index = 0; index < requirements.length; index += 1) {
    if (index && compareText(requirements[index - 1]!.id, requirements[index]!.id) >= 0) {
      fail("plugin_cache_corrupt", "cached Nextflow plugin requirements are not canonical");
    }
  }
  const files: FrozenNextflowPluginFileRecord[] = [];
  let totalBytes = 0;
  for (const [index, entry] of value.files.entries()) {
    const file = object(entry, `cached plugin file ${index}`, "plugin_cache_corrupt");
    exactKeys(file, ["path", "mode", "bytes", "digest"], `cached plugin file ${index}`, "plugin_cache_corrupt");
    if (typeof file.path !== "string" || !portableRelativePath(file.path)
      || (file.mode !== 0o100644 && file.mode !== 0o100755)
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0
      || (file.bytes as number) > NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_file_bytes
      || typeof file.digest !== "string" || !DIGEST.test(file.digest)) {
      fail("plugin_cache_corrupt", `cached plugin file ${index} is invalid`);
    }
    if (index && compareText(files[index - 1]!.path, file.path) >= 0) {
      fail("plugin_cache_corrupt", "cached Nextflow plugin files are not canonical");
    }
    totalBytes += file.bytes as number;
    files.push({ path: file.path, mode: file.mode, bytes: file.bytes as number, digest: file.digest });
  }
  if (!files.length || files.length > NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_files
    || totalBytes !== value.total_bytes || totalBytes > NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_total_bytes) {
    fail("plugin_cache_corrupt", "cached Nextflow plugin manifest has invalid file totals");
  }
  const manifest: FrozenNextflowPluginStoreManifest = {
    schema_version: 1,
    freezer_revision: NEXTFLOW_PLUGIN_FREEZER_REVISION,
    request_digest: value.request_digest as string,
    platform: value.platform as string,
    runtime_manifest_digest: value.runtime_manifest_digest as string,
    runtime_lock_digest: value.runtime_lock_digest as string,
    requirements,
    files,
    total_bytes: totalBytes,
    store_digest: value.store_digest as string,
  };
  const { store_digest: _storedDigest, ...material } = manifest;
  if (canonicalJsonDigest(material) !== manifest.store_digest) {
    fail("plugin_cache_corrupt", "cached Nextflow plugin manifest does not match its content digest");
  }
  return manifest;
}

function decodePointer(bytes: Uint8Array, expectedRequestDigest: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    fail("plugin_cache_corrupt", "cached Nextflow plugin request is not valid UTF-8 JSON", error);
  }
  const value = object(raw, "cached Nextflow plugin request", "plugin_cache_corrupt");
  exactKeys(value, ["schema_version", "request_digest", "store_digest"], "cached Nextflow plugin request", "plugin_cache_corrupt");
  if (value.schema_version !== 1 || value.request_digest !== expectedRequestDigest
    || typeof value.store_digest !== "string" || !DIGEST.test(value.store_digest)) {
    fail("plugin_cache_corrupt", "cached Nextflow plugin request has an invalid identity");
  }
  return value.store_digest;
}

function sameRecords(left: readonly FrozenNextflowPluginFileRecord[], right: readonly FrozenNextflowPluginFileRecord[]) {
  return canonicalJsonDigest(left) === canonicalJsonDigest(right);
}

async function readCacheObject(
  objects: string,
  storeDigest: string,
  expectedRequestDigest: string,
  cached: boolean,
): Promise<FrozenNextflowPluginStore> {
  const identity = storeDigest.slice("blake3:".length);
  const cachePath = join(objects, identity);
  await exactDirectory(cachePath, `cached Nextflow plugin object ${storeDigest}`, "plugin_cache_corrupt");
  let entries: string[];
  try {
    entries = (await readdir(cachePath)).sort(compareText);
  } catch (error) {
    fail("plugin_cache_corrupt", `cached Nextflow plugin object ${storeDigest} could not be read`, error);
  }
  if (entries.length !== 2 || entries[0] !== "manifest.json" || entries[1] !== "store") {
    fail("plugin_cache_corrupt", `cached Nextflow plugin object ${storeDigest} contains unmanifested entries`);
  }
  const manifest = decodeManifest(await exactFileBytes(
    join(cachePath, "manifest.json"),
    NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_store_manifest_bytes,
    "cached Nextflow plugin manifest",
    "plugin_cache_corrupt",
  ));
  if (manifest.store_digest !== storeDigest || manifest.request_digest !== expectedRequestDigest) {
    fail("plugin_cache_corrupt", `cached Nextflow plugin object ${storeDigest} does not match its request`);
  }
  const captured = await captureStore(join(cachePath, "store"), "plugin_cache_corrupt");
  if (captured.totalBytes !== manifest.total_bytes || !sameRecords(captured.records, manifest.files)) {
    fail("plugin_cache_corrupt", `cached Nextflow plugin object ${storeDigest} does not match its manifest`);
  }
  return { digest: storeDigest, manifest, files: captured.files, cache_path: cachePath, cached };
}

function boundedOutput(current: Buffer, chunk: Buffer) {
  const next = Buffer.concat([current, chunk]);
  const maximum = NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_process_output_bytes;
  return next.byteLength <= maximum ? next : next.subarray(next.byteLength - maximum);
}

const systemInstaller: NextflowPluginInstaller = async (invocation) => {
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  const completion = await runAbortableProcess(invocation.signal, () => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: { ...invocation.env },
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout = boundedOutput(stdout, chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = boundedOutput(stderr, chunk); });
    return child;
  }, {});
  if (invocation.signal.aborted) fail("plugin_freeze_cancelled", "Nextflow plugin freeze was cancelled");
  return {
    ...completion,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  };
};

function resultDetail(result: NextflowPluginInstallResult) {
  const line = [...result.stderr.split("\n"), ...result.stdout.split("\n")]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  const fallback = `exited with ${result.code ?? result.signal ?? "unknown status"}`;
  return (line ?? fallback).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1_000);
}

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) fail("plugin_freeze_cancelled", "Nextflow plugin freeze was cancelled", signal.reason);
}

async function publishObject(
  objects: string,
  manifest: FrozenNextflowPluginStoreManifest,
  files: readonly FrozenNextflowPluginFile[],
) {
  const destination = join(objects, manifest.store_digest.slice("blake3:".length));
  if (await pathExists(destination)) {
    await readCacheObject(objects, manifest.store_digest, manifest.request_digest, false);
    return destination;
  }
  const temporary = join(objects, `.incoming-${manifest.store_digest.slice("blake3:".length)}-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  const store = join(temporary, "store");
  await mkdir(store, { mode: 0o700 });
  try {
    for (const file of files) {
      const path = containedPath(store, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { flag: "wx", mode: file.mode === 0o100755 ? 0o755 : 0o644 });
      if (file.mode === 0o100755) await chmod(path, 0o755);
    }
    await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(canonicalJsonValue(manifest), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if ((code === "EEXIST" || code === "ENOTEMPTY") && await pathExists(destination)) {
      await readCacheObject(objects, manifest.store_digest, manifest.request_digest, false);
      return destination;
    }
    throw error;
  }
  return destination;
}

async function buildStore(
  input: FreezeNextflowPluginStoreInput,
  runtime: RuntimeIdentity,
  request: PluginRequest,
  requestDigest: string,
  cacheRoot: string,
  installer: NextflowPluginInstaller,
  signal: AbortSignal,
) {
  const [objects, requests, builds] = await Promise.all([
    privateChild(cacheRoot, "objects"),
    privateChild(cacheRoot, "requests"),
    privateChild(cacheRoot, "builds"),
  ]);
  const pointerPath = join(requests, `${requestDigest.slice("blake3:".length)}.json`);
  if (await pathExists(pointerPath)) {
    const storeDigest = decodePointer(await exactFileBytes(
      pointerPath,
      16 * 1024,
      "cached Nextflow plugin request",
      "plugin_cache_corrupt",
    ), requestDigest);
    return readCacheObject(objects, storeDigest, requestDigest, true);
  }

  checkCancelled(signal);
  const build = join(builds, `.build-${requestDigest.slice("blake3:".length)}-${randomUUID()}`);
  await mkdir(build, { mode: 0o700 });
  const store = join(build, "store");
  const nxfHome = join(build, "nxf-home");
  await Promise.all([mkdir(store, { mode: 0o700 }), mkdir(nxfHome, { mode: 0o700 })]);
  try {
    for (const requirement of request.requirements) {
      checkCancelled(signal);
      const environment = withoutEnvironmentPrefix(process.env, "NXF_");
      Object.assign(environment, {
        NXF_DISABLE_CHECK_LATEST: "true",
        NXF_HOME: nxfHome,
        NXF_PLUGINS_DIR: store,
      });
      const invocation: NextflowPluginInstallInvocation = {
        command: runtime.pixi,
        args: [
          "run",
          "--frozen",
          "--manifest-path",
          runtime.manifestPath,
          "--",
          "nextflow",
          "plugin",
          "install",
          requirement.spec,
        ],
        cwd: dirname(runtime.manifestPath),
        env: environment,
        signal,
      };
      let result: NextflowPluginInstallResult;
      try {
        result = await installer(invocation);
      } catch (error) {
        if (signal.aborted) checkCancelled(signal);
        fail(
          "plugin_install_failed",
          `Nextflow plugin ${requirement.spec} could not be installed: ${error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)}`,
          error,
        );
      }
      if (signal.aborted) checkCancelled(signal);
      if (!result) {
        fail("plugin_install_failed", `Nextflow plugin ${requirement.spec} installer returned no result`);
      }
      if (result.code !== 0 || result.signal !== null) {
        fail("plugin_install_failed", `Nextflow plugin ${requirement.spec} could not be installed: ${resultDetail(result)}`);
      }
    }
    const confirmedRuntime = await runtimeIdentity(input.runtime);
    if (confirmedRuntime.manifestDigest !== runtime.manifestDigest || confirmedRuntime.lockDigest !== runtime.lockDigest
      || confirmedRuntime.manifestPath !== runtime.manifestPath || confirmedRuntime.pixi !== runtime.pixi) {
      fail("plugin_runtime_invalid", "frozen Pixi runtime changed during Nextflow plugin installation");
    }
    checkCancelled(signal);
    const captured = await captureStore(store, "plugin_store_invalid");
    const manifest = storeManifest(request, requestDigest, captured.records, captured.totalBytes);
    await publishObject(objects, manifest, captured.files);
    await atomicWrite(pointerPath, `${JSON.stringify(canonicalJsonValue({
      schema_version: 1,
      request_digest: requestDigest,
      store_digest: manifest.store_digest,
    }), null, 2)}\n`);
    return readCacheObject(objects, manifest.store_digest, requestDigest, false);
  } finally {
    await rm(build, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sharedResult(operation: SharedFreeze, signal: AbortSignal) {
  operation.waiters += 1;
  return new Promise<FrozenNextflowPluginStore>((resolvePromise, rejectPromise) => {
    let completed = false;
    const release = () => {
      if (completed) return;
      completed = true;
      signal.removeEventListener("abort", cancelled);
      operation.waiters -= 1;
      if (!operation.settled && operation.waiters === 0) operation.controller.abort(new Error("all plugin freeze callers cancelled"));
    };
    const cancelled = () => {
      release();
      rejectPromise(new NextflowPluginCacheError("plugin_freeze_cancelled", "Nextflow plugin freeze was cancelled", signal.reason));
    };
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) {
      cancelled();
      return;
    }
    operation.promise.then(
      (value) => {
        if (completed) return;
        release();
        resolvePromise(value);
      },
      (error) => {
        if (completed) return;
        release();
        rejectPromise(error);
      },
    );
  });
}

/**
 * Freeze exact Nextflow plugins into a verified, immutable, content-addressed store.
 * Source spans are accepted for diagnostics but deliberately excluded from cache identity.
 */
export async function freezeNextflowPluginStore(
  input: FreezeNextflowPluginStoreInput,
  installer: NextflowPluginInstaller = systemInstaller,
): Promise<FrozenNextflowPluginStore> {
  if (!input || !(input.signal instanceof AbortSignal)) fail("plugin_freeze_cancelled", "Nextflow plugin freeze requires an AbortSignal");
  checkCancelled(input.signal);
  const requirements = normalizedRequirements(input.requirements);
  const platform = checkedPlatform(input.platform);
  const runtime = await runtimeIdentity(input.runtime);
  const cacheRoot = await ensurePrivateCacheRoot(input.cacheRoot ?? nextflowPluginCacheRoot());
  const request: PluginRequest = {
    schema_version: 1,
    freezer_revision: NEXTFLOW_PLUGIN_FREEZER_REVISION,
    platform,
    runtime_manifest_digest: runtime.manifestDigest,
    runtime_lock_digest: runtime.lockDigest,
    requirements,
  };
  const requestDigest = canonicalJsonDigest(request);
  const key = `${cacheRoot}\0${requestDigest}`;
  let operation = inflight.get(key);
  if (!operation) {
    const controller = new AbortController();
    operation = {
      controller,
      promise: buildStore(input, runtime, request, requestDigest, cacheRoot, installer, controller.signal),
      settled: false,
      waiters: 0,
    };
    inflight.set(key, operation);
    void operation.promise.then(
      () => {
        operation!.settled = true;
        if (inflight.get(key) === operation) inflight.delete(key);
      },
      () => {
        operation!.settled = true;
        if (inflight.get(key) === operation) inflight.delete(key);
      },
    );
  }
  return sharedResult(operation, input.signal);
}
