import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { SomiteGraph, SourceWorkflowInstance } from "@somite/workflow/model";
import {
  compatiblePortTypes,
  graphStateRevision,
  semanticGraphKey,
  topologicalOrder,
  validateGraph,
  validateSourceWorkflow,
} from "@somite/workflow/workflow";

type ParityCase = {
  name: string;
  graph: SomiteGraph;
  error: string | null;
  topological_order?: string[];
};

test("graph validation matches every shared parity case", async () => {
  const bytes = await readFile(new URL("../../testdata/ir-parity-cases.json", import.meta.url), "utf8");
  const cases = JSON.parse(bytes) as ParityCase[];
  for (const parity of cases) {
    const result = validateGraph(parity.graph);
    const message = result.ok ? null : result.issue.message;
    assert.equal(message, parity.error, parity.name);
    if (parity.topological_order) {
      assert.deepEqual(topologicalOrder(parity.graph), parity.topological_order, parity.name);
    }
  }
});

test("input unions accept declared source types without weakening exact ports", () => {
  assert.equal(compatiblePortTypes("FastqGz", "Fastq", ["FastqGz"]), true);
  assert.equal(compatiblePortTypes("Fasta", "Fastq", ["FastqGz"]), false);
  assert.equal(compatiblePortTypes("Fastq", "Fastq"), true);
});

test("semantic identity ignores presentation and changes with executable parameters", () => {
  const graph: SomiteGraph = {
    schema_version: 3,
    name: "Original title",
    nodes: [{
      id: "node",
      operator: "tool",
      operator_revision: "revision",
      ports: [],
      params: { threads: 2 },
      layout: { x: 0, y: 0 },
      note: "presentation",
      color: "blue",
    }],
    edges: [],
    annotations: [{ id: "note", kind: "sticky", text: "hello", color: "yellow", layout: { x: 0, y: 0 }, width: 120, height: 80 }],
  };
  const presentation = {
    ...graph,
    name: "Renamed",
    nodes: [{ ...graph.nodes[0], layout: { x: 300, y: 200 }, note: "changed", color: "rose" as const }],
    annotations: [],
  };
  assert.equal(semanticGraphKey(graph), semanticGraphKey(presentation));
  assert.notEqual(semanticGraphKey(graph), semanticGraphKey({ ...graph, nodes: [{ ...graph.nodes[0], params: { threads: 4 } }] }));
  assert.notEqual(graphStateRevision(graph), graphStateRevision(presentation));
  assert.equal(
    graphStateRevision(graph),
    graphStateRevision({ edges: graph.edges, nodes: graph.nodes, schema_version: graph.schema_version, name: graph.name, annotations: graph.annotations }),
  );
});

test("source workflow validation preserves exact path, digest, and parameter contracts", () => {
  const digest = `blake3:${"a".repeat(64)}`;
  const source: SourceWorkflowInstance = {
    schema_version: 1,
    workflow_revision: digest,
    source: {
      provider: "nf_core",
      repository: "nf-core/test",
      requested_revision: "1.0.0",
      resolved_revision: "b".repeat(40),
      source_digest: digest,
      entrypoint: "main.nf",
      file_count: 1,
      source_bytes: 100,
    },
    parameters: [{ name: "reads", label: "Reads", group: "Input", type: "string", format: "file-path", required: true }],
    bindings: { reads: { kind: "project_file", path: "data/reads.fastq.gz" } },
    scopes: [],
    invocations: [],
    capabilities: {
      exact_execution: true,
      parameter_edits: true,
      hierarchy_indexed: true,
      structural_edits: false,
      channel_contracts: false,
      source_edits: false,
    },
  };
  assert.equal(validateSourceWorkflow(source), null);
  assert.equal(
    validateSourceWorkflow({ ...source, bindings: { reads: { kind: "project_file", path: "../outside.fastq.gz" } } }),
    "binding reads has an invalid project file path",
  );
  assert.equal(
    validateSourceWorkflow({ ...source, workflow_revision: "mutable" }),
    "workflow and source revisions must be full blake3 digests",
  );
});

test("large deterministic DAGs validate and order without recursion", () => {
  const size = 1_000;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: Array.from({ length: size }, (_, index) => ({
      id: `node-${index.toString().padStart(4, "0")}`,
      operator: "tool",
      operator_revision: "revision",
      ports: [
        { name: "input", dir: "in", ty: "Text", optional: index === 0 },
        { name: "output", dir: "out", ty: "Text" },
      ],
      layout: { x: index * 10, y: 0 },
    })),
    edges: Array.from({ length: size - 1 }, (_, index) => ({
      id: `edge-${index}`,
      from_node: `node-${index.toString().padStart(4, "0")}`,
      from_port: "output",
      to_node: `node-${(index + 1).toString().padStart(4, "0")}`,
      to_port: "input",
    })),
  };
  assert.deepEqual(validateGraph(graph), { ok: true });
  const order = topologicalOrder(graph);
  assert.equal(order.length, size);
  assert.equal(order[0], "node-0000");
  assert.equal(order.at(-1), "node-0999");
});
