import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import type { SomiteGraph } from "@somite/workflow/model";
import {
  applySourceWorkflowEdits,
  parseNextflowParameterSchema,
  promoteSourceInvocation,
  restoreSourceWorkflow,
  sourceWorkflowRevision,
} from "@somite/workflow/sourceWorkflow";
import { trackedSourceWorkflowFixture } from "./source-workflow-fixture.ts";

test("the tracked source workflow has a stable semantic revision", async () => {
  const { workflow } = await trackedSourceWorkflowFixture();
  assert.equal(sourceWorkflowRevision(workflow), workflow.workflow_revision);
  assert.equal(workflow.workflow_revision, "blake3:dbec34d4268cc3b677bc590634a45272cb66dc8b0a4b123f18cf16e3706a56d7");
});

test("parameter projection preserves supported fields and isolates unsupported shapes", async () => {
  const { workflow, files } = await trackedSourceWorkflowFixture();
  const parsed = parseNextflowParameterSchema(files);
  assert.deepEqual(parsed.parameters.map((parameter) => parameter.name), ["input", "outdir", "threads", "mode"]);
  assert.deepEqual(parsed.parameters.map((parameter) => parameter.name), workflow.parameters?.map((parameter) => parameter.name));
  assert.equal(parsed.parameterEdits, true);
  assert.deepEqual(parsed.unsupportedRequired, []);
  assert.deepEqual(parsed.diagnostics.map((diagnostic) => diagnostic.code), ["unsupported_parameter"]);
});

test("source edits are revisioned and promotion remains an explicit native graph", async () => {
  const { workflow } = await trackedSourceWorkflowFixture();
  const invocation = workflow.invocations?.find((candidate) => candidate.name === "WFMASH_MAP_ALIGN") ?? workflow.invocations?.[0];
  assert.ok(invocation);
  const { catalog } = await loadOperatorCatalog(fileURLToPath(new URL("../../operators/", import.meta.url)));
  const bowtie2 = catalog.get("align.bowtie2")!;
  const edited = applySourceWorkflowEdits(workflow, workflow.workflow_revision, [{
    kind: "replace_invocation",
    invocation_id: invocation.id,
    operator: bowtie2.id,
    operator_revision: bowtie2.revision,
    params: {},
  }]);
  assert.notEqual(edited.workflow_revision, workflow.workflow_revision);

  const sourceOperator = catalog.get("workflow.source")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    name: "Pangenome variant",
    nodes: [{
      id: "source-pangenome",
      operator: sourceOperator.id,
      operator_revision: sourceOperator.revision,
      ports: [],
      params: {},
      source_workflow: edited,
      layout: { x: 10, y: 20 },
    }],
    edges: [],
  };
  const promoted = promoteSourceInvocation(graph, edited.workflow_revision, invocation.id, catalog);
  assert.equal(promoted.nodes[0]?.operator, "align.bowtie2");
  assert.equal(promoted.nodes[0]?.source_workflow, undefined);
  assert.equal(promoted.variant_origin?.source_node.source_workflow?.workflow_revision, edited.workflow_revision);
  assert.deepEqual(restoreSourceWorkflow(promoted, catalog).nodes, graph.nodes);
});
