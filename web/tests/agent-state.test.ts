import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_EVENT_RETENTION, agentBatchMatchesAuthoritativeState, agentPollCursorAfterSnapshot, agentPollFailureState, compactConsumedAgentEvents, mergeAgentSnapshots, planAgentTransactions, retainAppliedAgentTransactionIds, unseenAgentTransactions } from "../app/agentState.ts";
import type { AgentEvent, AgentSnapshot, AgentTransaction, SomiteGraph } from "../app/types.ts";

const empty: SomiteGraph = { schema_version: 3, nodes: [], edges: [] };
const withReads: SomiteGraph = {
  schema_version: 3,
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

test("only a canonically consumed event poll advances the transaction cursor", () => {
  assert.equal(agentPollCursorAfterSnapshot(4, 9, true), 9);
  assert.equal(agentPollCursorAfterSnapshot(4, 9, false), 4);
  assert.equal(agentPollCursorAfterSnapshot(9, 4, true), 9);
});

test("repeated Agent transport failures become visible and back off", () => {
  assert.deepEqual(agentPollFailureState(1), { degraded: false, retryDelayMs: 450 });
  assert.deepEqual(agentPollFailureState(2), { degraded: false, retryDelayMs: 450 });
  assert.deepEqual(agentPollFailureState(3), { degraded: true, retryDelayMs: 900 });
  assert.deepEqual(agentPollFailureState(6), { degraded: true, retryDelayMs: 5_000 });
});

test("each atomic graph transaction is offered to the canvas only once", () => {
  assert.deepEqual(unseenAgentTransactions([transactionEvent], new Set()), [transaction]);
  assert.deepEqual(unseenAgentTransactions([transactionEvent], new Set(["transaction-1"])), []);
  assert.deepEqual(empty.nodes, []);
  assert.equal(transaction.graph.nodes[0].id, "reads");
});

test("applied Agent transaction deduplication retains only the visible event window", () => {
  const ids = Array.from({ length: AGENT_EVENT_RETENTION + 1 }, (_, index) => `transaction-${index}`);
  const retained = retainAppliedAgentTransactionIds(new Set(), ids);
  assert.equal(retained.size, AGENT_EVENT_RETENTION);
  assert.equal(retained.has(ids[0]!), false);
  assert.equal(retained.has(ids.at(-1)!), true);

  const refreshed = retainAppliedAgentTransactionIds(retained, [ids[1]!]);
  assert.equal([...refreshed].at(-1), ids[1]);
});

test("consumed Agent transactions release graph bodies without erasing event metadata", () => {
  const unconsumed = { ...transactionEvent, cursor: 3, transaction: { ...transaction, transaction_id: "transaction-2" } };
  const compacted = compactConsumedAgentEvents(
    [transactionEvent, unconsumed],
    new Set(["transaction-1"]),
  );

  assert.equal(compacted[0]?.transaction, undefined);
  assert.equal(compacted[0]?.cursor, transactionEvent.cursor);
  assert.equal(compacted[0]?.kind, transactionEvent.kind);
  assert.equal(compacted[0]?.title, transactionEvent.title);
  assert.equal(compacted[0]?.detail, transactionEvent.detail);
  assert.equal(compacted[1]?.transaction?.transaction_id, "transaction-2");
  assert.equal(transactionEvent.transaction, transaction);
});

test("agent transactions apply only across an exact state-revision chain", () => {
  const second: AgentTransaction = {
    ...transaction,
    transaction_id: "transaction-2",
    previous_state_revision: "blake3:after",
    state_revision: "blake3:last",
  };
  const events = [
    transactionEvent,
    { ...transactionEvent, cursor: 3, transaction: second },
  ];

  const plan = planAgentTransactions(events, new Set(), "blake3:before");
  assert.deepEqual(plan.apply.map((entry) => entry.transaction_id), ["transaction-1", "transaction-2"]);
  assert.deepEqual(plan.represented, []);
  assert.equal(plan.gap, null);
});

test("agent transactions already represented by the current revision are acknowledged", () => {
  const plan = planAgentTransactions([transactionEvent], new Set(), "blake3:after");
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.represented, [transaction]);
  assert.equal(plan.gap, null);
});

test("a transaction from an unrelated revision is a refresh gap, never a canvas replacement", () => {
  const plan = planAgentTransactions([transactionEvent], new Set(), "blake3:other");
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.represented, []);
  assert.equal(plan.gap?.transaction_id, "transaction-1");
});

test("an authoritative snapshot taken after the event acknowledges a superseded transaction", () => {
  const plan = planAgentTransactions(
    [transactionEvent],
    new Set(),
    "blake3:later-browser-state",
    true,
  );
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.represented, [transaction]);
  assert.equal(plan.gap, null);
});

test("an authoritative snapshot never replays an older event chain when a revision was reused", () => {
  const second: AgentTransaction = {
    ...transaction,
    transaction_id: "transaction-2",
    previous_state_revision: "blake3:after",
    state_revision: "blake3:last",
  };
  const plan = planAgentTransactions(
    [transactionEvent, { ...transactionEvent, cursor: 3, transaction: second }],
    new Set(),
    "blake3:after",
    true,
  );
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.represented.map((entry) => entry.transaction_id), ["transaction-1", "transaction-2"]);
  assert.equal(plan.gap, null);
});

test("an exact client chain is refreshed when the server has already advanced beyond it", () => {
  const plan = planAgentTransactions([transactionEvent], new Set(), "blake3:before");
  assert.equal(plan.gap, null);
  assert.equal(
    agentBatchMatchesAuthoritativeState(plan, "blake3:before", "blake3:after"),
    true,
  );
  assert.equal(
    agentBatchMatchesAuthoritativeState(plan, "blake3:before", "blake3:later-browser-state"),
    false,
  );
  assert.equal(agentBatchMatchesAuthoritativeState(plan, "blake3:before", undefined), false);
});
