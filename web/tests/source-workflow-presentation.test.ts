import assert from "node:assert/strict";
import test from "node:test";
import {
  editableRequiredSourceFileParameters,
  groupedWorkflowParameters,
  hiddenRequiredWorkflowParameters,
  mergeCanonicalSourceWorkflow,
  opaqueNfcoreFallback,
  parseSourceNumericDraft,
  sourceBindingResetLabel,
  sourceBindingStatus,
  sourceBooleanNeedsExplicitChoice,
  sourceWorkflowCanAppendGraph,
  sourceWorkflowCanvasIsEmpty,
  sourceWorkflowInvocations,
  sourceWorkflowProvider,
  sourceWorkflowReplacementCandidate,
  sourceWorkflowRevision,
  sourceWorkflowRoot,
  sourceWorkflowSetupLabel,
  sourceWorkflowTitle,
  withSourceWorkflowBinding,
  workflowBinding,
  workflowChoiceBinding,
  workflowChoiceLabel,
  workflowChoiceSelection,
} from "../app/sourceWorkflowPresentation.ts";
import { semanticGraphKey } from "../app/validationState.ts";
import type { SomiteGraph, SomiteGraphNode, SourceWorkflowInstance, WorkflowParameterField } from "../app/types.ts";

const sourceWorkflow: SourceWorkflowInstance = {
  schema_version: 1,
  workflow_revision: `blake3:${"a".repeat(64)}`,
  source: {
    provider: "nf_core",
    repository: "https://github.com/nf-core/pangenome.git",
    requested_revision: "1.1.3",
    resolved_revision: "3d02bd1df79f48b4bfdb4ad95d4ca0d7f6aeb337",
    source_digest: `blake3:${"b".repeat(64)}`,
    entrypoint: "main.nf",
    file_count: 137,
    source_bytes: 424_000,
  },
  profiles: ["test"],
  parameters: [
    { name: "input", label: "Input FASTA", group: "Input/output", type: "string", format: "file-path", required: true },
    { name: "outdir", label: "Results", group: "Input/output", type: "string", format: "directory-path", managed: true },
    { name: "n_haplotypes", label: "Haplotypes", group: "Pangenome", type: "integer", minimum: 1 },
    { name: "secret", label: "Secret", group: "Internal", type: "string", hidden: true },
  ],
  bindings: {},
  scopes: [
    { id: "scope-main", title: "NFCORE_PANGENOME", symbol: "NFCORE_PANGENOME", kind: "entry_workflow", span: { path: "main.nf", start_line: 40, end_line: 55 } },
    { id: "scope-pggb", title: "PGGB", symbol: "PGGB", kind: "workflow", span: { path: "subworkflows/local/pggb.nf", start_line: 18, end_line: 150 } },
  ],
  invocations: [
    { id: "invoke-pggb", caller: "scope-main", name: "PGGB", callee: "scope-pggb", span: { path: "main.nf", start_line: 46, end_line: 46 } },
  ],
  capabilities: {
    exact_execution: true,
    parameter_edits: true,
    hierarchy_indexed: true,
    structural_edits: false,
    channel_contracts: false,
    source_edits: false,
  },
};

test("source replacement choices contain only pinned native tools", () => {
  assert.equal(sourceWorkflowReplacementCandidate({ id: "align.bowtie2", kind: "external", revision: "blake3:native" }), true);
  assert.equal(sourceWorkflowReplacementCandidate({ id: "manual.checkpoint", kind: "inprocess", revision: "blake3:manual" }), true);
  assert.equal(sourceWorkflowReplacementCandidate({ id: "nf.pangenome", kind: "external", revision: "blake3:nfcore" }), false);
  assert.equal(sourceWorkflowReplacementCandidate({ id: "smk.example", kind: "external", revision: "blake3:snakemake" }), false);
  assert.equal(sourceWorkflowReplacementCandidate({ id: "workflow.source", kind: "source", revision: "blake3:source" }), false);
  assert.equal(sourceWorkflowReplacementCandidate({ id: "align.unpinned", kind: "external" }), false);
});

const node: SomiteGraphNode = {
  id: "pangenome",
  operator: "workflow.source",
  operator_revision: `blake3:${"c".repeat(64)}`,
  ports: [],
  source_workflow: sourceWorkflow,
  layout: { x: 100, y: 100 },
};

test("source-backed workflow presentation favors the biological workflow over internal process names", () => {
  assert.equal(sourceWorkflowTitle(sourceWorkflow), "Pangenome");
  assert.equal(sourceWorkflowProvider(sourceWorkflow), "nf-core");
  assert.equal(sourceWorkflowRevision(sourceWorkflow), "1.1.3");
  assert.equal(sourceWorkflowSetupLabel(sourceWorkflow, 0), "Setup needed");
  assert.equal(sourceWorkflowSetupLabel({ ...sourceWorkflow, bindings: { input: { kind: "project_file", path: "inputs/pangenome.fa.gz" } } }, 0), "Setup complete");
  assert.equal(sourceWorkflowSetupLabel(sourceWorkflow, 2), "2 setup items");
  assert.equal(sourceWorkflowSetupLabel({ ...sourceWorkflow, capabilities: { ...sourceWorkflow.capabilities, exact_execution: false } }, 0), "Setup needed");
});

test("legacy nf-core reference cards cannot bypass source resolution", () => {
  assert.equal(opaqueNfcoreFallback({ id: "nf.rnaseq", palette: ["References", "nf-core"] }), true);
  assert.equal(opaqueNfcoreFallback({ id: "nf.rnaseq", palette: ["Catalog", "Nextflow"] }), false);
  assert.equal(opaqueNfcoreFallback({ id: "qc.fastp", palette: ["Quality Control"] }), false);
});

test("a whole-root source workflow only enters a still-empty canvas", () => {
  const native = { ...node, id: "native", source_workflow: undefined };
  assert.equal(sourceWorkflowCanvasIsEmpty({ nodes: [], edges: [] }), true);
  assert.equal(sourceWorkflowCanvasIsEmpty({ nodes: [node], edges: [] }), false);
  assert.equal(sourceWorkflowCanvasIsEmpty({ nodes: [], edges: [{ id: "stale", from_node: "a", from_port: "out", to_node: "b", to_port: "in" }] }), false);
  assert.equal(sourceWorkflowCanAppendGraph({ nodes: [], edges: [] }, { nodes: [node] }), true);
  assert.equal(sourceWorkflowCanAppendGraph({ nodes: [native], edges: [] }, { nodes: [node] }), false);
  assert.equal(sourceWorkflowCanAppendGraph({ nodes: [node], edges: [] }, { nodes: [native] }), false);
  assert.equal(sourceWorkflowCanAppendGraph({ nodes: [native], edges: [] }, { nodes: [native] }), true);
});

test("source outline stays hierarchical and source anchored", () => {
  const root = sourceWorkflowRoot(sourceWorkflow);
  assert.equal(root?.id, "scope-main");
  assert.deepEqual(sourceWorkflowInvocations(sourceWorkflow, root?.id ?? ""), [sourceWorkflow.invocations?.[0]]);
});

test("parameter groups show managed fields but omit hidden implementation parameters", () => {
  const groups = groupedWorkflowParameters(sourceWorkflow);
  assert.deepEqual(groups.map(({ group }) => group), ["Input/output", "Pangenome"]);
  assert.deepEqual(groups[0]?.parameters.map(({ name, managed }) => [name, Boolean(managed)]), [["input", false], ["outdir", true]]);
});

test("hidden required source parameters remain explicit blockers", () => {
  const hiddenRequired = {
    ...sourceWorkflow,
    parameters: sourceWorkflow.parameters?.map((parameter) => parameter.name === "secret" ? { ...parameter, required: true } : parameter),
  };
  assert.deepEqual(hiddenRequiredWorkflowParameters(hiddenRequired).map((parameter) => parameter.name), ["secret"]);
});

test("globally locked source schemas never advertise a drop-to-bind target", () => {
  assert.deepEqual(editableRequiredSourceFileParameters(sourceWorkflow).map((parameter) => parameter.name), ["input"]);
  const locked = {
    ...sourceWorkflow,
    capabilities: { ...sourceWorkflow.capabilities, parameter_edits: false },
  };
  assert.deepEqual(editableRequiredSourceFileParameters(locked), []);
});

test("binding controls preserve file, directory, and scalar binding kinds", () => {
  const [file, directory, scalar] = sourceWorkflow.parameters as WorkflowParameterField[];
  const ambiguous = { ...file, format: "path" };
  assert.deepEqual(workflowBinding(file, "inputs/genomes.fa.gz"), { kind: "project_file", path: "inputs/genomes.fa.gz" });
  assert.deepEqual(workflowBinding(directory, "results"), { kind: "project_directory", path: "results" });
  assert.deepEqual(workflowBinding(scalar, 12), { kind: "literal", value: 12 });
  assert.equal(workflowBinding(ambiguous, "inputs/reference"), undefined);
  assert.deepEqual(workflowBinding(ambiguous, "inputs/reference", "project_file"), { kind: "project_file", path: "inputs/reference" });
  assert.deepEqual(workflowBinding(ambiguous, "inputs/reference", "project_directory"), { kind: "project_directory", path: "inputs/reference" });
});

test("integer drafts never round outside JavaScript's exact integer domain", () => {
  const integer = { type: "integer" as const };
  assert.equal(parseSourceNumericDraft(integer, "9007199254740991"), 9_007_199_254_740_991);
  assert.equal(parseSourceNumericDraft(integer, "-9007199254740991"), -9_007_199_254_740_991);
  assert.equal(parseSourceNumericDraft(integer, "9007199254740992"), undefined);
  assert.equal(parseSourceNumericDraft(integer, "9007199254740993"), undefined);
  assert.equal(parseSourceNumericDraft(integer, "1.5"), undefined);
  assert.equal(parseSourceNumericDraft({ type: "number" }, "1.5"), 1.5);
  assert.equal(parseSourceNumericDraft({ type: "number" }, "0.10000000000000001"), undefined);
  assert.equal(parseSourceNumericDraft({ type: "number" }, "0.10"), 0.1);
  assert.equal(parseSourceNumericDraft({ type: "number" }, "1e2"), 100);
});

test("enum controls distinguish unset, explicit empty strings, and generic path kinds", () => {
  const scalar = { name: "label", label: "Label", group: "Input", type: "string" as const };
  const scalarChoices = ["", "   ", "sample"];
  const empty = workflowChoiceBinding(scalar, scalarChoices, "choice:0");
  const spaces = workflowChoiceBinding(scalar, scalarChoices, "choice:1");
  assert.deepEqual(empty, { kind: "literal", value: "" });
  assert.deepEqual(spaces, { kind: "literal", value: "   " });
  assert.equal(workflowChoiceSelection(scalarChoices, empty), "choice:0");
  assert.equal(workflowChoiceSelection(scalarChoices, undefined), "unset");
  assert.equal(workflowChoiceLabel(""), "\"\"");
  assert.equal(workflowChoiceLabel("   "), "\"   \"");
  assert.equal(
    workflowChoiceSelection([1, -0], { kind: "literal", value: 1 }),
    "choice:0",
  );
  assert.equal(
    workflowChoiceSelection([-0], { kind: "literal", value: 0 }),
    "choice:0",
  );

  const genericPath = { ...scalar, name: "input", format: "path" };
  const pathChoices = ["inputs/a.fa", "inputs/b.fa"];
  assert.equal(workflowChoiceBinding(genericPath, pathChoices, "choice:0"), undefined);
  assert.deepEqual(
    workflowChoiceBinding(genericPath, pathChoices, "choice:0", "project_file"),
    { kind: "project_file", path: "inputs/a.fa" },
  );
  assert.deepEqual(
    workflowChoiceBinding(genericPath, pathChoices, "choice:1", "project_directory"),
    { kind: "project_directory", path: "inputs/b.fa" },
  );
});

test("a boolean without a schema default stays visibly unset until the user chooses", () => {
  const optional = { type: "boolean" as const, required: false, default: undefined };
  const required = { ...optional, required: true };
  const defaulted = { ...optional, default: false };
  const disabled = { kind: "literal" as const, value: false };

  assert.equal(sourceBooleanNeedsExplicitChoice(optional, undefined), true);
  assert.equal(sourceBooleanNeedsExplicitChoice(defaulted, undefined), false);
  assert.equal(sourceBooleanNeedsExplicitChoice(optional, disabled), false);
  assert.equal(sourceBindingStatus(optional, undefined), "Not set · optional");
  assert.equal(sourceBindingStatus(required, undefined), "Not set · required");
  assert.equal(sourceBindingStatus(defaulted, undefined), "Using default");
  assert.equal(sourceBindingStatus(optional, disabled), "Bound to this workflow");
  assert.equal(sourceBindingResetLabel(optional), "Clear value");
  assert.equal(sourceBindingResetLabel(defaulted), "Use default");
});

test("binding updates are immutable and enter the client execution identity", () => {
  const updated = withSourceWorkflowBinding(node, "input", { kind: "project_file", path: "inputs/pangenome.fa.gz" });
  assert.notEqual(updated, node);
  assert.notEqual(updated.source_workflow, node.source_workflow);
  assert.deepEqual(node.source_workflow?.bindings, {});
  assert.deepEqual(updated.source_workflow?.bindings, { input: { kind: "project_file", path: "inputs/pangenome.fa.gz" } });

  const graph = (graphNode: SomiteGraphNode): SomiteGraph => ({ schema_version: 3, nodes: [graphNode], edges: [] });
  assert.notEqual(semanticGraphKey(graph(node)), semanticGraphKey(graph(updated)));
  const reordered = {
    ...updated,
    source_workflow: {
      ...updated.source_workflow!,
      bindings: { zeta: { kind: "literal" as const, value: true }, input: { kind: "project_file" as const, path: "inputs/pangenome.fa.gz" } },
    },
  };
  const sorted = {
    ...updated,
    source_workflow: {
      ...updated.source_workflow!,
      bindings: { input: { kind: "project_file" as const, path: "inputs/pangenome.fa.gz" }, zeta: { kind: "literal" as const, value: true } },
    },
  };
  assert.equal(semanticGraphKey(graph(reordered)), semanticGraphKey(graph(sorted)));
});

test("a canonical source edit follows the sole source node across presentation renames", () => {
  const renamed = { ...node, id: "renamed-on-canvas" };
  const current: SomiteGraph = { schema_version: 3, name: "Local title", nodes: [renamed], edges: [] };
  const canonicalWorkflow = {
    ...sourceWorkflow,
    workflow_revision: `blake3:${"d".repeat(64)}`,
    bindings: { input: { kind: "project_file" as const, path: "inputs/genomes.fa.gz" } },
  };
  const canonical: SomiteGraph = {
    schema_version: 3,
    name: "Older server title",
    nodes: [{ ...node, source_workflow: canonicalWorkflow }],
    edges: [],
  };

  const merged = mergeCanonicalSourceWorkflow(current, canonical, sourceWorkflow.workflow_revision);
  assert.equal(merged.name, "Local title");
  assert.equal(merged.nodes[0]?.id, "renamed-on-canvas");
  assert.equal(merged.nodes[0]?.source_workflow?.workflow_revision, canonicalWorkflow.workflow_revision);
  assert.deepEqual(merged.nodes[0]?.source_workflow?.bindings, canonicalWorkflow.bindings);
});

test("a source edit response does not resurrect a source node deleted while the request was pending", () => {
  const current: SomiteGraph = { schema_version: 3, name: "Still local", nodes: [], edges: [] };
  const canonical: SomiteGraph = { schema_version: 3, nodes: [node], edges: [] };
  assert.equal(mergeCanonicalSourceWorkflow(current, canonical, sourceWorkflow.workflow_revision), current);
});

test("a late source edit response cannot replace a different workflow restored by Undo", () => {
  const restoredWorkflow = {
    ...sourceWorkflow,
    workflow_revision: `blake3:${"e".repeat(64)}`,
    bindings: { input: { kind: "project_file" as const, path: "inputs/restored.fa.gz" } },
  };
  const current: SomiteGraph = {
    schema_version: 3,
    nodes: [{ ...node, id: "renamed-on-canvas", source_workflow: restoredWorkflow }],
    edges: [],
  };
  const canonical: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      ...node,
      source_workflow: {
        ...sourceWorkflow,
        workflow_revision: `blake3:${"f".repeat(64)}`,
        bindings: { input: { kind: "project_file" as const, path: "inputs/late.fa.gz" } },
      },
    }],
    edges: [],
  };

  assert.equal(
    mergeCanonicalSourceWorkflow(current, canonical, sourceWorkflow.workflow_revision),
    current,
  );
});
