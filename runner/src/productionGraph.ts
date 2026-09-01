import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { OperatorCatalog } from "@somite/workflow/catalog";
import { managedResourceReferenceId } from "@somite/workflow/assessment";
import type { SomiteGraph, WorkflowBinding } from "@somite/workflow/model";
import { operatorImportPaths } from "@somite/workflow/nextflow";

export type ProductionInputErrorCode =
  | "input_path_invalid"
  | "input_path_missing"
  | "input_path_not_portable"
  | "input_path_unsafe"
  | "input_path_type";

export class ProductionInputError extends Error {
  readonly code: ProductionInputErrorCode;

  constructor(code: ProductionInputErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProductionInputError";
    this.code = code;
  }
}

export type GraphInputLocation = Readonly<{
  graphBase: string;
  relativeInputOrder: "project_first" | "graph_first";
}>;

export type ManagedResourceResolver = (reference: string) => Promise<string>;

function inside(root: string, path: string) {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function remoteIdentity(value: string) {
  return /^(?:https?|ftp|s3|gs|az):\/\/[^\s]+$/i.test(value);
}

async function canonicalDirectory(path: string, label: string) {
  let canonical: string;
  try {
    canonical = await realpath(path);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a regular directory");
  } catch (error) {
    throw new ProductionInputError("input_path_invalid", `${label} is not an available regular directory`, error);
  }
  return canonical;
}

async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function resolveInputPath(
  value: string,
  expected: "file" | "directory",
  projectRoot: string,
  graphBase: string,
  relativeInputOrder: GraphInputLocation["relativeInputOrder"],
  label: string,
  managedResourceResolver?: ManagedResourceResolver,
) {
  if (!value || value.length > 4096 || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0 || code < 32 || code === 127;
  })) throw new ProductionInputError("input_path_invalid", `${label} is not a bounded printable path`);
  if (remoteIdentity(value)) return value;
  if (managedResourceReferenceId(value)) {
    if (expected !== "directory") throw new ProductionInputError("input_path_type", `${label} uses a managed resource where a file is required`);
    if (!managedResourceResolver) throw new ProductionInputError("input_path_missing", `${label} requires ${value}, but no managed resource store is attached`);
    return resolveInputPath(
      await managedResourceResolver(value),
      expected,
      projectRoot,
      graphBase,
      relativeInputOrder,
      label,
    );
  }

  let candidates: string[];
  if (isAbsolute(value)) candidates = [resolve(value)];
  else {
    const projectCandidate = resolve(projectRoot, value);
    const graphCandidate = resolve(graphBase, value);
    const ordered = relativeInputOrder === "graph_first"
      ? [{ candidate: graphCandidate, root: graphBase }, { candidate: projectCandidate, root: projectRoot }]
      : [{ candidate: projectCandidate, root: projectRoot }, { candidate: graphCandidate, root: graphBase }];
    candidates = ordered
      .filter(({ candidate, root }) => inside(root, candidate))
      .map(({ candidate }) => candidate)
      .filter((candidate, index, all) => all.indexOf(candidate) === index);
    if (!candidates.length) throw new ProductionInputError("input_path_unsafe", `${label} escapes its project and graph directories`);
  }

  let selected: string | undefined;
  let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const candidate of candidates) {
    const inspected = await existing(candidate);
    if (!inspected) continue;
    selected = candidate;
    metadata = inspected;
    break;
  }
  if (!selected || !metadata) throw new ProductionInputError("input_path_missing", `${label} does not exist: ${value}`);
  if (metadata.isSymbolicLink()) throw new ProductionInputError("input_path_unsafe", `${label} must not be a symbolic link`);
  let canonical: string;
  try {
    canonical = await realpath(selected);
  } catch (error) {
    throw new ProductionInputError("input_path_missing", `${label} is unavailable: ${value}`, error);
  }
  if (canonical !== resolve(selected)) throw new ProductionInputError("input_path_unsafe", `${label} must not cross a symbolic link`);
  if (expected === "file" ? !metadata.isFile() : !metadata.isDirectory()) {
    throw new ProductionInputError("input_path_type", `${label} must be a regular ${expected}`);
  }
  return canonical;
}

async function materializeBinding(
  binding: WorkflowBinding,
  projectRoot: string,
  graphBase: string,
  relativeInputOrder: GraphInputLocation["relativeInputOrder"],
  label: string,
  portable: boolean,
): Promise<WorkflowBinding> {
  if (binding.kind === "literal") return binding;
  const resolved = await resolveInputPath(
    binding.path,
    binding.kind === "project_directory" ? "directory" : "file",
    projectRoot,
    graphBase,
    relativeInputOrder,
    label,
  );
  return {
    ...binding,
    path: portable ? portableInputPath(resolved, projectRoot, label) : resolved,
  };
}

function portableInputPath(resolved: string, projectRoot: string, label: string) {
  if (remoteIdentity(resolved)) return resolved;
  if (!inside(projectRoot, resolved)) {
    throw new ProductionInputError(
      "input_path_not_portable",
      `${label} resolves outside the project; move it into the project before compiling or exporting a shared workflow`,
    );
  }
  const projectRelative = relative(projectRoot, resolved);
  if (!projectRelative) {
    throw new ProductionInputError("input_path_not_portable", `${label} cannot bind the project root as a portable input`);
  }
  return projectRelative.split(sep).join("/");
}

async function materializeGraph(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  projectRootValue: string,
  graphLocation: string | GraphInputLocation,
  managedResourceResolver: ManagedResourceResolver | undefined,
  portable: boolean,
) {
  const graphBaseValue = typeof graphLocation === "string" ? graphLocation : graphLocation.graphBase;
  const relativeInputOrder = typeof graphLocation === "string" ? "project_first" : graphLocation.relativeInputOrder;
  const [projectRoot, graphBase] = await Promise.all([
    canonicalDirectory(projectRootValue, "project root"),
    canonicalDirectory(graphBaseValue, "workflow graph directory"),
  ]);
  const materialized = structuredClone(graph);
  for (const node of materialized.nodes) {
    const operator = catalog.get(node.operator);
    if (!operator) continue;
    for (const contract of operatorImportPaths(operator)) {
      const value = node.params?.[contract.parameter];
      if (typeof value !== "string") continue;
      node.params ??= {};
      const resolved = await resolveInputPath(
        value,
        contract.kind,
        projectRoot,
        graphBase,
        relativeInputOrder,
        `${operator.title} ${contract.parameter}`,
        managedResourceResolver,
      );
      node.params[contract.parameter] = portable
        ? portableInputPath(resolved, projectRoot, `${operator.title} ${contract.parameter}`)
        : resolved;
    }
    if (!node.source_workflow?.bindings) continue;
    const bindings: Record<string, WorkflowBinding> = {};
    for (const [name, binding] of Object.entries(node.source_workflow.bindings)) {
      bindings[name] = await materializeBinding(
        binding,
        projectRoot,
        graphBase,
        relativeInputOrder,
        `${operator.title} ${name}`,
        portable,
      );
    }
    node.source_workflow.bindings = bindings;
  }
  return materialized;
}

/** Resolve executable local inputs on a clone while leaving the saved canvas portable. */
export async function materializeProductionGraph(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  projectRootValue: string,
  graphLocation: string | GraphInputLocation = projectRootValue,
  managedResourceResolver?: ManagedResourceResolver,
) {
  return materializeGraph(graph, catalog, projectRootValue, graphLocation, managedResourceResolver, false);
}

/** Verify local inputs while retaining only project-relative paths for sharing. */
export async function materializePortableProductionGraph(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  projectRootValue: string,
  graphLocation: string | GraphInputLocation = projectRootValue,
  managedResourceResolver?: ManagedResourceResolver,
) {
  return materializeGraph(graph, catalog, projectRootValue, graphLocation, managedResourceResolver, true);
}
