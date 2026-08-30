import assert from "node:assert/strict";
import test from "node:test";

import {
  ResponseContractError,
  createSomiteClient,
  normalizedSomiteServerUrl,
} from "../app/api.ts";

const graph = {
  schema_version: 3 as const,
  name: "Transport test",
  nodes: [],
  edges: [],
  annotations: [],
};

function session(overrides: Record<string, unknown> = {}) {
  return {
    project_name: "transport-test",
    graph_path: ".somite/web.somite.json",
    graph,
    operators: [],
    recovered_autosave: false,
    autosave_recovery_warning: null,
    input_origin_warning: null,
    input_origin_id: "origin-test",
    agent_cursor: 0,
    state_revision: "state-test",
    ...overrides,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("normalizes and confines the runtime runner origin", () => {
  assert.equal(normalizedSomiteServerUrl(undefined), "http://localhost:7310");
  assert.equal(normalizedSomiteServerUrl("https://runner.example:7443/"), "https://runner.example:7443");
  for (const value of [
    "file:///tmp/socket",
    "https://user:secret@runner.example",
    "https://runner.example/api",
    "https://runner.example/?target=other",
    "https://runner.example/#other",
  ]) {
    assert.throws(() => normalizedSomiteServerUrl(value), /HTTP\(S\) origin/);
  }
});

test("clients retain independent immutable origins", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: URL | RequestInfo) => {
    calls.push(String(input));
    return json(session());
  }) as typeof fetch;
  const first = createSomiteClient("http://127.0.0.1:43117", fetcher);
  const second = createSomiteClient("https://runner.example:7443", fetcher);

  await Promise.all([first.session(), second.session(), first.session()]);

  assert.deepEqual(calls, [
    "http://127.0.0.1:43117/api/session",
    "https://runner.example:7443/api/session",
    "http://127.0.0.1:43117/api/session",
  ]);
});

test("malformed JSON and response shapes fail at the transport boundary", async () => {
  const malformedJson = createSomiteClient("http://runner.test", (async () => new Response("{")) as typeof fetch);
  await assert.rejects(malformedJson.session(), (error: unknown) => error instanceof ResponseContractError && error.endpoint === "/api/session");

  const malformedShape = createSomiteClient("http://runner.test", (async () => json(session({ graph: { ...graph, nodes: "not-an-array" } }))) as typeof fetch);
  await assert.rejects(malformedShape.session(), (error: unknown) => error instanceof ResponseContractError && /nodes/.test(error.message));
});

test("response limits cancel an unadvertised oversized stream before reading it all", async () => {
  let pulls = 0;
  let cancelled = false;
  const client = createSomiteClient("http://runner.test", (async () => new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (pulls === 100) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }))) as typeof fetch);

  await assert.rejects(client.session(), (error: unknown) => error instanceof ResponseContractError && /exceeds/.test(error.message));
  assert.equal(cancelled, true);
  assert.ok(pulls < 100, `expected an early stop, received ${pulls} chunks`);
});

test("paper decoding rejects response-only enum drift", async () => {
  const client = createSomiteClient("http://runner.test", (async () => json({
    extracted_via: "poppler",
    outcome: "no_reconstructable_methods",
    warnings: [],
    mentions: [],
    resources: [],
    candidates: [],
  })) as typeof fetch);

  await assert.rejects(
    client.reconstructPaperPath("paper.pdf", new AbortController().signal),
    (error: unknown) => error instanceof ResponseContractError && /extracted_via/.test(error.message),
  );
});

test("paper intake status validates required job identity", async () => {
  const client = createSomiteClient("http://runner.test", (async () => json({
    phase: "queued",
    durations_ms: {},
    cache: { extraction: false, reconstruction: false },
  })) as typeof fetch);

  await assert.rejects(
    client.paperIntakeStatus("job-1"),
    (error: unknown) => error instanceof ResponseContractError && /job_id/.test(error.message),
  );
});

test("agent prompt preserves the endpoint request contract", async () => {
  let requestBody: unknown;
  const client = createSomiteClient("http://runner.test", (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return json({ valid: true, state_revision: "state-next" });
  }) as typeof fetch);

  await client.promptAgent({
    message: "Add FastQC",
    base_state_revision: "state-test",
    graph,
    input_origin_id: "origin-test",
  });

  assert.deepEqual(requestBody, {
    message: "Add FastQC",
    base_state_revision: "state-test",
    graph,
    input_origin_id: "origin-test",
  });
  assert.equal(Object.hasOwn(requestBody as object, "prompt"), false);
});

test("empty command endpoints reject response drift", async () => {
  const valid = createSomiteClient("http://runner.test", (async () => new Response(null, { status: 204 })) as typeof fetch);
  await valid.cancelAgent();

  const malformed = createSomiteClient("http://runner.test", (async () => json({ ok: true })) as typeof fetch);
  await assert.rejects(malformed.disconnectAgent(), ResponseContractError);
});

test("run status follows the status contract rather than the start-only replay flag", async () => {
  const client = createSomiteClient("http://runner.test", (async () => json({
    run_id: "run-1",
    phase: "running",
    states: {},
    progress: { completed: 0, total: 1, unit: "nodes", message: "Starting" },
  })) as typeof fetch);

  const status = await client.runStatus("run-1");
  assert.equal(status.phase, "running");
  assert.equal(Object.hasOwn(status, "replayed"), false);
});

test("input-origin recovery is endpoint-aware and validates the cleared warning", async () => {
  let requestBody: unknown;
  const client = createSomiteClient("http://runner.test", (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return json({ state_revision: "state-recovered", input_origin_id: "origin-recovered", input_origin_warning: null });
  }) as typeof fetch);

  const recovered = await client.recoverInputOrigin("state-test", "origin-test");
  assert.deepEqual(requestBody, { base_state_revision: "state-test", input_origin_id: "origin-test" });
  assert.equal(recovered.input_origin_warning, null);
});
