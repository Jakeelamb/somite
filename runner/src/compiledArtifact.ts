import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { byteDigest, canonicalJsonDigest, createByteDigester } from "@somite/workflow/contentIdentity";
import { MAX_FROZEN_PACKAGE_BYTES } from "@somite/workflow/limits";
import { safeSourcePath } from "@somite/workflow/nextflowSource";

const DIGEST = /^blake3:[a-f0-9]{64}$/;
export const MAX_AGENT_ARTIFACT_ENTRIES = 100_000;
const MAX_ARTIFACT_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_RUN_CLOSURE_BYTES = 1024 * 1024;

export type CompiledArtifactFile = Readonly<{
  path: string;
  bytes: number;
  digest: string;
  mode: 0o644 | 0o755;
}>;

export type CompiledArtifactManifest = Readonly<{
  schema_version: 1;
  closure_digest: string;
  compiled_graph_revision: string;
  files: readonly CompiledArtifactFile[];
  manifest_digest: string;
}>;

export type CompiledWorkflowArtifact = Readonly<{
  source_graph_revision: string;
  closure_digest: string;
  compiled_graph_revision: string;
  output_path: string;
  reused: boolean;
}>;

export type TrustedCompiledWorkflowArtifact = CompiledWorkflowArtifact & Readonly<{
  artifact_manifest: CompiledArtifactManifest;
}>;

export type CompiledArtifactSourceFile = Readonly<{
  path: string;
  bytes: Uint8Array;
  mode: 0o644 | 0o755;
}>;

export class CompiledArtifactIntegrityError extends Error {
  readonly code = "compiled_artifact_integrity_failed";

  constructor(message: string) {
    super(`compiled artifact integrity check failed: ${message}`);
    this.name = "CompiledArtifactIntegrityError";
  }
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestBase(
  closureDigest: string,
  compiledGraphRevision: string,
  files: readonly CompiledArtifactFile[],
) {
  return {
    schema_version: 1 as const,
    closure_digest: closureDigest,
    compiled_graph_revision: compiledGraphRevision,
    files,
  };
}

export function createCompiledArtifactManifest(
  closureDigest: string,
  compiledGraphRevision: string,
  sourceFiles: readonly CompiledArtifactSourceFile[],
): CompiledArtifactManifest {
  const files = sourceFiles.map((file) => ({
    path: file.path,
    bytes: file.bytes.byteLength,
    digest: byteDigest(file.bytes),
    mode: file.mode,
  })).sort((left, right) => compareText(left.path, right.path));
  const base = manifestBase(closureDigest, compiledGraphRevision, files);
  const manifest = { ...base, manifest_digest: canonicalJsonDigest(base) };
  if (!validatedCompiledArtifactManifest(manifest, closureDigest, compiledGraphRevision)) {
    throw new Error("compiled artifact files cannot form a canonical trusted manifest");
  }
  return manifest;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]) {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...fields].sort(compareText);
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

/** Runtime-validate the trusted compile-to-lease handoff before touching disk. */
export function validatedCompiledArtifactManifest(
  value: unknown,
  expectedClosureDigest: string,
  expectedGraphRevision: string,
): CompiledArtifactManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const manifest = value as Record<string, unknown>;
  if (!exactFields(manifest, ["schema_version", "closure_digest", "compiled_graph_revision", "files", "manifest_digest"])
    || manifest.schema_version !== 1
    || manifest.closure_digest !== expectedClosureDigest
    || manifest.compiled_graph_revision !== expectedGraphRevision
    || typeof manifest.manifest_digest !== "string" || !DIGEST.test(manifest.manifest_digest)
    || !Array.isArray(manifest.files) || manifest.files.length < 1
    || manifest.files.length > MAX_AGENT_ARTIFACT_ENTRIES) return undefined;

  const files: CompiledArtifactFile[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const item of manifest.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const file = item as Record<string, unknown>;
    if (!exactFields(file, ["path", "bytes", "digest", "mode"])
      || typeof file.path !== "string" || !safeSourcePath(file.path) || paths.has(file.path)
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0
      || typeof file.digest !== "string" || !DIGEST.test(file.digest)
      || (file.mode !== 0o644 && file.mode !== 0o755)) return undefined;
    totalBytes += file.bytes as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_FROZEN_PACKAGE_BYTES) return undefined;
    paths.add(file.path);
    files.push({
      path: file.path,
      bytes: file.bytes as number,
      digest: file.digest,
      mode: file.mode,
    });
  }
  const sorted = [...files].sort((left, right) => compareText(left.path, right.path));
  if (sorted.some((file, index) => file.path !== files[index]?.path)) return undefined;
  const closurePaths = ["run-closure.json", ".somite/run/run-closure.json"].filter((path) => paths.has(path));
  if (closurePaths.length !== 1) return undefined;
  const base = manifestBase(expectedClosureDigest, expectedGraphRevision, files);
  if (canonicalJsonDigest(base) !== manifest.manifest_digest) return undefined;
  return { ...base, manifest_digest: manifest.manifest_digest };
}

type ArtifactScan = Readonly<{
  root: Stats;
  canonicalRoot: string;
  files: ReadonlyMap<string, Stats>;
  directories: ReadonlyMap<string, Stats>;
  bytes: number;
}>;

function integrityFailure(message: string): never {
  throw new CompiledArtifactIntegrityError(message);
}

function sameFileIdentity(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function scanArtifactDirectory(root: string): Promise<ArtifactScan> {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    return integrityFailure("artifact root must be a regular directory");
  }
  const canonicalRoot = await realpath(root);
  const files = new Map<string, Stats>();
  const directories = new Map<string, Stats>();
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: "" }];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    for await (const entry of await opendir(current.absolute)) {
      const name = entry.name;
      entries += 1;
      if (entries > MAX_AGENT_ARTIFACT_ENTRIES) {
        return integrityFailure(`artifact contains more than ${MAX_AGENT_ARTIFACT_ENTRIES} entries`);
      }
      const relativePath = current.relative ? `${current.relative}/${name}` : name;
      const absolutePath = join(current.absolute, name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) return integrityFailure(`entry ${JSON.stringify(relativePath)} is a symbolic link`);
      if (metadata.isDirectory()) {
        directories.set(relativePath, metadata);
        pending.push({ absolute: absolutePath, relative: relativePath });
        continue;
      }
      if (!metadata.isFile()) return integrityFailure(`entry ${JSON.stringify(relativePath)} is not a regular file or directory`);
      if (metadata.nlink !== 1) return integrityFailure(`file ${JSON.stringify(relativePath)} is a hard link`);
      bytes += metadata.size;
      if (!Number.isSafeInteger(bytes) || bytes > MAX_FROZEN_PACKAGE_BYTES) {
        return integrityFailure(`artifact bytes exceed ${MAX_FROZEN_PACKAGE_BYTES}`);
      }
      files.set(relativePath, metadata);
    }
  }
  return { root: rootMetadata, canonicalRoot, files, directories, bytes };
}

function expectedArtifactDirectories(files: readonly CompiledArtifactFile[]) {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  return directories;
}

function assertExactArtifactInventory(scan: ArtifactScan, manifest: CompiledArtifactManifest) {
  const expectedFiles = new Set(manifest.files.map((file) => file.path));
  const expectedDirectories = expectedArtifactDirectories(manifest.files);
  for (const path of scan.files.keys()) {
    if (!expectedFiles.has(path)) return integrityFailure(`unexpected file ${JSON.stringify(path)}`);
  }
  for (const path of expectedFiles) {
    if (!scan.files.has(path)) return integrityFailure(`manifest file ${JSON.stringify(path)} is missing`);
  }
  for (const path of scan.directories.keys()) {
    if (!expectedDirectories.has(path)) return integrityFailure(`unexpected directory ${JSON.stringify(path)}`);
  }
  for (const path of expectedDirectories) {
    if (!scan.directories.has(path)) return integrityFailure(`manifest directory ${JSON.stringify(path)} is missing`);
  }
  const expectedBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  if (scan.bytes !== expectedBytes) {
    return integrityFailure(`artifact has ${scan.bytes} bytes; manifest requires ${expectedBytes}`);
  }
}

async function verifyArtifactFile(
  root: string,
  canonicalRoot: string,
  expected: CompiledArtifactFile,
  inspected: Stats,
  capture: boolean,
) {
  if (inspected.size !== expected.bytes) {
    return integrityFailure(`file ${JSON.stringify(expected.path)} has ${inspected.size} bytes; manifest requires ${expected.bytes}`);
  }
  if ((inspected.mode & 0o777) !== expected.mode) {
    return integrityFailure(`file ${JSON.stringify(expected.path)} mode does not match its manifest`);
  }
  if (inspected.nlink !== 1) return integrityFailure(`file ${JSON.stringify(expected.path)} is a hard link`);
  const path = join(root, expected.path);
  if (await realpath(path) !== resolve(canonicalRoot, expected.path)) {
    return integrityFailure(`file ${JSON.stringify(expected.path)} crosses a symbolic link`);
  }
  if (capture && expected.bytes > MAX_RUN_CLOSURE_BYTES) {
    return integrityFailure(`run closure exceeds ${MAX_RUN_CLOSURE_BYTES} bytes`);
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(inspected, opened)) {
      return integrityFailure(`file ${JSON.stringify(expected.path)} changed between inspection and open`);
    }
    const digester = createByteDigester();
    const chunk = new Uint8Array(Math.min(MAX_ARTIFACT_READ_CHUNK_BYTES, Math.max(1, expected.bytes)));
    const captured = capture ? new Uint8Array(expected.bytes) : undefined;
    let offset = 0;
    while (offset < expected.bytes) {
      const requested = Math.min(chunk.byteLength, expected.bytes - offset);
      const { bytesRead } = await handle.read(chunk, 0, requested, offset);
      if (bytesRead < 1) return integrityFailure(`file ${JSON.stringify(expected.path)} ended before ${expected.bytes} bytes`);
      const bytes = chunk.subarray(0, bytesRead);
      digester.update(bytes);
      captured?.set(bytes, offset);
      offset += bytesRead;
    }
    const confirmed = await handle.stat();
    if (!sameFileIdentity(opened, confirmed)) {
      return integrityFailure(`file ${JSON.stringify(expected.path)} changed while it was read`);
    }
    if (digester.digest() !== expected.digest) {
      return integrityFailure(`file ${JSON.stringify(expected.path)} digest does not match its manifest`);
    }
    const stillLinked = await lstat(path);
    if (!sameFileIdentity(confirmed, stillLinked)) {
      return integrityFailure(`file ${JSON.stringify(expected.path)} changed after it was read`);
    }
    return captured;
  } finally {
    await handle.close();
  }
}

function assertRunClosureIdentity(
  bytes: Uint8Array,
  manifest: CompiledArtifactManifest,
) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return integrityFailure("run closure identity is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return integrityFailure("run closure identity is invalid");
  }
  const closure = value as Record<string, unknown>;
  if (closure.schema_version !== 1
    || closure.closure_digest !== manifest.closure_digest
    || closure.graph_revision !== manifest.compiled_graph_revision) {
    return integrityFailure("run closure identity does not match the compiled artifact manifest");
  }
}

function assertStableArtifactScan(before: ArtifactScan, after: ArtifactScan) {
  if (!sameFileIdentity(before.root, after.root) || before.canonicalRoot !== after.canonicalRoot) {
    return integrityFailure("artifact root changed while it was verified");
  }
  for (const [path, metadata] of before.files) {
    const confirmed = after.files.get(path);
    if (!confirmed || !sameFileIdentity(metadata, confirmed)) {
      return integrityFailure(`file ${JSON.stringify(path)} changed while the artifact was verified`);
    }
  }
  for (const [path, metadata] of before.directories) {
    const confirmed = after.directories.get(path);
    if (!confirmed || !sameFileIdentity(metadata, confirmed)) {
      return integrityFailure(`directory ${JSON.stringify(path)} changed while the artifact was verified`);
    }
  }
}

/** Verify that a reusable compiled directory is exactly the immutable artifact described by its manifest. */
export async function verifyCompiledArtifactDirectory(
  root: string,
  value: CompiledArtifactManifest,
): Promise<CompiledArtifactManifest> {
  const manifest = validatedCompiledArtifactManifest(value, value.closure_digest, value.compiled_graph_revision);
  if (!manifest) return integrityFailure("manifest is invalid");
  try {
    const before = await scanArtifactDirectory(root);
    assertExactArtifactInventory(before, manifest);
    const closurePath = manifest.files.find((file) => file.path === "run-closure.json"
      || file.path === ".somite/run/run-closure.json")!;
    let closureBytes: Uint8Array | undefined;
    for (const expected of manifest.files) {
      const captured = await verifyArtifactFile(
        root,
        before.canonicalRoot,
        expected,
        before.files.get(expected.path)!,
        expected.path === closurePath.path,
      );
      if (expected.path === closurePath.path) closureBytes = captured;
    }
    if (!closureBytes) return integrityFailure("run closure is missing");
    assertRunClosureIdentity(closureBytes, manifest);
    const after = await scanArtifactDirectory(root);
    assertExactArtifactInventory(after, manifest);
    assertStableArtifactScan(before, after);
    return manifest;
  } catch (error) {
    if (error instanceof CompiledArtifactIntegrityError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CompiledArtifactIntegrityError(`artifact could not be verified: ${detail}`);
  }
}
