import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { byteDigest } from "../contentIdentity.ts";
import { buildSourceManifest, indexNextflowSource, type FrozenSourceFile } from "../nextflowSource.ts";
import {
  planAnalyzedSourceTaskExecution,
  planSourceTaskExecution,
  SOURCE_TASK_EXECUTION_PLANNER_REVISION,
  type SourceTaskExecutionDecision,
} from "../sourceTaskExecution.ts";
import { planTaskEnvironments } from "../taskEnvironment.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../testdata/source-workflow/source-task-execution");

function sourceFile(filePath: string, text: string): FrozenSourceFile {
  return { path: filePath, mode: 0o100644, bytes: encoder.encode(text) };
}

async function fixtureFiles(root = fixtureRoot, prefix = ""): Promise<FrozenSourceFile[]> {
  const files: FrozenSourceFile[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await fixtureFiles(path.join(root, entry.name), relative));
    else files.push({ path: relative, mode: 0o100644, bytes: await readFile(path.join(root, entry.name)) });
  }
  return files;
}

function blocked(decision: SourceTaskExecutionDecision, code: string) {
  assert.equal(decision.status, "blocked");
  assert.ok(decision.blockers.some((entry) => entry.code === code), JSON.stringify(decision, null, 2));
}

test("plans deterministic isolated environments for reachable processes and retains exact rewrite provenance", async () => {
  const files = await fixtureFiles();
  const first = planSourceTaskExecution(files, "main.nf");
  const second = planSourceTaskExecution([...files].reverse(), "main.nf");

  assert.equal(first.status, "candidate");
  assert.deepEqual(second, first, "source file enumeration order must not affect the plan");
  assert.equal(first.plan.planner_revision, SOURCE_TASK_EXECUTION_PLANNER_REVISION);
  assert.equal(first.plan.schema_version, 2);
  assert.match(first.plan.plan_digest, /^blake3:[0-9a-f]{64}$/);
  assert.equal("channels" in first.plan, false, "channel order belongs to each task environment");
  assert.ok(first.plan.environments.every((environment) => (
    JSON.stringify(environment.channels) === JSON.stringify(["conda-forge", "bioconda"])
  )));
  assert.equal(first.plan.environments.length, 2, "conflicting versions in separate task environments are valid");
  assert.deepEqual(
    first.plan.environments.flatMap((environment) => environment.dependencies.map((dependency) => dependency.match_spec)).sort(),
    ["bioconda::samtools=1.18", "bioconda::samtools=1.19.2"],
  );
  assert.ok(first.plan.environments.every((environment) => /^task-[0-9a-f]{64}$/.test(environment.name)));
  assert.equal(first.plan.assignments.length, 2);
  assert.equal(first.plan.assignments.some((assignment) => assignment.process === "UNREACHABLE_DYNAMIC"), false);
  assert.equal(first.plan.rewrites.length, 2);

  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  for (const rewrite of first.plan.rewrites) {
    const bytes = byPath.get(rewrite.path);
    assert.ok(bytes);
    const expression = bytes.subarray(rewrite.start_byte, rewrite.end_byte);
    assert.equal(byteDigest(expression), rewrite.expected_digest);
    assert.match(decoder.decode(expression), /^\$\{moduleDir\}\/environment\.yml$/);
  }
});

test("precomputed source analysis preserves the public task-plan identity", async () => {
  const files = await fixtureFiles();
  const manifest = buildSourceManifest(files);
  const outline = indexNextflowSource(files, "main.nf", manifest.source_digest);
  const inventory = planTaskEnvironments(files, "main.nf");
  const reused = planAnalyzedSourceTaskExecution({
    entrypoint: "main.nf",
    source_digest: manifest.source_digest,
    outline,
    inventory,
  });
  const standalone = planSourceTaskExecution(files, "main.nf");

  assert.deepEqual(reused, standalone);
  assert.equal(reused.status, "candidate");
  assert.equal(reused.plan.plan_digest, "blake3:398f58c56058f8e2b54a3bee34bb5769eb54b92694df6a836f5a3adcb6e7da84");
});

test("precomputed source analysis preserves public blockers and their evidence", () => {
  const files = [sourceFile("main.nf", [
    "process MISSING { conda \"${moduleDir}/missing.yml\"; script: \"\"\"true\"\"\" }",
    "workflow { MISSING() }",
    "",
  ].join("\n"))];
  const manifest = buildSourceManifest(files);
  const outline = indexNextflowSource(files, "main.nf", manifest.source_digest);
  const inventory = planTaskEnvironments(files, "main.nf");
  const reused = planAnalyzedSourceTaskExecution({
    entrypoint: "main.nf",
    source_digest: manifest.source_digest,
    outline,
    inventory,
  });

  assert.deepEqual(reused, planSourceTaskExecution(files, "main.nf"));
  assert.equal(reused.status, "blocked");
  assert.deepEqual(reused.blockers, [{
    code: "source_task_environment_missing",
    message: "MISSING references missing frozen environment missing.yml.",
    spans: [{ path: "main.nf", start_line: 1, end_line: 1 }],
  }]);
});

test("deduplicates byte-identical reachable environment files into one named environment", async () => {
  const files = await fixtureFiles();
  const oldEnvironment = files.find((file) => file.path === "modules/used_old/environment.yml")!;
  const same = files.map((file) => file.path === "modules/used_new/environment.yml"
    ? { ...file, bytes: oldEnvironment.bytes }
    : file);
  const decision = planSourceTaskExecution(same, "main.nf");

  assert.equal(decision.status, "candidate");
  assert.equal(decision.plan.environments.length, 1);
  assert.deepEqual(decision.plan.environments[0]?.source_paths, [
    "modules/used_new/environment.yml",
    "modules/used_old/environment.yml",
  ]);
  assert.equal(new Set(decision.plan.assignments.map((assignment) => assignment.environment)).size, 1);
});

test("plans isolated content-addressed environments for coproid-style direct Conda literals", () => {
  const files = [sourceFile("main.nf", [
    "nextflow.enable.dsl = 2",
    "process PANDAS_OLD { conda 'conda-forge::pandas=1.4.3'; script: \"\"\"true\"\"\" }",
    "process PANDAS_NEW { conda 'conda-forge::pandas=2.2.3'; script: \"\"\"true\"\"\" }",
    "workflow { PANDAS_OLD(); PANDAS_NEW() }",
    "",
  ].join("\n"))];
  const first = planSourceTaskExecution(files, "main.nf");
  const second = planSourceTaskExecution([...files].reverse(), "main.nf");

  assert.equal(first.status, "candidate", JSON.stringify(first, null, 2));
  assert.deepEqual(second, first);
  assert.equal(first.plan.environments.length, 2, "different direct expressions must remain isolated");
  assert.deepEqual(
    first.plan.environments.map((environment) => environment.dependencies[0]?.match_spec).sort(),
    ["conda-forge::pandas=1.4.3", "conda-forge::pandas=2.2.3"],
  );
  assert.ok(first.plan.environments.every((environment) => (
    environment.source_paths.length === 1
      && environment.source_paths[0]?.startsWith("direct-conda:blake3:")
      && environment.channels[0] === "conda-forge"
  )));
  assert.equal(first.plan.rewrites.length, 2);
  for (const rewrite of first.plan.rewrites) {
    const expression = files[0]!.bytes.subarray(rewrite.start_byte, rewrite.end_byte);
    assert.equal(byteDigest(expression), rewrite.expected_digest);
    assert.match(decoder.decode(expression), /^conda-forge::pandas=/);
  }
});

test("preserves independent channel orders for direct and file environments", () => {
  const workflow = sourceFile("main.nf", [
    "nextflow.enable.dsl = 2",
    "process FILE_TOOL { conda \"${projectDir}/environment.yml\"; script: \"\"\"true\"\"\" }",
    "process DIRECT_TOOL { conda 'bioconda::samtools=1.20'; script: \"\"\"true\"\"\" }",
    "workflow { FILE_TOOL(); DIRECT_TOOL() }",
    "",
  ].join("\n"));
  const environment = (channels: string) => sourceFile(
    "environment.yml",
    `channels: [${channels}]\ndependencies: [conda-forge::coreutils=9.5]\n`,
  );
  const candidate = planSourceTaskExecution([
    workflow,
    environment("conda-forge, bioconda"),
  ], "main.nf");

  assert.equal(candidate.status, "candidate", JSON.stringify(candidate, null, 2));
  assert.equal(candidate.plan.environments.length, 2);
  assert.deepEqual(new Map(candidate.plan.environments.map((entry) => [
    entry.dependencies[0]?.name,
    entry.channels,
  ])), new Map([
    ["coreutils", ["conda-forge", "bioconda"]],
    ["samtools", ["bioconda"]],
  ]));

  const independent = planSourceTaskExecution([
    workflow,
    environment("conda-forge"),
  ], "main.nf");
  assert.equal(independent.status, "candidate", JSON.stringify(independent, null, 2));
});

test("keeps explicitly channel-qualified direct declarations isolated per task", () => {
  const decision = planSourceTaskExecution([sourceFile("main.nf", [
    "process TABLE { conda 'conda-forge::pandas=1.4.3'; script: \"\"\"true\"\"\" }",
    "process ALIGN { conda 'bioconda::samtools=1.20'; script: \"\"\"true\"\"\" }",
    "workflow { TABLE(); ALIGN() }",
    "",
  ].join("\n"))], "main.nf");

  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));
  assert.deepEqual(decision.plan.environments.map((environment) => environment.channels).sort(), [
    ["bioconda"],
    ["conda-forge"],
  ]);
});

test("blocks a reachable unqualified direct Conda package instead of guessing its source", () => {
  const decision = planSourceTaskExecution([sourceFile("main.nf", [
    "process TOOL { conda 'pandas=1.4.3'; script: \"\"\"true\"\"\" }",
    "workflow { TOOL() }",
    "",
  ].join("\n"))], "main.nf");

  blocked(decision, "source_task_direct_conda_channel_unqualified");
  assert.equal(decision.status, "blocked");
  assert.match(decision.blockers.find((entry) => (
    entry.code === "source_task_direct_conda_channel_unqualified"
  ))?.message ?? "", /pandas=1\.4\.3/);
});

test("plans crisprseq-style unqualified tools from an exact named Conda profile", () => {
  const workflow = sourceFile("main.nf", [
    "nextflow.enable.dsl = 2",
    "process FASTQC { conda 'fastqc=0.12.1'; script: \"\"\"true\"\"\" }",
    "process TRIMGALORE { conda 'trim-galore=0.6.10'; script: \"\"\"true\"\"\" }",
    "workflow { FASTQC(); TRIMGALORE() }",
    "",
  ].join("\n"));
  const config = (channels: readonly string[]) => sourceFile("nextflow.config", [
    "profiles {",
    "  conda {",
    "    conda.enabled = true",
    `    conda.channels = [${channels.map((channel) => `'${channel}'`).join(", ")}]`,
    "  }",
    "}",
    "",
  ].join("\n"));
  const first = planSourceTaskExecution([workflow, config(["conda-forge", "bioconda"])], "main.nf");
  const second = planSourceTaskExecution([config(["conda-forge", "bioconda"]), workflow], "main.nf");

  assert.equal(first.status, "candidate", JSON.stringify(first, null, 2));
  assert.deepEqual(second, first);
  assert.equal(first.plan.config_closure.conda_channel_order?.profile, "conda");
  assert.equal(first.plan.config_closure.conda_profile?.name, "conda");
  assert.deepEqual(first.plan.environments.map((environment) => environment.dependencies[0]?.match_spec).sort(), [
    "fastqc=0.12.1",
    "trim-galore=0.6.10",
  ]);
  assert.ok(first.plan.environments.every((environment) => (
    JSON.stringify(environment.channels) === JSON.stringify(["conda-forge", "bioconda"])
  )));

  const reversed = planSourceTaskExecution([workflow, config(["bioconda", "conda-forge"])], "main.nf");
  assert.equal(reversed.status, "candidate", JSON.stringify(reversed, null, 2));
  assert.notEqual(reversed.plan.plan_digest, first.plan.plan_digest);
  assert.notDeepEqual(
    reversed.plan.environments.map((environment) => environment.name).sort(),
    first.plan.environments.map((environment) => environment.name).sort(),
    "the source channel order is part of each direct environment identity",
  );
});

test("uses the proven config order for transitive dependencies of qualified direct packages", () => {
  const decision = planSourceTaskExecution([
    sourceFile("main.nf", [
      "process ALIGN { conda 'bioconda::samtools=1.20'; script: \"\"\"true\"\"\" }",
      "workflow { ALIGN() }",
      "",
    ].join("\n")),
    sourceFile("nextflow.config", "conda.channels = ['conda-forge', 'bioconda']\n"),
  ], "main.nf");

  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));
  assert.deepEqual(decision.plan.environments[0]?.channels, ["conda-forge", "bioconda"]);
  assert.equal(decision.plan.environments[0]?.dependencies[0]?.channel, "bioconda");
});

test("uses a top-level channel order without inventing a named profile", () => {
  const decision = planSourceTaskExecution([
    sourceFile("main.nf", [
      "process FASTQC { conda 'fastqc=0.12.1'; script: \"\"\"true\"\"\" }",
      "workflow { FASTQC() }",
      "",
    ].join("\n")),
    sourceFile("nextflow.config", "conda.channels = ['conda-forge', 'bioconda']\n"),
  ], "main.nf");

  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));
  assert.equal(decision.plan.config_closure.conda_channel_order?.origin, "top_level");
  assert.equal(decision.plan.config_closure.conda_channel_order?.profile, undefined);
  assert.equal(decision.plan.config_closure.conda_profile, undefined);
});

test("fails closed for unresolved reachable invocations", () => {
  const decision = planSourceTaskExecution([
    sourceFile("main.nf", [
      "nextflow.enable.dsl = 2",
      "include { ABSENT } from './modules/absent'",
      "workflow { ABSENT() }",
      "",
    ].join("\n")),
  ], "main.nf");
  blocked(decision, "source_task_reachable_invocation_unresolved");
});

test("fails closed before rendering when the entry workflow reaches no process", () => {
  const decision = planSourceTaskExecution([sourceFile("main.nf", "workflow {}\n")], "main.nf");
  assert.equal(decision.status, "blocked");
  if (decision.status === "blocked") {
    assert.ok(decision.blockers.some((entry) => entry.code === "source_task_no_reachable_processes"));
  }
});

test("fails closed for dynamic, missing, unsupported, and ambiguous Conda mappings", () => {
  const environment = sourceFile("environment.yml", "channels:\n  - conda-forge\ndependencies:\n  - coreutils=9.5\n");
  const workflow = (body: string) => sourceFile("main.nf", `process TOOL { ${body}; script: \"\"\"true\"\"\" }\nworkflow { TOOL() }\n`);

  blocked(planSourceTaskExecution([workflow("conda params.environment")], "main.nf"), "source_task_conda_dynamic");
  blocked(planSourceTaskExecution([workflow("container 'ubuntu:24.04'")], "main.nf"), "source_task_conda_mapping_missing");
  blocked(planSourceTaskExecution([workflow("conda \"${moduleDir}/environment.yml\"")], "main.nf"), "source_task_environment_missing");
  blocked(planSourceTaskExecution([workflow("conda 'environment.yml'"), environment], "main.nf"), "source_task_conda_unsupported");
  blocked(planSourceTaskExecution([
    workflow("conda \"${moduleDir}/environment.yml\"; conda \"${projectDir}/environment.yml\""),
    environment,
  ], "main.nf"), "source_task_conda_mapping_ambiguous");
});

test("fails closed for conflicts inside one environment while allowing conflicts across environments", () => {
  const main = sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\nworkflow { TOOL() }\n");
  const conflicting = sourceFile("environment.yml", [
    "channels:",
    "  - conda-forge",
    "  - bioconda",
    "dependencies:",
    "  - bioconda::samtools=1.18",
    "  - bioconda::samtools=1.19.2",
    "",
  ].join("\n"));
  blocked(planSourceTaskExecution([main, conflicting], "main.nf"), "source_task_environment_version_conflict");

  const absentChannel = sourceFile("environment.yml", [
    "channels: [conda-forge]",
    "dependencies: [bioconda::samtools=1.20]",
    "",
  ].join("\n"));
  blocked(planSourceTaskExecution([main, absentChannel], "main.nf"), "source_task_environment_channel_absent");

  const mixedDirect = sourceFile("main.nf", [
    "process TOOL { conda 'python=3.11 private::tool=1.0'; script: \"\"\"true\"\"\" }",
    "workflow { TOOL() }",
    "",
  ].join("\n"));
  blocked(planSourceTaskExecution([
    mixedDirect,
    sourceFile("nextflow.config", "conda.channels = ['conda-forge', 'bioconda']\n"),
  ], "main.nf"), "source_task_environment_channel_absent");
});

test("preserves opposite file orders even when a named Conda profile has its own direct-package order", async () => {
  const files = (await fixtureFiles()).map((file) => file.path === "modules/used_new/environment.yml"
    ? sourceFile(file.path, decoder.decode(file.bytes).replace("  - conda-forge\n  - bioconda", "  - bioconda\n  - conda-forge"))
    : file);
  files.push(sourceFile(
    "nextflow.config",
    "profiles { conda { conda.channels = ['conda-forge', 'bioconda'] } }\n",
  ));
  const decision = planSourceTaskExecution(files, "main.nf");
  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));
  assert.deepEqual(decision.plan.environments.map((environment) => environment.channels).sort(), [
    ["bioconda", "conda-forge"],
    ["conda-forge", "bioconda"],
  ]);
});

test("fails closed when includeConfig hides or may hide an environment override", () => {
  const base = [
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\nworkflow { TOOL() }\n"),
    sourceFile("environment.yml", "channels: [conda-forge]\ndependencies: [coreutils=9.5]\n"),
  ];
  blocked(planSourceTaskExecution([
    ...base,
    sourceFile("nextflow.config", "includeConfig 'custom.conf'\n"),
    sourceFile("custom.conf", "process.conda = params.hidden_environment\n"),
  ], "main.nf"), "source_task_config_override");
  blocked(planSourceTaskExecution([
    ...base,
    sourceFile("nextflow.config", "includeConfig params.extra_config\n"),
  ], "main.nf"), "task_environment_config_include_unresolved");
});

test("replans config closure from actual scalar parameter bindings", () => {
  const files = [
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\nworkflow { TOOL() }\n"),
    sourceFile("environment.yml", "channels: [conda-forge]\ndependencies: [coreutils=9.5]\n"),
    sourceFile("nextflow.config", "params { ignored = false }\nincludeConfig !params.ignored ? 'conf/active.config' : 'conf/ignored.config'\n"),
    sourceFile("conf/active.config", "process { withName: TOOL { cpus = 2 } }\n"),
    sourceFile("conf/ignored.config", "process { withName: TOOL { memory = '1 GB' } }\n"),
  ];
  const active = planSourceTaskExecution(files, "main.nf");
  const ignored = planSourceTaskExecution(files, "main.nf", { parameters: { ignored: true } });

  assert.equal(active.status, "candidate", JSON.stringify(active, null, 2));
  assert.equal(ignored.status, "candidate", JSON.stringify(ignored, null, 2));
  assert.deepEqual(active.plan.config_closure.paths, ["conf/active.config", "nextflow.config"]);
  assert.deepEqual(ignored.plan.config_closure.paths, ["conf/ignored.config", "nextflow.config"]);
  assert.notEqual(active.plan.plan_digest, ignored.plan.plan_digest);
});

test("ignores unreferenced test configs but blocks them when statically included", () => {
  const base = [
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\nworkflow { TOOL() }\n"),
    sourceFile("environment.yml", "channels: [conda-forge]\ndependencies: [coreutils=9.5]\n"),
    sourceFile("nf-test.config", "plugins { load 'nft-utils@0.0.3' }\n"),
  ];
  const decision = planSourceTaskExecution(base, "main.nf");

  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));
  blocked(planSourceTaskExecution([
    ...base,
    sourceFile("nextflow.config", "includeConfig 'nf-test.config'\n"),
  ], "main.nf"), "source_config_plugin_declaration_unsupported");
});

test("freezes exact plugins and treats resource selectors as closure-neutral while preserving environment blockers", () => {
  const base = [
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\nworkflow { TOOL() }\n"),
    sourceFile("environment.yml", "channels: [conda-forge]\ndependencies: [coreutils=9.5]\n"),
  ];
  const ignored = planSourceTaskExecution([
    ...base,
    sourceFile("nextflow.config", [
      "// plugins { id 'ignored-comment@1.0.0' }",
      "def note = \"includeConfig params.shadow; plugins { id 'ignored-string@1.0.0' }; withName: TOOL { }\"",
      "def longNote = \"\"\"",
      "process.conda = params.shadow_environment",
      "\"\"\"",
      "",
    ].join("\n")),
  ], "main.nf");
  assert.equal(ignored.status, "candidate", JSON.stringify(ignored, null, 2));

  const decision = planSourceTaskExecution([
    ...base,
    sourceFile("nextflow.config", "includeConfig 'conf/plugins.conf'\nplugins { id 'nf-core-utils@0.5.0' }\n"),
    sourceFile("conf/plugins.conf", "plugins { id 'nf-schema@2.7.2' }\n"),
  ], "main.nf");
  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));
  assert.deepEqual(decision.plan.nextflow_plugins, [
    {
      name: "nf-core-utils",
      version: "0.5.0",
      requirement: "nf-core-utils@0.5.0",
      spans: [{ path: "nextflow.config", start_line: 2, end_line: 2 }],
    },
    {
      name: "nf-schema",
      version: "2.7.2",
      requirement: "nf-schema@2.7.2",
      spans: [{ path: "conf/plugins.conf", start_line: 1, end_line: 1 }],
    },
  ]);

  const nameSelector = planSourceTaskExecution([
    ...base,
    sourceFile("nextflow.config", "process { withName: TOOL { cpus = 2 } }\n"),
  ], "main.nf");
  assert.equal(nameSelector.status, "candidate", JSON.stringify(nameSelector, null, 2));
  const labelSelector = planSourceTaskExecution([
    ...base,
    sourceFile("nextflow.config", "process { withLabel: compute { memory = '2 GB' } }\n"),
  ], "main.nf");
  assert.equal(labelSelector.status, "candidate", JSON.stringify(labelSelector, null, 2));

  blocked(planSourceTaskExecution([
    ...base,
    sourceFile("nextflow.config", "process { withName: TOOL { container = 'ubuntu:24.04' } }\n"),
  ], "main.nf"), "source_task_config_override");
});
