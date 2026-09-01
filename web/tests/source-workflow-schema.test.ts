import assert from "node:assert/strict";
import test from "node:test";

import {
  indexNextflowSource,
  type FrozenSourceFile,
} from "@somite/workflow/nextflowSource";
import {
  applySourceWorkflowEdits,
  deriveSourceWorkflow,
  parseNextflowParameterSchema,
} from "@somite/workflow/sourceWorkflow";

const encoder = new TextEncoder();

function schemaFile(source: string): FrozenSourceFile {
  return { path: "nextflow_schema.json", mode: 0o100644, bytes: encoder.encode(source) };
}

function parseSchema(source: string) {
  return parseNextflowParameterSchema([schemaFile(source)]);
}

function deriveSchema(source: string) {
  return deriveSourceWorkflow([
    { path: "main.nf", mode: 0o100644, bytes: encoder.encode("workflow {}\n") },
    schemaFile(source),
  ], {
    provider: "nf_core",
    repository: "https://github.com/nf-core/example",
    requested_revision: "1.0.0",
    resolved_revision: "a".repeat(40),
    entrypoint: "main.nf",
  }).workflow;
}

function rejectsSchema(source: string, message: string) {
  assert.throws(() => parseSchema(source), (error) => error instanceof Error && error.message === message);
}

test("duplicate JSON members disable parameter editing before last-wins projection", () => {
  for (const source of [
    '{"type":"object","type":"object","properties":{"input":{"type":"string"}}}',
    '{"type":"object","properties":{"input":{"type":"string","type":"integer"}}}',
    '{"type":"object","properties":{"input":{"type":"string"},"input":{"type":"integer"}}}',
    '{"type":"object","properties":{"input":{"type":"string"},"\\u0069nput":{"type":"integer"}}}',
    '{"type":"object","properties":{},"properties":{"input":{"type":"string"}}}',
  ]) {
    const parsed = parseSchema(source);
    assert.equal(parsed.parameterEdits, false);
    assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.code === "unsupported_schema_container"
      && diagnostic.message.includes("duplicate JSON object members")));
  }
});

test("root and group assertions with coupled semantics disable editing explicitly", () => {
  const cases = [
    ['{"type":"object","properties":{"input":{"type":"string"}},"if":{"required":["mode"]},"then":{"required":["input"]}}', "if"],
    ['{"type":"object","properties":{"input":{"type":"string"}},"then":{"required":["input"]}}', "then"],
    ['{"type":"object","properties":{"input":{"type":"string"}},"else":{"required":["input"]}}', "else"],
    ['{"type":"object","properties":{"input":{"type":"string"}},"futureContainerConstraint":{"input":"coupled"}}', "futureContainerConstraint"],
    ['{"type":"object","$defs":{"io":{"type":"object","properties":{"input":{"type":"string"}},"dependentRequired":{"input":["reference"]}}},"allOf":[{"$ref":"#/$defs/io"}]}', "dependentRequired"],
    ['{"type":"object","definitions":{"io":{"type":"object","properties":{"input":{"type":"string"}},"dependencies":{"input":["reference"]}}},"allOf":[{"$ref":"#/definitions/io"}]}', "dependencies"],
    ['{"type":"object","$defs":{"io":{"type":"object","properties":{"input":{"type":"string"}},"futureGroupAssertion":true}},"allOf":[{"$ref":"#/$defs/io"}]}', "futureGroupAssertion"],
    ['{"type":"object","properties":{"input":{"type":"string"}},"allOf":[{"properties":{"input":{"minLength":1}}}]}', "allOf"],
  ] as const;
  for (const [source, keyword] of cases) {
    const parsed = parseSchema(source);
    assert.equal(parsed.parameterEdits, false, keyword);
    assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.code === "unsupported_schema_container"
      && diagnostic.message.includes(keyword)), keyword);
  }
});

test("unsupported property constraints remain source-only without hiding proven parameters", () => {
  const workflow = deriveSchema(`{
    "type": "object",
    "required": ["precise_required"],
    "properties": {
      "good": {"type": "string", "default": "ready"},
      "wrong_bound": {"type": "string", "minimum": 2},
      "wrong_pattern": {"type": "integer", "pattern": "^[0-9]+$"},
      "wrong_format": {"type": "integer", "format": "file-path"},
      "contradictory": {"type": "integer", "minimum": 2, "maximum": 1},
      "precise_required": {"type": "number", "default": 0.10000000000000001}
    }
  }`);

  assert.equal(workflow.capabilities.parameter_edits, true);
  assert.deepEqual(workflow.parameters?.map((parameter) => parameter.name), ["good"]);
  assert.deepEqual(workflow.unsupported_required_parameters?.map((parameter) => parameter.name), ["precise_required"]);
  const constraints = (workflow.diagnostics ?? []).filter((diagnostic) => diagnostic.code === "unsupported_parameter_constraint");
  assert.ok(constraints.length >= 5);
  assert.ok(constraints.every((diagnostic) => diagnostic.message.includes("source-only")
    && diagnostic.message.includes("independently proven parameters remain editable")));
});

test("common nf-core path and pattern keywords project only where Somite can enforce them", () => {
  const workflow = deriveSchema(`{
    "type": "object",
    "required": ["reads", "sample_sheet"],
    "properties": {
      "reads": {
        "type": "string",
        "format": "file-path",
        "exists": true,
        "pattern": "^\\\\S+\\\\.fastq$"
      },
      "index": {
        "type": "string",
        "format": "directory-path",
        "exists": true
      },
      "email": {
        "type": "string",
        "pattern": "^([a-zA-Z0-9_\\\\-\\\\.]+)@([a-zA-Z0-9_\\\\-\\\\.]+)\\\\.([a-zA-Z]{2,5})$"
      },
      "igenomes_base": {
        "type": "string",
        "format": "directory-path",
        "default": "s3://ngi-igenomes/igenomes/"
      },
      "sample_sheet": {
        "type": "string",
        "format": "file-path",
        "exists": true,
        "schema": "assets/schema_input.json"
      },
      "untyped_exists": {
        "type": "string",
        "exists": true
      },
      "malformed_exists": {
        "type": "string",
        "format": "file-path",
        "exists": "yes"
      }
    }
  }`);

  assert.deepEqual(workflow.parameters?.map((parameter) => parameter.name), [
    "reads",
    "index",
    "email",
    "igenomes_base",
  ]);
  assert.equal(workflow.parameters?.find((parameter) => parameter.name === "reads")?.required, true);
  assert.equal(workflow.parameters?.find((parameter) => parameter.name === "igenomes_base")?.default, undefined);
  assert.deepEqual(workflow.unsupported_required_parameters?.map((parameter) => parameter.name), ["sample_sheet"]);
  assert.ok(workflow.diagnostics?.some((diagnostic) => diagnostic.code === "source_parameter_default_retained"
    && diagnostic.message.includes("igenomes_base")));
  assert.ok(workflow.diagnostics?.some((diagnostic) => diagnostic.code === "unsupported_parameter_constraint"
    && diagnostic.message.includes("sample_sheet")
    && diagnostic.message.includes("schema")));
  assert.ok(workflow.diagnostics?.some((diagnostic) => diagnostic.code === "unsupported_parameter_constraint"
    && diagnostic.message.includes("untyped_exists")));
  assert.ok(workflow.diagnostics?.some((diagnostic) => diagnostic.code === "unsupported_parameter_constraint"
    && diagnostic.message.includes("malformed_exists")));

  const email = workflow.parameters?.find((parameter) => parameter.name === "email");
  assert.ok(email);
  const valid = applySourceWorkflowEdits(workflow, workflow.workflow_revision, [{
    kind: "set_parameter",
    name: "email",
    binding: { kind: "literal", value: "person@example.org" },
  }]);
  assert.equal(valid.bindings?.email?.kind, "literal");
  assert.throws(() => applySourceWorkflowEdits(workflow, workflow.workflow_revision, [{
    kind: "set_parameter",
    name: "email",
    binding: { kind: "literal", value: "not-an-email" },
  }]), /violates its contract/);

  const unsafeRepetitions = parseSchema(`{
    "type": "object",
    "properties": {
      "too_wide": {"type": "string", "pattern": "^a{10001}$"},
      "backwards": {"type": "string", "pattern": "^a{5,2}$"}
    }
  }`);
  assert.deepEqual(unsafeRepetitions.parameters, []);
  assert.equal(unsafeRepetitions.diagnostics.filter((diagnostic) => diagnostic.code === "unsupported_parameter_pattern").length, 2);
});

test("numeric lexemes are compared before JavaScript can round them", () => {
  const parsed = parseSchema(`{
    "type": "object",
    "properties": {
      "safe": {"type": "number", "minimum": 0.1, "maximum": 1.5, "enum": [0.1, 1.5], "default": 0.1},
      "bad_minimum": {"type": "number", "minimum": 0.10000000000000001},
      "bad_default": {"type": "number", "default": 0.10000000000000001},
      "bad_enum": {"type": "number", "enum": [0.1, 0.10000000000000001]}
    }
  }`);

  assert.equal(parsed.parameterEdits, true);
  assert.deepEqual(parsed.parameters.map((parameter) => parameter.name), ["safe"]);
  assert.deepEqual(parsed.diagnostics.map((diagnostic) => diagnostic.code), [
    "unsupported_parameter_constraint",
    "unsupported_parameter_constraint",
    "unsupported_parameter_constraint",
  ]);
  assert.ok(parsed.diagnostics.every((diagnostic) => diagnostic.message.includes("original JSON decimal precision")));

  const grouped = parseSchema(`{
    "type": "object",
    "$defs": {
      "inputs": {
        "type": "object",
        "properties": {
          "safe_grouped": {"type": "number", "default": 0.1},
          "bad_grouped": {"type": "number", "maximum": 1.00000000000000001}
        }
      }
    },
    "allOf": [{"$ref": "#/$defs/inputs"}]
  }`);
  assert.deepEqual(grouped.parameters.map((parameter) => parameter.name), ["safe_grouped"]);
  assert.ok(grouped.diagnostics.some((diagnostic) => diagnostic.code === "unsupported_parameter_constraint"
    && diagnostic.message.includes("bad_grouped")
    && diagnostic.message.includes("original JSON decimal precision")));
});

test("schema shape limits reject node, container, property, and string amplification", () => {
  rejectsSchema(JSON.stringify(Array.from({ length: 101 }, () => Array(1_000).fill(null))),
    "parameter schema exceeds 100000 JSON nodes");
  rejectsSchema(JSON.stringify(Array(20_001).fill(null)),
    "parameter schema array exceeds 20000 items");
  rejectsSchema(JSON.stringify(Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`k${index}`, null]))),
    "parameter schema object exceeds 20000 members");

  const properties = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`p${index}`, { type: "string" }]));
  rejectsSchema(JSON.stringify({ type: "object", properties }),
    "parameter schema exceeds 10000 properties");
  rejectsSchema(JSON.stringify({ type: "object", title: "x".repeat(16_385), properties: {} }),
    "parameter schema string exceeds 16384 bytes");
});

test("schema projection and raw numeric lexemes have deterministic byte ceilings", () => {
  const projected = Array.from({ length: 60 }, () => Array(1_000).fill("x".repeat(51)));
  rejectsSchema(JSON.stringify(projected),
    "derived parameter schema projection exceeds the 33554432-byte projection budget");

  for (const number of [`0.${"0".repeat(16_383)}1`, `1e${"1".repeat(16_383)}`]) {
    rejectsSchema(`{"type":"object","properties":{"input":{"type":"number","default":${number}}}}`,
      "parameter schema number exceeds 16384 bytes");
  }
});

test("deep JSON is bounded before the raw audit can recurse", () => {
  const nested = (depth: number) => `${"[".repeat(depth)}null${"]".repeat(depth)}`;
  assert.doesNotThrow(() => parseSchema(nested(128)));
  rejectsSchema(nested(129), "parameter schema exceeds 128 JSON nesting levels");
});

test("source derivation shares one projection budget across outline and schema", () => {
  const declarations = Array.from({ length: 4_000 }, (_, index) => {
    const symbol = `P${String(index).padStart(5, "0")}${"x".repeat(1_018)}`;
    return `process ${symbol} {}`;
  }).join("\n");
  const main = { path: "main.nf", mode: 0o100644, bytes: encoder.encode(declarations) } as const;
  const examples = Array.from({ length: 60 }, () => Array(1_000).fill("x".repeat(30)));
  const schema = JSON.stringify({ type: "object", properties: {}, examples });
  const schemaInput = schemaFile(schema);
  const digest = `blake3:${"0".repeat(64)}`;

  assert.doesNotThrow(() => indexNextflowSource([main], "main.nf", digest));
  assert.doesNotThrow(() => parseSchema(schema));
  assert.throws(() => deriveSourceWorkflow([main, schemaInput], {
    provider: "nf_core",
    repository: "https://github.com/nf-core/example",
    requested_revision: "1.0.0",
    resolved_revision: "a".repeat(40),
    entrypoint: "main.nf",
  }), (error) => error instanceof Error
    && error.message === "derived parameter schema projection exceeds the 33554432-byte projection budget");
});
