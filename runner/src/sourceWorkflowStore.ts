import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import {
  buildSourceManifest,
  safeSourcePath,
  type FrozenSourceFile,
  type SourceManifest,
} from "@somite/workflow/nextflowSource";

import { containedPath, ensurePrivateDirectory, pathExists, regularDirectory, regularFile } from "./files.ts";
import { SourceWorkflowTrustError, sourceWorkflowTrustFailure } from "./sourceWorkflowErrors.ts";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseManifest(bytes: Uint8Array, expectedDigest: string): SourceManifest {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    return sourceWorkflowTrustFailure("source_object_invalid", `source object ${expectedDigest} has an invalid manifest`, error);
  }
  if (!isObject(value) || value.schema_version !== 1 || value.source_digest !== expectedDigest
    || !Number.isSafeInteger(value.source_bytes) || (value.source_bytes as number) < 0 || !Array.isArray(value.files)) {
    return sourceWorkflowTrustFailure("source_object_invalid", `source object ${expectedDigest} has an invalid manifest contract`);
  }
  for (const entry of value.files) {
    if (!isObject(entry) || typeof entry.path !== "string" || !safeSourcePath(entry.path)
      || (entry.mode !== 0o100644 && entry.mode !== 0o100755)
      || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0
      || typeof entry.digest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(entry.digest)) {
      return sourceWorkflowTrustFailure("source_object_invalid", `source object ${expectedDigest} has an invalid manifest entry`);
    }
  }
  return value as unknown as SourceManifest;
}

function expectedSourceEntries(manifest: SourceManifest) {
  const files = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const directories = new Set<string>();
  for (const entry of manifest.files) {
    for (const match of entry.path.matchAll(/\//g)) directories.add(entry.path.slice(0, match.index));
  }
  return { files, directories };
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readInspectedFile(path: string, inspected: Awaited<ReturnType<typeof lstat>>, label: string) {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(inspected, opened)) {
      return sourceWorkflowTrustFailure("source_object_invalid", `${label} changed between inspection and open`);
    }
    const bytes = await handle.readFile();
    const confirmed = await handle.stat();
    if (bytes.byteLength !== inspected.size || !sameFileIdentity(opened, confirmed)) {
      return sourceWorkflowTrustFailure("source_object_invalid", `${label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function exactDirectory(parent: string, name: string, label: string) {
  const path = join(parent, name);
  await regularDirectory(path, label);
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) sourceWorkflowTrustFailure("source_object_invalid", `${label} must not cross a symbolic link`);
  return path;
}

/** Read and content-verify one immutable source object without creating store paths. */
export async function readSourceObject(root: string, sourceDigest: string) {
  if (!/^blake3:[0-9a-f]{64}$/.test(sourceDigest)) {
    return sourceWorkflowTrustFailure("source_object_invalid", "source digest is malformed");
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
    await regularDirectory(canonicalRoot, "project root");
    const state = await exactDirectory(canonicalRoot, ".somite", "source workflow state");
    const store = await exactDirectory(state, "source-workflows", "source workflow store");
    const objects = await exactDirectory(store, "objects", "source object store");
    const directory = await exactDirectory(objects, sourceDigest.slice("blake3:".length), `source object ${sourceDigest}`);

    const objectEntries = (await readdir(directory)).sort();
    if (objectEntries.length !== 2 || objectEntries[0] !== "source" || objectEntries[1] !== "source-manifest.json") {
      return sourceWorkflowTrustFailure("source_object_invalid", `source object ${sourceDigest} contains unmanifested entries`);
    }
    const source = await exactDirectory(directory, "source", `source object ${sourceDigest} tree`);
    const manifest = parseManifest(
      await regularFile(join(directory, "source-manifest.json"), MAX_MANIFEST_BYTES, `source object ${sourceDigest} manifest`),
      sourceDigest,
    );
    const expected = expectedSourceEntries(manifest);
    const foundFiles = new Set<string>();
    const foundDirectories = new Set<string>();
    const filesByPath = new Map<string, FrozenSourceFile>();
    const pending: Array<{ directory: string; prefix: string }> = [{ directory: source, prefix: "" }];

    while (pending.length) {
      const current = pending.pop()!;
      for (const entry of await readdir(current.directory, { withFileTypes: true })) {
        const relativePath = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
        if (!safeSourcePath(relativePath)) {
          return sourceWorkflowTrustFailure("source_object_invalid", `source object ${sourceDigest} contains unsafe path ${relativePath}`);
        }
        const path = join(current.directory, entry.name);
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
          return sourceWorkflowTrustFailure("source_object_invalid", `source object ${sourceDigest} contains symlink ${relativePath}`);
        }
        if (metadata.isDirectory()) {
          if (!expected.directories.has(relativePath) || foundDirectories.has(relativePath)) {
            return sourceWorkflowTrustFailure("source_object_invalid", `source object ${sourceDigest} contains unmanifested directory ${relativePath}`);
          }
          foundDirectories.add(relativePath);
          pending.push({ directory: path, prefix: relativePath });
          continue;
        }
        if (!metadata.isFile()) {
          return sourceWorkflowTrustFailure("source_object_invalid", `source object ${sourceDigest} contains unsupported entry ${relativePath}`);
        }
        const expectedFile = expected.files.get(relativePath);
        if (!expectedFile || foundFiles.has(relativePath) || metadata.size !== expectedFile.bytes) {
          return sourceWorkflowTrustFailure("source_object_invalid", `source file ${relativePath} does not match its manifest`);
        }
        if (process.platform !== "win32" && Boolean(metadata.mode & 0o111) !== (expectedFile.mode === 0o100755)) {
          return sourceWorkflowTrustFailure("source_object_invalid", `source file ${relativePath} does not match its manifest mode`);
        }
        const bytes = await readInspectedFile(path, metadata, `source file ${relativePath}`);
        filesByPath.set(relativePath, { path: relativePath, mode: expectedFile.mode, bytes });
        foundFiles.add(relativePath);
      }
    }
    if (foundFiles.size !== expected.files.size || foundDirectories.size !== expected.directories.size) {
      return sourceWorkflowTrustFailure("source_object_invalid", `source object ${sourceDigest} does not exactly match its manifest`);
    }
    const files = manifest.files.map((entry) => filesByPath.get(entry.path)!);
    const actual = buildSourceManifest(files);
    if (canonicalJsonDigest(actual) !== canonicalJsonDigest(manifest) || actual.source_digest !== sourceDigest) {
      return sourceWorkflowTrustFailure("source_object_invalid", `source object ${sourceDigest} failed exact content verification`);
    }
    return { manifest: actual, files };
  } catch (error) {
    if (error instanceof SourceWorkflowTrustError) throw error;
    return sourceWorkflowTrustFailure("source_object_invalid", `source object ${sourceDigest} could not be verified: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

/**
 * Publish an immutable, content-addressed source tree. An existing identity is
 * reused only after the same exact verification readers and runners require.
 */
export async function persistSourceObject(
  root: string,
  manifest: SourceManifest,
  files: readonly FrozenSourceFile[],
) {
  const calculated = buildSourceManifest(files);
  if (canonicalJsonDigest(calculated) !== canonicalJsonDigest(manifest)) {
    sourceWorkflowTrustFailure("source_object_invalid", "source manifest does not describe the supplied source files");
  }
  const objects = await ensurePrivateDirectory(root, ".somite/source-workflows/objects");
  const identity = manifest.source_digest.slice("blake3:".length);
  const destination = join(objects, identity);
  if (await pathExists(destination)) {
    await readSourceObject(root, manifest.source_digest);
    return { cached: true } as const;
  }
  const temporary = join(objects, `.incoming-${identity}-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  await mkdir(join(temporary, "source"), { mode: 0o700 });
  try {
    for (const file of files) {
      const path = containedPath(join(temporary, "source"), file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { flag: "wx", mode: file.mode === 0o100755 ? 0o755 : 0o644 });
      if (file.mode === 0o100755) await chmod(path, 0o755);
    }
    await writeFile(join(temporary, "source-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if ((code === "EEXIST" || code === "ENOTEMPTY") && await pathExists(destination)) {
      await readSourceObject(root, manifest.source_digest);
      return { cached: true } as const;
    }
    throw error;
  }
  await readSourceObject(root, manifest.source_digest);
  return { cached: false } as const;
}
