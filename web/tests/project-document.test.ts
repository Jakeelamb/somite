import assert from "node:assert/strict";
import test from "node:test";

import {
  openProjectDocument,
  redoDocument,
  scopedGraphRequest,
  undoDocument,
  workflowDocument,
} from "../app/projectDocument.ts";
import type { ProjectOpenResponse, SomiteGraph } from "../app/types.ts";

const node = (id: string, x: number) => ({
  id,
  operator: "tool.example",
  operator_revision: "blake3:operator",
  ports: [],
  params: { label: id },
  layout: { x, y: x + 10 },
});

test("opening a Somite project is an exact document replacement with origin-aware undo and redo", () => {
  const current: SomiteGraph = { schema_version: 3, name: "Current", nodes: [node("current", 0)], edges: [] };
  const imported: SomiteGraph = {
    schema_version: 3,
    name: "Exact imported name",
    nodes: [node("reads", 10), node("align", 410)],
    edges: [{ id: "paper-edge-id", from_node: "reads", from_port: "out", to_node: "align", to_port: "in" }],
    annotations: [{ id: "stage-note", kind: "sticky", text: "Alignment", color: "blue", layout: { x: 80, y: 40 }, width: 220, height: 140 }],
    variant_origin: { source_node: node("original-source", -200), promoted_invocations: { "call-align": "align" } },
  };
  const response: ProjectOpenResponse = {
    kind: "somite",
    project_path: "external/paper-workflow",
    entrypoint: "paper.somite.json",
    graph: imported,
    input_origin_id: "external-origin-token",
  };
  const before = workflowDocument(current, "current-origin-token");
  const transition = openProjectDocument(response, before, { past: [], future: [] }, 80);
  assert.ok(transition);
  assert.deepEqual(transition.document.graph, imported);
  assert.deepEqual(transition.document.graph.nodes.map(({ id }) => id), ["reads", "align"]);
  assert.equal(transition.document.graph.edges[0]?.id, "paper-edge-id");
  assert.deepEqual(transition.document.graph.annotations, imported.annotations);
  assert.deepEqual(transition.document.graph.variant_origin, imported.variant_origin);
  assert.equal(transition.document.input_origin_id, "external-origin-token");
  assert.deepEqual(transition.history.past, [before]);

  const undone = undoDocument(transition.history, transition.document, 80);
  assert.deepEqual(undone?.document, before);
  const redone = undone && redoDocument(undone.history, undone.document, 80);
  assert.deepEqual(redone?.document, transition.document);
  assert.deepEqual(scopedGraphRequest(transition.document), {
    graph: imported,
    input_origin_id: "external-origin-token",
  });
});

test("Nextflow and Snakemake project imports remain additive dispositions", () => {
  const current = workflowDocument({ schema_version: 3, nodes: [], edges: [] }, "current-origin-token");
  for (const kind of ["nextflow", "snakemake"] as const) {
    const response: ProjectOpenResponse = {
      kind,
      project_path: kind,
      entrypoint: kind === "nextflow" ? "main.nf" : "Snakefile",
      graph: { schema_version: 3, nodes: [], edges: [] },
    };
    assert.equal(openProjectDocument(response, current, { past: [], future: [] }, 80), null);
  }
});
