import { URL } from "node:url";

import { MAX_ACP_CONTROL_FRAME_BYTES, MAX_WORKFLOW_REQUEST_BYTES } from "@somite/workflow/limits";
import { boundedResponseBytes } from "@somite/workflow/boundedResponse";
import { SOMITE_VERSION } from "@somite/workflow/version";
import { boundedNdjsonStream } from "./boundedNdjson.ts";
import { MCP_OUTPUT_SCHEMAS } from "./mcpSchemas.ts";
import { SOMITE_MCP_TOOL, type SomiteMcpToolName } from "./mcpTools.ts";

const MAX_MCP_TEXT_MIRROR_BYTES = 64 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 8;
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
const parameterValueSchema: JsonObject = {
  type: ["string", "number", "boolean"],
  description: "One browser-stable operator parameter value: string, finite number, or boolean.",
};
const noteSchema: JsonObject = {
  type: ["string", "null"],
  maxLength: 4_096,
  pattern: "^[^\\u0000]*$",
  description: "Node note text (at most 4,096 UTF-8 bytes), or null to remove it.",
};
const sourcePromotionSchema: JsonObject = {
  ...objectSchema({
    base_state_revision: stateSchema,
    workflow_revision: stringSchema("Exact current source workflow revision."),
    invocation_id: stringSchema("One exact source invocation id with a selected replacement."),
    invocation_ids: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: stringSchema("Exact source invocation id with a selected replacement."),
      description: "One to 64 source calls to promote atomically into the current native variant.",
    },
    idempotency_key: keySchema,
    summary: summarySchema,
  }, ["base_state_revision", "workflow_revision", "idempotency_key", "summary"]),
  oneOf: [{ required: ["invocation_id"] }, { required: ["invocation_ids"] }],
};

function identifierSchema(description: string): JsonObject {
  return stringSchema(description, { minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.-]+$" });
}

function parameterRecordSchema(description: string): JsonObject {
  return { type: "object", description, additionalProperties: parameterValueSchema };
}

function taggedObjectSchema(
  discriminator: "op" | "kind" | "action",
  tag: string,
  title: string,
  description: string,
  properties: JsonObject,
  required: string[],
): JsonObject {
  return {
    ...objectSchema({
      [discriminator]: { type: "string", const: tag, description: `${discriminator} discriminator; use exactly ${JSON.stringify(tag)}.` },
      ...properties,
    }, [discriminator, ...required]),
    title,
    description,
  };
}

const workflowBindingSchema: JsonObject = {
  type: "object",
  description: "Explicit source-workflow parameter binding, discriminated by kind.",
  oneOf: [
    taggedObjectSchema("kind", "project_file", "Project file binding", "Bind the parameter to one safe project-relative file.", {
      path: stringSchema("Safe project-relative file path resolved from the workflow input location.", { minLength: 1 }),
    }, ["path"]),
    taggedObjectSchema("kind", "project_directory", "Project directory binding", "Bind the parameter to one safe project-relative directory.", {
      path: stringSchema("Safe project-relative directory path resolved from the workflow input location.", { minLength: 1 }),
    }, ["path"]),
    taggedObjectSchema("kind", "literal", "Literal parameter binding", "Bind the parameter to one literal value accepted by its indexed source schema.", {
      value: parameterValueSchema,
    }, ["value"]),
  ],
};

const sourceWorkflowEditSchema: JsonObject = {
  type: "object",
  description: "Exactly one typed source-workflow edit, discriminated by kind.",
  oneOf: [
    taggedObjectSchema("kind", "set_parameter", "Set source parameter", "Set one indexed source-workflow parameter with an explicit binding.", {
      name: stringSchema("Exact parameter name returned by the indexed source workflow.", { minLength: 1 }),
      binding: workflowBindingSchema,
    }, ["name", "binding"]),
    taggedObjectSchema("kind", "reset_parameter", "Reset source parameter", "Remove one explicit binding and restore the source workflow's default behavior.", {
      name: stringSchema("Exact parameter name returned by the indexed source workflow.", { minLength: 1 }),
    }, ["name"]),
    taggedObjectSchema("kind", "replace_invocation", "Replace source invocation", "Select one reviewed native operator contract for an indexed source invocation.", {
      invocation_id: stringSchema("Exact invocation id returned by the indexed source workflow.", { minLength: 1 }),
      operator: identifierSchema("Exact reviewed native operator id returned by somite.catalog.search."),
      operator_revision: stringSchema("Exact immutable operator revision returned with that catalog match.", { minLength: 1 }),
      params: parameterRecordSchema("Optional declared parameters for the reviewed replacement operator."),
    }, ["invocation_id", "operator", "operator_revision"]),
    taggedObjectSchema("kind", "reset_invocation", "Reset source invocation", "Remove the selected native replacement from one indexed source invocation.", {
      invocation_id: stringSchema("Exact invocation id returned by the indexed source workflow.", { minLength: 1 }),
    }, ["invocation_id"]),
  ],
};

const graphOperationSchema: JsonObject = {
  type: "object",
  description: "Exactly one atomic native graph operation, discriminated by op.",
  oneOf: [
    taggedObjectSchema("op", "add_operator", "Add native operator", "Add one reviewed catalog operator as a new editable node.", {
      node_id: identifierSchema("New unique node id chosen for this graph."),
      operator_id: identifierSchema("Exact reviewed native operator id returned by somite.catalog.search."),
      params: parameterRecordSchema("Optional declared operator parameters; omit values that should use catalog defaults."),
      x: { type: "number", description: "Optional finite canvas x coordinate; defaults to 0." },
      y: { type: "number", description: "Optional finite canvas y coordinate; defaults to 0." },
      note: noteSchema,
    }, ["node_id", "operator_id"]),
    taggedObjectSchema("op", "remove_node", "Remove node", "Remove one existing node and all of its incident edges.", {
      node_id: identifierSchema("Exact id of the existing node to remove."),
    }, ["node_id"]),
    taggedObjectSchema("op", "set_param", "Set node parameter", "Set one declared parameter on an existing native node.", {
      node_id: identifierSchema("Exact id of the existing native node."),
      parameter: identifierSchema("Exact parameter name declared by that node's pinned operator contract."),
      value: parameterValueSchema,
    }, ["node_id", "parameter", "value"]),
    taggedObjectSchema("op", "unset_param", "Reset node parameter", "Remove one explicit parameter value, restoring its default when the contract has one.", {
      node_id: identifierSchema("Exact id of the existing native node."),
      parameter: identifierSchema("Exact parameter name declared by that node's pinned operator contract."),
    }, ["node_id", "parameter"]),
    taggedObjectSchema("op", "connect", "Connect nodes", "Add one typed edge between exact ports on two existing nodes.", {
      edge_id: identifierSchema("New unique edge id chosen for this graph."),
      from_node: identifierSchema("Exact id of the source node."),
      from_port: identifierSchema("Exact output port name from the source node contract."),
      to_node: identifierSchema("Exact id of the destination node."),
      to_port: identifierSchema("Exact input port name from the destination node contract."),
    }, ["edge_id", "from_node", "from_port", "to_node", "to_port"]),
    taggedObjectSchema("op", "disconnect", "Disconnect nodes", "Remove one existing graph edge without removing either node.", {
      edge_id: identifierSchema("Exact id of the existing edge to remove."),
    }, ["edge_id"]),
    taggedObjectSchema("op", "set_note", "Set node note", "Set or remove the non-executable note on one existing node.", {
      node_id: identifierSchema("Exact id of the existing node."),
      note: noteSchema,
    }, ["node_id", "note"]),
  ],
};

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
    edits: { type: "array", minItems: 1, maxItems: 64, description: "One to 64 ordered typed source-workflow edits.", items: sourceWorkflowEditSchema },
  }, ["base_state_revision", "workflow_revision", "idempotency_key", "summary", "edits"]), { readOnlyHint: false, destructiveHint: true }),
  tool(SOMITE_MCP_TOOL.sourceWorkflowPromote, "Promote source calls", "Promote one or more selected source invocation replacements into ordinary editable typed nodes while retaining source provenance.", sourcePromotionSchema, { readOnlyHint: false, destructiveHint: true }),
  tool(SOMITE_MCP_TOOL.sourceSearch, "Search scientific sources", "Search current NCBI or Ensembl records for accessions, organisms, reads, assemblies, references, or genes.", objectSchema({
    query: stringSchema("Scientific entity, accession, organism, assembly, run, or gene.", { minLength: 2, maxLength: 120 }),
    provider: { type: "string", enum: ["ncbi", "ensembl"] },
  }, ["query", "provider"]), { openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.operatorCandidateDraft, "Draft project operator", "Submit one evidence-backed project-local external Operator candidate. This does not admit it to the executable catalog.", objectSchema({
    operator: { type: "object", description: "Complete Operator contract using a project.* id, typed ports, argv, outputs, and Pixi requirements.", additionalProperties: true },
    sources: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: objectSchema({
        kind: { type: "string", enum: ["official_docs", "source", "package_recipe", "workflow_use"] },
        url: stringSchema("Credential-free authoritative HTTPS URL."),
      }, ["kind", "url"]),
    },
  }, ["operator", "sources"]), { readOnlyHint: false, openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.operatorCandidateProve, "Test project operator", "Run one ready tiny fixture graph containing the exact draft candidate in an isolated Pixi-frozen Nextflow execution.", objectSchema({
    candidate_id: stringSchema("Exact project.* candidate id."),
    graph: { type: "object", description: "Complete ready Somite fixture graph containing the exact candidate once.", additionalProperties: true },
    idempotency_key: keySchema,
  }, ["candidate_id", "graph", "idempotency_key"]), { readOnlyHint: false, openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.operatorProofStatus, "Inspect operator proof", "Poll one Operator Workshop proof to terminal evidence.", objectSchema({
    proof_id: stringSchema("Proof id returned by operator_candidate.prove."),
    wait_ms: { type: "integer", minimum: 0, maximum: 25_000, default: 0 },
  }, ["proof_id"])),
  tool(SOMITE_MCP_TOOL.resource, "Manage scientific resource", "Install, inspect, or cancel one reviewed scientific resource. Before install, tell the user its declared download, stored size, and scientific effect from readiness and obtain explicit agreement.", {
    type: "object",
    additionalProperties: false,
    description: "One managed-resource action, discriminated by action.",
    oneOf: [
      taggedObjectSchema("action", "install", "Install resource", "Start one reviewed, checksum-pinned provider after explicit user agreement.", {
        profile: stringSchema("Exact resource profile from readiness."),
        resolution: stringSchema("Exact downloadable resolution id from readiness."),
        idempotency_key: keySchema,
      }, ["profile", "resolution", "idempotency_key"]),
      taggedObjectSchema("action", "status", "Inspect resource", "Wait for or inspect one managed-resource job.", {
        job_id: stringSchema("Exact job id returned by install."),
        wait_ms: { type: "integer", minimum: 0, maximum: 25_000, default: 0 },
      }, ["job_id"]),
      taggedObjectSchema("action", "cancel", "Cancel resource", "Cancel one active managed-resource job and remove its partial data.", {
        job_id: stringSchema("Exact active job id."),
      }, ["job_id"]),
    ],
  }, { readOnlyHint: false, openWorldHint: true }),
  tool(SOMITE_MCP_TOOL.graphApplyTransaction, "Edit Somite workflow", "Apply one small atomic typed graph edit against the latest state revision.", objectSchema({
    base_state_revision: stateSchema,
    idempotency_key: keySchema,
    summary: summarySchema,
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      description: "One to 64 ordered native graph operations committed atomically.",
      items: graphOperationSchema,
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
  if (server.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(server.hostname)
    || server.username
    || server.password
    || server.pathname !== "/"
    || server.search
    || server.hash) {
    throw new Error("Somite MCP requires a credential-free loopback HTTP origin");
  }
  const capability = process.env.SOMITE_MCP_RUNTIME_CAPABILITY;
  if (!capability || !/^[a-f0-9]{64}$/.test(capability)) throw new Error("Somite MCP runtime capability is missing");
  return { server, capability };
}

const options = parseOptions();
const active = new Map<JsonRpcId, AbortController>();

async function responseBytes(response: Response) {
  return boundedResponseBytes(response, MAX_WORKFLOW_REQUEST_BYTES);
}

async function http(method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal, milliseconds = 30_000) {
  const timeoutSignal = AbortSignal.timeout(milliseconds);
  const combined = AbortSignal.any([signal, timeoutSignal]);
  const response = await fetch(new URL(path, options.server), {
    method,
    signal: combined,
    redirect: "error",
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
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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
  if (name === SOMITE_MCP_TOOL.operatorCandidateDraft) return http("POST", "/api/operator-workshop/candidates", args, signal);
  if (name === SOMITE_MCP_TOOL.operatorCandidateProve) return http("POST", `/api/operator-workshop/candidates/${encodeURIComponent(requiredString(args.candidate_id, "candidate_id"))}/proofs`, { graph: args.graph, idempotency_key: args.idempotency_key }, signal, 300_000);
  if (name === SOMITE_MCP_TOOL.operatorProofStatus) return http("GET", query(`/api/operator-workshop/proofs/${encodeURIComponent(requiredString(args.proof_id, "proof_id"))}`, { wait_ms: args.wait_ms ?? 0 }), undefined, signal, 30_000);
  if (name === SOMITE_MCP_TOOL.resource) {
    const action = requiredString(args.action, "action");
    if (action === "install") return http("POST", "/api/resources/install", { profile: args.profile, resolution: args.resolution, idempotency_key: args.idempotency_key }, signal, 300_000);
    const jobId = encodeURIComponent(requiredString(args.job_id, "job_id"));
    if (action === "status") return http("GET", query(`/api/resources/jobs/${jobId}`, { wait_ms: args.wait_ms ?? 0 }), undefined, signal, 30_000);
    if (action === "cancel") return http("POST", `/api/resources/jobs/${jobId}/cancel`, {}, signal);
    throw new Error(`unknown managed resource action ${action}`);
  }
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
  const serialized = JSON.stringify(value);
  const serializedBytes = Buffer.byteLength(serialized);
  return {
    content: [{
      type: "text",
      text: serializedBytes <= MAX_MCP_TEXT_MIRROR_BYTES
        ? serialized
        : `Somite returned a ${serializedBytes}-byte structured result. Read structuredContent for the complete value.`,
    }],
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

let outputChain = Promise.resolve();

function write(value: unknown) {
  let serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_ACP_CONTROL_FRAME_BYTES) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
    serialized = JSON.stringify({
      jsonrpc: "2.0",
      id: typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : null,
      error: { code: -32603, message: `MCP response exceeds ${MAX_ACP_CONTROL_FRAME_BYTES} bytes.` },
    });
  }
  const frame = `${serialized}\n`;
  const queued = outputChain.then(() => new Promise<void>((resolvePromise, rejectPromise) => {
    process.stdout.write(frame, (error) => error ? rejectPromise(error) : resolvePromise());
  }));
  outputChain = queued.catch(() => undefined);
  return queued;
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
    await write({ jsonrpc: "2.0", id, result: await dispatch(message.method, message.params, controller.signal) });
  } catch (cause) {
    const failure = cause as Error & { code?: number };
    await write({ jsonrpc: "2.0", id, error: { code: failure.code ?? -32603, message: failure.message || String(cause) } });
  } finally {
    active.delete(id);
  }
}

const framedInput = process.stdin.pipe(boundedNdjsonStream(MAX_ACP_CONTROL_FRAME_BYTES));
for await (const chunk of framedInput) {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(chunk);
  for (const candidate of decoded.split("\n")) {
    const line = candidate.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const message = value as JsonObject;
      const id = message.id;
      if ((typeof id === "string" || typeof id === "number") && active.has(id)) {
        await write({ jsonrpc: "2.0", id, error: { code: -32600, message: "duplicate in-flight request id" } });
        continue;
      }
      if ((typeof id === "string" || typeof id === "number") && active.size >= MAX_IN_FLIGHT_REQUESTS) {
        await write({ jsonrpc: "2.0", id, error: { code: -32000, message: `Somite MCP allows at most ${MAX_IN_FLIGHT_REQUESTS} in-flight requests.` } });
        continue;
      }
    }
    void handle(value);
  }
}
