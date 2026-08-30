import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AgentTransactionError, applyGraphTransaction, parseGraphTransaction } from "@somite/workflow/agentTransaction";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import type { SomiteGraph } from "@somite/workflow/model";
import { graphStateRevision } from "@somite/workflow/workflow";

const operatorsPath = fileURLToPath(new URL("../../operators/", import.meta.url));

function emptyGraph(): SomiteGraph {
  return { schema_version: 3, nodes: [], edges: [] };
}

test("agent transactions are atomic, pin catalog contracts, and distinguish semantic from canvas identity", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsPath);
  const original = emptyGraph();
  const added = applyGraphTransaction(original, catalog, {
    base_state_revision: graphStateRevision(original),
    idempotency_key: "atomic-edit-1",
    summary: "  Add reads and quality control  ",
    operations: [
      { op: "add_operator", node_id: "reads", operator_id: "files.import", params: { path: "reads.fastq" }, x: 0, y: 0 },
      { op: "add_operator", node_id: "fastqc", operator_id: "qc.fastqc", x: 320, y: 0 },
      { op: "connect", edge_id: "reads_to_fastqc", from_node: "reads", from_port: "file", to_node: "fastqc", to_port: "fastq" },
    ],
  }, "transaction-1");

  assert.equal(original.nodes.length, 0);
  assert.equal(added.summary, "Add reads and quality control");
  assert.equal(added.graph.nodes.length, 2);
  assert.equal(added.graph.edges.length, 1);
  assert.ok(added.graph.nodes.every((node) => node.operator_revision.startsWith("blake3:")));

  const noted = applyGraphTransaction(added.graph, catalog, {
    base_state_revision: added.state_revision,
    idempotency_key: "atomic-note-1",
    summary: "Annotate quality control",
    operations: [{ op: "set_note", node_id: "fastqc", note: "Review this report" }],
  }, "transaction-2");
  assert.equal(noted.graph_revision, added.graph_revision);
  assert.notEqual(noted.state_revision, added.state_revision);
  assert.throws(
    () => applyGraphTransaction(noted.graph, catalog, {
      base_state_revision: added.state_revision,
      idempotency_key: "atomic-stale-note-1",
      summary: "Overwrite stale note",
      operations: [{ op: "set_note", node_id: "fastqc", note: "stale" }],
    }, "transaction-3"),
    (error) => error instanceof AgentTransactionError && error.code === "stale_transaction",
  );
});

test("agent transactions reject resolver-only nodes and roll back invalid wiring", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsPath);
  const graph = emptyGraph();
  for (const operator of ["workflow.source", "nf.rnaseq", "smk.catalog-demo"]) {
    assert.throws(
      () => applyGraphTransaction(graph, catalog, {
        base_state_revision: graphStateRevision(graph),
        idempotency_key: `blocked-${operator.replaceAll(".", "-")}`,
        summary: "Try resolver-only operator",
        operations: [{ op: "add_operator", node_id: "source", operator_id: operator }],
      }, "transaction-blocked"),
      (error) => error instanceof AgentTransactionError
        && (error.code === "source_operator_requires_resolver" || error.code === "resolver_only_operator"),
    );
  }
  assert.throws(
    () => applyGraphTransaction(graph, catalog, {
      base_state_revision: graphStateRevision(graph),
      idempotency_key: "invalid-wire-1",
      summary: "Invalid wire",
      operations: [{ op: "connect", edge_id: "bad", from_node: "missing", from_port: "out", to_node: "also_missing", to_port: "in" }],
    }, "transaction-invalid"),
    (error) => error instanceof AgentTransactionError && error.code === "invalid_graph",
  );
  assert.deepEqual(graph, emptyGraph());
});

test("agent parameter edits enforce declared type, bounds, and required defaults", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsPath);
  const graph = emptyGraph();
  const withFastp = applyGraphTransaction(graph, catalog, {
    base_state_revision: graphStateRevision(graph),
    idempotency_key: "add-fastp-1",
    summary: "Add fastp",
    operations: [{ op: "add_operator", node_id: "fastp", operator_id: "qc.fastp" }],
  }, "transaction-fastp");
  const operator = catalog.get("qc.fastp")!;
  const bounded = Object.entries(operator.params).find(([, spec]) => spec.min !== undefined || spec.max !== undefined);
  if (bounded) {
    const [name, spec] = bounded;
    const outside = spec.max !== undefined ? spec.max + 1 : spec.min! - 1;
    assert.throws(
      () => applyGraphTransaction(withFastp.graph, catalog, {
        base_state_revision: withFastp.state_revision,
        idempotency_key: "bad-bound-1",
        summary: "Set invalid bound",
        operations: [{ op: "set_param", node_id: "fastp", parameter: name, value: outside }],
      }, "transaction-bound"),
      (error) => error instanceof AgentTransactionError && error.code === "parameter_bounds",
    );
  }
  assert.throws(
    () => applyGraphTransaction(withFastp.graph, catalog, {
      base_state_revision: withFastp.state_revision,
      idempotency_key: "unknown-param-1",
      summary: "Set unknown parameter",
      operations: [{ op: "set_param", node_id: "fastp", parameter: "invented", value: 3 }],
    }, "transaction-param"),
    (error) => error instanceof AgentTransactionError && error.code === "unknown_parameter",
  );
});

test("untrusted transaction JSON is strict and normalizes omitted operation defaults", () => {
  assert.deepEqual(parseGraphTransaction({
    base_state_revision: "blake3:before",
    idempotency_key: "parse-test-1",
    summary: "Add",
    operations: [{ op: "add_operator", node_id: "node", operator_id: "qc.fastqc" }],
  }).operations[0], {
    op: "add_operator",
    node_id: "node",
    operator_id: "qc.fastqc",
    params: {},
    x: 0,
    y: 0,
    note: null,
  });
  assert.throws(
    () => parseGraphTransaction({
      base_state_revision: "revision",
      idempotency_key: "parse-test-2",
      summary: "bad",
      operations: [{ op: "disconnect", edge_id: "edge", surprise: true }],
    }),
    (error) => error instanceof AgentTransactionError && error.code === "invalid_request",
  );
});
