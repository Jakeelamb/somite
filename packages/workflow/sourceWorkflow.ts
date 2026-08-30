import { byteDigest } from "./contentIdentity.ts";
import { operatorPorts, type OperatorCatalog } from "./catalog.ts";
import {
  buildSourceManifest,
  indexNextflowSource,
  safeSourcePath,
  type FrozenSourceFile,
} from "./nextflowSource.ts";
import type {
  ParamValue,
  SomiteGraph,
  SomiteGraphNode,
  SourceDiagnostic,
  SourceWorkflowInstance,
  UnsupportedRequiredWorkflowParameter,
  WorkflowBinding,
  WorkflowParameterField,
} from "./model.ts";
import { graphStateRevision, semanticGraphRevision, validateGraph, validateSourceWorkflow } from "./workflow.ts";

export const SOURCE_INDEXER_REVISION = "source-indexer-ts-v1";
const encoder = new TextEncoder();
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const PROPERTY_KEYS = new Set(["type", "enum", "minimum", "maximum", "pattern", "format", "default"]);
const PROPERTY_ANNOTATIONS = new Set(["title", "description", "help_text", "help", "hidden", "fa_icon", "mimetype", "errorMessage", "examples", "$comment", "readOnly", "writeOnly"]);

type JsonObject = Record<string, unknown>;

export type ParsedParameterSchema = Readonly<{
  parameters: readonly WorkflowParameterField[];
  unsupportedRequired: readonly UnsupportedRequiredWorkflowParameter[];
  diagnostics: readonly SourceDiagnostic[];
  parameterEdits: boolean;
  digest?: string;
}>;

export type SourceWorkflowEdit =
  | Readonly<{ kind: "set_parameter"; name: string; binding: WorkflowBinding }>
  | Readonly<{ kind: "reset_parameter"; name: string }>
  | Readonly<{ kind: "replace_invocation"; invocation_id: string; operator: string; operator_revision: string; params?: Readonly<Record<string, ParamValue>> }>
  | Readonly<{ kind: "reset_invocation"; invocation_id: string }>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function printable(value: string) {
  return Boolean(value.trim()) && ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function label(name: string) {
  const value = name.replaceAll("_", " ");
  return value ? value[0]!.toLocaleUpperCase("en-US") + value.slice(1) : value;
}

function schemaSpan() {
  return { path: "nextflow_schema.json", start_line: 1, end_line: 1 };
}

function parameterValue(value: unknown): ParamValue | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) && !Object.is(value, -0)) return value;
  return undefined;
}

function parameterType(value: unknown): WorkflowParameterField["type"] | undefined {
  return value === "string" || value === "integer" || value === "number" || value === "boolean" ? value : undefined;
}

function typeMatches(type: WorkflowParameterField["type"], value: ParamValue) {
  return type === "string" ? typeof value === "string"
    : type === "boolean" ? typeof value === "boolean"
      : type === "integer" ? Number.isSafeInteger(value)
        : typeof value === "number" && Number.isFinite(value);
}

function safePattern(pattern: string): string | undefined {
  if (![...pattern].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code <= 126;
  })) return "pattern source must be printable ASCII";
  if (pattern.includes("&&") || pattern.includes("--") || pattern.includes("~~") || pattern.includes("[:") || pattern.includes(":]")) {
    return "character-class set operations and POSIX classes are not supported";
  }
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      const escaped = pattern[++index];
      if (!escaped) return "pattern ends with an incomplete escape";
      const allowed = inClass ? "dDsSwW]\\^-" : "dDsSwWbB.^$*+?()[]|\\";
      if (!allowed.includes(escaped)) return `escape \\${escaped} is outside the supported subset`;
    } else if (character === "[") {
      if (inClass) return "nested character classes are not supported";
      inClass = true;
    } else if (character === "]") {
      if (!inClass) return "unmatched character-class close is not supported";
      inClass = false;
    } else if (character === "(" && !inClass && pattern[index + 1] === "?" && pattern[index + 2] !== ":") {
      return "lookarounds, inline modes, and special groups are not supported";
    } else if (character === "{" || character === "}") return "counted quantifiers are not supported";
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function valueValid(field: Pick<WorkflowParameterField, "type" | "minimum" | "maximum" | "choices" | "pattern">, value: ParamValue) {
  if (!typeMatches(field.type, value)) return false;
  if (field.choices?.length && !field.choices.some((choice) => choice === value)) return false;
  if (typeof value === "number" && (field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum)) return false;
  if (field.pattern && typeof value === "string") {
    if (![...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code <= 126;
    })) return false;
    return new RegExp(field.pattern).test(value);
  }
  return true;
}

function parseProperty(name: string, group: string, schema: JsonObject, required: boolean): { field?: WorkflowParameterField; diagnostic?: SourceDiagnostic; unsupported?: UnsupportedRequiredWorkflowParameter } {
  const type = parameterType(schema.type);
  let issue = type ? undefined : "type is not a supported primitive";
  const unknown = Object.keys(schema).find((key) => !PROPERTY_KEYS.has(key) && !PROPERTY_ANNOTATIONS.has(key));
  if (!issue && unknown) issue = `property keyword ${JSON.stringify(unknown)} has no proven validation parity in the typed source editor`;
  const pattern = text(schema.pattern);
  const patternIssue = pattern ? safePattern(pattern) : undefined;
  if (!issue && schema.pattern !== undefined && pattern === undefined) issue = "JSON Schema constraint pattern is not a string";
  if (!issue && patternIssue) {
    const unsupported = required ? {
      name,
      label: printable(text(schema.title) ?? "") ? text(schema.title)! : label(name),
      group,
      ...(text(schema.description) ? { description: text(schema.description) } : {}),
      reason: `pattern is outside Somite's ECMA-262-compatible printable-ASCII subset (${patternIssue})`,
      ...(schema.hidden === true ? { hidden: true } : {}),
    } : undefined;
    return {
      ...(unsupported ? { unsupported } : {}),
      diagnostic: {
        code: "unsupported_parameter_pattern",
        message: `Parameter ${name} remains source-only because Somite cannot evaluate its JSON Schema pattern with proven ECMA-262 parity (${patternIssue}); independently proven parameters remain editable.`,
        span: schemaSpan(),
      },
    };
  }
  if (issue || !type) {
    return {
      ...(required ? { unsupported: {
        name,
        label: printable(text(schema.title) ?? "") ? text(schema.title)! : label(name),
        group,
        ...(text(schema.description) ? { description: text(schema.description) } : {}),
        reason: issue ?? "unsupported property",
        ...(schema.hidden === true ? { hidden: true } : {}),
      } } : {}),
      diagnostic: { code: "unsupported_parameter", message: `Parameter ${name} remains source-only because its ${issue ?? "contract is unsupported"}.`, span: schemaSpan() },
    };
  }
  const minimum = typeof schema.minimum === "number" && Number.isFinite(schema.minimum) && !Object.is(schema.minimum, -0) ? schema.minimum : undefined;
  const maximum = typeof schema.maximum === "number" && Number.isFinite(schema.maximum) && !Object.is(schema.maximum, -0) ? schema.maximum : undefined;
  if ((schema.minimum !== undefined && minimum === undefined) || (schema.maximum !== undefined && maximum === undefined)
    || (type === "integer" && [minimum, maximum].some((bound) => bound !== undefined && !Number.isSafeInteger(bound)))) {
    return {
      ...(required ? { unsupported: { name, label: label(name), group, reason: "numeric bounds are outside the exact JSON domain" } } : {}),
      diagnostic: { code: "unsupported_parameter_constraint", message: `Parameter ${name} remains source-only because its numeric bounds are outside the exact JSON domain; independently proven parameters remain editable.`, span: schemaSpan() },
    };
  }
  const choices = Array.isArray(schema.enum) ? schema.enum.map(parameterValue) : [];
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || choices.some((choice) => choice === undefined))) {
    return {
      ...(required ? { unsupported: { name, label: label(name), group, reason: "enum is not a non-empty array of primitive values" } } : {}),
      diagnostic: { code: "unsupported_parameter_enum", message: `Parameter ${name} remains source-only because its enum is not a non-empty array of primitive values; independently proven parameters remain editable.`, span: schemaSpan() },
    };
  }
  const field: WorkflowParameterField = {
    name,
    label: printable(text(schema.title) ?? "") ? text(schema.title)! : label(name),
    group,
    ...(text(schema.description) ? { description: text(schema.description) } : {}),
    ...(text(schema.help_text) ? { help: text(schema.help_text) } : {}),
    type,
    ...(required ? { required: true } : {}),
    ...(schema.hidden === true ? { hidden: true } : {}),
    ...(name === "outdir" ? { managed: true } : {}),
    ...(text(schema.format) ? { format: text(schema.format) } : {}),
    ...(pattern ? { pattern } : {}),
    ...(choices.length ? { choices: choices as ParamValue[] } : {}),
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  };
  const defaultValue = parameterValue(schema.default);
  if (schema.default !== undefined && schema.default !== null && (defaultValue === undefined || !valueValid(field, defaultValue)
    || (field.format?.includes("path") && (typeof defaultValue !== "string" || !safeSourcePath(defaultValue))))) {
    return {
      ...(required ? { unsupported: { name, label: field.label, group, reason: "default is outside the representable contract" } } : {}),
      diagnostic: { code: "unsupported_parameter_default", message: `Parameter ${name} remains source-only because its default is outside the representable contract; independently proven parameters remain editable.`, span: schemaSpan() },
    };
  }
  if (defaultValue !== undefined) field.default = defaultValue;
  return { field };
}

export function parseNextflowParameterSchema(files: readonly FrozenSourceFile[]): ParsedParameterSchema {
  const schemaFile = files.find((file) => file.path === "nextflow_schema.json");
  if (!schemaFile) return {
    parameters: [],
    unsupportedRequired: [],
    diagnostics: [{ code: "parameter_schema_missing", message: "The pinned source has no tracked nextflow_schema.json." }],
    parameterEdits: false,
  };
  if (schemaFile.bytes.byteLength > MAX_SCHEMA_BYTES) throw new Error(`nextflow_schema.json exceeds ${MAX_SCHEMA_BYTES} bytes`);
  const root = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(schemaFile.bytes)));
  if (!root) throw new Error("nextflow_schema.json root must be an object");
  const definitions = object(root.$defs) ?? object(root.definitions);
  const namespace = root.$defs ? "$defs" : "definitions";
  const groups: Array<[string, JsonObject]> = [];
  if (definitions) {
    for (const clause of Array.isArray(root.allOf) ? root.allOf : []) {
      const reference = text(object(clause)?.$ref);
      const prefix = `#/${namespace}/`;
      if (!reference?.startsWith(prefix)) continue;
      const key = reference.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~");
      const group = object(definitions[key]);
      if (group && !groups.some(([existing]) => existing === key)) groups.push([key, group]);
    }
  } else if (object(root.properties)) groups.push(["Parameters", root]);

  const parameters: WorkflowParameterField[] = [];
  const unsupportedRequired: UnsupportedRequiredWorkflowParameter[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const names = new Set<string>();
  let parameterEdits = root.type === "object" && groups.length > 0;
  for (const [key, group] of groups) {
    const groupTitle = printable(text(group.title) ?? "") ? text(group.title)! : label(key);
    const properties = object(group.properties);
    const requiredValues = Array.isArray(group.required) ? group.required : [];
    const required = new Set(requiredValues.filter((value): value is string => typeof value === "string" && printable(value)));
    if (group.type !== "object" || !properties || required.size !== requiredValues.length) {
      parameterEdits = false;
      diagnostics.push({ code: "unsupported_schema_container", message: `Schema container ${groupTitle} remains source-only because its object contract is malformed; parameter editing is disabled.`, span: schemaSpan() });
      continue;
    }
    for (const [name, candidate] of Object.entries(properties)) {
      if (!printable(name) || names.has(name)) {
        parameterEdits = false;
        diagnostics.push({ code: "duplicate_parameter", message: `Parameter ${name} appears in more than one schema group.`, span: schemaSpan() });
        continue;
      }
      names.add(name);
      const schema = object(candidate);
      if (!schema) {
        diagnostics.push({ code: "unsupported_parameter", message: `Parameter ${name} remains source-only because its schema is not an object.`, span: schemaSpan() });
        if (required.has(name)) unsupportedRequired.push({ name, label: label(name), group: groupTitle, reason: "schema is not an object" });
        continue;
      }
      const parsed = parseProperty(name, groupTitle, schema, required.has(name));
      if (parsed.field) parameters.push(parsed.field);
      if (parsed.unsupported) unsupportedRequired.push(parsed.unsupported);
      if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
    }
    for (const name of required) {
      if (properties[name] !== undefined) continue;
      unsupportedRequired.push({ name, label: label(name), group: groupTitle, reason: "required name has no property contract" });
      diagnostics.push({ code: "unsupported_parameter", message: `Parameter ${name} remains source-only because its required name has no property contract.`, span: schemaSpan() });
    }
  }
  return {
    parameters,
    unsupportedRequired,
    diagnostics,
    parameterEdits,
    digest: byteDigest(schemaFile.bytes),
  };
}

function sortedRecord<T>(value: Readonly<Record<string, T>>) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export function sourceWorkflowRevision(workflow: SourceWorkflowInstance) {
  const parameters = [...(workflow.parameters ?? [])]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .map((parameter) => ({
      name: parameter.name,
      ty: parameter.type,
      required: parameter.required ?? false,
      managed: parameter.managed ?? false,
      format: parameter.format ?? null,
      pattern: parameter.pattern ?? null,
      default: parameter.default ?? null,
      choices: parameter.choices ?? [],
      minimum: parameter.minimum ?? null,
      maximum: parameter.maximum ?? null,
    }));
  const replacements = [...(workflow.replacements ?? [])]
    .sort((left, right) => left.invocation_id < right.invocation_id ? -1 : left.invocation_id > right.invocation_id ? 1 : 0)
    .map((replacement) => ({
      invocation_id: replacement.invocation_id,
      operator: replacement.operator,
      operator_revision: replacement.operator_revision,
      ...(Object.keys(replacement.params ?? {}).length ? { params: sortedRecord(replacement.params ?? {}) } : {}),
    }));
  return byteDigest(encoder.encode(JSON.stringify({
    schema_version: workflow.schema_version,
    source: {
      provider: workflow.source.provider,
      repository: workflow.source.repository,
      requested_revision: workflow.source.requested_revision,
      resolved_revision: workflow.source.resolved_revision,
      source_digest: workflow.source.source_digest,
      entrypoint: workflow.source.entrypoint,
      file_count: workflow.source.file_count,
      source_bytes: workflow.source.source_bytes,
    },
    profiles: workflow.profiles ?? [],
    parameters,
    bindings: sortedRecord(workflow.bindings ?? {}),
    ...(replacements.length ? { replacements } : {}),
  })));
}

export function deriveSourceWorkflow(files: readonly FrozenSourceFile[], source: Omit<SourceWorkflowInstance["source"], "source_digest" | "file_count" | "source_bytes">) {
  const manifest = buildSourceManifest(files);
  const outline = indexNextflowSource(files, source.entrypoint, manifest.source_digest);
  const schema = parseNextflowParameterSchema(files);
  const diagnostics = [...outline.diagnostics, ...schema.diagnostics].sort((left, right) =>
    (left.span?.path ?? "").localeCompare(right.span?.path ?? "")
    || (left.span?.start_line ?? 0) - (right.span?.start_line ?? 0)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message));
  const workflow: SourceWorkflowInstance = {
    schema_version: 1,
    workflow_revision: "",
    source: {
      ...source,
      source_digest: manifest.source_digest,
      file_count: manifest.files.length,
      source_bytes: manifest.source_bytes,
    },
    parameters: [...schema.parameters],
    unsupported_required_parameters: [...schema.unsupportedRequired],
    bindings: {},
    scopes: outline.scopes,
    invocations: outline.invocations,
    replacements: [],
    capabilities: {
      exact_execution: false,
      parameter_edits: schema.parameterEdits,
      hierarchy_indexed: outline.scopes.length > 0,
      structural_edits: false,
      channel_contracts: false,
      source_edits: false,
    },
    diagnostics,
  };
  workflow.workflow_revision = sourceWorkflowRevision(workflow);
  const issue = validateSourceWorkflow(workflow);
  if (issue) throw new Error(`derived source workflow is invalid: ${issue}`);
  return { workflow, manifest, parameterSchemaDigest: schema.digest };
}

function validateBinding(parameter: WorkflowParameterField, binding: WorkflowBinding) {
  if (binding.kind === "project_file" || binding.kind === "project_directory") {
    if (parameter.type !== "string" || !safeSourcePath(binding.path)) throw new Error(`parameter ${parameter.name} requires a safe project path`);
    if (binding.kind === "project_file" && parameter.format !== "file-path" && parameter.format !== "path") throw new Error(`parameter ${parameter.name} is not a file path`);
    if (binding.kind === "project_directory" && parameter.format !== "directory-path" && parameter.format !== "path") throw new Error(`parameter ${parameter.name} is not a directory path`);
    if (parameter.choices?.length && !parameter.choices.includes(binding.path)) throw new Error(`parameter ${parameter.name} is not an allowed choice`);
    return;
  }
  if (parameter.format?.includes("path")) throw new Error(`parameter ${parameter.name} requires an explicit project path binding`);
  if (!valueValid(parameter, binding.value)) throw new Error(`parameter ${parameter.name} value violates its contract`);
}

export function applySourceWorkflowEdits(base: SourceWorkflowInstance, baseRevision: string, edits: readonly SourceWorkflowEdit[]) {
  if (sourceWorkflowRevision(base) !== base.workflow_revision) throw new Error("source workflow has a stale semantic revision");
  if (baseRevision !== base.workflow_revision) throw new Error(`source workflow revision ${baseRevision} is stale; current workflow revision is ${base.workflow_revision}`);
  if (!edits.length || edits.length > 64) throw new Error("source workflow transaction must contain between 1 and 64 edits");
  const bindings = { ...(base.bindings ?? {}) };
  const replacements = [...(base.replacements ?? [])];
  for (const edit of edits) {
    if (edit.kind === "set_parameter") {
      if (!base.capabilities.parameter_edits) throw new Error("source workflow does not permit parameter edits");
      const parameter = base.parameters?.find((candidate) => candidate.name === edit.name);
      if (!parameter) throw new Error(`unknown source workflow parameter ${edit.name}`);
      validateBinding(parameter, edit.binding);
      bindings[edit.name] = edit.binding;
    } else if (edit.kind === "reset_parameter") {
      if (!base.parameters?.some((candidate) => candidate.name === edit.name)) throw new Error(`unknown source workflow parameter ${edit.name}`);
      delete bindings[edit.name];
    } else {
      const invocationId = edit.invocation_id;
      if (!base.invocations?.some((candidate) => candidate.id === invocationId)) throw new Error(`unknown source invocation ${invocationId}`);
      const index = replacements.findIndex((candidate) => candidate.invocation_id === invocationId);
      if (edit.kind === "reset_invocation") {
        if (index >= 0) replacements.splice(index, 1);
      } else {
        const replacement = {
          invocation_id: invocationId,
          operator: edit.operator,
          operator_revision: edit.operator_revision,
          ...(edit.params && Object.keys(edit.params).length ? { params: sortedRecord(edit.params) } : {}),
        };
        if (index >= 0) replacements[index] = replacement;
        else replacements.push(replacement);
      }
    }
  }
  replacements.sort((left, right) => left.invocation_id < right.invocation_id ? -1 : left.invocation_id > right.invocation_id ? 1 : 0);
  const edited: SourceWorkflowInstance = { ...base, bindings, replacements, workflow_revision: "" };
  edited.workflow_revision = sourceWorkflowRevision(edited);
  const issue = validateSourceWorkflow(edited);
  if (issue) throw new Error(`edited source workflow is invalid: ${issue}`);
  return edited;
}

function promotedNodeId(operator: string, invocation: string) {
  const base = (operator.split(".").at(-1) ?? "promoted").replaceAll(/[^A-Za-z0-9-]/g, "-").toLocaleLowerCase("en-US").replace(/^-+|-+$/g, "") || "promoted";
  return `${base}-${byteDigest(encoder.encode(invocation)).slice("blake3:".length, "blake3:".length + 8)}`;
}

export function promoteSourceInvocation(graph: SomiteGraph, workflowRevision: string, invocationId: string, catalog: OperatorCatalog) {
  if (graph.nodes.length !== 1 || graph.edges.length || graph.variant_origin) throw new Error("invocation promotion requires one source-backed node and no edges");
  const sourceNode = graph.nodes[0]!;
  const workflow = sourceNode.source_workflow;
  if (!workflow || workflow.workflow_revision !== workflowRevision) throw new Error("source workflow revision is stale");
  const replacement = workflow.replacements?.find((candidate) => candidate.invocation_id === invocationId);
  if (!replacement) throw new Error(`source invocation ${invocationId} has no selected replacement to promote`);
  const operator = catalog.get(replacement.operator);
  if (!operator || operator.revision !== replacement.operator_revision) throw new Error(`replacement operator ${replacement.operator} is not in the pinned catalog`);
  const node: SomiteGraphNode = {
    id: promotedNodeId(operator.id, invocationId),
    operator: operator.id,
    operator_revision: operator.revision,
    ports: operatorPorts(operator),
    params: { ...(replacement.params ?? {}) },
    layout: { ...sourceNode.layout },
  };
  const promoted: SomiteGraph = {
    schema_version: graph.schema_version,
    ...(graph.name ? { name: graph.name } : {}),
    nodes: [node],
    edges: [],
    annotations: graph.annotations ?? [],
    variant_origin: { source_node: sourceNode, promoted_invocations: { [invocationId]: node.id } },
  };
  const validation = validateGraph(promoted);
  if (!validation.ok) throw new Error(validation.issue.message);
  const verified = catalog.verifyGraph(promoted);
  if (!verified.ok) throw new Error(verified.issue.message);
  return promoted;
}

export function restoreSourceWorkflow(graph: SomiteGraph, catalog: OperatorCatalog) {
  if (!graph.variant_origin) throw new Error("the graph is not a promoted source workflow variant");
  const restored: SomiteGraph = {
    schema_version: graph.schema_version,
    ...(graph.name ? { name: graph.name } : {}),
    nodes: [graph.variant_origin.source_node],
    edges: [],
    annotations: graph.annotations ?? [],
  };
  const validation = validateGraph(restored);
  if (!validation.ok) throw new Error(validation.issue.message);
  const verified = catalog.verifyGraph(restored);
  if (!verified.ok) throw new Error(verified.issue.message);
  return restored;
}

export function sourceWorkflowEditResponse(graph: SomiteGraph) {
  return {
    state_revision: graphStateRevision(graph),
    graph_revision: semanticGraphRevision(graph),
    graph,
  };
}
