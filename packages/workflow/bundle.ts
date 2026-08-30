import type { Operator, PinnedOperator } from "./catalog.ts";
import { zipSync, type Zippable } from "fflate";
import { OperatorCatalog } from "./catalog.ts";
import { assessWorkflow, type NodeAssessment, type WorkflowAssessment } from "./assessment.ts";
import {
  emptyEvidenceIndex,
  freezeRunClosure,
  linkRunClosure,
  type RunClosure,
} from "./linker.ts";
import type { SomiteGraph } from "./model.ts";
import {
  compileNextflow,
  PINNED_NEXTFLOW_VERSION,
  PINNED_OPENJDK_VERSION,
} from "./nextflow.ts";
import { validateGraph } from "./workflow.ts";

export type ExportTarget = Readonly<{ archiveName: string; platform: string }>;

export type ToolState =
  | "built_in"
  | "ready"
  | "installable"
  | "system_required"
  | "source_setup"
  | "manual_checkpoint"
  | "method_details"
  | "legacy_source"
  | "adapter_needed";

export type ToolRequirement = Readonly<{
  operator_id: string;
  title: string;
  binary?: string;
  packages: readonly string[];
  state: ToolState;
  detail: string;
}>;

export type BundlePlan = Readonly<{
  filename: string;
  platform: string;
  channels: readonly string[];
  packages: readonly string[];
  tools: readonly ToolRequirement[];
  ready_count: number;
  installable_count: number;
  source_setup_count: number;
  manual_count: number;
  details_count: number;
  legacy_count: number;
  adapter_count: number;
  assessment: WorkflowAssessment;
}>;

export type FrozenPackage = Readonly<{
  plan: BundlePlan;
  closure: RunClosure;
  files: ReadonlyMap<string, Uint8Array>;
}>;

const encoder = new TextEncoder();

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function prettyJson(value: unknown) {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function titleFor(operator: Operator, supports: readonly NodeAssessment[]) {
  const titles = [...new Set(supports.map((support) => support.title))].sort(compareText);
  return titles.join(", ") || operator.title;
}

function toolRequirement(
  operator: PinnedOperator,
  assessment: WorkflowAssessment,
  binaryAvailable: (binary: string) => boolean,
): ToolRequirement {
  const supports = assessment.nodes.filter((node) => node.operator_id === operator.id);
  const support = supports[0];
  const title = titleFor(operator, supports);
  const requiresAction = supports.some((candidate) => candidate.requires_action);
  if (support) {
    const blocked: Partial<Record<NodeAssessment["kind"], ToolState>> = {
      source_workflow: "source_setup",
      manual_checkpoint: "manual_checkpoint",
      method_details: "method_details",
      legacy_source: "legacy_source",
      adapter: "adapter_needed",
    };
    const state = blocked[support.kind];
    if (state && requiresAction) {
      return {
        operator_id: operator.id,
        title,
        ...(operator.bin !== undefined ? { binary: operator.bin } : {}),
        packages: operator.pixi ?? [],
        state,
        detail: support.detail,
      };
    }
    if (["input_required", "built_in", "manual_checkpoint", "method_details"].includes(support.kind)) {
      return {
        operator_id: operator.id,
        title,
        packages: [],
        state: "built_in",
        detail: support.label,
      };
    }
  }

  const packages = operator.pixi ?? [];
  if (packages.length > 0) {
    return {
      operator_id: operator.id,
      title,
      ...(operator.bin !== undefined ? { binary: operator.bin } : {}),
      packages,
      state: "installable",
      detail: "Declared package will be resolved and locked by Pixi.",
    };
  }
  if (operator.bin && binaryAvailable(operator.bin)) {
    return {
      operator_id: operator.id,
      title,
      binary: operator.bin,
      packages,
      state: "ready",
      detail: "Available on this machine.",
    };
  }
  return {
    operator_id: operator.id,
    title,
    ...(operator.bin !== undefined ? { binary: operator.bin } : {}),
    packages,
    state: "system_required",
    detail: "External binary has no managed package declaration.",
  };
}

function usedOperators(graph: SomiteGraph, catalog: OperatorCatalog) {
  const ids = new Set(graph.nodes.map((node) => node.operator));
  for (const node of graph.nodes) {
    for (const replacement of node.source_workflow?.replacements ?? []) ids.add(replacement.operator);
  }
  return [...ids].sort(compareText).map((id) => {
    const operator = catalog.get(id);
    if (!operator) throw new Error(`unknown operator ${id}`);
    return operator;
  });
}

export function safeArchiveName(name: string) {
  const safe = [...name]
    .map((character) => /[A-Za-z0-9_-]/.test(character) ? character : "-")
    .join("")
    .replace(/^-+|-+$/g, "");
  return safe || "somite-workflow";
}

/** Inspect one target package without performing filesystem or process work. */
export function planFrozenPackage(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  target: ExportTarget,
  binaryAvailable: (binary: string) => boolean = () => false,
): BundlePlan {
  const validation = validateGraph(graph);
  if (!validation.ok) throw new Error(`invalid graph: ${validation.issue.message}`);
  const catalogValidation = catalog.verifyGraph(graph);
  if (!catalogValidation.ok) throw new Error(`catalog: ${catalogValidation.issue.message}`);
  const assessment = assessWorkflow(graph, catalog);
  const tools = usedOperators(graph, catalog).map((operator) => toolRequirement(operator, assessment, binaryAvailable));
  const packages = [...new Set(tools.flatMap((tool) => tool.packages))].sort(compareText);
  const count = (state: ToolState) => tools.filter((tool) => tool.state === state).length;
  return {
    filename: `${safeArchiveName(target.archiveName)}.somite-run.zip`,
    platform: target.platform,
    channels: ["conda-forge", "bioconda"],
    packages,
    tools,
    ready_count: count("built_in") + count("ready"),
    installable_count: count("installable"),
    source_setup_count: count("source_setup"),
    manual_count: count("manual_checkpoint"),
    details_count: count("method_details"),
    legacy_count: count("legacy_source"),
    adapter_count: count("adapter_needed"),
    assessment,
  };
}

/**
 * Build every immutable package file after the runner has resolved Pixi.
 * The lock itself is an input, keeping package assembly pure and portable.
 */
export function createFrozenPackageFiles(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  target: ExportTarget,
  pixiLock: Uint8Array,
  binaryAvailable: (binary: string) => boolean = () => false,
): FrozenPackage {
  const plan = planFrozenPackage(graph, catalog, target, binaryAvailable);
  const compiled = compileNextflow(graph, catalog, {
    workflowName: "somite-workflow",
    outputDirectory: "results",
    platforms: [target.platform],
    nextflowVersion: PINNED_NEXTFLOW_VERSION,
    openjdkVersion: PINNED_OPENJDK_VERSION,
  });
  const linked = linkRunClosure(graph, catalog, encoder.encode(compiled.pixiToml), {
    targetPlatform: target.platform,
    compilerIdentity: "somite-nextflow@0.1.0",
    nextflowIdentity: `nextflow@${PINNED_NEXTFLOW_VERSION}`,
    openjdkIdentity: `openjdk@${PINNED_OPENJDK_VERSION}`,
  });
  const closure = freezeRunClosure(linked.draft, pixiLock);
  const files = new Map<string, Uint8Array>([
    ["main.nf", encoder.encode(compiled.mainNf)],
    ["nextflow.config", encoder.encode(compiled.nextflowConfig)],
    ["params.json", encoder.encode(compiled.paramsJson)],
    ["node-map.json", encoder.encode(compiled.nodeMapJson)],
    ["pixi.toml", encoder.encode(compiled.pixiToml)],
    ["pixi.lock", pixiLock],
    ["workflow.somite.json", prettyJson(graph)],
    ["toolchain/tools.json", prettyJson(plan)],
    ["assessment.json", prettyJson(plan.assessment)],
    ["evidence/index.json", prettyJson(emptyEvidenceIndex())],
    ["run-closure.json", prettyJson(closure)],
    ["README.md", encoder.encode(frozenReadme())],
  ]);
  for (const manifest of linked.operatorManifests) {
    files.set(`operators/${manifest.operator_id}.json`, prettyJson(manifest));
  }
  return { plan, closure, files };
}

/** Deterministic, stored ZIP for download or runner transfer. */
export function archiveFrozenPackage(packageFiles: ReadonlyMap<string, Uint8Array>) {
  const archive: Zippable = {};
  for (const [path, bytes] of [...packageFiles].sort(([left], [right]) => compareText(left, right))) {
    archive[path] = bytes;
  }
  return zipSync(archive, {
    level: 0,
    mtime: new Date(1980, 0, 1),
    os: 3,
    attrs: 0o644 << 16,
  });
}

function frozenReadme() {
  return "# Frozen Somite run\n\nThis package contains one pinned Somite Graph revision, exact Operator revisions, generated Nextflow DSL2, and a resolved Pixi lock. Run it with:\n\n```bash\npixi run --frozen run\n```\n\n`run-closure.json` identifies the target-specific executable closure. Validation evidence is stored separately under `evidence/`.\n";
}
