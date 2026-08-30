import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OperatorCatalog, ParamSpec } from "@somite/workflow/catalog";
import { canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import type {
  SomiteGraph,
  SourceWorkflowInstance,
  WorkflowBinding,
} from "@somite/workflow/model";
import { safeSourcePath } from "@somite/workflow/nextflowSource";
import { deriveSourceWorkflow, sourceWorkflowRevision } from "@somite/workflow/sourceWorkflow";
import { validateSourceWorkflow } from "@somite/workflow/workflow";

import {
  SourceWorkflowTrustError,
  sourceWorkflowTrustFailure,
  type SourceWorkflowTrustCode,
} from "./sourceWorkflowErrors.ts";
import { readSourceObject } from "./sourceWorkflowStore.ts";

export { SourceWorkflowTrustError, type SourceWorkflowTrustCode } from "./sourceWorkflowErrors.ts";
export { readSourceObject } from "./sourceWorkflowStore.ts";

function trustFailure(code: SourceWorkflowTrustCode, message: string, cause?: unknown): never {
  return sourceWorkflowTrustFailure(code, message, cause);
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
