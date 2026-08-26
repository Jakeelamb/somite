import assert from "node:assert/strict";
import test from "node:test";
import { mergeAgentSnapshots, unseenAgentTransactions } from "../app/agentState.ts";
import type { AgentEvent, AgentSnapshot, AgentTransaction, SomiteGraph } from "../app/types.ts";

const empty: SomiteGraph = { schema_version: 2, nodes: [], edges: [] };
const withReads: SomiteGraph = {
  schema_version: 2,
  nodes: [{ id: "reads", operator: "files.import", operator_revision: "blake3:operator", ports: [], params: {}, layout: { x: 20, y: 20 } }],
  edges: [],
};
const transaction: AgentTransaction = {
  transaction_id: "transaction-1",
  previous_state_revision: "blake3:before",
  state_revision: "blake3:after",
  graph_revision: "blake3:semantic",
  summary: "Add reads",
  graph: withReads,
};
const transactionEvent: AgentEvent = {
  cursor: 2,
  recorded_at_unix_ms: 2,
  kind: "transaction",
  title: "Add reads",
  detail: "blake3:before to blake3:after",
  transaction,
};

test("agent polling merges replayed events once and advances its cursor", () => {
  const current: AgentSnapshot = {
    connected: true,
    connecting: false,
    busy: true,
    config_options: [],
    cursor: 1,
    events: [{ cursor: 1, recorded_at_unix_ms: 1, kind: "user", title: "You", detail: "Add reads" }],
  };
  const incoming: AgentSnapshot = {
    connected: true,
    connecting: false,
    busy: false,
    config_options: [],
    cursor: 2,
    events: [current.events[0], transactionEvent],
  };
  const merged = mergeAgentSnapshots(current, incoming);
  assert.equal(merged.cursor, 2);
  assert.deepEqual(merged.events.map((event) => event.cursor), [1, 2]);
  assert.equal(merged.busy, false);
});

test("each atomic graph transaction is offered to the canvas only once", () => {
  assert.deepEqual(unseenAgentTransactions([transactionEvent], new Set()), [transaction]);
  assert.deepEqual(unseenAgentTransactions([transactionEvent], new Set(["transaction-1"])), []);
  assert.deepEqual(empty.nodes, []);
  assert.equal(transaction.graph.nodes[0].id, "reads");
});
