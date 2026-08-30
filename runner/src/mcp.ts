import { URL } from "node:url";

import { SOMITE_VERSION } from "@somite/workflow/version";
import { MCP_OUTPUT_SCHEMAS } from "./mcpSchemas.ts";
import { SOMITE_MCP_TOOL, type SomiteMcpToolName } from "./mcpTools.ts";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const LEGACY_PROTOCOLS = new Set(["2024-10-07", "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const LATEST_LEGACY_PROTOCOL = "2025-11-25";
const MODERN_PROTOCOL = "2026-07-28";

type JsonRpcId = string | number;
type JsonObject = Record<string, unknown>;
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
};

const objectSchema = (properties: JsonObject = {}, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const stringSchema = (description: string, extra: JsonObject = {}): JsonObject => ({ type: "string", description, ...extra });
const keySchema = stringSchema("Stable retry key for this identical action.", { pattern: "^[A-Za-z0-9_-]{8,128}$" });
const stateSchema = stringSchema("Exact state_revision returned by somite.workflow.get.");
const summarySchema = stringSchema("Short user-facing description of this canvas edit.", { minLength: 1, maxLength: 240 });

function tool(
  name: SomiteMcpToolName,
  title: string,
  description: string,
  inputSchema: JsonObject,
  behavior: Partial<Tool["annotations"]> = {},
): Tool {
  return {
    name,
    title,
    description,
    inputSchema,
    outputSchema: MCP_OUTPUT_SCHEMAS[name],
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      ...behavior,
    },
  };
}

const TOOLS: Tool[] = [
  tool(SOMITE_MCP_TOOL.workflowGet, "Inspect Somite workflow", "Read the current typed graph and its full canvas and semantic revisions.", objectSchema()),
  tool(SOMITE_MCP_TOOL.readinessGet, "Inspect Somite readiness", "List every deterministic missing input, parameter, dependency, resource, and known resolution.", objectSchema()),
  tool(SOMITE_MCP_TOOL.catalogSearch, "Search Somite tools", "Search revision-pinned operator contracts. Never invent operator ids, ports, revisions, or parameters.", objectSchema({
    query: stringSchema("Short operator, artifact, or task phrase.", { minLength: 1, maxLength: 120 }),
    limit: { type: "integer", minimum: 1, maximum: 50, default: 12 },
    cursor: stringSchema("Opaque cursor from an earlier search page."),
  }, ["query"])),
  tool(SOMITE_MCP_TOOL.sourceWorkflowSearchNfcore, "Search nf-core workflows", "Search the official nf-core catalog for exact repository and release pairs.", objectSchema({
    query: stringSchema("Pipeline name, topic, or scientific purpose.", { minLength: 1, maxLength: 120 }),
    limit: { type: "integer", minimum: 1, maximum: 50, default: 12 },
  }, ["query"]), { openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.sourceWorkflowResolveNfcore, "Resolve nf-core workflow", "Place one exact, pinned nf-core release on an unchanged empty canvas.", objectSchema({
    workflow: stringSchema("Exact nf-core repository such as nf-core/rnaseq."),
    revision: stringSchema("Exact catalog-advertised release tag."),
    base_state_revision: stateSchema,
    idempotency_key: keySchema,
    summary: summarySchema,
  }, ["workflow", "revision", "base_state_revision", "idempotency_key", "summary"]), { readOnlyHint: false, openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.sourceWorkflowEdit, "Edit source workflow", "Apply typed parameter or invocation-replacement edits to a pinned source workflow.", objectSchema({
    base_state_revision: stateSchema,
    workflow_revision: stringSchema("Exact current source workflow revision."),
    idempotency_key: keySchema,
    summary: summarySchema,
    edits: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } },
  }, ["base_state_revision", "workflow_revision", "idempotency_key", "summary", "edits"]), { readOnlyHint: false, destructiveHint: true }),
  tool(SOMITE_MCP_TOOL.sourceWorkflowPromote, "Promote source call", "Promote one selected source invocation replacement into an ordinary editable typed node.", objectSchema({
    base_state_revision: stateSchema,
    workflow_revision: stringSchema("Exact current source workflow revision."),
    invocation_id: stringSchema("Exact source invocation id that has a selected replacement."),
    idempotency_key: keySchema,
    summary: summarySchema,
  }, ["base_state_revision", "workflow_revision", "invocation_id", "idempotency_key", "summary"]), { readOnlyHint: false, destructiveHint: true }),
  tool(SOMITE_MCP_TOOL.sourceSearch, "Search scientific sources", "Search current NCBI or Ensembl records for accessions, organisms, reads, assemblies, references, or genes.", objectSchema({
    query: stringSchema("Scientific entity, accession, organism, assembly, run, or gene.", { minLength: 2, maxLength: 120 }),
    provider: { type: "string", enum: ["ncbi", "ensembl"] },
  }, ["query", "provider"]), { openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.graphApplyTransaction, "Edit Somite workflow", "Apply one small atomic typed graph edit against the latest state revision.", objectSchema({
    base_state_revision: stateSchema,
    idempotency_key: keySchema,
    summary: summarySchema,
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        required: ["op"],
        properties: { op: { enum: ["add_operator", "remove_node", "set_param", "unset_param", "connect", "disconnect", "set_note"] } },
      },
    },
  }, ["base_state_revision", "idempotency_key", "summary", "operations"]), { readOnlyHint: false, destructiveHint: true }),
  tool(SOMITE_MCP_TOOL.workflowCompile, "Compile Somite workflow", "Freeze the ready graph into content-addressed Nextflow and Pixi artifacts.", objectSchema(), { readOnlyHint: false, openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.runStart, "Run Somite workflow", "Start a real Nextflow run through the Pixi-frozen runtime.", objectSchema({ idempotency_key: keySchema }, ["idempotency_key"]), { readOnlyHint: false, openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.validationStart, "Validate Somite workflow", "Start representative-data validation and produce immutable evidence.", objectSchema({ idempotency_key: keySchema }, ["idempotency_key"]), { readOnlyHint: false, openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.runStatus, "Inspect Somite run", "Read run lifecycle, node states, closure identity, and evidence.", objectSchema({
    run_id: stringSchema("Run id returned by run.start or validation.start."),
    wait_ms: { type: "integer", minimum: 0, maximum: 25_000, default: 0 },
  }, ["run_id"])),
  tool(SOMITE_MCP_TOOL.runCancel, "Cancel Somite run", "Cancel an active run or validation and its process tree.", objectSchema({ run_id: stringSchema("Run id to cancel.") }, ["run_id"]), { readOnlyHint: false, destructiveHint: true }),
  tool(SOMITE_MCP_TOOL.evidenceLookup, "Inspect Somite evidence", "Read immutable validation receipts for a semantic graph revision.", objectSchema({ subject_digest: stringSchema("Optional graph_revision; omit for the current graph.") })),
];

function argumentsObject(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool arguments must be an object");
  return value as JsonObject;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function parseOptions() {
  const index = process.argv.indexOf("--server-url");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--server-url is required");
  const server = new URL(process.argv[index + 1]!);
  if (server.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(server.hostname)) {
    throw new Error("Somite MCP only connects to a loopback HTTP runner");
  }
  const capability = process.env.SOMITE_MCP_RUNTIME_CAPABILITY;
  if (!capability || !/^[a-f0-9]{64}$/.test(capability)) throw new Error("Somite MCP runtime capability is missing");
  return { server, capability };
}

const options = parseOptions();
const active = new Map<JsonRpcId, AbortController>();

async function responseBytes(response: Response) {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(announced) && announced > MAX_MESSAGE_BYTES) throw new Error("Somite response is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error("Somite response is too large");
  return bytes;
}

async function http(method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal, milliseconds = 30_000) {
  const timeoutSignal = AbortSignal.timeout(milliseconds);
  const combined = AbortSignal.any([signal, timeoutSignal]);
  const response = await fetch(new URL(path, options.server), {
    method,
    signal: combined,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-somite-mcp-capability": options.capability,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const bytes = await responseBytes(response);
  let value: unknown = {};
  if (bytes.byteLength) {
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(`Somite returned invalid JSON (HTTP ${response.status})`);
    }
  }
  if (!response.ok) {
    const bodyObject = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
    const failure = new Error(typeof bodyObject.error === "string" ? bodyObject.error : `Somite returned HTTP ${response.status}`);
    Object.assign(failure, { detail: value, status: response.status });
    throw failure;
  }
  return value;
}

async function currentGraph(signal: AbortSignal) {
  return http("GET", "/api/agent/graph", undefined, signal) as Promise<{ graph: unknown; graph_revision: string }>;
}

function query(path: string, fields: Record<string, unknown>) {
  const url = new URL(path, options.server);
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  }
  return `${url.pathname}${url.search}`;
}

async function callTool(name: string, value: unknown, signal: AbortSignal) {
  const args = argumentsObject(value);
  if (name === SOMITE_MCP_TOOL.workflowGet) return http("GET", "/api/agent/graph", undefined, signal);
  if (name === SOMITE_MCP_TOOL.readinessGet) return http("GET", "/api/agent/readiness", undefined, signal);
  if (name === SOMITE_MCP_TOOL.catalogSearch) return http("GET", query("/api/agent/catalog", { q: args.query, limit: args.limit ?? 12, cursor: args.cursor }), undefined, signal);
  if (name === SOMITE_MCP_TOOL.sourceWorkflowSearchNfcore) return http("GET", query("/api/source-workflows/nfcore/search", { q: args.query, limit: args.limit ?? 12 }), undefined, signal);
  if (name === SOMITE_MCP_TOOL.sourceWorkflowResolveNfcore) return http("POST", "/api/agent/source-workflows/nfcore/resolve", args, signal, 300_000);
  if (name === SOMITE_MCP_TOOL.sourceWorkflowEdit) return http("POST", "/api/agent/source-workflows/edit", args, signal);
  if (name === SOMITE_MCP_TOOL.sourceWorkflowPromote) return http("POST", "/api/agent/source-workflows/promote", args, signal);
  if (name === SOMITE_MCP_TOOL.sourceSearch) return http("GET", query("/api/sources/search", { q: args.query, provider: args.provider }), undefined, signal);
  if (name === SOMITE_MCP_TOOL.graphApplyTransaction) return http("POST", "/api/agent/transactions", args, signal);
  if (name === SOMITE_MCP_TOOL.workflowCompile) return http("POST", "/api/agent/compile", {}, signal, 300_000);
  if (name === SOMITE_MCP_TOOL.runStart || name === SOMITE_MCP_TOOL.validationStart) {
    const workflow = await currentGraph(signal);
    const path = name === SOMITE_MCP_TOOL.runStart ? "/api/runs" : "/api/validations";
    return http("POST", query(path, { idempotency_key: args.idempotency_key }), workflow.graph, signal, 300_000);
  }
  if (name === SOMITE_MCP_TOOL.runStatus) return http("GET", query(`/api/runs/${encodeURIComponent(requiredString(args.run_id, "run_id"))}`, { wait_ms: args.wait_ms ?? 0 }), undefined, signal, 30_000);
  if (name === SOMITE_MCP_TOOL.runCancel) return http("POST", `/api/runs/${encodeURIComponent(requiredString(args.run_id, "run_id"))}/cancel`, {}, signal);
  if (name === SOMITE_MCP_TOOL.evidenceLookup) return http("GET", query("/api/agent/evidence", { subject: args.subject_digest }), undefined, signal);
  throw new Error(`unknown Somite tool ${name}`);
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolFailure(cause: unknown) {
  const failure = cause as Error & { detail?: unknown; status?: number };
  const value = {
    error: {
      code: failure.name === "TimeoutError" ? "timeout" : "somite_tool_error",
      message: failure.message || String(cause),
      retryable: failure.status !== undefined && failure.status >= 500,
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
    },
  };
  return { ...toolResult(value), isError: true };
}

async function dispatch(method: string, params: unknown, signal: AbortSignal) {
  if (method === "server/discover") return {
    supportedVersions: [MODERN_PROTOCOL, LATEST_LEGACY_PROTOCOL],
    capabilities: { tools: { listChanged: false } },
    instructions: "Somite is a visual bioinformatics workflow compiler. Inspect the workflow before editing, use exact catalog contracts, and validate before claiming a workflow runs.",
  };
  if (method === "initialize") {
    const requested = params && typeof params === "object" && !Array.isArray(params) ? (params as JsonObject).protocolVersion : undefined;
    return {
      protocolVersion: typeof requested === "string" && LEGACY_PROTOCOLS.has(requested) ? requested : LATEST_LEGACY_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "somite", title: "Somite", version: SOMITE_VERSION },
      instructions: "Inspect the current workflow before each edit. Use exact catalog contracts and current state revisions. Resolve readiness before compile, run, or validation.",
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    const raw = argumentsObject(params);
    const name = requiredString(raw.name, "tool name");
    try {
      return await callTool(name, raw.arguments, signal).then(toolResult);
    } catch (cause) {
      return toolFailure(cause);
    }
  }
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

function write(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const message = value as JsonObject;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  if (message.method === "notifications/cancelled") {
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params as JsonObject : {};
    const requestId = params.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") active.get(requestId)?.abort();
    return;
  }
  if (message.id === undefined) return;
  if (typeof message.id !== "string" && typeof message.id !== "number") return;
  const id = message.id;
  const controller = new AbortController();
  active.set(id, controller);
  try {
    write({ jsonrpc: "2.0", id, result: await dispatch(message.method, message.params, controller.signal) });
  } catch (cause) {
    const failure = cause as Error & { code?: number };
    write({ jsonrpc: "2.0", id, error: { code: failure.code ?? -32603, message: failure.message || String(cause) } });
  } finally {
    active.delete(id);
  }
}

let buffer = "";
for await (const chunk of process.stdin) {
  buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) throw new Error("MCP message is too large");
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    void handle(value);
  }
}
