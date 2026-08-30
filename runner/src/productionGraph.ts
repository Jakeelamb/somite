import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { OperatorCatalog } from "@somite/workflow/catalog";
import type { SomiteGraph, WorkflowBinding } from "@somite/workflow/model";
import { operatorImportPaths } from "@somite/workflow/nextflow";

export type ProductionInputErrorCode =
  | "input_path_invalid"
  | "input_path_missing"
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
  label: string,
) {
  if (!value || value.length > 4096 || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0 || code < 32 || code === 127;
  })) throw new ProductionInputError("input_path_invalid", `${label} is not a bounded printable path`);
  if (remoteIdentity(value)) return value;

  let candidates: string[];
  if (isAbsolute(value)) candidates = [resolve(value)];
  else {
    const projectCandidate = resolve(projectRoot, value);
    const graphCandidate = resolve(graphBase, value);
    candidates = [projectCandidate, graphCandidate]
      .filter((candidate, index, all) => inside(index === 0 ? projectRoot : graphBase, candidate) && all.indexOf(candidate) === index);
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
  label: string,
): Promise<WorkflowBinding> {
  if (binding.kind === "literal") return binding;
  return {
    ...binding,
    path: await resolveInputPath(
      binding.path,
      binding.kind === "project_directory" ? "directory" : "file",
      projectRoot,
      graphBase,
      label,
    ),
  };
}

/** Resolve executable local inputs on a clone while leaving the saved canvas portable. */
export async function materializeProductionGraph(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  projectRootValue: string,
  graphBaseValue = projectRootValue,
) {
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
      node.params[contract.parameter] = await resolveInputPath(
        value,
        contract.kind,
        projectRoot,
        graphBase,
        `${operator.title} ${contract.parameter}`,
      );
    }
    if (!node.source_workflow?.bindings) continue;
    const bindings: Record<string, WorkflowBinding> = {};
    for (const [name, binding] of Object.entries(node.source_workflow.bindings)) {
      bindings[name] = await materializeBinding(binding, projectRoot, graphBase, `${operator.title} ${name}`);
    }
    node.source_workflow.bindings = bindings;
  }
  return materialized;
}
