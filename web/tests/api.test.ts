import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  MAX_AGENT_SNAPSHOT_BYTES,
  MAX_FROZEN_PACKAGE_BYTES,
  MAX_PAPER_REVIEW_BYTES,
  MAX_PAPER_STATUS_BYTES,
} from "@somite/workflow/limits";
import { operatorRevision, parseOperator } from "@somite/workflow/catalogCodec";

import {
  ResponseContractError,
  boundedZipBlob,
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

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
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

test("runner requests never forward across an HTTP redirect", async (context) => {
  let forwarded = 0;
  const destination = createServer((_request, response) => {
    forwarded += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ valid: true }));
  });
  const destinationOrigin = await listen(destination);
  const redirector = createServer((_request, response) => {
    response.statusCode = 307;
    response.setHeader("location", `${destinationOrigin}/captured`);
    response.end();
  });
  const redirectOrigin = await listen(redirector);
  context.after(async () => {
    await Promise.all([
      new Promise<void>((resolve) => destination.close(() => resolve())),
      new Promise<void>((resolve) => redirector.close(() => resolve())),
    ]);
  });

  const client = createSomiteClient(redirectOrigin);
  await assert.rejects(client.validateGraph({ graph }));
  assert.equal(forwarded, 0);
});

test("malformed JSON and response shapes fail at the transport boundary", async () => {
  const malformedJson = createSomiteClient("http://runner.test", (async () => new Response("{")) as typeof fetch);
  await assert.rejects(malformedJson.session(), (error: unknown) => error instanceof ResponseContractError && error.endpoint === "/api/session");

  const malformedShape = createSomiteClient("http://runner.test", (async () => json(session({ graph: { ...graph, nodes: "not-an-array" } }))) as typeof fetch);
  await assert.rejects(malformedShape.session(), (error: unknown) => error instanceof ResponseContractError && /nodes/.test(error.message));
});

test("session decoding accepts the runner's pinned Operator contract", async () => {
  const operator = parseOperator({
    id: "files.import",
    title: "Local file",
    palette: ["Input"],
    kind: "inprocess",
    cost: "low",
    params: {},
    ports: { in: [], out: [] },
  });
  const client = createSomiteClient("http://runner.test", (async () => json(session({
    operators: [{
      ...operator,
      revision: operatorRevision(operator),
    }],
  }))) as typeof fetch);

  const opened = await client.session();
  assert.equal(opened.operators[0]?.revision, operatorRevision(operator));
});

test("workflow catalog decoding accepts pinned remote operators", async () => {
  const operator = parseOperator({
    id: "nf.demo",
    title: "nf-core/demo",
    palette: ["nf-core"],
    kind: "external",
    cost: "high",
    params: {},
    ports: { in: [], out: [] },
  });
  const client = createSomiteClient("http://runner.test", (async () => json({
    entries: [{
      operator: {
        ...operator,
        revision: operatorRevision(operator),
      },
      description: "Pinned demo workflow",
      topics: ["testing"],
      revision: "1.0.0",
    }],
    cached: false,
  })) as typeof fetch);

  const catalog = await client.workflowCatalog("nfcore");
  assert.equal(catalog.entries[0]?.operator.revision, operatorRevision(operator));
});

test("runner responses cannot forge a pinned Operator revision", async () => {
  const operator = parseOperator({ id: "forged.tool", title: "Forged", kind: "external", ports: { in: [], out: [] } });
  const client = createSomiteClient("http://runner.test", (async () => json(session({
    operators: [{ ...operator, revision: "blake3:forged" }],
  }))) as typeof fetch);
  await assert.rejects(client.session(), /revision does not match/);
});

test("Agent discovery normalizes optional fields and rejects unsafe response links", async () => {
  const discovery = {
    registry_url: "https://registry.example/agents.json",
    registry_status: "live",
    agents: [{
      id: "test-agent",
      name: "Test Agent",
      version: "1.0.0",
      description: "A test Agent",
      command: "test-agent --acp",
      availability: "installed",
      availability_detail: "Ready",
      repository: "https://example.com/repository",
      extra: "must not cross the decoder",
    }],
  };
  const valid = createSomiteClient("http://runner.test", (async () => json(discovery)) as typeof fetch);
  const decoded = await valid.discoverAgents();
  assert.equal(decoded.agents[0]?.command, "test-agent --acp");
  assert.equal(Object.hasOwn(decoded.agents[0] ?? {}, "extra"), false);

  const invalidCommand = createSomiteClient("http://runner.test", (async () => json({
    ...discovery,
    agents: [{ ...discovery.agents[0], command: { executable: "test-agent" } }],
  })) as typeof fetch);
  await assert.rejects(invalidCommand.discoverAgents(), /command must be a string/);

  const unsafeWebsite = createSomiteClient("http://runner.test", (async () => json({
    ...discovery,
    agents: [{ ...discovery.agents[0], website: "javascript:alert(1)" }],
  })) as typeof fetch);
  await assert.rejects(unsafeWebsite.discoverAgents(), /absolute HTTP\(S\) URL/);
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

test("paper intake status has a review-sized response envelope", async () => {
  const validStatus = {
    job_id: "job-1",
    source_digest: "blake3:test",
    phase: "completed",
    durations_ms: {},
    cache: { extraction: false, reconstruction: false },
    result: {
      extracted_via: "text",
      outcome: "no_reconstructable_methods",
      warnings: [],
      mentions: [],
      resources: [],
      candidates: [],
    },
  };
  const accepted = createSomiteClient("http://runner.test", (async () => new Response(JSON.stringify(validStatus), {
    headers: {
      "content-type": "application/json",
      "content-length": String(MAX_PAPER_REVIEW_BYTES + 1),
    },
  })) as typeof fetch);
  assert.equal((await accepted.paperIntakeStatus("job-1")).phase, "completed");

  const rejected = createSomiteClient("http://runner.test", (async () => new Response(JSON.stringify(validStatus), {
    headers: {
      "content-type": "application/json",
      "content-length": String(MAX_PAPER_STATUS_BYTES + 1),
    },
  })) as typeof fetch);
  await assert.rejects(
    rejected.paperIntakeStatus("job-1"),
    (error: unknown) => error instanceof ResponseContractError && /exceeds/.test(error.message),
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

test("Agent transaction graphs are returned in their normalized runtime form", async () => {
  const client = createSomiteClient("http://runner.test", (async () => json({
    connected: true,
    connecting: false,
    busy: false,
    config_options: [],
    cursor: 1,
    events: [{
      cursor: 1,
      recorded_at_unix_ms: 1,
      kind: "transaction",
      title: "Changed canvas",
      transaction: {
        transaction_id: "transaction-1",
        previous_state_revision: "state-test",
        state_revision: "state-next",
        graph_revision: "graph-next",
        summary: "Added a node",
        graph: { schema_version: 3, name: "Normalized", nodes: [] },
      },
    }],
  })) as typeof fetch);

  const snapshot = await client.agentEvents(0);
  assert.deepEqual(snapshot.events[0]?.transaction?.graph.edges, []);
});

test("Agent polling uses its shared snapshot envelope instead of the generic JSON cap", async () => {
  const payload = `${" ".repeat(16 * 1024 * 1024 + 1)}${JSON.stringify({
    connected: true,
    connecting: false,
    busy: false,
    config_options: [],
    cursor: 0,
    events: [],
  })}`;
  const client = createSomiteClient("http://runner.test", (async () => new Response(payload)) as typeof fetch);
  assert.equal((await client.agentEvents(0)).connected, true);

  const oversized = createSomiteClient("http://runner.test", (async () => new Response(null, {
    headers: { "content-length": String(MAX_AGENT_SNAPSHOT_BYTES + 1) },
  })) as typeof fetch);
  await assert.rejects(
    oversized.agentEvents(0),
    (error: unknown) => error instanceof ResponseContractError && /exceeds/.test(error.message),
  );
});

test("empty command endpoints reject response drift", async () => {
  const valid = createSomiteClient("http://runner.test", (async () => new Response(null, { status: 204 })) as typeof fetch);
  await valid.cancelAgent();

  const malformed = createSomiteClient("http://runner.test", (async () => json({ ok: true })) as typeof fetch);
  await assert.rejects(malformed.disconnectAgent(), ResponseContractError);
});

test("JSON responses reject and cancel a malformed Content-Length", async () => {
  let cancelled = false;
  const client = createSomiteClient("http://runner.test", (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      cancelled = true;
    },
  }), { headers: { "content-length": "not-a-byte-count" } })) as typeof fetch);

  await assert.rejects(
    client.system(),
    (error: unknown) => error instanceof ResponseContractError && /invalid Content-Length/.test(error.message),
  );
  assert.equal(cancelled, true);
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

test("export downloads enforce the frozen-package response envelope", async () => {
  const client = createSomiteClient("http://runner.test", (async () => new Response(new Uint8Array(), {
    headers: { "content-length": String(MAX_FROZEN_PACKAGE_BYTES + 1), "content-type": "application/zip" },
  })) as typeof fetch);

  await assert.rejects(
    client.downloadExport({ graph }),
    (error: unknown) => error instanceof ResponseContractError && error.endpoint === "/api/export",
  );
});

test("export downloads require both ZIP media type and signature", async () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const valid = createSomiteClient("http://runner.test", (async () => new Response(zip, {
    headers: { "content-type": "application/zip; charset=binary" },
  })) as typeof fetch);
  const archive = await valid.downloadExport({ graph });
  assert.equal(archive.type, "application/zip");
  assert.equal(archive.size, 4);

  const wrongType = createSomiteClient("http://runner.test", (async () => new Response(zip, {
    headers: { "content-type": "text/html" },
  })) as typeof fetch);
  await assert.rejects(wrongType.downloadExport({ graph }), /content-type must be application\/zip/);

  const wrongSignature = createSomiteClient("http://runner.test", (async () => new Response(new TextEncoder().encode("not zip"), {
    headers: { "content-type": "application/zip" },
  })) as typeof fetch);
  await assert.rejects(wrongSignature.downloadExport({ graph }), /not a ZIP archive/);
});

test("export downloads cancel a response stream rejected by media type", async () => {
  let cancelled = false;
  const client = createSomiteClient("http://runner.test", (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  }), {
    headers: { "content-type": "text/html" },
  })) as typeof fetch);

  await assert.rejects(client.downloadExport({ graph }), /content-type must be application\/zip/);
  assert.equal(cancelled, true);
});

test("ZIP export preserves bounded chunks and validates a split signature", async () => {
  const parts = [
    new Uint8Array([0x50]),
    new Uint8Array([0x4b, 0x03]),
    new Uint8Array([0x04, 0x01, 0x02]),
  ];
  const exact = await boundedZipBlob(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  })), "/api/export", 6);
  assert.equal(exact.type, "application/zip");
  assert.deepEqual([...new Uint8Array(await exact.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);

  let cancelled = false;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(3)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(
    boundedZipBlob(oversized, "/api/export", 4),
    (error: unknown) => error instanceof ResponseContractError && /exceeds/.test(error.message),
  );
  assert.equal(cancelled, true);

  let invalidCancelled = false;
  let invalidPulls = 0;
  const invalid = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      invalidPulls += 1;
      controller.enqueue(new Uint8Array([0, 1, 2, 3]));
    },
    cancel() { invalidCancelled = true; },
  }));
  await assert.rejects(boundedZipBlob(invalid, "/api/export", 64), /not a ZIP archive/);
  assert.equal(invalidCancelled, true);
  assert.ok(invalidPulls <= 2, `invalid ZIP pulled ${invalidPulls} chunks`);
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
