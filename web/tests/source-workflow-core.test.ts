import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import type { SomiteGraph, SourceWorkflowInstance } from "@somite/workflow/model";
import type { FrozenSourceFile, SourceManifest } from "@somite/workflow/nextflowSource";
import {
  applySourceWorkflowEdits,
  parseNextflowParameterSchema,
  promoteSourceInvocation,
  restoreSourceWorkflow,
  sourceWorkflowRevision,
} from "@somite/workflow/sourceWorkflow";

const objectRoot = new URL("../../.somite/source-workflows/objects/4b8e157a3fbd3009095b60e4d857fba2af999ffe29c21bd01bd8304aaa427442/", import.meta.url);
const instancePath = new URL("../../.somite/source-workflows/instances/779d9b35a620a72180c6bd4d545bb753fb343a9396c9771818d6cc21aa5481fe.json", import.meta.url);

async function fixture() {
  const manifest = JSON.parse(await readFile(new URL("source-manifest.json", objectRoot), "utf8")) as SourceManifest;
  const record = JSON.parse(await readFile(instancePath, "utf8")) as { workflow: SourceWorkflowInstance };
  const files = await Promise.all(manifest.files.map(async (entry): Promise<FrozenSourceFile> => ({
    path: entry.path,
    mode: entry.mode,
    bytes: await readFile(new URL(`source/${entry.path}`, objectRoot)),
  })));
  return { workflow: record.workflow, files };
}

test("TypeScript reproduces existing source-workflow semantic revisions", async () => {
  const { workflow } = await fixture();
  assert.equal(sourceWorkflowRevision(workflow), workflow.workflow_revision);
});

test("TypeScript parameter projection preserves the supported pangenome fields", async () => {
  const { workflow, files } = await fixture();
  const parsed = parseNextflowParameterSchema(files);
  assert.deepEqual(parsed.parameters.map((parameter) => parameter.name), workflow.parameters?.map((parameter) => parameter.name));
  assert.equal(parsed.parameterEdits, true);
  assert.deepEqual(parsed.unsupportedRequired, []);
  assert.deepEqual(parsed.diagnostics.map((diagnostic) => diagnostic.code), ["unsupported_parameter_pattern", "unsupported_parameter_pattern"]);
});

test("source edits are revisioned and promotion remains an explicit native graph", async () => {
  const { workflow } = await fixture();
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
