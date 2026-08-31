import { byteDigest } from "./contentIdentity.ts";
import { operatorPorts, type OperatorCatalog } from "./catalog.ts";
import {
  buildSourceManifest,
  DerivedProjectionBudget,
  indexNextflowSource,
  MAX_DERIVED_PROJECTION_BYTES,
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
import {
  graphStateRevision,
  MAX_EXACT_JSON_INTEGER_BOUND,
  semanticGraphRevision,
  validateGraph,
  validateSourceWorkflow,
} from "./workflow.ts";

// Bump whenever immutable source-derived fields or capabilities change. This is
// part of every cached source request identity, not a presentation version.
export const SOURCE_INDEXER_REVISION = "source-indexer-ts-v2";
const encoder = new TextEncoder();
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const MAX_SCHEMA_NODES = 100_000;
const MAX_SCHEMA_CONTAINER_ITEMS = 20_000;
const MAX_SCHEMA_DEPTH = 128;
const MAX_SCHEMA_PARAMETERS = 10_000;
const MAX_SCHEMA_STRING_BYTES = 16 * 1024;
const MAX_SCHEMA_TOTAL_STRING_BYTES = 16 * 1024 * 1024;
const MAX_SCHEMA_NUMBER_BYTES = 16 * 1024;
const PROPERTY_KEYS = new Set(["type", "enum", "minimum", "maximum", "pattern", "format", "default"]);
const PROPERTY_ANNOTATIONS = new Set(["title", "description", "help_text", "help", "hidden", "fa_icon", "mimetype", "errorMessage", "examples", "$comment", "readOnly", "writeOnly"]);
const CONTAINER_ANNOTATIONS = new Set(["title", "description", "help_text", "help", "hidden", "fa_icon", "default", "examples", "$comment", "readOnly", "writeOnly"]);
const ROOT_KEYS = new Set(["type", "properties", "required", "allOf", "$defs", "definitions", "$id", "$schema"]);
const GROUP_KEYS = new Set(["type", "properties", "required"]);
const STRING_ANNOTATIONS = new Set(["title", "description", "help_text", "help", "fa_icon", "$comment"]);
const BOOLEAN_ANNOTATIONS = new Set(["hidden", "readOnly", "writeOnly"]);
const PATH_FORMATS = new Set(["file-path", "directory-path", "path"]);

type JsonObject = Record<string, unknown>;
type JsonPath = readonly (string | number)[];

type RawJsonAudit = Readonly<{
  duplicateMembers: boolean;
  precisionLosingProperties: ReadonlySet<string>;
}>;

type SchemaProjectionShape = {
  nodes: number;
  stringBytes: number;
  parameters: number;
};

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

function addSchemaString(shape: SchemaProjectionShape, value: string) {
  const bytes = encoder.encode(value).byteLength;
  if (bytes > MAX_SCHEMA_STRING_BYTES) throw new Error(`parameter schema string exceeds ${MAX_SCHEMA_STRING_BYTES} bytes`);
  shape.stringBytes += bytes;
  if (!Number.isSafeInteger(shape.stringBytes)) throw new Error("parameter schema string byte count overflowed");
  if (shape.stringBytes > MAX_SCHEMA_TOTAL_STRING_BYTES) {
    throw new Error(`parameter schema strings exceed ${MAX_SCHEMA_TOTAL_STRING_BYTES} bytes`);
  }
}

/** Bound the decoded projection iteratively before any recursive/raw audit. */
function schemaProjectionBytes(root: unknown) {
  const shape: SchemaProjectionShape = { nodes: 0, stringBytes: 0, parameters: 0 };
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value: root, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    shape.nodes += 1;
    if (!Number.isSafeInteger(shape.nodes)) throw new Error("parameter schema node count overflowed");
    if (shape.nodes > MAX_SCHEMA_NODES) throw new Error(`parameter schema exceeds ${MAX_SCHEMA_NODES} JSON nodes`);
    if (typeof value === "string") {
      addSchemaString(shape, value);
      continue;
    }
    if (Array.isArray(value)) {
      const childDepth = depth + 1;
      if (childDepth > MAX_SCHEMA_DEPTH) throw new Error(`parameter schema exceeds ${MAX_SCHEMA_DEPTH} JSON nesting levels`);
      if (value.length > MAX_SCHEMA_CONTAINER_ITEMS) {
        throw new Error(`parameter schema array exceeds ${MAX_SCHEMA_CONTAINER_ITEMS} items`);
      }
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push({ value: value[index], depth: childDepth });
      continue;
    }
    const record = object(value);
    if (!record) continue;
    const childDepth = depth + 1;
    if (childDepth > MAX_SCHEMA_DEPTH) throw new Error(`parameter schema exceeds ${MAX_SCHEMA_DEPTH} JSON nesting levels`);
    const entries = Object.entries(record);
    if (entries.length > MAX_SCHEMA_CONTAINER_ITEMS) {
      throw new Error(`parameter schema object exceeds ${MAX_SCHEMA_CONTAINER_ITEMS} members`);
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      addSchemaString(shape, key);
      if (key === "properties") {
        const properties = object(child);
        if (properties) {
          shape.parameters += Object.keys(properties).length;
          if (!Number.isSafeInteger(shape.parameters)) throw new Error("parameter schema property count overflowed");
          if (shape.parameters > MAX_SCHEMA_PARAMETERS) {
            throw new Error(`parameter schema exceeds ${MAX_SCHEMA_PARAMETERS} properties`);
          }
        }
      }
      pending.push({ value: child, depth: childDepth });
    }
  }
  const projectedBytes = shape.nodes * 256 + shape.stringBytes * 6;
  if (!Number.isSafeInteger(projectedBytes)) throw new Error("parameter schema projection byte count overflowed");
  return projectedBytes;
}

function reserveSchemaProjection(budget: DerivedProjectionBudget, bytes: number, kind: string) {
  const reservation = budget.reserve(bytes);
  if (reservation === "overflow") throw new Error("parameter schema projection byte count overflowed");
  if (reservation === "limit") {
    throw new Error(`derived parameter schema ${kind} exceeds the ${MAX_DERIVED_PROJECTION_BYTES}-byte projection budget`);
  }
}

function pathKey(path: JsonPath) {
  return JSON.stringify(path);
}

function numericPropertyPath(path: JsonPath): JsonPath | undefined {
  const keyword = path.at(-1);
  if (keyword === "minimum" || keyword === "maximum" || keyword === "default") return path.slice(0, -1);
  if (typeof keyword === "number" && path.at(-2) === "enum") return path.slice(0, -2);
  return undefined;
}

function normalizedDecimal(source: string) {
  const negative = source.startsWith("-");
  const unsigned = negative ? source.slice(1) : source;
  const exponentAt = unsigned.search(/[eE]/);
  const mantissa = exponentAt < 0 ? unsigned : unsigned.slice(0, exponentAt);
  const exponentSource = exponentAt < 0 ? "0" : unsigned.slice(exponentAt + 1);
  const point = mantissa.indexOf(".");
  const whole = point < 0 ? mantissa : mantissa.slice(0, point);
  const fraction = point < 0 ? "" : mantissa.slice(point + 1);
  let digits = `${whole}${fraction}`;
  const firstNonzero = digits.search(/[1-9]/);
  if (firstNonzero < 0) return "0e0";
  digits = digits.slice(firstNonzero);
  const trailing = digits.match(/0+$/)?.[0].length ?? 0;
  if (trailing) digits = digits.slice(0, -trailing);
  const exponent = BigInt(exponentSource) - BigInt(fraction.length) + BigInt(trailing);
  return `${negative ? "-" : ""}${digits}e${exponent}`;
}

function rawNumberLosesPrecision(source: string) {
  const parsed = Number(source);
  const mantissa = source.split(/[eE]/, 1)[0]!;
  const nonzero = /[1-9]/.test(mantissa);
  if (!Number.isFinite(parsed)) return true;
  if (parsed === 0) return nonzero;
  return normalizedDecimal(source) !== normalizedDecimal(String(parsed));
}

/**
 * Audit parser-sensitive JSON facts before projecting the ordinary JSON.parse
 * result. JSON.parse alone loses duplicate members and original number lexemes.
 */
function auditRawJson(source: string): RawJsonAudit {
  let offset = 0;
  let duplicateMembers = false;
  const precisionLosingProperties = new Set<string>();
  const whitespace = () => {
    while (offset < source.length && /\s/.test(source[offset]!)) offset += 1;
  };
  const parseString = () => {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
      } else if (source[offset++] === '"') {
        return JSON.parse(source.slice(start, offset)) as string;
      }
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = (path: JsonPath): void => {
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      const names = new Set<string>();
      whitespace();
      while (source[offset] !== "}") {
        const name = parseString();
        if (names.has(name)) duplicateMembers = true;
        names.add(name);
        whitespace();
        offset += 1; // Validated JSON guarantees a colon here.
        parseValue([...path, name]);
        whitespace();
        if (source[offset] === ",") {
          offset += 1;
          whitespace();
        } else break;
      }
      offset += 1;
      return;
    }
    if (source[offset] === "[") {
      offset += 1;
      let index = 0;
      whitespace();
      while (source[offset] !== "]") {
        parseValue([...path, index++]);
        whitespace();
        if (source[offset] === ",") {
          offset += 1;
          whitespace();
        } else break;
      }
      offset += 1;
      return;
    }
    if (source[offset] === '"') {
      parseString();
      return;
    }
    if (source[offset] === "-" || /[0-9]/.test(source[offset] ?? "")) {
      const start = offset;
      while (offset < source.length && !/[\s,\]}]/.test(source[offset]!)) offset += 1;
      if (offset - start > MAX_SCHEMA_NUMBER_BYTES) {
        throw new Error(`parameter schema number exceeds ${MAX_SCHEMA_NUMBER_BYTES} bytes`);
      }
      const propertyPath = numericPropertyPath(path);
      if (propertyPath && rawNumberLosesPrecision(source.slice(start, offset))) {
        precisionLosingProperties.add(pathKey(propertyPath));
      }
      return;
    }
    if (source.startsWith("true", offset)) offset += 4;
    else if (source.startsWith("false", offset)) offset += 5;
    else if (source.startsWith("null", offset)) offset += 4;
  };
  parseValue([]);
  return { duplicateMembers, precisionLosingProperties };
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

function annotationIssue(schema: JsonObject, container: boolean) {
  for (const keyword of STRING_ANNOTATIONS) {
    if (schema[keyword] !== undefined && typeof schema[keyword] !== "string") return `annotation ${keyword} is not a string`;
  }
  for (const keyword of BOOLEAN_ANNOTATIONS) {
    if (schema[keyword] !== undefined && typeof schema[keyword] !== "boolean") return `annotation ${keyword} is not a boolean`;
  }
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) return "annotation examples is not an array";
  if (!container && schema.mimetype !== undefined && typeof schema.mimetype !== "string") return "annotation mimetype is not a string";
  if (!container && schema.errorMessage !== undefined) {
    const messages = object(schema.errorMessage);
    if (typeof schema.errorMessage !== "string" && (!messages || Object.values(messages).some((value) => typeof value !== "string"))) {
      return "annotation errorMessage is neither a string nor a string-valued object";
    }
  }
  return undefined;
}

function unsupportedContainerIssue(schema: JsonObject, allowed: ReadonlySet<string>) {
  const unknown = Object.keys(schema).find((key) => !allowed.has(key) && !CONTAINER_ANNOTATIONS.has(key));
  return unknown ? `container keyword ${JSON.stringify(unknown)} is not supported` : annotationIssue(schema, true);
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

type ParsedProperty = Readonly<{
  field?: WorkflowParameterField;
  diagnostic?: SourceDiagnostic;
  unsupported?: UnsupportedRequiredWorkflowParameter;
}>;

function unsupportedProperty(
  name: string,
  group: string,
  schema: JsonObject,
  required: boolean,
  detail: string,
  code = "unsupported_parameter_constraint",
): ParsedProperty {
  const fieldLabel = printable(text(schema.title) ?? "") ? text(schema.title)! : label(name);
  return {
    ...(required ? { unsupported: {
      name,
      label: fieldLabel,
      group,
      ...(text(schema.description) ? { description: text(schema.description) } : {}),
      reason: detail,
      ...(schema.hidden === true ? { hidden: true } : {}),
    } } : {}),
    diagnostic: {
      code,
      message: `Parameter ${name} remains source-only because its ${detail}; independently proven parameters remain editable.`,
      span: schemaSpan(),
    },
  };
}

function parseProperty(
  name: string,
  group: string,
  schema: JsonObject,
  required: boolean,
  precisionLosing: boolean,
): ParsedProperty {
  const type = parameterType(schema.type);
  if (!type) return unsupportedProperty(name, group, schema, required, "type is not a supported primitive", "unsupported_parameter");

  const unknown = Object.keys(schema).find((key) => !PROPERTY_KEYS.has(key) && !PROPERTY_ANNOTATIONS.has(key));
  if (unknown) return unsupportedProperty(
    name,
    group,
    schema,
    required,
    `property keyword ${JSON.stringify(unknown)} has no proven validation parity in the typed source editor`,
  );
  const malformedAnnotation = annotationIssue(schema, false);
  if (malformedAnnotation) return unsupportedProperty(name, group, schema, required, malformedAnnotation);
  if (precisionLosing) return unsupportedProperty(
    name,
    group,
    schema,
    required,
    "numeric constraint, default, or enum loses its original JSON decimal precision",
  );

  const pattern = text(schema.pattern);
  if (schema.pattern !== undefined && pattern === undefined) {
    return unsupportedProperty(name, group, schema, required, "JSON Schema constraint pattern is not a string");
  }
  if (pattern !== undefined && type !== "string") {
    return unsupportedProperty(name, group, schema, required, "JSON Schema pattern is only supported on string properties");
  }
  const patternIssue = pattern === undefined ? undefined : safePattern(pattern);
  if (patternIssue) {
    return unsupportedProperty(
      name,
      group,
      schema,
      required,
      `pattern is outside Somite's ECMA-262-compatible printable-ASCII subset (${patternIssue})`,
      "unsupported_parameter_pattern",
    );
  }

  const format = text(schema.format);
  if (schema.format !== undefined && (!format || !PATH_FORMATS.has(format) || type !== "string")) {
    return unsupportedProperty(name, group, schema, required, "JSON Schema format is not a supported path format on a string property");
  }

  if ((schema.minimum !== undefined || schema.maximum !== undefined) && type !== "integer" && type !== "number") {
    return unsupportedProperty(name, group, schema, required, "numeric bounds on a non-numeric property are outside Somite's proven editable contract");
  }
  for (const keyword of ["minimum", "maximum"] as const) {
    if (schema[keyword] === undefined) continue;
    const bound = schema[keyword];
    if (typeof bound !== "number" || !Number.isFinite(bound) || Object.is(bound, -0)) {
      return unsupportedProperty(name, group, schema, required, `JSON Schema constraint ${keyword} is not an exact finite number`);
    }
    if (bound < -MAX_EXACT_JSON_INTEGER_BOUND || bound > MAX_EXACT_JSON_INTEGER_BOUND
      || type === "integer" && !Number.isSafeInteger(bound)) {
      return unsupportedProperty(name, group, schema, required, `${type} constraint ${keyword} is outside Somite's exact persisted-bound domain`);
    }
  }
  const minimum = typeof schema.minimum === "number" ? schema.minimum : undefined;
  const maximum = typeof schema.maximum === "number" ? schema.maximum : undefined;
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    return unsupportedProperty(name, group, schema, required, "minimum is greater than maximum");
  }

  const rawChoices = schema.enum;
  if (rawChoices !== undefined && (!Array.isArray(rawChoices) || rawChoices.length === 0)) {
    return unsupportedProperty(name, group, schema, required, Array.isArray(rawChoices)
      ? "enum is empty and cannot produce an editable value"
      : "enum is not an array", "unsupported_parameter_enum");
  }
  const choices = Array.isArray(rawChoices) ? rawChoices.map(parameterValue) : [];
  const provisional = { type, minimum, maximum, ...(pattern ? { pattern } : {}) };
  if (choices.some((choice) => choice === undefined
    || !valueValid(provisional, choice)
    || (format && (typeof choice !== "string" || !safeSourcePath(choice))))) {
    return unsupportedProperty(
      name,
      group,
      schema,
      required,
      "enum contains a value outside the representable type, bounds, printable-ASCII pattern, or safe project-path domain",
      "unsupported_parameter_enum",
    );
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
    ...(format ? { format } : {}),
    ...(pattern ? { pattern } : {}),
    ...(choices.length ? { choices: choices as ParamValue[] } : {}),
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  };
  const defaultValue = parameterValue(schema.default);
  if (schema.default !== undefined && schema.default !== null && (defaultValue === undefined || !valueValid(field, defaultValue)
    || (format && (typeof defaultValue !== "string" || !safeSourcePath(defaultValue))))) {
    return unsupportedProperty(
      name,
      group,
      schema,
      required,
      "default is outside the representable type, bounds, enum, printable-ASCII pattern, or safe project-path domain",
      "unsupported_parameter_default",
    );
  }
  if (defaultValue !== undefined) field.default = defaultValue;
  return { field };
}

export function parseNextflowParameterSchema(
  files: readonly FrozenSourceFile[],
  projectionBudget = new DerivedProjectionBudget(),
): ParsedParameterSchema {
  const schemaFile = files.find((file) => file.path === "nextflow_schema.json");
  if (!schemaFile) {
    const code = "parameter_schema_missing";
    const message = "The pinned source has no tracked nextflow_schema.json.";
    reserveSchemaProjection(projectionBudget, 256 + code.length + message.length, "diagnostics");
    return {
      parameters: [],
      unsupportedRequired: [],
      diagnostics: [{ code, message }],
      parameterEdits: false,
    };
  }
  if (schemaFile.bytes.byteLength > MAX_SCHEMA_BYTES) throw new Error(`nextflow_schema.json exceeds ${MAX_SCHEMA_BYTES} bytes`);
  const parameters: WorkflowParameterField[] = [];
  const unsupportedRequired: UnsupportedRequiredWorkflowParameter[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const names = new Set<string>();
  const parameterIndices = new Map<string, number>();
  const unsupportedRequiredNames = new Set<string>();
  let parameterEdits = true;
  const disableEdits = (message: string) => {
    parameterEdits = false;
    diagnostics.push({ code: "unsupported_schema_container", message, span: schemaSpan() });
  };
  const retainRequired = (name: string, group: string, reason: string, schema?: JsonObject) => {
    const index = parameterIndices.get(name);
    if (index !== undefined) {
      parameters[index]!.required = true;
      return;
    }
    if (unsupportedRequiredNames.has(name)) return;
    unsupportedRequiredNames.add(name);
    unsupportedRequired.push({
      name,
      label: schema && printable(text(schema.title) ?? "") ? text(schema.title)! : label(name),
      group,
      ...(schema && text(schema.description) ? { description: text(schema.description) } : {}),
      reason,
      ...(schema?.hidden === true ? { hidden: true } : {}),
    });
  };
  const requiredNames = (schema: JsonObject) => {
    if (schema.required === undefined) return { names: new Set<string>(), valid: true };
    if (!Array.isArray(schema.required)) return { names: new Set<string>(), valid: false };
    const required = new Set<string>();
    let valid = true;
    for (const value of schema.required) {
      if (typeof value !== "string" || !printable(value) || required.has(value)) valid = false;
      else required.add(value);
    }
    return { names: required, valid };
  };

  const source = new TextDecoder("utf-8", { fatal: true }).decode(schemaFile.bytes);
  const decoded = JSON.parse(source) as unknown;
  reserveSchemaProjection(projectionBudget, schemaProjectionBytes(decoded), "projection");
  const audit = auditRawJson(source);
  if (audit.duplicateMembers) disableEdits(
    "The parameter schema contains duplicate JSON object members; parameter editing is disabled because parser-independent semantics cannot be proven.",
  );
  const root = object(decoded);
  if (!root) {
    disableEdits("Root parameter schema must be an object; parameter editing is disabled.");
    return { parameters, unsupportedRequired, diagnostics, parameterEdits, digest: byteDigest(schemaFile.bytes) };
  }

  if (root.type !== "object") disableEdits("Root parameter schema type must be object; parameter editing is disabled.");
  const rootIssue = unsupportedContainerIssue(root, ROOT_KEYS);
  if (rootIssue) disableEdits(`Root JSON Schema ${rootIssue}; parameter editing is disabled.`);
  for (const keyword of ["$id", "$schema"] as const) {
    if (root[keyword] !== undefined && typeof root[keyword] !== "string") {
      disableEdits(`Root JSON Schema annotation ${keyword} is not a string; parameter editing is disabled.`);
    }
  }
  if (root.$defs !== undefined && root.definitions !== undefined) {
    disableEdits("Root schema cannot combine $defs and definitions in the typed source editor; parameter editing is disabled.");
  }
  for (const keyword of ["$defs", "definitions"] as const) {
    if (root[keyword] !== undefined && !object(root[keyword])) {
      disableEdits(`Root ${keyword} must be an object; parameter editing is disabled.`);
    }
  }

  const definitions = object(root.$defs) ?? object(root.definitions);
  const namespace = object(root.$defs) ? "$defs" : "definitions";
  if (definitions && root.properties !== undefined) {
    disableEdits("Root properties combined with $defs/definitions are not a supported source-editor shape; parameter editing is disabled.");
  }
  if (root.properties !== undefined && !object(root.properties)) {
    disableEdits("Root properties must be an object; parameter editing is disabled.");
  }

  const decodeReference = (reference: string): string | undefined => {
    const prefix = `#/${namespace}/`;
    if (!reference.startsWith(prefix)) return undefined;
    const encoded = reference.slice(prefix.length);
    if (!encoded || encoded.includes("/") || encoded.includes("%")) return undefined;
    let value = "";
    for (let index = 0; index < encoded.length; index += 1) {
      if (encoded[index] !== "~") value += encoded[index];
      else if (encoded[index + 1] === "0") { value += "~"; index += 1; }
      else if (encoded[index + 1] === "1") { value += "/"; index += 1; }
      else return undefined;
    }
    return value;
  };

  const groups: Array<[string, JsonObject, JsonPath]> = [];
  const rootRequirements: Array<Readonly<{ names: ReadonlySet<string>; reason: string }>> = [];
  const rootRequired = requiredNames(root);
  if (!rootRequired.valid) disableEdits("Root required must be an array of unique string names; parameter editing is disabled.");
  rootRequirements.push({
    names: rootRequired.names,
    reason: "the root schema requires a parameter without one complete editable property contract",
  });

  if (!definitions && object(root.properties)) {
    groups.push(["Parameters", root, []]);
  }
  if (root.allOf === undefined && definitions && Object.keys(definitions).length) {
    disableEdits("Root definitions are not active parameters without explicit local allOf references; parameter editing is disabled.");
  } else if (root.allOf !== undefined && !Array.isArray(root.allOf)) {
    disableEdits("Root allOf must be an array; parameter editing is disabled.");
  } else if (Array.isArray(root.allOf)) {
    for (const clauseValue of root.allOf) {
      const clause = object(clauseValue);
      if (!clause) {
        disableEdits("Root allOf clause is not an object; parameter editing is disabled.");
        continue;
      }
      if (Object.keys(clause).length === 1 && typeof clause.$ref === "string") {
        const key = definitions ? decodeReference(clause.$ref) : undefined;
        if (key !== undefined && definitions && Object.hasOwn(definitions, key)) {
          const group = object(definitions[key]);
          if (!group) disableEdits(`Schema definition ${JSON.stringify(key)} is not an object; parameter editing is disabled.`);
          else if (!groups.some(([existing]) => existing === key)) groups.push([key, group, [namespace, key]]);
          continue;
        }
        disableEdits("Root allOf contains an unknown or non-local $ref; parameter editing is disabled.");
        continue;
      }
      if (Object.keys(clause).length === 1 && clause.required !== undefined) {
        const required = requiredNames(clause);
        if (!required.valid) disableEdits("Root allOf required must be an array of unique string names; parameter editing is disabled.");
        rootRequirements.push({
          names: required.names,
          reason: "an allOf clause requires a parameter without one complete editable property contract",
        });
        continue;
      }
      disableEdits("Root allOf clause contains unsupported assertions; parameter editing is disabled.");
      const required = requiredNames(clause);
      rootRequirements.push({
        names: required.names,
        reason: "an unsupported allOf clause contains this statically discoverable requirement",
      });
    }
  }

  if (!groups.length && !object(root.properties)) {
    parameterEdits = false;
    diagnostics.push({ code: "parameter_schema_empty", message: "nextflow_schema.json has no supported parameter properties.", span: schemaSpan() });
  }

  for (const [key, group, groupPath] of groups) {
    const groupTitle = printable(text(group.title) ?? "") ? text(group.title)! : label(key);
    const properties = object(group.properties);
    const required = requiredNames(group);
    const groupIssue = groupPath.length ? unsupportedContainerIssue(group, GROUP_KEYS) : undefined;
    const detail = groupPath.length && group.type !== "object" ? "container type must be object"
      : groupIssue ? groupIssue
        : group.properties !== undefined && !properties ? "properties is not an object"
          : !required.valid ? "required must be an array of unique string names"
            : undefined;
    if (detail) {
      disableEdits(`Schema container ${groupTitle} remains source-only because ${detail}; parameter editing is disabled.`);
      for (const name of required.names) retainRequired(name, groupTitle, detail, object(properties?.[name]));
      continue;
    }
    if (!properties) continue;
    for (const [name, candidate] of Object.entries(properties)) {
      if (!printable(name) || names.has(name)) {
        if (!printable(name)) {
          diagnostics.push({ code: "unsupported_parameter_name", message: `Schema property name ${JSON.stringify(name)} remains source-only because editable parameter names must be non-blank and contain no control characters; independently proven parameters remain editable.`, span: schemaSpan() });
        } else {
          parameterEdits = false;
          diagnostics.push({ code: "duplicate_parameter", message: `Parameter ${name} appears in more than one schema group.`, span: schemaSpan() });
          if (required.names.has(name)) retainRequired(name, groupTitle, "duplicate parameter has no single representable contract", object(candidate));
        }
        continue;
      }
      names.add(name);
      const schema = object(candidate);
      if (!schema) {
        diagnostics.push({ code: "unsupported_parameter", message: `Parameter ${name} remains source-only because its schema is not an object.`, span: schemaSpan() });
        if (required.names.has(name)) retainRequired(name, groupTitle, "schema is not an object");
        continue;
      }
      const parsed = parseProperty(
        name,
        groupTitle,
        schema,
        required.names.has(name),
        audit.precisionLosingProperties.has(pathKey([...groupPath, "properties", name])),
      );
      if (parsed.field) {
        parameterIndices.set(name, parameters.length);
        parameters.push(parsed.field);
      }
      if (parsed.unsupported && !unsupportedRequiredNames.has(name)) {
        unsupportedRequiredNames.add(name);
        unsupportedRequired.push(parsed.unsupported);
      }
      if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
    }
    for (const name of required.names) {
      if (Object.hasOwn(properties, name)) continue;
      retainRequired(name, groupTitle, "required name has no property contract");
      diagnostics.push({ code: "unsupported_parameter", message: `Parameter ${name} remains source-only because its required name has no property contract.`, span: schemaSpan() });
    }
  }

  for (const requirement of rootRequirements) {
    for (const name of requirement.names) retainRequired(name, "Parameters", requirement.reason, object(object(root.properties)?.[name]));
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

function sourceText(file: FrozenSourceFile) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return undefined;
  }
}

function rootPixiDependencies(text: string) {
  const dependencies = new Set<string>();
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      continue;
    }
    if (section !== "dependencies") continue;
    const assignment = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (assignment) dependencies.add(assignment[1]!.toLocaleLowerCase("en-US"));
  }
  return dependencies;
}

function externalEnvironmentDirective(files: readonly FrozenSourceFile[]) {
  const sourceFiles = files.filter((file) => file.path.endsWith(".nf") || file.path.endsWith(".config"));
  for (const file of sourceFiles) {
    const text = sourceText(file);
    if (text === undefined) continue;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.replace(/\/\/.*$/, "");
      if (/\b(?:container|conda|spack|module)\s+(?:['"]|[A-Za-z_$])/.test(line)
        || /\b(?:container|conda|spack|module)\s*=/.test(line)
        || /\b(?:docker|podman|singularity|apptainer|wave|fusion)\.enabled\s*=\s*true\b/.test(line)) {
        return { path: file.path, line: index + 1 };
      }
    }
  }
  return undefined;
}

function sourceExecutionCapability(files: readonly FrozenSourceFile[]) {
  const diagnostics: SourceDiagnostic[] = [];
  const manifestFile = files.find((file) => file.path === "pixi.toml");
  const lockFile = files.find((file) => file.path === "pixi.lock");
  const diagnostic = (code: string, message: string, path: string, line = 1) => diagnostics.push({
    code,
    message,
    span: { path, start_line: line, end_line: line },
  });
  if (!manifestFile && !lockFile) {
    diagnostic(
      "source_pixi_environment_missing",
      "Exact execution remains disabled because the source has no root pixi.toml and pixi.lock task environment.",
      "main.nf",
    );
    return { exact: false, diagnostics };
  }
  if (!manifestFile || !lockFile) {
    diagnostic(
      "source_pixi_lock_incomplete",
      "Exact execution remains disabled because the source must contain both root pixi.toml and pixi.lock files.",
      manifestFile?.path ?? lockFile!.path,
    );
    return { exact: false, diagnostics };
  }
  const manifestText = sourceText(manifestFile);
  const lockText = sourceText(lockFile);
  const dependencies = manifestText === undefined ? new Set<string>() : rootPixiDependencies(manifestText);
  if (!dependencies.has("nextflow") || !dependencies.has("openjdk")
    || lockText === undefined || !/^version:\s*\d+/m.test(lockText) || !/^environments:\s*$/m.test(lockText)) {
    diagnostic(
      "source_pixi_runtime_incomplete",
      "Exact execution remains disabled because the root Pixi environment must lock both Nextflow and OpenJDK.",
      "pixi.toml",
    );
    return { exact: false, diagnostics };
  }
  const external = externalEnvironmentDirective(files);
  if (external) {
    diagnostic(
      "source_external_task_environment",
      "Exact execution remains disabled because this workflow delegates a process environment to a container, Conda, module, or external runtime instead of the locked root Pixi environment.",
      external.path,
      external.line,
    );
    return { exact: false, diagnostics };
  }
  return { exact: true, diagnostics };
}

export function deriveSourceWorkflow(files: readonly FrozenSourceFile[], source: Omit<SourceWorkflowInstance["source"], "source_digest" | "file_count" | "source_bytes">) {
  const manifest = buildSourceManifest(files);
  const projectionBudget = new DerivedProjectionBudget();
  const outline = indexNextflowSource(files, source.entrypoint, manifest.source_digest, projectionBudget);
  const schema = parseNextflowParameterSchema(files, projectionBudget);
  const execution = sourceExecutionCapability(files);
  const diagnostics = [...outline.diagnostics, ...schema.diagnostics, ...execution.diagnostics].sort((left, right) =>
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
      exact_execution: execution.exact,
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

function promotionSource(graph: SomiteGraph) {
  if (graph.variant_origin) return graph.variant_origin.source_node;
  if (graph.nodes.length !== 1 || graph.edges.length || !graph.nodes[0]?.source_workflow) {
    throw new Error("invocation promotion requires one source-backed workflow or an existing native variant");
  }
  return graph.nodes[0];
}

function promotedLayout(sourceNode: SomiteGraphNode, invocationId: string, offset: number) {
  const position = sourceNode.source_canvas?.positions?.[invocationId];
  if (position) return { x: sourceNode.layout.x + position.x, y: sourceNode.layout.y + position.y };
  return { x: sourceNode.layout.x + offset * 260, y: sourceNode.layout.y + (offset % 2) * 170 };
}

export function promoteSourceInvocations(graph: SomiteGraph, workflowRevision: string, invocationIds: readonly string[], catalog: OperatorCatalog) {
  if (!invocationIds.length) throw new Error("at least one source invocation is required for promotion");
  if (new Set(invocationIds).size !== invocationIds.length) throw new Error("source invocation promotion contains a duplicate invocation");
  const sourceNode = promotionSource(graph);
  const workflow = sourceNode.source_workflow;
  if (!workflow || workflow.workflow_revision !== workflowRevision) throw new Error("source workflow revision is stale");
  const promotedInvocations = { ...(graph.variant_origin?.promoted_invocations ?? {}) };
  const nodes = graph.variant_origin ? [...graph.nodes] : [];
  for (const invocationId of invocationIds) {
    if (promotedInvocations[invocationId]) throw new Error(`source invocation ${invocationId} is already editable`);
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
      layout: promotedLayout(sourceNode, invocationId, nodes.length),
    };
    if (nodes.some((candidate) => candidate.id === node.id)) throw new Error(`promoted Node id ${node.id} already exists`);
    nodes.push(node);
    promotedInvocations[invocationId] = node.id;
  }
  const promoted: SomiteGraph = {
    schema_version: graph.schema_version,
    ...(graph.name ? { name: graph.name } : {}),
    nodes,
    edges: graph.variant_origin ? graph.edges : [],
    annotations: graph.annotations ?? [],
    variant_origin: { source_node: sourceNode, promoted_invocations: promotedInvocations },
  };
  const validation = validateGraph(promoted);
  if (!validation.ok) throw new Error(validation.issue.message);
  const verified = catalog.verifyGraph(promoted);
  if (!verified.ok) throw new Error(verified.issue.message);
  return promoted;
}

export function promoteSourceInvocation(graph: SomiteGraph, workflowRevision: string, invocationId: string, catalog: OperatorCatalog) {
  return promoteSourceInvocations(graph, workflowRevision, [invocationId], catalog);
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
