import { operatorPorts, type OperatorCatalog, type ParamSpec } from "./catalog.ts";
import type { ParamValue, SomiteGraph } from "./model.ts";
import { graphStateRevision, semanticGraphRevision, validateGraph } from "./workflow.ts";

const MAX_OPERATIONS = 64;
const MAX_NOTE_BYTES = 4_096;

export type GraphOperation =
  | {
      op: "add_operator";
      node_id: string;
      operator_id: string;
      params?: Record<string, unknown>;
      x?: number;
      y?: number;
      note?: string | null;
    }
  | { op: "remove_node"; node_id: string }
  | { op: "set_param"; node_id: string; parameter: string; value: unknown }
  | { op: "unset_param"; node_id: string; parameter: string }
  | {
      op: "connect";
      edge_id: string;
      from_node: string;
      from_port: string;
      to_node: string;
      to_port: string;
    }
  | { op: "disconnect"; edge_id: string }
  | { op: "set_note"; node_id: string; note: string | null };

export type GraphTransaction = {
  base_state_revision: string;
  idempotency_key: string;
  summary: string;
  operations: GraphOperation[];
};

export type AgentTransactionResult = {
  transaction_id: string;
  previous_state_revision: string;
  state_revision: string;
  graph_revision: string;
  summary: string;
  graph: SomiteGraph;
};

export class AgentTransactionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new AgentTransactionError(code, message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function onlyFields(value: Record<string, unknown>, label: string, allowed: readonly string[]) {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown) fail("invalid_request", `${label} has unknown field ${unknown}`);
}

function string(value: unknown, label: string) {
  if (typeof value !== "string") fail("invalid_request", `${label} must be a string`);
  return value;
}

function finiteNumber(value: unknown, label: string, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) fail("invalid_identifier", `${label} must be finite`);
  return value;
}

function nullableNote(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail("invalid_note", `${label} must be a string or null`);
  validateNote(value);
  return value;
}

function parameterRecord(value: unknown, label: string) {
  if (value === undefined) return {};
  return object(value, label);
}

export function parseGraphTransaction(value: unknown): GraphTransaction {
  const raw = object(value, "transaction");
  onlyFields(raw, "transaction", ["base_state_revision", "idempotency_key", "summary", "operations"]);
  if (!Array.isArray(raw.operations)) fail("invalid_operation_count", "transaction operations must be an array");
  const operations = raw.operations.map((candidate, index): GraphOperation => {
    const operation = object(candidate, `operations[${index}]`);
    const op = string(operation.op, `operations[${index}].op`);
    if (op === "add_operator") {
      onlyFields(operation, `operations[${index}]`, ["op", "node_id", "operator_id", "params", "x", "y", "note"]);
      return {
        op,
        node_id: string(operation.node_id, `operations[${index}].node_id`),
        operator_id: string(operation.operator_id, `operations[${index}].operator_id`),
        params: parameterRecord(operation.params, `operations[${index}].params`),
        x: finiteNumber(operation.x, `operations[${index}].x`, 0),
        y: finiteNumber(operation.y, `operations[${index}].y`, 0),
        note: nullableNote(operation.note, `operations[${index}].note`),
      };
    }
    if (op === "remove_node") {
      onlyFields(operation, `operations[${index}]`, ["op", "node_id"]);
      return { op, node_id: string(operation.node_id, `operations[${index}].node_id`) };
    }
    if (op === "set_param") {
      onlyFields(operation, `operations[${index}]`, ["op", "node_id", "parameter", "value"]);
      return {
        op,
        node_id: string(operation.node_id, `operations[${index}].node_id`),
        parameter: string(operation.parameter, `operations[${index}].parameter`),
        value: operation.value,
      };
    }
    if (op === "unset_param") {
      onlyFields(operation, `operations[${index}]`, ["op", "node_id", "parameter"]);
      return {
        op,
        node_id: string(operation.node_id, `operations[${index}].node_id`),
        parameter: string(operation.parameter, `operations[${index}].parameter`),
      };
    }
    if (op === "connect") {
      onlyFields(operation, `operations[${index}]`, ["op", "edge_id", "from_node", "from_port", "to_node", "to_port"]);
      return {
        op,
        edge_id: string(operation.edge_id, `operations[${index}].edge_id`),
        from_node: string(operation.from_node, `operations[${index}].from_node`),
        from_port: string(operation.from_port, `operations[${index}].from_port`),
        to_node: string(operation.to_node, `operations[${index}].to_node`),
        to_port: string(operation.to_port, `operations[${index}].to_port`),
      };
    }
    if (op === "disconnect") {
      onlyFields(operation, `operations[${index}]`, ["op", "edge_id"]);
      return { op, edge_id: string(operation.edge_id, `operations[${index}].edge_id`) };
    }
    if (op === "set_note") {
      onlyFields(operation, `operations[${index}]`, ["op", "node_id", "note"]);
      return {
        op,
        node_id: string(operation.node_id, `operations[${index}].node_id`),
        note: nullableNote(operation.note, `operations[${index}].note`),
      };
    }
    fail("invalid_request", `operations[${index}].op is not supported`);
  });
  return {
    base_state_revision: string(raw.base_state_revision, "base_state_revision"),
    idempotency_key: string(raw.idempotency_key, "idempotency_key"),
    summary: string(raw.summary, "summary"),
    operations,
  };
}

function validateIdentifier(value: string) {
  if (!value || value.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    fail("invalid_identifier", `invalid identifier: ${value}`);
  }
}

function validateNote(note: string | null | undefined) {
  if (note !== null && note !== undefined && (new TextEncoder().encode(note).byteLength > MAX_NOTE_BYTES || note.includes("\0"))) {
    fail("invalid_note", "invalid note");
  }
}

function checkedParameter(operatorId: string, parameter: string, spec: ParamSpec, value: unknown): ParamValue {
  let converted: ParamValue;
  if (spec.type === "string" && typeof value === "string") converted = value;
  else if (spec.type === "bool" && typeof value === "boolean") converted = value;
  else if (spec.type === "int" && typeof value === "number" && Number.isSafeInteger(value)) converted = value;
  else if (spec.type === "float" && typeof value === "number" && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) converted = Object.is(value, -0) ? 0 : value;
  else fail("parameter_type", `parameter ${parameter} for operator ${operatorId} expects ${spec.type}`);

  if (typeof converted === "number"
    && ((spec.min !== undefined && converted < spec.min) || (spec.max !== undefined && converted > spec.max))) {
    fail("parameter_bounds", `parameter ${parameter} for operator ${operatorId} is outside its declared bounds`);
  }
  return converted;
}

function normalizeParams(params: Record<string, ParamValue>) {
  return Object.keys(params).length ? params : undefined;
}

function applyOperation(graph: SomiteGraph, catalog: OperatorCatalog, operation: GraphOperation) {
  if (operation.op === "add_operator") {
    validateIdentifier(operation.node_id);
    if (operation.operator_id.startsWith("nf.") || operation.operator_id.startsWith("smk.")) {
      fail("resolver_only_operator", `operator ${operation.operator_id} is a resolver-only catalog descriptor and cannot be added directly`);
    }
    validateNote(operation.note);
    if (graph.nodes.some((node) => node.id === operation.node_id) || graph.edges.some((edge) => edge.id === operation.node_id)) {
      fail("invalid_identifier", `invalid identifier: ${operation.node_id}`);
    }
    const operator = catalog.get(operation.operator_id);
    if (!operator) fail("unknown_operator", `unknown operator ${operation.operator_id}`);
    if (operator.kind === "source") {
      fail("source_operator_requires_resolver", `operator ${operation.operator_id} can only be added through its source workflow resolver`);
    }
    const params: Record<string, ParamValue> = {};
    for (const [name, spec] of Object.entries(operator.params)) {
      if (spec.default !== undefined) params[name] = spec.default;
    }
    for (const [name, value] of Object.entries(operation.params ?? {})) {
      const spec = operator.params[name];
      if (!spec) fail("unknown_parameter", `parameter ${name} is not declared by operator ${operator.id}`);
      params[name] = checkedParameter(operator.id, name, spec, value);
    }
    graph.nodes.push({
      id: operation.node_id,
      operator: operator.id,
      operator_revision: operator.revision,
      ports: operatorPorts(operator),
      ...(normalizeParams(params) ? { params } : {}),
      layout: { x: operation.x ?? 0, y: operation.y ?? 0 },
      ...(operation.note !== null && operation.note !== undefined ? { note: operation.note } : {}),
    });
    return;
  }
  if (operation.op === "remove_node") {
    const before = graph.nodes.length;
    graph.nodes = graph.nodes.filter((node) => node.id !== operation.node_id);
    if (before === graph.nodes.length) fail("node_not_found", `node not found: ${operation.node_id}`);
    graph.edges = graph.edges.filter((edge) => edge.from_node !== operation.node_id && edge.to_node !== operation.node_id);
    return;
  }
  if (operation.op === "set_param" || operation.op === "unset_param") {
    const node = graph.nodes.find((candidate) => candidate.id === operation.node_id);
    if (!node) fail("node_not_found", `node not found: ${operation.node_id}`);
    const operator = catalog.get(node.operator);
    if (!operator) fail("unknown_operator", `unknown operator ${node.operator}`);
    const spec = operator.params[operation.parameter];
    if (!spec) fail("unknown_parameter", `parameter ${operation.parameter} is not declared by operator ${node.operator}`);
    const params = { ...(node.params ?? {}) };
    if (operation.op === "set_param") {
      params[operation.parameter] = checkedParameter(node.operator, operation.parameter, spec, operation.value);
    } else {
      if (spec.required && spec.default === undefined) {
        fail("parameter_type", `parameter ${operation.parameter} for operator ${node.operator} expects a required value`);
      }
      delete params[operation.parameter];
      if (spec.default !== undefined) params[operation.parameter] = spec.default;
    }
    node.params = normalizeParams(params);
    return;
  }
  if (operation.op === "connect") {
    for (const identifier of [operation.edge_id, operation.from_node, operation.from_port, operation.to_node, operation.to_port]) {
      validateIdentifier(identifier);
    }
    if (graph.nodes.some((node) => node.id === operation.edge_id) || graph.edges.some((edge) => edge.id === operation.edge_id)) {
      fail("invalid_identifier", `invalid identifier: ${operation.edge_id}`);
    }
    graph.edges.push({
      id: operation.edge_id,
      from_node: operation.from_node,
      from_port: operation.from_port,
      to_node: operation.to_node,
      to_port: operation.to_port,
    });
    return;
  }
  if (operation.op === "disconnect") {
    const before = graph.edges.length;
    graph.edges = graph.edges.filter((edge) => edge.id !== operation.edge_id);
    if (before === graph.edges.length) fail("edge_not_found", `edge not found: ${operation.edge_id}`);
    return;
  }
  validateNote(operation.note);
  const node = graph.nodes.find((candidate) => candidate.id === operation.node_id);
  if (!node) fail("node_not_found", `node not found: ${operation.node_id}`);
  if (operation.note === null) delete node.note;
  else node.note = operation.note;
}

/** Apply one small agent-authored edit atomically against immutable catalog contracts. */
export function applyGraphTransaction(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  request: GraphTransaction,
  transactionId: string,
): AgentTransactionResult {
  const previousStateRevision = graphStateRevision(graph);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(request.idempotency_key)) {
    fail("invalid_idempotency_key", "idempotency key must contain 8 to 128 ASCII letters, numbers, hyphens, or underscores");
  }
  if (request.base_state_revision !== previousStateRevision) {
    fail("stale_transaction", `transaction base ${request.base_state_revision} is stale; current state revision is ${previousStateRevision}`);
  }
  const summary = request.summary.trim();
  if (!summary || [...summary].length > 240 || [...summary].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) {
    fail("invalid_summary", "transaction summary must contain between 1 and 240 characters");
  }
  if (request.operations.length < 1 || request.operations.length > MAX_OPERATIONS) {
    fail("invalid_operation_count", `transaction must contain between 1 and ${MAX_OPERATIONS} operations`);
  }
  const candidate = structuredClone(graph);
  for (const operation of request.operations) applyOperation(candidate, catalog, operation);
  const validation = validateGraph(candidate);
  if (!validation.ok) fail("invalid_graph", validation.issue.message);
  const verified = catalog.verifyGraph(candidate);
  if (!verified.ok) fail(verified.issue.code, verified.issue.message);
  return {
    transaction_id: transactionId,
    previous_state_revision: previousStateRevision,
    state_revision: graphStateRevision(candidate),
    graph_revision: semanticGraphRevision(candidate),
    summary,
    graph: candidate,
  };
}
