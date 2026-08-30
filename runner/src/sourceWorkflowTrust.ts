import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OperatorCatalog, ParamSpec } from "@somite/workflow/catalog";
import { canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import type {
  SomiteGraph,
  SourceWorkflowInstance,
  WorkflowBinding,
} from "@somite/workflow/model";
import {
  buildSourceManifest,
  safeSourcePath,
  type FrozenSourceFile,
  type SourceManifest,
} from "@somite/workflow/nextflowSource";
import { deriveSourceWorkflow, sourceWorkflowRevision } from "@somite/workflow/sourceWorkflow";
import { validateSourceWorkflow } from "@somite/workflow/workflow";

import { regularDirectory, regularFile } from "./files.ts";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type SourceWorkflowTrustCode =
  | "source_object_invalid"
  | "workflow_revision_invalid"
  | "source_derivation_mismatch"
  | "binding_invalid"
  | "replacement_invalid";

/** A source-workflow failure at a runner trust boundary, safe to return as 422. */
export class SourceWorkflowTrustError extends Error {
  readonly code: SourceWorkflowTrustCode;

  constructor(code: SourceWorkflowTrustCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SourceWorkflowTrustError";
    this.code = code;
  }
}

function trustFailure(code: SourceWorkflowTrustCode, message: string, cause?: unknown): never {
  throw new SourceWorkflowTrustError(code, message, cause);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseManifest(bytes: Uint8Array, expectedDigest: string): SourceManifest {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    return trustFailure("source_object_invalid", `source object ${expectedDigest} has an invalid manifest`, error);
  }
  if (!isObject(value) || value.schema_version !== 1 || value.source_digest !== expectedDigest
    || !Number.isSafeInteger(value.source_bytes) || (value.source_bytes as number) < 0 || !Array.isArray(value.files)) {
    return trustFailure("source_object_invalid", `source object ${expectedDigest} has an invalid manifest contract`);
  }
  for (const entry of value.files) {
    if (!isObject(entry) || typeof entry.path !== "string" || !safeSourcePath(entry.path)
      || (entry.mode !== 0o100644 && entry.mode !== 0o100755)
      || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0
      || typeof entry.digest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(entry.digest)) {
      return trustFailure("source_object_invalid", `source object ${expectedDigest} has an invalid manifest entry`);
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
      return trustFailure("source_object_invalid", `${label} changed between inspection and open`);
    }
    const bytes = await handle.readFile();
    const confirmed = await handle.stat();
    if (bytes.byteLength !== inspected.size || !sameFileIdentity(opened, confirmed)) {
      return trustFailure("source_object_invalid", `${label} changed while it was read`);
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
  if (canonical !== resolve(path)) trustFailure("source_object_invalid", `${label} must not cross a symbolic link`);
  return path;
}

/** Read and content-verify one immutable source object without creating store paths. */
export async function readSourceObject(root: string, sourceDigest: string) {
  if (!/^blake3:[0-9a-f]{64}$/.test(sourceDigest)) {
    return trustFailure("source_object_invalid", "source digest is malformed");
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
      return trustFailure("source_object_invalid", `source object ${sourceDigest} contains unmanifested entries`);
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
          return trustFailure("source_object_invalid", `source object ${sourceDigest} contains unsafe path ${relativePath}`);
        }
        const path = join(current.directory, entry.name);
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
          return trustFailure("source_object_invalid", `source object ${sourceDigest} contains symlink ${relativePath}`);
        }
        if (metadata.isDirectory()) {
          if (!expected.directories.has(relativePath) || foundDirectories.has(relativePath)) {
            return trustFailure("source_object_invalid", `source object ${sourceDigest} contains unmanifested directory ${relativePath}`);
          }
          foundDirectories.add(relativePath);
          pending.push({ directory: path, prefix: relativePath });
          continue;
        }
        if (!metadata.isFile()) {
          return trustFailure("source_object_invalid", `source object ${sourceDigest} contains unsupported entry ${relativePath}`);
        }
        const expectedFile = expected.files.get(relativePath);
        if (!expectedFile || foundFiles.has(relativePath) || metadata.size !== expectedFile.bytes) {
          return trustFailure("source_object_invalid", `source file ${relativePath} does not match its manifest`);
        }
        if (process.platform !== "win32" && Boolean(metadata.mode & 0o111) !== (expectedFile.mode === 0o100755)) {
          return trustFailure("source_object_invalid", `source file ${relativePath} does not match its manifest mode`);
        }
        const bytes = await readInspectedFile(path, metadata, `source file ${relativePath}`);
        filesByPath.set(relativePath, { path: relativePath, mode: expectedFile.mode, bytes });
        foundFiles.add(relativePath);
      }
    }
    if (foundFiles.size !== expected.files.size || foundDirectories.size !== expected.directories.size) {
      return trustFailure("source_object_invalid", `source object ${sourceDigest} does not exactly match its manifest`);
    }
    const files = manifest.files.map((entry) => filesByPath.get(entry.path)!);
    const actual = buildSourceManifest(files);
    if (canonicalJsonDigest(actual) !== canonicalJsonDigest(manifest) || actual.source_digest !== sourceDigest) {
      return trustFailure("source_object_invalid", `source object ${sourceDigest} failed exact content verification`);
    }
    return { manifest: actual, files };
  } catch (error) {
    if (error instanceof SourceWorkflowTrustError) throw error;
    return trustFailure("source_object_invalid", `source object ${sourceDigest} could not be verified: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

function immutableProjection(workflow: SourceWorkflowInstance) {
  return {
    schema_version: workflow.schema_version,
    source: workflow.source,
    profiles: workflow.profiles ?? [],
    parameters: workflow.parameters ?? [],
    unsupported_required_parameters: workflow.unsupported_required_parameters ?? [],
    scopes: workflow.scopes ?? [],
    invocations: workflow.invocations ?? [],
    capabilities: workflow.capabilities,
    diagnostics: workflow.diagnostics ?? [],
  };
}

function pathInside(root: string, path: string) {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function verifyProjectPath(root: string, parameter: string, binding: Extract<WorkflowBinding, { path: string }>) {
  if (!safeSourcePath(binding.path)) {
    return trustFailure("binding_invalid", `source parameter ${parameter} project path must be safe and relative`);
  }
  const kind = binding.kind === "project_file" ? "file" : "directory";
  let current = root;
  const components = binding.path.split("/");
  try {
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        return trustFailure("binding_invalid", `source parameter ${parameter} project ${kind} ${binding.path} crosses a symlink`);
      }
      const final = index + 1 === components.length;
      if (!final && !metadata.isDirectory()) {
        return trustFailure("binding_invalid", `source parameter ${parameter} project ${kind} ${binding.path} crosses a non-directory component`);
      }
      if (final && (kind === "file" ? !metadata.isFile() : !metadata.isDirectory())) {
        return trustFailure("binding_invalid", `source parameter ${parameter} project ${kind} ${binding.path} has the wrong file type`);
      }
    }
    const canonical = await realpath(current);
    if (canonical !== resolve(current) || !pathInside(root, canonical)) {
      return trustFailure("binding_invalid", `source parameter ${parameter} project ${kind} ${binding.path} must remain inside the canonical project without symlinks`);
    }
  } catch (error) {
    if (error instanceof SourceWorkflowTrustError) throw error;
    return trustFailure("binding_invalid", `source parameter ${parameter} project ${kind} ${binding.path} is not available: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

function validReplacementValue(spec: ParamSpec, value: unknown) {
  if (spec.type === "string") return typeof value === "string";
  if (spec.type === "bool") return typeof value === "boolean";
  if (spec.type === "int") {
    return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)
      && (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max);
  }
  if (spec.type === "float") {
    return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)
      && (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max);
  }
  return false;
}

async function verifyMutableOverlay(root: string, catalog: OperatorCatalog, workflow: SourceWorkflowInstance) {
  const canonicalRoot = await realpath(root);
  if ((Object.keys(workflow.bindings ?? {}).length > 0) && !workflow.capabilities.parameter_edits) {
    return trustFailure("binding_invalid", "source workflow does not permit parameter bindings");
  }
  for (const [parameter, binding] of Object.entries(workflow.bindings ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (binding.kind !== "literal") await verifyProjectPath(canonicalRoot, parameter, binding);
  }

  const invocations = new Set((workflow.invocations ?? []).map((invocation) => invocation.id));
  const replaced = new Set<string>();
  for (const replacement of workflow.replacements ?? []) {
    if (!invocations.has(replacement.invocation_id) || replaced.has(replacement.invocation_id)) {
      return trustFailure("replacement_invalid", `source replacement ${replacement.invocation_id} does not identify one canonical invocation`);
    }
    replaced.add(replacement.invocation_id);
    const operator = catalog.get(replacement.operator);
    if (!operator || operator.revision !== replacement.operator_revision) {
      return trustFailure("replacement_invalid", `source replacement ${replacement.invocation_id} does not pin a catalog operator revision`);
    }
    if ((operator.kind !== "external" && operator.kind !== "inprocess")
      || operator.id.startsWith("nf.") || operator.id.startsWith("smk.")) {
      return trustFailure("replacement_invalid", `source replacement ${replacement.invocation_id} must use an executable leaf operator`);
    }
    for (const [name, value] of Object.entries(replacement.params ?? {})) {
      const spec = operator.params[name];
      if (!spec) {
        return trustFailure("replacement_invalid", `source replacement ${replacement.invocation_id} has unknown parameter ${name}`);
      }
      if (!validReplacementValue(spec, value)) {
        return trustFailure("replacement_invalid", `source replacement ${replacement.invocation_id} parameter ${name} violates its catalog contract`);
      }
    }
  }
}

async function verifyWorkflow(
  root: string,
  catalog: OperatorCatalog,
  workflow: SourceWorkflowInstance,
  readObject: (digest: string) => Promise<Awaited<ReturnType<typeof readSourceObject>>>,
) {
  const contractIssue = validateSourceWorkflow(workflow);
  if (contractIssue) trustFailure("source_derivation_mismatch", `source workflow contract is invalid: ${contractIssue}`);
  let calculatedRevision: string;
  try {
    calculatedRevision = sourceWorkflowRevision(workflow);
  } catch (error) {
    return trustFailure("workflow_revision_invalid", "source workflow revision could not be calculated", error);
  }
  if (calculatedRevision !== workflow.workflow_revision) {
    return trustFailure("workflow_revision_invalid", `source workflow ${workflow.workflow_revision} has a stale or forged workflow revision`);
  }
  const { files } = await readObject(workflow.source.source_digest);
  let canonical: SourceWorkflowInstance;
  try {
    canonical = deriveSourceWorkflow(files, {
      provider: workflow.source.provider,
      repository: workflow.source.repository,
      requested_revision: workflow.source.requested_revision,
      resolved_revision: workflow.source.resolved_revision,
      entrypoint: workflow.source.entrypoint,
    }).workflow;
  } catch (error) {
    return trustFailure("source_derivation_mismatch", `source workflow ${workflow.workflow_revision} could not be reindexed from its frozen source`, error);
  }
  if (canonicalJsonDigest(immutableProjection(canonical)) !== canonicalJsonDigest(immutableProjection(workflow))) {
    return trustFailure(
      "source_derivation_mismatch",
      `source workflow ${workflow.workflow_revision} immutable source-derived fields or capabilities do not match its exact frozen source`,
    );
  }
  await verifyMutableOverlay(root, catalog, workflow);
}

/**
 * Prove every source-backed node from immutable project bytes, then validate
 * the only mutable state Somite permits: typed bindings and leaf replacements.
 */
export async function verifyGraphSourceWorkflowTrust(root: string, catalog: OperatorCatalog, graph: SomiteGraph) {
  const objectReads = new Map<string, Promise<Awaited<ReturnType<typeof readSourceObject>>>>();
  const readObject = (digest: string) => {
    let read = objectReads.get(digest);
    if (!read) {
      read = readSourceObject(root, digest);
      objectReads.set(digest, read);
    }
    return read;
  };
  for (const node of [
    ...graph.nodes,
    ...(graph.variant_origin ? [graph.variant_origin.source_node] : []),
  ]) {
    if (!node.source_workflow) continue;
    try {
      await verifyWorkflow(root, catalog, node.source_workflow, readObject);
    } catch (error) {
      if (error instanceof SourceWorkflowTrustError) {
        throw new SourceWorkflowTrustError(error.code, `source node ${node.id} failed trust verification: ${error.message}`, error);
      }
      throw error;
    }
  }
}
