import assert from "node:assert/strict";
import test from "node:test";

import { byteDigest, canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import { buildSourceManifest, type FrozenSourceFile } from "@somite/workflow/nextflowSource";
import {
  SOURCE_TASK_EXECUTION_PLANNER_REVISION,
  type SourceTaskExecutionPlan,
} from "@somite/workflow/sourceTaskExecution";
import {
  stagePortableSourceTaskExecution,
  stageSourceTaskExecution,
} from "../src/sourceTaskRewrite.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function file(path: string, source: string): FrozenSourceFile {
  return { path, mode: 0o100644, bytes: encoder.encode(source) };
}

function fixture() {
  const source = [
    "process OLD {",
    "  conda '${moduleDir}/old.yml'",
    "}",
    "process NEW {",
    '  conda "${moduleDir}/new.yml"',
    "}",
    "workflow { OLD(); NEW() }",
    "def decoy = '${moduleDir}/old.yml'",
    "",
  ].join("\n");
  const files = [file("main.nf", source)];
  const sourceDigest = buildSourceManifest(files).source_digest;
  const oldExpression = "${moduleDir}/old.yml";
  const newExpression = "${moduleDir}/new.yml";
  const oldStart = source.indexOf(oldExpression);
  const newStart = source.indexOf(newExpression);
  const environments = ["task_old", "task_new"].map((name) => ({
    name,
    source_environment_digest: byteDigest(encoder.encode(name)),
    source_paths: [`${name}.yml`],
    channels: ["conda-forge", "bioconda"],
    dependencies: [],
    process_scope_ids: [`scope_${name}`],
    invocation_ids: [`call_${name}`],
  }));
  const base: Omit<SourceTaskExecutionPlan, "plan_digest"> = {
    schema_version: 1,
    planner_revision: SOURCE_TASK_EXECUTION_PLANNER_REVISION,
    source_digest: sourceDigest,
    entrypoint: "main.nf",
    channels: ["conda-forge", "bioconda"],
    environments,
    assignments: [
      {
        process_id: "process_old",
        process_scope_id: "scope_task_old",
        process: "OLD",
        span: { path: "main.nf", start_line: 1, end_line: 3 },
        invocation_ids: ["call_task_old"],
        environment: "task_old",
        source_environment_path: "task_old.yml",
        conda_expression: oldExpression,
      },
      {
        process_id: "process_new",
        process_scope_id: "scope_task_new",
        process: "NEW",
        span: { path: "main.nf", start_line: 4, end_line: 6 },
        invocation_ids: ["call_task_new"],
        environment: "task_new",
        source_environment_path: "task_new.yml",
        conda_expression: newExpression,
      },
    ],
    rewrites: [
      {
        path: "main.nf",
        start_byte: oldStart,
        end_byte: oldStart + oldExpression.length,
        expected_digest: byteDigest(encoder.encode(oldExpression)),
        process_scope_id: "scope_task_old",
        environment: "task_old",
      },
      {
        path: "main.nf",
        start_byte: newStart,
        end_byte: newStart + newExpression.length,
        expected_digest: byteDigest(encoder.encode(newExpression)),
        process_scope_id: "scope_task_new",
        environment: "task_new",
      },
    ],
  };
  return { files, plan: { ...base, plan_digest: canonicalJsonDigest(base) }, source };
}

function redigest(plan: SourceTaskExecutionPlan): SourceTaskExecutionPlan {
  const { plan_digest: _advertised, ...base } = plan;
  return { ...base, plan_digest: canonicalJsonDigest(base) };
}

test("stages every guarded Conda literal without mutating the frozen source", () => {
  const { files, plan, source } = fixture();
  const prefixes = new Map([
    ["task_old", "/cache/alice's env/$old"],
    ["task_new", '/cache/new "quoted"/$value'],
  ]);
  const staged = stageSourceTaskExecution(files, plan, prefixes);
  const executed = decoder.decode(staged.files[0]!.bytes);

  assert.equal(decoder.decode(files[0]!.bytes), source);
  assert.match(executed, /conda '\/cache\/alice\\'s env\/\$old'/);
  assert.match(executed, /conda "\/cache\/new \\\"quoted\\\"\/\\\$value"/);
  assert.notEqual(staged.executed_source_digest, staged.source_digest);
  assert.deepEqual(staged.rewritten_files, [{
    path: "main.nf",
    original_digest: byteDigest(files[0]!.bytes),
    executed_digest: byteDigest(staged.files[0]!.bytes),
  }]);
  assert.equal(staged.rewrites.length, 2);
});

test("stages deterministic portable Pixi environment literals with quote-inclusive audit bounds", () => {
  const { files, plan, source } = fixture();
  const first = stagePortableSourceTaskExecution(files, plan);
  const second = stagePortableSourceTaskExecution(files, plan);
  const executed = decoder.decode(first.files[0]!.bytes);
  const oldLiteral = '"${projectDir}/.pixi/envs/task_old"';

  assert.equal(decoder.decode(files[0]!.bytes), source);
  assert.deepEqual(second, first);
  assert.match(executed, /conda "\$\{projectDir\}\/\.pixi\/envs\/task_old"/);
  assert.match(executed, /conda "\$\{projectDir\}\/\.pixi\/envs\/task_new"/);
  assert.match(executed, /def decoy = '\$\{moduleDir\}\/old\.yml'/);
  assert.deepEqual(first.rewrites[0], {
    ...plan.rewrites[0],
    applied_start_byte: plan.rewrites[0]!.start_byte - 1,
    applied_end_byte: plan.rewrites[0]!.end_byte + 1,
    replacement_digest: byteDigest(encoder.encode(oldLiteral)),
    replacement_bytes: encoder.encode(oldLiteral).byteLength,
  });
});

test("portable staging resolves Pixi prefixes from a nested main-script directory", () => {
  const { files, plan } = fixture();
  const nestedPath = "workflows/clipseq/main.nf";
  const nestedFiles = [{ ...files[0]!, path: nestedPath }];
  const nestedPlan = redigest({
    ...plan,
    source_digest: buildSourceManifest(nestedFiles).source_digest,
    entrypoint: nestedPath,
    assignments: plan.assignments.map((assignment) => ({
      ...assignment,
      span: { ...assignment.span, path: nestedPath },
    })),
    rewrites: plan.rewrites.map((rewrite) => ({ ...rewrite, path: nestedPath })),
  });

  const staged = stagePortableSourceTaskExecution(nestedFiles, nestedPlan);
  const executed = decoder.decode(staged.files[0]!.bytes);
  assert.match(executed, /conda "\$\{projectDir\}\/\.\.\/\.\.\/\.pixi\/envs\/task_old"/);
  assert.match(executed, /conda "\$\{projectDir\}\/\.\.\/\.\.\/\.pixi\/envs\/task_new"/);
});

test("portable staging rejects unsafe environment names after full plan re-digest", () => {
  const { files, plan } = fixture();
  const unsafe = "../outside";
  const malformed = redigest({
    ...plan,
    environments: [
      { ...plan.environments[0]!, name: unsafe },
      plan.environments[1]!,
    ],
    assignments: [
      { ...plan.assignments[0]!, environment: unsafe },
      plan.assignments[1]!,
    ],
    rewrites: [
      { ...plan.rewrites[0]!, environment: unsafe },
      plan.rewrites[1]!,
    ],
  });

  assert.throws(
    () => stagePortableSourceTaskExecution(files, malformed),
    /unsafe portable Pixi environment name/,
  );
});

test("rejects stale plans, expressions, ranges, and host prefixes before staging", () => {
  const { files, plan } = fixture();
  const prefixes = new Map([["task_old", "/cache/old"], ["task_new", "/cache/new"]]);
  assert.throws(
    () => stageSourceTaskExecution(files, { ...plan, entrypoint: "changed.nf" }, prefixes),
    /content digest/,
  );
  const changedFiles = [file("main.nf", decoder.decode(files[0]!.bytes).replace("old.yml", "bad.yml"))];
  assert.throws(() => stageSourceTaskExecution(changedFiles, plan, prefixes), /does not describe the frozen source/);

  const forged = redigest({
    ...plan,
    rewrites: [{ ...plan.rewrites[0]!, expected_digest: byteDigest(encoder.encode("wrong")) }],
  });
  assert.throws(() => stageSourceTaskExecution(files, forged, prefixes), /does not match its assignment expression/);

  const overlap = redigest({
    ...plan,
    rewrites: [plan.rewrites[0]!, { ...plan.rewrites[1]!, start_byte: plan.rewrites[0]!.start_byte + 1 }],
  });
  assert.throws(() => stageSourceTaskExecution(files, overlap, prefixes), /overlap/);
  assert.throws(() => stageSourceTaskExecution(files, plan, new Map([["task_old", "relative"], ["task_new", "/cache/new"]])), /unsafe execution prefix/);
  assert.throws(() => stageSourceTaskExecution(files, plan, new Map([["task_old", "/cache/old"]])), /no realized prefix/);
});

test("rejects a re-digested plan whose process-scope assignment is missing", () => {
  const { files, plan } = fixture();
  const malformed = redigest({
    ...plan,
    assignments: plan.assignments.slice(1),
  });

  assert.throws(
    () => stageSourceTaskExecution(files, malformed, new Map([
      ["task_old", "/cache/old"],
      ["task_new", "/cache/new"],
    ])),
    /process scope scope_task_old has no assignment/,
  );
});

test("rejects a re-digested rewrite that crosses process-scope environments", () => {
  const { files, plan } = fixture();
  const malformed = redigest({
    ...plan,
    rewrites: [
      { ...plan.rewrites[0]!, environment: "task_new" },
      plan.rewrites[1]!,
    ],
  });

  assert.throws(
    () => stageSourceTaskExecution(files, malformed, new Map([
      ["task_old", "/cache/old"],
      ["task_new", "/cache/new"],
    ])),
    /rewrite for process scope scope_task_old does not match its assignment/,
  );
});

test("rejects a re-digested assignment whose invocation leaves its environment", () => {
  const { files, plan } = fixture();
  const malformed = redigest({
    ...plan,
    assignments: [
      { ...plan.assignments[0]!, invocation_ids: ["call_other"] },
      plan.assignments[1]!,
    ],
  });

  assert.throws(
    () => stageSourceTaskExecution(files, malformed, new Map([
      ["task_old", "/cache/old"],
      ["task_new", "/cache/new"],
    ])),
    /invocation call_other does not match environment membership/,
  );
});

test("rejects a re-digested assignment whose source environment is not a member", () => {
  const { files, plan } = fixture();
  const malformed = redigest({
    ...plan,
    assignments: [
      { ...plan.assignments[0]!, source_environment_path: "other.yml" },
      plan.assignments[1]!,
    ],
  });

  assert.throws(
    () => stageSourceTaskExecution(files, malformed, new Map([
      ["task_old", "/cache/old"],
      ["task_new", "/cache/new"],
    ])),
    /source environment other\.yml does not belong to task_old/,
  );
});

test("rejects a re-digested rewrite outside its assigned process scope", () => {
  const { files, plan, source } = fixture();
  const decoyStart = source.lastIndexOf("${moduleDir}/old.yml");
  const malformed = redigest({
    ...plan,
    rewrites: [
      {
        ...plan.rewrites[0]!,
        start_byte: decoyStart,
        end_byte: decoyStart + "${moduleDir}/old.yml".length,
      },
      plan.rewrites[1]!,
    ],
  });

  assert.throws(
    () => stageSourceTaskExecution(files, malformed, new Map([
      ["task_old", "/cache/old"],
      ["task_new", "/cache/new"],
    ])),
    /rewrite for process scope scope_task_old is outside its assignment span/,
  );
});
