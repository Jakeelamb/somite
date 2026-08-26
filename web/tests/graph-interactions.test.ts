import assert from "node:assert/strict";
import test from "node:test";
import { compatibleOperatorPorts, continuationEdge, nextContinuationPosition, operatorContinues, type PendingConnection } from "../app/graphInteractions.ts";
import { edgeLifecycleState, semanticGraphKey } from "../app/validationState.ts";
import type { SomiteGraphNode, Operator } from "../app/types.ts";

const fastp: Operator = {
  id: "qc.fastp",
  title: "fastp",
  palette: ["QC"],
  kind: "external",
  cost: "high",
  params: {},
  ports: {
    in: [
      { name: "r1", type: "Fastq", union: ["FastqGz"] },
      { name: "r2", type: "Fastq", union: ["FastqGz"], optional: true },
    ],
    out: [{ name: "r1", type: "Fastq" }, { name: "r2", type: "Fastq", optional: true }],
  },
};

const node: SomiteGraphNode = { id: "fastp1", operator: fastp.id, operator_revision: "test-revision", ports: [], params: {}, layout: { x: 200, y: 100 } };

test("continuation matches the native input-union rule and prefers the same port name", () => {
  const pending: PendingConnection = { nodeId: "reads1", port: { name: "r1", dir: "out", ty: "FastqGz" }, position: { x: 200, y: 100 } };
  assert.equal(operatorContinues(fastp, pending), true);
  assert.deepEqual(compatibleOperatorPorts(fastp, pending).map((port) => port.name), ["r1", "r2"]);
  assert.deepEqual(continuationEdge(fastp, node, pending), {
    id: "e-reads1-r1-fastp1-r1",
    from_node: "reads1",
    from_port: "r1",
    to_node: "fastp1",
    to_port: "r1",
  });
});

test("continuation can start from an input and reverses the new edge", () => {
  const pending: PendingConnection = { nodeId: "fastp1", port: { name: "r1", dir: "in", ty: "Fastq", union: ["FastqGz"] }, position: { x: 0, y: 100 } };
  const upstream = { ...node, id: "fastp2" };
  assert.deepEqual(continuationEdge(fastp, upstream, pending), {
    id: "e-fastp2-r1-fastp1-r1",
    from_node: "fastp2",
    from_port: "r1",
    to_node: "fastp1",
    to_port: "r1",
  });
});

test("incompatible types never enter continuation results", () => {
  const pending: PendingConnection = { nodeId: "bam1", port: { name: "bam", dir: "out", ty: "Bam" }, position: { x: 200, y: 100 } };
  assert.equal(operatorContinues(fastp, pending), false);
  assert.equal(continuationEdge(fastp, node, pending), null);
});

test("one-click continuation chooses the next clear vertical lane", () => {
  assert.deepEqual(nextContinuationPosition({ x: 100, y: 100 }, "out", [{ x: 340, y: 100 }]), { x: 340, y: 280 });
  assert.deepEqual(nextContinuationPosition({ x: 340, y: 100 }, "in", []), { x: 100, y: 100 });
});

test("validation edges expose progress and terminal evidence without color-only ambiguity", () => {
  const edge = { id: "edge1", from_node: "source1", from_port: "out", to_node: "tool1", to_port: "in" };
  assert.equal(edgeLifecycleState(edge, { source1: "done", tool1: "queued" }), "queued");
  assert.equal(edgeLifecycleState(edge, { source1: "done", tool1: "running" }), "running");
  assert.equal(edgeLifecycleState(edge, { source1: "done", tool1: "done" }), "done");
  assert.equal(edgeLifecycleState(edge, { source1: "done", tool1: "failed" }), "failed");
});

test("validation identity ignores layout but invalidates parameter changes", () => {
  const graph = { schema_version: 2, nodes: [{ ...node, params: { threads: 2 } }], edges: [] };
  const moved = { ...graph, nodes: [{ ...graph.nodes[0], layout: { x: 900, y: -20 } }] };
  const changed = { ...graph, nodes: [{ ...graph.nodes[0], params: { threads: 4 } }] };
  assert.equal(semanticGraphKey(graph), semanticGraphKey(moved));
  assert.notEqual(semanticGraphKey(graph), semanticGraphKey(changed));
});
