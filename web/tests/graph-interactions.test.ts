import assert from "node:assert/strict";
import test from "node:test";
import {
  compatibleOperatorPorts,
  continuationEdge,
  nextContinuationPosition,
  normalizeImportedNodeLayouts,
  operatorContinues,
  type PendingConnection,
} from "../app/graphInteractions.ts";
import { edgeLifecycleState, semanticGraphKey } from "../app/validationState.ts";
import { preventBrowserZoomOutsideCanvas } from "../app/canvasGestures.ts";
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

test("managed-resource continuation requires the reviewed scientific profile", () => {
  const pending: PendingConnection = {
    nodeId: "kraken",
    port: { name: "db", dir: "in", ty: "Directory" },
    position: { x: 0, y: 0 },
    resourceProfile: "kraken2-database",
  };
  const genericDirectory: Operator = {
    ...fastp,
    id: "files.import_directory",
    ports: { in: [], out: [{ name: "directory", type: "Directory" }] },
  };
  const krakenDatabase: Operator = {
    ...genericDirectory,
    id: "files.import_kraken2_database",
    ports: { in: [], out: [{ name: "database", type: "Directory", resource_profile: "kraken2-database" }] },
  };
  assert.equal(operatorContinues(genericDirectory, pending), false);
  assert.equal(operatorContinues(krakenDatabase, pending), true);

  const genericConsumer: Operator = {
    ...fastp,
    id: "utility.directory",
    ports: { in: [{ name: "directory", type: "Directory" }], out: [] },
  };
  assert.equal(operatorContinues(genericConsumer, {
    nodeId: "database",
    port: { name: "database", dir: "out", ty: "Directory" },
    position: { x: 0, y: 0 },
    resourceProfile: "kraken2-database",
  }), true, "a profiled directory remains usable by a generic directory consumer");
});

test("one-click continuation chooses the next clear vertical lane", () => {
  assert.deepEqual(nextContinuationPosition({ x: 100, y: 100 }, "out", [{ x: 340, y: 100 }]), { x: 340, y: 280 });
  assert.deepEqual(nextContinuationPosition({ x: 340, y: 100 }, "in", []), { x: 100, y: 100 });
});

test("imported workflow layout reserves room for node titles, ids, and port labels", () => {
  const imported = [
    { ...node, id: "prepare-a", layout: { x: 0, y: 0 } },
    { ...node, id: "prepare-b", layout: { x: 0, y: 150 } },
    { ...node, id: "collect", layout: { x: 280, y: 0 } },
  ];

  assert.deepEqual(
    normalizeImportedNodeLayouts(imported).map((item) => item.layout),
    [
      { x: 0, y: 0 },
      { x: 0, y: 184 },
      { x: 360, y: 0 },
    ],
  );
});

test("pinch zoom cannot scale the browser chrome while canvas zoom remains available", () => {
  let toolbarPrevented = false;
  preventBrowserZoomOutsideCanvas({
    ctrlKey: true,
    target: { closest: () => null },
    preventDefault: () => { toolbarPrevented = true; },
  });
  assert.equal(toolbarPrevented, true);

  let canvasPrevented = false;
  preventBrowserZoomOutsideCanvas({
    ctrlKey: true,
    target: { closest: (selector: string) => selector === ".react-flow" ? {} : null },
    preventDefault: () => { canvasPrevented = true; },
  });
  assert.equal(canvasPrevented, false);

  let regularWheelPrevented = false;
  preventBrowserZoomOutsideCanvas({
    ctrlKey: false,
    target: { closest: () => null },
    preventDefault: () => { regularWheelPrevented = true; },
  });
  assert.equal(regularWheelPrevented, false);
});

test("validation edges expose progress and terminal evidence without color-only ambiguity", () => {
  const edge = { id: "edge1", from_node: "source1", from_port: "out", to_node: "tool1", to_port: "in" };
  assert.equal(edgeLifecycleState(edge, { source1: "done", tool1: "queued" }), "queued");
  assert.equal(edgeLifecycleState(edge, { source1: "done", tool1: "running" }), "running");
  assert.equal(edgeLifecycleState(edge, { source1: "done", tool1: "done" }), "done");
  assert.equal(edgeLifecycleState(edge, { source1: "done", tool1: "failed" }), "failed");
});

test("validation identity ignores layout but invalidates parameter changes", () => {
  const graph = { schema_version: 3, nodes: [{ ...node, params: { threads: 2 } }], edges: [] };
  const renamed = { ...graph, name: "RNA-seq review" };
  const moved = {
    ...graph,
    nodes: [{ ...graph.nodes[0], layout: { x: 900, y: -20 }, color: "violet" as const }],
    annotations: [{ id: "note-1", kind: "sticky" as const, text: "Review", color: "yellow" as const, layout: { x: 10, y: 20 }, width: 220, height: 140 }],
  };
  const changed = { ...graph, nodes: [{ ...graph.nodes[0], params: { threads: 4 } }] };
  assert.equal(semanticGraphKey(graph), semanticGraphKey(renamed));
  assert.equal(semanticGraphKey(graph), semanticGraphKey(moved));
  assert.notEqual(semanticGraphKey(graph), semanticGraphKey(changed));
});

test("native variant provenance survives in the graph without becoming execution identity", () => {
  const graph = { schema_version: 3, nodes: [{ ...node, params: { threads: 2 } }], edges: [] };
  const first = {
    ...graph,
    variant_origin: {
      source_node: { ...node, id: "source-workflow-a" },
      promoted_invocations: { "call-fastp": node.id },
    },
  };
  const renamedSource = {
    ...first,
    variant_origin: {
      source_node: { ...first.variant_origin.source_node, id: "source-workflow-b", note: "Original source" },
      promoted_invocations: { "renamed-source-call": node.id },
    },
  };

  assert.equal(semanticGraphKey(first), semanticGraphKey(renamedSource));
  assert.notEqual(
    semanticGraphKey(first),
    semanticGraphKey({ ...first, nodes: [{ ...first.nodes[0], params: { threads: 4 } }] }),
  );
});
