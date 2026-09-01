import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SOMITE_VERSION } from "@somite/workflow/version";
import { MCP_OUTPUT_SCHEMAS } from "../src/mcpSchemas.ts";
import { SOMITE_MCP_TOOL_NAMES, type SomiteMcpToolName } from "../src/mcpTools.ts";
import { startServer } from "../src/server.ts";

type RpcResponse = { id: number; result?: Record<string, unknown>; error?: Record<string, unknown> };
type JsonSchema = Record<string, unknown>;

const REQUIRED_SUCCESS_FIELDS = {
  "somite.workflow.get": ["state_revision", "graph_revision", "graph"],
  "somite.readiness.get": ["graph_revision", "state", "required_count", "items", "nodes"],
  "somite.catalog.search": ["query", "catalog_revision", "total_matches", "matches"],
  "somite.source_workflow.search_nfcore": ["query", "provenance", "total_matches", "entries"],
  "somite.source_workflow.resolve_nfcore": ["transaction_id", "previous_state_revision", "state_revision", "graph_revision", "graph", "replayed"],
  "somite.source_workflow.resolve_github": ["transaction_id", "previous_state_revision", "state_revision", "graph_revision", "graph", "replayed"],
  "somite.source_workflow.edit": ["transaction_id", "previous_state_revision", "state_revision", "graph_revision", "graph", "replayed"],
  "somite.source_workflow.promote": ["transaction_id", "previous_state_revision", "state_revision", "graph_revision", "graph", "replayed"],
  "somite.source.search": ["query", "provider", "results"],
  "somite.operator_candidate.draft": ["schema_version", "candidate_id", "operator", "sources", "created_at", "status"],
  "somite.operator_candidate.prove": ["proof_id", "replayed"],
  "somite.operator_proof.status": ["proof_id", "candidate_id", "run"],
  "somite.resource": ["job_id", "provider_id", "profile", "resolution", "phase", "progress"],
  "somite.graph.apply_transaction": ["transaction_id", "previous_state_revision", "state_revision", "graph_revision", "graph", "replayed"],
  "somite.workflow.compile": ["source_graph_revision", "closure_digest", "compiled_graph_revision", "output_path"],
  "somite.run.start": ["run_id", "phase", "replayed"],
  "somite.validation.start": ["run_id", "phase", "replayed"],
  "somite.run.status": ["run_id", "phase", "states", "progress"],
  "somite.run.cancel": ["run_id", "phase", "states", "progress"],
  "somite.evidence.lookup": ["subject_digest", "receipts"],
} as const satisfies Record<SomiteMcpToolName, readonly string[]>;

async function unusedPort() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolvePromise, rejectPromise) => reservation.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return address.port;
}

function valueType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function validationErrors(schema: JsonSchema, value: unknown, path = "$"): string[] {
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => validationErrors(candidate as JsonSchema, value, path).length === 0);
    return matches.length === 1 ? [] : [`${path} matched ${matches.length} oneOf branches`];
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((candidate) => validationErrors(candidate as JsonSchema, value, path).length === 0)
      ? []
      : [`${path} did not match anyOf`];
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) return [`${path} must equal ${JSON.stringify(schema.const)}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => candidate === value)) return [`${path} is outside the enum`];

  const acceptedTypes = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  if (acceptedTypes.length) {
    const actual = valueType(value);
    const matches = acceptedTypes.some((expected) => expected === actual || (expected === "number" && actual === "integer"));
    if (!matches) return [`${path} expected ${acceptedTypes.join(" or ")}, received ${actual}`];
  }

  const errors: string[] = [];
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path} does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is less than ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} is greater than ${schema.maximum}`);
  }

  if (acceptedTypes.includes("array") && Array.isArray(value) && schema.items && typeof schema.items === "object") {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path} has fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    errors.push(...value.flatMap((item, index) => validationErrors(schema.items as JsonSchema, item, `${path}[${index}]`)));
    return errors;
  }
  if (acceptedTypes.includes("object") && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, JsonSchema>
      : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === "string") : [];
    errors.push(...required.filter((field) => !Object.hasOwn(record, field)).map((field) => `${path}.${field} is required`));
    for (const [field, candidate] of Object.entries(record)) {
      if (properties[field]) errors.push(...validationErrors(properties[field]!, candidate, `${path}.${field}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${field} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validationErrors(schema.additionalProperties as JsonSchema, candidate, `${path}.${field}`));
      }
    }
    return errors;
  }
  return errors;
}

function assertValid(schema: JsonSchema, value: unknown, label: string) {
  assert.deepEqual(validationErrors(schema, value), [], `${label} must conform to its advertised schema`);
}

test("MCP output schemas stay compact, exhaustive, and identity-bearing", () => {
  assert.deepEqual(Object.keys(MCP_OUTPUT_SCHEMAS), SOMITE_MCP_TOOL_NAMES);
  const serializedBytes = Buffer.byteLength(JSON.stringify(MCP_OUTPUT_SCHEMAS));
  assert.ok(serializedBytes < 25_000, `MCP output schemas use ${serializedBytes} bytes; budget is under 25000`);

  for (const name of SOMITE_MCP_TOOL_NAMES) {
    const schema = MCP_OUTPUT_SCHEMAS[name] as JsonSchema;
    const branches = schema.oneOf as JsonSchema[];
    assert.equal(branches.length, 2, `${name} must describe success and structured failure results`);
    const success = branches[0]!;
    assert.equal(success.type, "object", `${name} success must be a concrete object`);
    const properties = success.properties as Record<string, unknown>;
    const required = new Set(success.required as string[]);
    for (const field of REQUIRED_SUCCESS_FIELDS[name]) {
      assert.ok(properties[field], `${name} must describe success field ${field}`);
      assert.ok(required.has(field), `${name} must require success identity ${field}`);
    }

    const failure = branches[1]!;
    assertValid(failure, { error: { code: "stale_state_revision", message: "Refresh state.", retryable: false, status: 409, detail: { code: "stale_transaction" } } }, `${name} failure`);
    assert.notDeepEqual(validationErrors(failure, { error: { code: "forged", message: "missing retryability" } }), [], `${name} must reject incomplete structured failures`);
  }
});

class McpClient {
  readonly child: ChildProcess;
  readonly responses = new Map<number, (value: RpcResponse) => void>();

  constructor(url: string, capability: string) {
    const script = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
    this.child = spawn(process.execPath, ["--experimental-strip-types", script, "--server-url", url], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SOMITE_MCP_RUNTIME_CAPABILITY: capability },
    });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => {
      const response = JSON.parse(line) as RpcResponse;
      this.responses.get(response.id)?.(response);
      this.responses.delete(response.id);
    });
  }

  request(id: number, method: string, params: unknown = {}) {
    const response = new Promise<RpcResponse>((resolvePromise) => this.responses.set(id, resolvePromise));
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  requestBytes(id: number, chunks: readonly Uint8Array[]) {
    const response = new Promise<RpcResponse>((resolvePromise) => this.responses.set(id, resolvePromise));
    for (const chunk of chunks) this.child.stdin!.write(chunk);
    return response;
  }

  close() {
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
  }
}

test("stdio MCP preserves split UTF-8 request frames", async (context) => {
  const client = new McpClient(`http://127.0.0.1:${await unusedPort()}`, "b".repeat(64));
  context.after(() => client.close());
  const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown-🧬", params: {} })}\n`);
  const sequence = Buffer.from("🧬");
  const index = bytes.indexOf(sequence);
  assert.ok(index >= 0);
  const response = await client.requestBytes(1, [bytes.subarray(0, index + 1), bytes.subarray(index + 1)]);
  assert.match(String(response.error?.message), /unknown-🧬/);
});

test("stdio MCP accepts a valid workflow response larger than the old 16 MiB ceiling", async (context) => {
  const capability = "c".repeat(64);
  const annotations = Array.from({ length: 3_400 }, (_, index) => ({
    id: `note-${index}`,
    kind: "sticky",
    text: "x".repeat(5_000),
    color: "yellow",
    layout: { x: index, y: index },
    width: 180,
    height: 100,
  }));
  const payload = JSON.stringify({
    state_revision: `blake3:${"1".repeat(64)}`,
    graph_revision: `blake3:${"2".repeat(64)}`,
    graph: { schema_version: 3, nodes: [], edges: [], annotations },
  });
  assert.ok(Buffer.byteLength(payload) > 16 * 1024 * 1024);
  const server = createServer((request, response) => {
    assert.equal(request.headers["x-somite-mcp-capability"], capability);
    response.setHeader("content-type", "application/json");
    response.end(payload);
  });
  const origin = await new Promise<string>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
  const client = new McpClient(origin, capability);
  context.after(async () => {
    client.close();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  const response = await client.request(1, "tools/call", { name: "somite.workflow.get", arguments: {} });
  assert.equal(response.result?.isError, undefined);
  const graph = (response.result?.structuredContent as Record<string, unknown>).graph as Record<string, unknown>;
  assert.equal((graph.annotations as unknown[]).length, annotations.length);
  const content = response.result?.content as Array<{ text: string }>;
  assert.match(content[0]?.text ?? "", /structured result/);
  assert.ok(Buffer.byteLength(content[0]?.text ?? "") < 256);
});

test("stdio MCP never follows a loopback redirect or forwards its capability", async (context) => {
  let forwarded = 0;
  const destination = createServer((_request, response) => {
    forwarded += 1;
    response.end("{}");
  });
  const destinationPort = await new Promise<number>((resolvePromise, rejectPromise) => {
    destination.once("error", rejectPromise);
    destination.listen(0, "127.0.0.1", () => {
      const address = destination.address();
      assert.ok(address && typeof address !== "string");
      resolvePromise(address.port);
    });
  });
  const redirector = createServer((_request, response) => {
    response.statusCode = 307;
    response.setHeader("location", `http://127.0.0.1:${destinationPort}/captured`);
    response.end();
  });
  const redirectOrigin = await new Promise<string>((resolvePromise, rejectPromise) => {
    redirector.once("error", rejectPromise);
    redirector.listen(0, "127.0.0.1", () => {
      const address = redirector.address();
      assert.ok(address && typeof address !== "string");
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
  const client = new McpClient(redirectOrigin, "d".repeat(64));
  context.after(async () => {
    client.close();
    await Promise.all([
      new Promise<void>((resolvePromise) => redirector.close(() => resolvePromise())),
      new Promise<void>((resolvePromise) => destination.close(() => resolvePromise())),
    ]);
  });

  const response = await client.request(1, "tools/call", { name: "somite.workflow.get", arguments: {} });
  assert.equal(response.result?.isError, true);
  assert.equal(forwarded, 0);
});

test("stdio MCP advertises concrete result contracts and preserves atomic transaction semantics", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-mcp-ts-"));
  const capability = "a".repeat(64);
  const server = await startServer({ projectRoot: root, port: await unusedPort(), agentCapability: capability });
  const client = new McpClient(server.url, capability);
  context.after(async () => {
    client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const discovered = await client.request(1, "server/discover");
  assert.deepEqual(discovered.result?.supportedVersions, ["2026-07-28", "2025-11-25"]);
  const initialized = await client.request(2, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.result?.protocolVersion, "2025-06-18");
  assert.deepEqual(initialized.result?.serverInfo, { name: "somite", title: "Somite", version: SOMITE_VERSION });
  const listed = await client.request(3, "tools/list");
  const tools = listed.result?.tools as Array<{ name: string; inputSchema?: JsonSchema; outputSchema?: JsonSchema }>;
  assert.deepEqual(tools.map((tool) => tool.name), SOMITE_MCP_TOOL_NAMES);
  assert.ok(tools.some((tool) => tool.name === "somite.graph.apply_transaction"));
  assert.ok(tools.some((tool) => tool.name === "somite.validation.start"));
  const inputSchemas = new Map(tools.map((tool) => {
    assert.ok(tool.inputSchema, `${tool.name} must advertise inputSchema`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema must use the MCP object shape`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown top-level fields`);
    return [tool.name, tool.inputSchema] as const;
  }));
  const inputSchemaBytes = Buffer.byteLength(JSON.stringify([...inputSchemas.values()]));
  assert.ok(inputSchemaBytes < 20_000, `MCP input schemas use ${inputSchemaBytes} bytes; budget is under 20000`);
  const outputSchemas = new Map(tools.map((tool) => {
    assert.ok(tool.outputSchema, `${tool.name} must advertise outputSchema`);
    const branches = tool.outputSchema.oneOf as JsonSchema[];
    assert.equal(branches.length, 2, `${tool.name} must describe success and structured failure results`);
    assert.equal(branches[0]?.type, "object", `${tool.name} success schema must be a concrete object`);
    assert.ok(Object.keys(branches[0]?.properties as Record<string, unknown>).length > 0, `${tool.name} success schema must name its fields`);
    assert.ok((branches[0]?.required as unknown[]).length > 0, `${tool.name} success schema must require its identity fields`);
    return [tool.name, tool.outputSchema] as const;
  }));

  const transactionInput = inputSchemas.get("somite.graph.apply_transaction")!;
  const transactionProperties = transactionInput.properties as Record<string, JsonSchema>;
  const operations = transactionProperties.operations!;
  assert.equal(operations.minItems, 1);
  assert.equal(operations.maxItems, 64);
  const operationSchema = operations.items as JsonSchema;
  const operationBranches = operationSchema.oneOf as JsonSchema[];
  const operationTags = ["add_operator", "remove_node", "set_param", "unset_param", "connect", "disconnect", "set_note"];
  const operationFields: Record<string, string[]> = {
    add_operator: ["op", "node_id", "operator_id", "params", "x", "y", "note"],
    remove_node: ["op", "node_id"],
    set_param: ["op", "node_id", "parameter", "value"],
    unset_param: ["op", "node_id", "parameter"],
    connect: ["op", "edge_id", "from_node", "from_port", "to_node", "to_port"],
    disconnect: ["op", "edge_id"],
    set_note: ["op", "node_id", "note"],
  };
  const operationRequired: Record<string, string[]> = {
    add_operator: ["op", "node_id", "operator_id"],
    remove_node: ["op", "node_id"],
    set_param: ["op", "node_id", "parameter", "value"],
    unset_param: ["op", "node_id", "parameter"],
    connect: ["op", "edge_id", "from_node", "from_port", "to_node", "to_port"],
    disconnect: ["op", "edge_id"],
    set_note: ["op", "node_id", "note"],
  };
  assert.deepEqual(operationBranches.map((branch) => ((branch.properties as Record<string, JsonSchema>).op as JsonSchema).const), operationTags);
  const operationByTag = new Map(operationBranches.map((branch) => [((branch.properties as Record<string, JsonSchema>).op as JsonSchema).const as string, branch]));
  for (const [tag, branch] of operationByTag) {
    assert.equal(branch.additionalProperties, false, `${tag} must reject guessed fields`);
    assert.equal(typeof branch.description, "string", `${tag} must explain its behavior`);
    assert.deepEqual(Object.keys(branch.properties as JsonSchema), operationFields[tag], `${tag} must advertise every exact field`);
    assert.deepEqual(branch.required, operationRequired[tag], `${tag} must require exactly its canonical fields`);
    for (const [field, fieldSchema] of Object.entries(branch.properties as Record<string, JsonSchema>)) {
      assert.equal(typeof fieldSchema.description, "string", `${tag}.${field} must describe its exact meaning`);
    }
  }
  const validOperations = [
    { op: "add_operator", node_id: "fastqc", operator_id: "qc.fastqc", params: {}, x: 120, y: 80, note: "Review reads" },
    { op: "remove_node", node_id: "fastqc" },
    { op: "set_param", node_id: "reads", parameter: "path", value: "reads.fastq" },
    { op: "unset_param", node_id: "reads", parameter: "path" },
    { op: "connect", edge_id: "reads-fastqc", from_node: "reads", from_port: "file", to_node: "fastqc", to_port: "fastq" },
    { op: "disconnect", edge_id: "reads-fastqc" },
    { op: "set_note", node_id: "fastqc", note: null },
  ];
  for (const operation of validOperations) assertValid(operationSchema, operation, `${operation.op} operation`);
  const legacyOperations = [
    { ...validOperations[0], id: "fastqc", operator: "qc.fastqc" },
    { ...validOperations[1], id: "fastqc" },
    { ...validOperations[2], node: "reads", name: "path" },
    { ...validOperations[3], node: "reads", name: "path" },
    { ...validOperations[4], id: "reads-fastqc", source: "reads.file", target: "fastqc.fastq" },
    { ...validOperations[5], id: "reads-fastqc" },
    { ...validOperations[6], node: "fastqc", text: null },
  ];
  for (let index = 0; index < legacyOperations.length; index += 1) {
    const tag = operationTags[index]!;
    assert.ok(
      validationErrors(operationByTag.get(tag)!, legacyOperations[index]).some((error) => error.includes("is not allowed")),
      `${tag} must reject ambiguous legacy field names`,
    );
  }
  assert.notDeepEqual(validationErrors(operationSchema, { op: "add_operator", node_id: "bad/id", operator_id: "qc.fastqc" }), []);
  assert.notDeepEqual(validationErrors(operationSchema, { op: "add_operator", node_id: "x".repeat(129), operator_id: "qc.fastqc" }), []);
  assert.notDeepEqual(validationErrors(operationSchema, { op: "set_param", node_id: "reads", parameter: "path", value: { guessed: true } }), []);
  assert.notDeepEqual(validationErrors(operationSchema, { op: "set_note", node_id: "fastqc", note: "x".repeat(4_097) }), []);
  assert.notDeepEqual(validationErrors(operationSchema, { op: "set_note", node_id: "fastqc", note: "hidden\0tail" }), []);
  assert.notDeepEqual(validationErrors(operations, []), []);
  assert.notDeepEqual(validationErrors(operations, Array.from({ length: 65 }, () => validOperations[1])), []);

  const sourceEditInput = inputSchemas.get("somite.source_workflow.edit")!;
  const sourceEditProperties = sourceEditInput.properties as Record<string, JsonSchema>;
  const edits = sourceEditProperties.edits!;
  assert.equal(edits.minItems, 1);
  assert.equal(edits.maxItems, 64);
  const editSchema = edits.items as JsonSchema;
  const editBranches = editSchema.oneOf as JsonSchema[];
  const editTags = ["set_parameter", "reset_parameter", "replace_invocation", "reset_invocation"];
  const editFields: Record<string, string[]> = {
    set_parameter: ["kind", "name", "binding"],
    reset_parameter: ["kind", "name"],
    replace_invocation: ["kind", "invocation_id", "operator", "operator_revision", "params"],
    reset_invocation: ["kind", "invocation_id"],
  };
  const editRequired: Record<string, string[]> = {
    set_parameter: ["kind", "name", "binding"],
    reset_parameter: ["kind", "name"],
    replace_invocation: ["kind", "invocation_id", "operator", "operator_revision"],
    reset_invocation: ["kind", "invocation_id"],
  };
  assert.deepEqual(editBranches.map((branch) => ((branch.properties as Record<string, JsonSchema>).kind as JsonSchema).const), editTags);
  const editByTag = new Map(editBranches.map((branch) => [((branch.properties as Record<string, JsonSchema>).kind as JsonSchema).const as string, branch]));
  for (const [tag, branch] of editByTag) {
    assert.equal(branch.additionalProperties, false, `${tag} must reject guessed fields`);
    assert.equal(typeof branch.description, "string", `${tag} must explain its behavior`);
    assert.deepEqual(Object.keys(branch.properties as JsonSchema), editFields[tag], `${tag} must advertise every exact field`);
    assert.deepEqual(branch.required, editRequired[tag], `${tag} must require exactly its canonical fields`);
    for (const [field, fieldSchema] of Object.entries(branch.properties as Record<string, JsonSchema>)) {
      assert.equal(typeof fieldSchema.description, "string", `${tag}.${field} must describe its exact meaning`);
    }
  }
  const bindingSchema = (editByTag.get("set_parameter")!.properties as Record<string, JsonSchema>).binding!;
  const bindingBranches = bindingSchema.oneOf as JsonSchema[];
  assert.deepEqual(bindingBranches.map((branch) => ((branch.properties as Record<string, JsonSchema>).kind as JsonSchema).const), ["project_file", "project_directory", "literal"]);
  assert.deepEqual(bindingBranches.map((branch) => branch.required), [["kind", "path"], ["kind", "path"], ["kind", "value"]]);
  assert.ok(bindingBranches.every((branch) => branch.additionalProperties === false));
  const validEdits = [
    { kind: "set_parameter", name: "reads", binding: { kind: "project_file", path: "inputs/reads.fastq" } },
    { kind: "set_parameter", name: "workspace", binding: { kind: "project_directory", path: "inputs/workspace" } },
    { kind: "set_parameter", name: "label", binding: { kind: "literal", value: "demo" } },
    { kind: "reset_parameter", name: "reads" },
    { kind: "replace_invocation", invocation_id: "FASTQC", operator: "qc.fastqc", operator_revision: "blake3:reviewed", params: {} },
    { kind: "reset_invocation", invocation_id: "FASTQC" },
  ];
  for (const edit of validEdits) assertValid(editSchema, edit, `${edit.kind} source edit`);
  const legacyEdits = [
    { ...validEdits[0], parameter: "reads", value: "inputs/reads.fastq" },
    { ...validEdits[3], parameter: "reads" },
    { ...validEdits[4], invocation: "FASTQC", operator_id: "qc.fastqc", revision: "blake3:reviewed" },
    { ...validEdits[5], invocation: "FASTQC" },
  ];
  for (let index = 0; index < legacyEdits.length; index += 1) {
    const tag = editTags[index]!;
    assert.ok(
      validationErrors(editByTag.get(tag)!, legacyEdits[index]).some((error) => error.includes("is not allowed")),
      `${tag} must reject ambiguous legacy field names`,
    );
  }
  assert.notDeepEqual(validationErrors(editSchema, { kind: "set_parameter", name: "reads", binding: { kind: "project_file", path: "reads.fastq", value: "reads.fastq" } }), []);
  assert.notDeepEqual(validationErrors(editSchema, { kind: "replace_invocation", invocation_id: "FASTQC", operator: "qc.fastqc", operator_revision: "blake3:reviewed", params: { config: {} } }), []);
  assert.notDeepEqual(validationErrors(edits, []), []);
  assert.notDeepEqual(validationErrors(edits, Array.from({ length: 65 }, () => validEdits[3])), []);

  const workflowCall = await client.request(4, "tools/call", { name: "somite.workflow.get", arguments: {} });
  const workflow = workflowCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.workflow.get")!, workflow, "workflow.get response");
  const baseRevision = workflow.state_revision as string;
  assert.match(baseRevision, /^blake3:/);
  assert.deepEqual((workflow.graph as Record<string, unknown>).nodes, []);

  const readinessCall = await client.request(5, "tools/call", { name: "somite.readiness.get", arguments: {} });
  const emptyReadiness = readinessCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.readiness.get")!, emptyReadiness, "readiness.get response");
  assert.equal(emptyReadiness.state, "empty");

  const catalogCall = await client.request(6, "tools/call", {
    name: "somite.catalog.search",
    arguments: { query: "paired FASTQ", limit: 5 },
  });
  const catalog = catalogCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.catalog.search")!, catalog, "catalog.search response");
  assert.ok((catalog.matches as unknown[]).length > 0);

  const transactionArguments = {
    base_state_revision: baseRevision,
    idempotency_key: "mcp-atomic-edit-1",
    summary: "Add a local FASTQ source",
    operations: [{
      op: "add_operator",
      node_id: "reads",
      operator_id: "files.import",
      x: 80,
      y: 120,
    }],
  };
  const editedCall = await client.request(7, "tools/call", {
    name: "somite.graph.apply_transaction",
    arguments: transactionArguments,
  });
  assert.equal(editedCall.result?.isError, undefined);
  const edited = editedCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.graph.apply_transaction")!, edited, "transaction response");
  assert.equal(((edited.graph as Record<string, unknown>).nodes as Array<Record<string, unknown>>)[0]?.id, "reads");
  assert.equal(edited.replayed, false);
  assert.notEqual(edited.state_revision, baseRevision);
  const transactionWithoutNodeIdentity = structuredClone(edited);
  delete (((transactionWithoutNodeIdentity.graph as Record<string, unknown>).nodes as Array<Record<string, unknown>>)[0]!).id;
  assert.notDeepEqual(
    validationErrors(outputSchemas.get("somite.graph.apply_transaction")!, transactionWithoutNodeIdentity),
    [],
    "transaction schema must reject a graph node without its identity",
  );

  const replayCall = await client.request(8, "tools/call", {
    name: "somite.graph.apply_transaction",
    arguments: transactionArguments,
  });
  const replay = replayCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.graph.apply_transaction")!, replay, "transaction replay response");
  assert.equal(replay.replayed, true);
  assert.equal(replay.transaction_id, edited.transaction_id);

  const staleCall = await client.request(9, "tools/call", {
    name: "somite.graph.apply_transaction",
    arguments: { ...transactionArguments, idempotency_key: "mcp-atomic-edit-2" },
  });
  assert.equal(staleCall.result?.isError, true);
  const stale = staleCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.graph.apply_transaction")!, stale, "stale transaction response");
  assert.equal((stale.error as Record<string, unknown>).status, 409);
  assert.equal(((stale.error as Record<string, unknown>).detail as Record<string, unknown>).code, "stale_transaction");

  const currentCall = await client.request(10, "tools/call", { name: "somite.workflow.get", arguments: {} });
  const current = currentCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.workflow.get")!, current, "updated workflow.get response");
  assert.equal(((current.graph as Record<string, unknown>).nodes as Array<Record<string, unknown>>)[0]?.id, "reads");

  const blockedCall = await client.request(11, "tools/call", { name: "somite.readiness.get", arguments: {} });
  const blocked = blockedCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.readiness.get")!, blocked, "blocked readiness.get response");
  assert.equal(blocked.state, "building");
  assert.equal(blocked.required_count, 1);
  const readinessWithoutItemIdentity = structuredClone(blocked);
  delete ((readinessWithoutItemIdentity.items as Array<Record<string, unknown>>)[0]!).id;
  assert.notDeepEqual(
    validationErrors(outputSchemas.get("somite.readiness.get")!, readinessWithoutItemIdentity),
    [],
    "readiness schema must reject an action without its identity",
  );

  const configuredCall = await client.request(12, "tools/call", {
    name: "somite.graph.apply_transaction",
    arguments: {
      base_state_revision: edited.state_revision,
      idempotency_key: "mcp-set-input-1",
      summary: "Choose the local FASTQ",
      operations: [{ op: "set_param", node_id: "reads", parameter: "path", value: "reads.fastq" }],
    },
  });
  const configured = configuredCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.graph.apply_transaction")!, configured, "configuration transaction response");
  assert.equal(configured.replayed, false);

  const readyCall = await client.request(13, "tools/call", { name: "somite.readiness.get", arguments: {} });
  const ready = readyCall.result?.structuredContent as Record<string, unknown>;
  assertValid(outputSchemas.get("somite.readiness.get")!, ready, "ready readiness.get response");
  assert.equal(ready.state, "ready");
  assert.equal(ready.required_count, 0);
});
