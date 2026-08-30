import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { byteDigest, canonicalJsonValue } from "@somite/workflow/contentIdentity";
import { atomicWrite, ensurePrivateDirectory, pathExists, regularDirectory, regularFile } from "./files.ts";
import { commandFailure, runCaptured } from "./process.ts";
import { executablePath } from "./system.ts";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const PLATFORM = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const BUILD_GRACE_MS = 30_000;
const MAX_BUILD_MS = 2 * 60 * 60_000;

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

function hex(digest: string) {
  return digest.slice("blake3:".length);
}

async function sameBytes(path: string, expected: Uint8Array, maximumBytes: number, label: string) {
  const existing = await regularFile(path, maximumBytes, label);
  return byteDigest(existing) === byteDigest(expected);
}

export class PixiCache {
  readonly #projectRoot: string;
  readonly #locks = new Map<string, SharedOperation<LockedManifest>>();
  readonly #environments = new Map<string, SharedOperation<string>>();

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
  }

  async lock(manifestText: string, platform: string, signal?: AbortSignal): Promise<LockedManifest> {
    if (!PLATFORM.test(platform)) throw new Error(`invalid Pixi platform ${platform}`);
    const manifest = new TextEncoder().encode(manifestText);
    if (manifest.byteLength === 0 || manifest.byteLength > MAX_MANIFEST_BYTES) throw new Error("Pixi manifest size is invalid");
    const manifestDigest = byteDigest(manifest);
    const key = `${platform}:${manifestDigest}`;
    return this.#shared(this.#locks, key, (sharedSignal) => this.#lock(manifest, manifestDigest, platform, sharedSignal), signal);
  }

  async environment(locked: LockedManifest, platform: string, signal?: AbortSignal) {
    if (!PLATFORM.test(platform)) throw new Error(`invalid Pixi platform ${platform}`);
    const key = `${platform}:${locked.lock_digest}:${locked.manifest_digest}`;
    return this.#shared(this.#environments, key, (sharedSignal) => this.#environment(locked, platform, sharedSignal), signal);
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
      const lock = await regularFile(join(temporary, "pixi.lock"), MAX_LOCK_BYTES, "Pixi lock");
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
    const lock = await regularFile(join(directory, "pixi.lock"), MAX_LOCK_BYTES, "cached Pixi lock");
    if (lock.byteLength === 0) throw new Error("cached Pixi lock is empty");
    return { pixi, manifest, lock, manifest_digest: manifestDigest, lock_digest: byteDigest(lock) };
  }

  async #environment(locked: LockedManifest, platform: string, signal?: AbortSignal): Promise<string> {
    const parent = await ensurePrivateDirectory(this.#projectRoot, `.somite/pixi/environments/${platform}`);
    const destination = join(parent, `${hex(locked.lock_digest)}-${hex(locked.manifest_digest)}`);
    while (await pathExists(destination)) {
      if (await pathExists(join(destination, "environment.json"))) {
        return this.#verifyEnvironment(destination, locked, platform);
      }
      const metadata = await lstat(destination);
      const builder = await this.#builder(join(destination, "building.json"));
      const builderAge = builder ? Date.now() - builder.started_at_unix_ms : Number.POSITIVE_INFINITY;
      if ((builder && builderAge >= 0 && builderAge <= MAX_BUILD_MS && processAlive(builder.pid))
        || Date.now() - metadata.mtimeMs < BUILD_GRACE_MS) {
        await pause(100, signal);
        continue;
      }
      await regularDirectory(destination, "incomplete Pixi environment cache entry");
      await rm(destination, { recursive: true });
    }
    try {
      await mkdir(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.#environment(locked, platform, signal);
      throw error;
    }
    try {
      await atomicWrite(join(destination, "building.json"), `${JSON.stringify({ pid: process.pid, started_at_unix_ms: Date.now() })}\n`);
      await writeFile(join(destination, "pixi.toml"), locked.manifest, { flag: "wx", mode: 0o600 });
      await writeFile(join(destination, "pixi.lock"), locked.lock, { flag: "wx", mode: 0o600 });
      const installed = await runCaptured(
        locked.pixi,
        ["install", "--frozen", "--no-progress", "--manifest-path", join(destination, "pixi.toml")],
        destination,
        signal,
      );
      if (installed.code !== 0) throw new Error(`Pixi install failed: ${commandFailure("pixi install", installed)}`);
      await regularDirectory(join(destination, ".pixi", "envs", "default"), "installed Pixi environment");
      await atomicWrite(join(destination, "environment.json"), `${JSON.stringify(canonicalJsonValue({
        schema_version: 1,
        platform,
        lock_digest: locked.lock_digest,
        manifest_digest: locked.manifest_digest,
        environment: "default",
      }), null, 2)}\n`);
      await rm(join(destination, "building.json"), { force: true });
      return this.#verifyEnvironment(destination, locked, platform);
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async #builder(path: string) {
    try {
      const bytes = await regularFile(path, MAX_METADATA_BYTES, "Pixi environment build marker");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      return Number.isSafeInteger(value.pid)
        && (value.pid as number) > 0
        && Number.isSafeInteger(value.started_at_unix_ms)
        && (value.started_at_unix_ms as number) >= 0
        ? { pid: value.pid as number, started_at_unix_ms: value.started_at_unix_ms as number }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #verifyEnvironment(directory: string, locked: LockedManifest, platform: string) {
    await regularDirectory(directory, "Pixi environment cache entry");
    if (!await sameBytes(join(directory, "pixi.toml"), locked.manifest, MAX_MANIFEST_BYTES, "cached Pixi environment manifest")) {
      throw new Error(`Pixi environment ${locked.lock_digest} does not match its manifest`);
    }
    const lock = await regularFile(join(directory, "pixi.lock"), MAX_LOCK_BYTES, "cached Pixi environment lock");
    if (byteDigest(lock) !== locked.lock_digest) throw new Error(`Pixi environment ${locked.lock_digest} does not match its lock`);
    const metadataBytes = await regularFile(join(directory, "environment.json"), MAX_METADATA_BYTES, "Pixi environment metadata");
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes)) as Record<string, unknown>;
    if (metadata.schema_version !== 1
      || metadata.lock_digest !== locked.lock_digest
      || metadata.manifest_digest !== locked.manifest_digest
      || metadata.platform !== platform
      || metadata.environment !== "default") {
      throw new Error(`Pixi environment ${locked.lock_digest} has invalid metadata`);
    }
    const environment = join(directory, ".pixi", "envs", "default");
    await regularDirectory(environment, "cached Pixi environment");
    if (await realpath(environment) !== resolve(environment)) throw new Error(`Pixi environment ${locked.lock_digest} contains a symbolic path`);
    return join(directory, "pixi.toml");
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
