import assert from "node:assert/strict";
import test from "node:test";
import { GraphProjectionClock, type GraphProjectionInput } from "../app/graphProjection.ts";
import type { SomiteEdge, SomiteGraph, SomiteGraphNode } from "../app/types.ts";
import { semanticGraphKey } from "../app/validationState.ts";
import { trackedSourceWorkflowFixture } from "./source-workflow-fixture.ts";

function graphNode(overrides: Partial<SomiteGraphNode> = {}): SomiteGraphNode {
  return {
    id: "fastqc",
    operator: "qc.fastqc",
    operator_revision: "blake3:fastqc",
    ports: [{ name: "reads", dir: "in", ty: "Fastq" }],
    params: { threads: 2 },
    layout: { x: 20, y: 40 },
    ...overrides,
  };
}

function input(node: SomiteGraphNode, edge?: SomiteEdge): GraphProjectionInput {
  return {
    name: "QC",
    nodes: [{ position: node.layout, data: { graphNode: node } }],
    edges: edge ? [{ data: { somite: edge } }] : [],
    annotations: [],
  };
}

test("graph projection ignores React Flow presentation-only object churn", () => {
  const clock = new GraphProjectionClock();
  const node = graphNode();
  const first = clock.observe(input(node));
  const presentationOnly = clock.observe({
    ...input(node),
    nodes: [{ position: { ...node.layout }, data: { graphNode: node }, selected: true }],
  });

  assert.equal(first.graphChanged, true);
  assert.equal(first.semanticChanged, true);
  assert.equal(presentationOnly.graphChanged, false);
  assert.equal(presentationOnly.semanticChanged, false);
  assert.equal(presentationOnly.graph, first.graph);
});

test("graph projection separates canvas edits from executable edits", () => {
  const clock = new GraphProjectionClock();
  const node = graphNode();
  clock.observe(input(node));

  const moved = clock.observe({ ...input(node), nodes: [{ position: { x: 80, y: 120 }, data: { graphNode: node } }] });
  assert.equal(moved.graphChanged, true);
  assert.equal(moved.semanticChanged, false);
  assert.deepEqual(moved.graph.nodes[0]?.layout, { x: 80, y: 120 });

  const noted = clock.observe(input({ ...node, layout: { x: 80, y: 120 }, note: "review" }));
  assert.equal(noted.graphChanged, true);
  assert.equal(noted.semanticChanged, false);

  const configured = clock.observe(input({ ...node, layout: { x: 80, y: 120 }, params: { threads: 8 } }));
  assert.equal(configured.graphChanged, true);
  assert.equal(configured.semanticChanged, true);
});

test("graph projection detects executable edge changes but not edge presentation", () => {
  const clock = new GraphProjectionClock();
  const node = graphNode();
  const edge: SomiteEdge = { id: "edge", from_node: "input", from_port: "reads", to_node: "fastqc", to_port: "reads" };
  const first = clock.observe(input(node, edge));
  const presentationOnly = clock.observe({ ...input(node, edge), edges: [{ data: { somite: edge }, selected: true }] });
  const rewired = clock.observe(input(node, { ...edge, from_node: "trimmed" }));

  assert.equal(first.semanticChanged, true);
  assert.equal(presentationOnly.graphChanged, false);
  assert.equal(rewired.graphChanged, true);
  assert.equal(rewired.semanticChanged, true);
});

test("graph projection delegates normalized executable identity to semanticGraphKey", async () => {
  const reorderedClock = new GraphProjectionClock();
  const firstNode = graphNode({ id: "first" });
  const secondNode = graphNode({ id: "second", operator: "qc.multiqc" });
  const firstEdge: SomiteEdge = { id: "first-edge", from_node: "input", from_port: "reads", to_node: "first", to_port: "reads" };
  const secondEdge: SomiteEdge = { id: "second-edge", from_node: "input", from_port: "reads", to_node: "second", to_port: "reads" };
  const ordered: GraphProjectionInput = {
    name: "QC",
    nodes: [firstNode, secondNode].map((node) => ({ position: node.layout, data: { graphNode: node } })),
    edges: [firstEdge, secondEdge].map((edge) => ({ data: { somite: edge } })),
    annotations: [],
  };
  reorderedClock.observe(ordered);
  const reordered = reorderedClock.observe({ ...ordered, nodes: [...ordered.nodes].reverse(), edges: [...ordered.edges].reverse() });
  assert.equal(reordered.graphChanged, true);
  assert.equal(reordered.semanticChanged, false);
  assert.equal(reordered.semanticKey, semanticGraphKey(reordered.graph));

  const normalizedClock = new GraphProjectionClock();
  const implicit = graphNode({ ports: [{ name: "reads", dir: "in", ty: "Fastq" }] });
  normalizedClock.observe(input(implicit));
  const explicit = normalizedClock.observe(input({
    ...implicit,
    ports: [{ name: "reads", dir: "in", ty: "Fastq", optional: false, union: [] }],
  }));
  assert.equal(explicit.semanticChanged, false);

  const { workflow } = await trackedSourceWorkflowFixture();
  const sourceClock = new GraphProjectionClock();
  const source = graphNode({ operator: "workflow.source", source_workflow: workflow });
  sourceClock.observe(input(source));
  const cloned = sourceClock.observe(input(structuredClone(source)));
  assert.equal(cloned.semanticChanged, false);
  const changedWorkflow = structuredClone(source);
  changedWorkflow.source_workflow!.bindings = {
    ...changedWorkflow.source_workflow!.bindings,
    somite_test: { kind: "literal", value: "changed" },
  };
  assert.equal(sourceClock.observe(input(changedWorkflow)).semanticChanged, true);
});

test("unprojected React Flow edges do not create graph or semantic epochs", () => {
  const clock = new GraphProjectionClock();
  const node = graphNode();
  const edge: SomiteEdge = { id: "edge", from_node: "input", from_port: "reads", to_node: "fastqc", to_port: "reads" };
  clock.observe(input(node, edge));
  const withPresentationEdge = clock.observe({ ...input(node, edge), edges: [{ data: { somite: edge } }, { selected: true }] });
  assert.equal(withPresentationEdge.graphChanged, false);
  assert.equal(withPresentationEdge.semanticChanged, false);
});

test("priming a canonical graph prevents a second epoch for its React Flow projection", () => {
  const clock = new GraphProjectionClock();
  const oldNode = graphNode();
  clock.observe(input(oldNode));
  const canonicalNode = graphNode({ params: { threads: 12 }, layout: { x: 100, y: 200 } });
  const graph: SomiteGraph = { schema_version: 3, name: "QC", nodes: [canonicalNode], edges: [], annotations: [] };

  assert.equal(clock.prime(graph).semanticChanged, true);
  const projected = clock.observe(input(canonicalNode));
  assert.equal(projected.graphChanged, false);
  assert.equal(projected.semanticChanged, false);
  assert.equal(projected.graph, graph);
});

test("priming a preserved local graph adopts the current React Flow identities", () => {
  const clock = new GraphProjectionClock();
  const node = graphNode();
  const currentInput = {
    ...input(node),
    annotations: [{ id: "note-1", kind: "sticky" as const, text: "Review", color: "yellow" as const, layout: { x: 10, y: 10 }, width: 120, height: 80 }],
  };
  const local = clock.observe(currentInput).graph;

  clock.prime(local, currentInput);
  const projected = clock.observe({ ...input(node), annotations: currentInput.annotations });
  assert.equal(projected.graphChanged, false);
  assert.equal(projected.semanticChanged, false);
  assert.equal(projected.graph, local);
  assert.equal(projected.semanticKey, semanticGraphKey(projected.graph));
});
