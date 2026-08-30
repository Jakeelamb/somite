import type {
  CanvasAnnotation,
  CanvasColor,
  ParamValue,
  PortType,
  SomiteEdge,
  SomiteGraph,
  SomiteGraphNode,
  SomitePort,
  SourceCapabilities,
  SourceDiagnostic,
  SourceInvocation,
  SourceInvocationReplacement,
  SourceScope,
  SourceSpan,
  SourceWorkflowInstance,
  UnsupportedRequiredWorkflowParameter,
  WorkflowBinding,
  WorkflowParameterField,
  WorkflowSourcePin,
} from "./model.ts";
import { validateGraph } from "./workflow.ts";

const PORT_TYPES = new Set<PortType>([
  "Sra", "Fastq", "FastqGz", "Fasta", "FastaGz", "Gtf", "GtfGz", "Gff3", "Sam", "Bam", "Bai",
  "Vcf", "VcfGz", "Bed", "Agp", "Chain", "Table", "Json", "Html", "Image", "Zip", "Directory", "Text", "Preview",
]);
const COLORS = new Set<CanvasColor>(["yellow", "orange", "rose", "violet", "blue", "teal", "green", "gray"]);

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function knownFields(value: Record<string, unknown>, path: string, fields: readonly string[]) {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new Error(`${path} has unknown field ${unknown}`);
}

function string(value: unknown, path: string) {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function optionalString(value: unknown, path: string) {
  return value === undefined || value === null ? undefined : string(value, path);
}

function boolean(value: unknown, path: string, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function number(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function integer(value: unknown, path: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer`);
  return value as number;
}

function optionalNumber(value: unknown, path: string) {
  return value === undefined || value === null ? undefined : number(value, path);
}

function array(value: unknown, path: string) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function optionalArray(value: unknown, path: string) {
  return value === undefined ? [] : array(value, path);
}

function oneOf<const T extends string>(value: unknown, path: string, allowed: ReadonlySet<T>): T {
  if (typeof value !== "string" || !allowed.has(value as T)) throw new Error(`${path} has an unsupported value`);
  return value as T;
}

function paramValue(value: unknown, path: string): ParamValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  throw new Error(`${path} must be a browser-stable parameter value`);
}

function paramRecord(value: unknown, path: string) {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(object(value, path)).map(([key, item]) => [key, paramValue(item, `${path}.${key}`)]));
}

function stringRecord(value: unknown, path: string) {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(object(value, path)).map(([key, item]) => [key, string(item, `${path}.${key}`)]));
}

function point(value: unknown, path: string) {
  const raw = object(value, path);
  knownFields(raw, path, ["x", "y"]);
  return { x: number(raw.x, `${path}.x`), y: number(raw.y, `${path}.y`) };
}

function port(value: unknown, path: string): SomitePort {
  const raw = object(value, path);
  knownFields(raw, path, ["name", "dir", "ty", "union", "optional"]);
  const union = optionalArray(raw.union, `${path}.union`).map((item, index) => oneOf(item, `${path}.union[${index}]`, PORT_TYPES));
  return {
    name: string(raw.name, `${path}.name`),
    dir: oneOf(raw.dir, `${path}.dir`, new Set(["in", "out"] as const)),
    ty: oneOf(raw.ty, `${path}.ty`, PORT_TYPES),
    ...(union.length ? { union } : {}),
    ...(boolean(raw.optional, `${path}.optional`) ? { optional: true } : {}),
  };
}

function span(value: unknown, path: string): SourceSpan {
  const raw = object(value, path);
  knownFields(raw, path, ["path", "start_line", "end_line"]);
  return {
    path: string(raw.path, `${path}.path`),
    start_line: integer(raw.start_line, `${path}.start_line`),
    end_line: integer(raw.end_line, `${path}.end_line`),
  };
}

function sourcePin(value: unknown, path: string): WorkflowSourcePin {
  const raw = object(value, path);
  knownFields(raw, path, ["provider", "repository", "requested_revision", "resolved_revision", "source_digest", "entrypoint", "file_count", "source_bytes"]);
  return {
    provider: oneOf(raw.provider, `${path}.provider`, new Set(["nf_core", "local"] as const)),
    repository: string(raw.repository, `${path}.repository`),
    requested_revision: string(raw.requested_revision, `${path}.requested_revision`),
    resolved_revision: string(raw.resolved_revision, `${path}.resolved_revision`),
    source_digest: string(raw.source_digest, `${path}.source_digest`),
    entrypoint: string(raw.entrypoint, `${path}.entrypoint`),
    file_count: integer(raw.file_count, `${path}.file_count`),
    source_bytes: integer(raw.source_bytes, `${path}.source_bytes`),
  };
}

function parameterField(value: unknown, path: string): WorkflowParameterField {
  const raw = object(value, path);
  knownFields(raw, path, ["name", "label", "group", "description", "help", "type", "required", "hidden", "managed", "format", "pattern", "default", "choices", "minimum", "maximum"]);
  const description = optionalString(raw.description, `${path}.description`);
  const help = optionalString(raw.help, `${path}.help`);
  const format = optionalString(raw.format, `${path}.format`);
  const pattern = optionalString(raw.pattern, `${path}.pattern`);
  const choices = optionalArray(raw.choices, `${path}.choices`).map((item, index) => paramValue(item, `${path}.choices[${index}]`));
  const minimum = optionalNumber(raw.minimum, `${path}.minimum`);
  const maximum = optionalNumber(raw.maximum, `${path}.maximum`);
  return {
    name: string(raw.name, `${path}.name`),
    label: string(raw.label, `${path}.label`),
    group: string(raw.group, `${path}.group`),
    ...(description !== undefined ? { description } : {}),
    ...(help !== undefined ? { help } : {}),
    type: oneOf(raw.type, `${path}.type`, new Set(["string", "integer", "number", "boolean"] as const)),
    ...(boolean(raw.required, `${path}.required`) ? { required: true } : {}),
    ...(boolean(raw.hidden, `${path}.hidden`) ? { hidden: true } : {}),
    ...(boolean(raw.managed, `${path}.managed`) ? { managed: true } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
    ...(raw.default !== undefined && raw.default !== null ? { default: paramValue(raw.default, `${path}.default`) } : {}),
    ...(choices.length ? { choices } : {}),
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  };
}

function unsupportedParameter(value: unknown, path: string): UnsupportedRequiredWorkflowParameter {
  const raw = object(value, path);
  knownFields(raw, path, ["name", "label", "group", "description", "reason", "hidden"]);
  const description = optionalString(raw.description, `${path}.description`);
  return {
    name: string(raw.name, `${path}.name`),
    label: string(raw.label, `${path}.label`),
    group: string(raw.group, `${path}.group`),
    ...(description !== undefined ? { description } : {}),
    reason: string(raw.reason, `${path}.reason`),
    ...(boolean(raw.hidden, `${path}.hidden`) ? { hidden: true } : {}),
  };
}

function binding(value: unknown, path: string): WorkflowBinding {
  const raw = object(value, path);
  const kind = oneOf(raw.kind, `${path}.kind`, new Set(["project_file", "project_directory", "literal"] as const));
  if (kind === "literal") {
    knownFields(raw, path, ["kind", "value"]);
    return { kind, value: paramValue(raw.value, `${path}.value`) };
  }
  knownFields(raw, path, ["kind", "path"]);
  return { kind, path: string(raw.path, `${path}.path`) };
}

export function parseWorkflowBinding(value: unknown, path = "binding") {
  return binding(value, path);
}

export function parseParameterRecord(value: unknown, path = "params") {
  return paramRecord(value, path);
}

function scope(value: unknown, path: string): SourceScope {
  const raw = object(value, path);
  knownFields(raw, path, ["id", "title", "symbol", "kind", "span"]);
  const symbol = optionalString(raw.symbol, `${path}.symbol`);
  return {
    id: string(raw.id, `${path}.id`),
    title: string(raw.title, `${path}.title`),
    ...(symbol !== undefined ? { symbol } : {}),
    kind: oneOf(raw.kind, `${path}.kind`, new Set(["entry_workflow", "workflow", "process"] as const)),
    span: span(raw.span, `${path}.span`),
  };
}

function invocation(value: unknown, path: string): SourceInvocation {
  const raw = object(value, path);
  knownFields(raw, path, ["id", "caller", "name", "callee", "span"]);
  const callee = optionalString(raw.callee, `${path}.callee`);
  return {
    id: string(raw.id, `${path}.id`),
    caller: string(raw.caller, `${path}.caller`),
    name: string(raw.name, `${path}.name`),
    ...(callee !== undefined ? { callee } : {}),
    span: span(raw.span, `${path}.span`),
  };
}

function replacement(value: unknown, path: string): SourceInvocationReplacement {
  const raw = object(value, path);
  knownFields(raw, path, ["invocation_id", "operator", "operator_revision", "params"]);
  const params = paramRecord(raw.params, `${path}.params`);
  return {
    invocation_id: string(raw.invocation_id, `${path}.invocation_id`),
    operator: string(raw.operator, `${path}.operator`),
    operator_revision: string(raw.operator_revision, `${path}.operator_revision`),
    ...(Object.keys(params).length ? { params } : {}),
  };
}

function capabilities(value: unknown, path: string): SourceCapabilities {
  const raw = value === undefined ? {} : object(value, path);
  knownFields(raw, path, ["exact_execution", "parameter_edits", "hierarchy_indexed", "structural_edits", "channel_contracts", "source_edits"]);
  return {
    exact_execution: boolean(raw.exact_execution, `${path}.exact_execution`),
    parameter_edits: boolean(raw.parameter_edits, `${path}.parameter_edits`),
    hierarchy_indexed: boolean(raw.hierarchy_indexed, `${path}.hierarchy_indexed`),
    structural_edits: boolean(raw.structural_edits, `${path}.structural_edits`),
    channel_contracts: boolean(raw.channel_contracts, `${path}.channel_contracts`),
    source_edits: boolean(raw.source_edits, `${path}.source_edits`),
  };
}

function diagnostic(value: unknown, path: string): SourceDiagnostic {
  const raw = object(value, path);
  knownFields(raw, path, ["code", "message", "span"]);
  return {
    code: string(raw.code, `${path}.code`),
    message: string(raw.message, `${path}.message`),
    ...(raw.span !== undefined && raw.span !== null ? { span: span(raw.span, `${path}.span`) } : {}),
  };
}

function sourceWorkflow(value: unknown, path: string): SourceWorkflowInstance {
  const raw = object(value, path);
  knownFields(raw, path, ["schema_version", "workflow_revision", "source", "profiles", "parameters", "unsupported_required_parameters", "bindings", "scopes", "invocations", "replacements", "capabilities", "diagnostics"]);
  const profiles = optionalArray(raw.profiles, `${path}.profiles`).map((item, index) => string(item, `${path}.profiles[${index}]`));
  const parameters = optionalArray(raw.parameters, `${path}.parameters`).map((item, index) => parameterField(item, `${path}.parameters[${index}]`));
  const unsupported = optionalArray(raw.unsupported_required_parameters, `${path}.unsupported_required_parameters`).map((item, index) => unsupportedParameter(item, `${path}.unsupported_required_parameters[${index}]`));
  const bindings = Object.fromEntries(Object.entries(raw.bindings === undefined ? {} : object(raw.bindings, `${path}.bindings`)).map(([key, item]) => [key, binding(item, `${path}.bindings.${key}`)]));
  const scopes = optionalArray(raw.scopes, `${path}.scopes`).map((item, index) => scope(item, `${path}.scopes[${index}]`));
  const invocations = optionalArray(raw.invocations, `${path}.invocations`).map((item, index) => invocation(item, `${path}.invocations[${index}]`));
  const replacements = optionalArray(raw.replacements, `${path}.replacements`).map((item, index) => replacement(item, `${path}.replacements[${index}]`));
  const diagnostics = optionalArray(raw.diagnostics, `${path}.diagnostics`).map((item, index) => diagnostic(item, `${path}.diagnostics[${index}]`));
  return {
    schema_version: integer(raw.schema_version, `${path}.schema_version`),
    workflow_revision: string(raw.workflow_revision, `${path}.workflow_revision`),
    source: sourcePin(raw.source, `${path}.source`),
    ...(profiles.length ? { profiles } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(unsupported.length ? { unsupported_required_parameters: unsupported } : {}),
    ...(Object.keys(bindings).length ? { bindings } : {}),
    ...(scopes.length ? { scopes } : {}),
    ...(invocations.length ? { invocations } : {}),
    ...(replacements.length ? { replacements } : {}),
    capabilities: capabilities(raw.capabilities, `${path}.capabilities`),
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

function node(value: unknown, path: string): SomiteGraphNode {
  const raw = object(value, path);
  knownFields(raw, path, ["id", "operator", "operator_revision", "ports", "params", "source_workflow", "layout", "note", "color"]);
  const params = paramRecord(raw.params, `${path}.params`);
  const note = optionalString(raw.note, `${path}.note`);
  const color = raw.color === undefined || raw.color === null ? undefined : oneOf(raw.color, `${path}.color`, COLORS);
  return {
    id: string(raw.id, `${path}.id`),
    operator: string(raw.operator, `${path}.operator`),
    operator_revision: string(raw.operator_revision, `${path}.operator_revision`),
    ports: array(raw.ports, `${path}.ports`).map((item, index) => port(item, `${path}.ports[${index}]`)),
    ...(Object.keys(params).length ? { params } : {}),
    ...(raw.source_workflow !== undefined && raw.source_workflow !== null ? { source_workflow: sourceWorkflow(raw.source_workflow, `${path}.source_workflow`) } : {}),
    layout: point(raw.layout, `${path}.layout`),
    ...(note !== undefined ? { note } : {}),
    ...(color !== undefined ? { color } : {}),
  };
}

function edge(value: unknown, path: string): SomiteEdge {
  const raw = object(value, path);
  knownFields(raw, path, ["id", "from_node", "from_port", "to_node", "to_port"]);
  return {
    id: string(raw.id, `${path}.id`),
    from_node: string(raw.from_node, `${path}.from_node`),
    from_port: string(raw.from_port, `${path}.from_port`),
    to_node: string(raw.to_node, `${path}.to_node`),
    to_port: string(raw.to_port, `${path}.to_port`),
  };
}

function annotation(value: unknown, path: string): CanvasAnnotation {
  const raw = object(value, path);
  const kind = oneOf(raw.kind, `${path}.kind`, new Set(["sticky", "box", "stroke"] as const));
  const color = oneOf(raw.color, `${path}.color`, COLORS);
  if (kind === "stroke") {
    knownFields(raw, path, ["id", "kind", "color", "points"]);
    return {
      id: string(raw.id, `${path}.id`),
      kind,
      color,
      points: array(raw.points, `${path}.points`).map((item, index) => point(item, `${path}.points[${index}]`)),
    };
  }
  knownFields(raw, path, ["id", "kind", "text", "color", "layout", "width", "height"]);
  return {
    id: string(raw.id, `${path}.id`),
    kind,
    text: string(raw.text, `${path}.text`),
    color,
    layout: point(raw.layout, `${path}.layout`),
    width: number(raw.width, `${path}.width`),
    height: number(raw.height, `${path}.height`),
  };
}

/** Parse and validate untrusted persisted or network Graph JSON. */
export function parseGraph(value: unknown, path = "graph"): SomiteGraph {
  const raw = object(value, path);
  knownFields(raw, path, ["schema_version", "name", "nodes", "edges", "annotations", "variant_origin"]);
  const name = optionalString(raw.name, `${path}.name`);
  const nodes = array(raw.nodes, `${path}.nodes`).map((item, index) => node(item, `${path}.nodes[${index}]`));
  const edges = optionalArray(raw.edges, `${path}.edges`).map((item, index) => edge(item, `${path}.edges[${index}]`));
  const annotations = optionalArray(raw.annotations, `${path}.annotations`).map((item, index) => annotation(item, `${path}.annotations[${index}]`));
  let variantOrigin: SomiteGraph["variant_origin"];
  if (raw.variant_origin !== undefined && raw.variant_origin !== null) {
    const origin = object(raw.variant_origin, `${path}.variant_origin`);
    knownFields(origin, `${path}.variant_origin`, ["source_node", "promoted_invocations"]);
    const promoted = stringRecord(origin.promoted_invocations, `${path}.variant_origin.promoted_invocations`);
    variantOrigin = {
      source_node: node(origin.source_node, `${path}.variant_origin.source_node`),
      ...(Object.keys(promoted).length ? { promoted_invocations: promoted } : {}),
    };
  }
  const graph: SomiteGraph = {
    schema_version: integer(raw.schema_version, `${path}.schema_version`),
    ...(name !== undefined ? { name } : {}),
    nodes,
    edges,
    ...(annotations.length ? { annotations } : {}),
    ...(variantOrigin ? { variant_origin: variantOrigin } : {}),
  };
  const validation = validateGraph(graph);
  if (!validation.ok) throw new Error(`${path}: ${validation.issue.message}`);
  return graph;
}
