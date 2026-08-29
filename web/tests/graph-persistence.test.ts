import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRefreshAccepted, canonicalRefreshDisposition, captureGraphWrite, commitIfCanonicalEpochCurrent, enqueueGraphWrite, graphNodeSetChanged } from "../app/graphPersistence.ts";
import type { SomiteGraph } from "../app/types.ts";

const graph = (name: string): SomiteGraph => ({ schema_version: 3, name, nodes: [], edges: [] });

test("browser writes serialize and each write observes the acknowledged revision", async () => {
  const queue = { current: Promise.resolve() };
  let revision = "state-a";
  const observed: Array<{ base: string; name?: string }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const transport = async (_path: "/api/graph" | "/api/graph/autosave", request: { base_state_revision: string; graph: SomiteGraph }) => {
    observed.push({ base: request.base_state_revision, name: request.graph.name });
    calls += 1;
    if (calls === 1) await firstGate;
    return { valid: true, state_revision: calls === 1 ? "state-b" : "state-c" };
  };

  const first = enqueueGraphWrite(queue, () => revision, (next) => { revision = next; }, transport, "/api/graph/autosave", captureGraphWrite(graph("first"), 1));
  const second = enqueueGraphWrite(queue, () => revision, (next) => { revision = next; }, transport, "/api/graph/autosave", captureGraphWrite(graph("second"), 2));
  await Promise.resolve();
  assert.deepEqual(observed, [{ base: "state-a", name: "first" }]);
  releaseFirst?.();
  await Promise.all([first, second]);

  assert.deepEqual(observed, [
    { base: "state-a", name: "first" },
    { base: "state-b", name: "second" },
  ]);
  assert.equal(revision, "state-c");
});

test("a failed write does not poison the serialization queue", async () => {
  const queue = { current: Promise.resolve() };
  let revision = "state-a";
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls === 1) throw new Error("conflict");
    return { valid: true, state_revision: "state-b" };
  };

  await assert.rejects(enqueueGraphWrite(queue, () => revision, (next) => { revision = next; }, transport, "/api/graph", captureGraphWrite(graph("first"), 1)));
  await enqueueGraphWrite(queue, () => revision, (next) => { revision = next; }, transport, "/api/graph", captureGraphWrite(graph("second"), 2));
  assert.equal(revision, "state-b");
});

test("a canonical response invalidates older queued snapshots before transport", async () => {
  let releaseQueue: (() => void) | undefined;
  const queue = { current: new Promise<void>((resolve) => { releaseQueue = resolve; }) };
  let minimumEpoch = 1;
  let transported = false;
  const pending = enqueueGraphWrite(
    queue,
    () => "state-a",
    () => undefined,
    async () => { transported = true; return { valid: true, state_revision: "state-b" }; },
    "/api/graph/autosave",
    captureGraphWrite(graph("stale"), 1),
    () => minimumEpoch,
  );

  minimumEpoch = 2;
  releaseQueue?.();
  await pending;
  assert.equal(transported, false);
});

test("a canonical graph invalidates an older write response already in flight", async () => {
  const queue = { current: Promise.resolve() };
  let minimumEpoch = 1;
  let revision = "state-a";
  let releaseTransport: (() => void) | undefined;
  const transportGate = new Promise<void>((resolve) => { releaseTransport = resolve; });
  let transported = false;
  let applied = false;
  const pending = enqueueGraphWrite(
    queue,
    () => revision,
    (next) => { applied = true; revision = next; },
    async () => {
      transported = true;
      await transportGate;
      return { valid: true, state_revision: "state-stale" };
    },
    "/api/graph/autosave",
    captureGraphWrite(graph("stale"), 1),
    () => minimumEpoch,
  );

  await Promise.resolve();
  assert.equal(transported, true);
  minimumEpoch = 2;
  revision = "state-canonical";
  releaseTransport?.();
  await pending;

  assert.equal(applied, false);
  assert.equal(revision, "state-canonical");
});

test("direct mutation responses share the same canonical epoch guard", () => {
  let revision = "state-canonical";
  let acknowledged = "canonical graph";
  const committed = commitIfCanonicalEpochCurrent(4, () => 5, () => {
    revision = "state-stale";
    acknowledged = "stale graph";
  });

  assert.equal(committed, false);
  assert.equal(revision, "state-canonical");
  assert.equal(acknowledged, "canonical graph");
});

test("conflict refreshes reject late canonical snapshots and preserve intervening local edits", () => {
  assert.equal(canonicalRefreshDisposition(
    { canonicalEpoch: 4, graphEpoch: 8, stateRevision: "state-a" },
    { canonicalEpoch: 5, graphEpoch: 8, stateRevision: "state-b" },
  ), "stale");
  assert.equal(canonicalRefreshDisposition(
    { canonicalEpoch: 5, graphEpoch: 8, stateRevision: "state-a" },
    { canonicalEpoch: 5, graphEpoch: 9, stateRevision: "state-a" },
  ), "preserve_local");
  assert.equal(canonicalRefreshDisposition(
    { canonicalEpoch: 5, graphEpoch: 8, stateRevision: "state-a" },
    { canonicalEpoch: 5, graphEpoch: 8, stateRevision: "state-a" },
  ), "replace");
});

test("a write acknowledgement that lands during refresh rejects the older session snapshot", () => {
  assert.equal(canonicalRefreshDisposition(
    { canonicalEpoch: 4, graphEpoch: 9, stateRevision: "state-a" },
    { canonicalEpoch: 4, graphEpoch: 9, stateRevision: "state-b" },
  ), "stale");
});

test("only an accepted post-event refresh can supersede an Agent event batch", () => {
  assert.equal(canonicalRefreshAccepted("replace"), true);
  assert.equal(canonicalRefreshAccepted("preserve_local"), true);
  assert.equal(canonicalRefreshAccepted("stale"), false);
  assert.equal(canonicalRefreshAccepted("busy"), false);
});

test("viewport fitting follows node-set changes but ignores ordinary graph edits", () => {
  const node = (id: string, x = 0) => ({
    id,
    operator: "qc.fastqc",
    operator_revision: "revision",
    ports: [],
    params: {},
    layout: { x, y: 0 },
  });
  const first: SomiteGraph = { schema_version: 3, nodes: [node("fastqc")], edges: [] };
  const moved: SomiteGraph = { schema_version: 3, nodes: [node("fastqc", 400)], edges: [] };
  const added: SomiteGraph = { schema_version: 3, nodes: [node("fastqc"), node("multiqc")], edges: [] };
  const swapped: SomiteGraph = { schema_version: 3, nodes: [node("bowtie2")], edges: [] };

  assert.equal(graphNodeSetChanged(first, moved), false);
  assert.equal(graphNodeSetChanged(first, added), true);
  assert.equal(graphNodeSetChanged(first, swapped), true);
});
