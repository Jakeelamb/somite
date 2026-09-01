import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_TASK_ENVIRONMENT_FILE_BYTES,
  planTaskEnvironments,
} from "../taskEnvironment.ts";
import type { FrozenSourceFile } from "../nextflowSource.ts";

const encoder = new TextEncoder();
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../testdata/source-workflow/task-environments");

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

test("inventories task environments with provenance and a conservative Pixi closure candidate", async () => {
  const plan = planTaskEnvironments(await fixtureFiles(), "main.nf");

  assert.equal(plan.processes.length, 2);
  assert.equal(plan.covered_processes, 2);
  assert.equal(plan.declarations.filter((entry) => entry.kind === "conda").length, 2);
  assert.equal(plan.declarations.filter((entry) => entry.kind === "container").length, 2);
  assert.deepEqual(plan.declarations.filter((entry) => entry.kind === "container").map((entry) => entry.resolution).sort(), ["dynamic", "static"]);
  assert.equal(plan.conda_environments.length, 2);
  assert.deepEqual(plan.conda_environments.map((entry) => entry.path), [
    "modules/align/environment.yml",
    "modules/prepare/environment.yml",
  ]);
  assert.equal(plan.conda_environments[0]?.referenced_by[0]?.span.path, "modules/align/main.nf");
  assert.equal(plan.conda_environments[0]?.dependencies[0]?.span.path, "modules/align/environment.yml");
  assert.equal(plan.pixi_closure.status, "candidate");
  assert.deepEqual(plan.pixi_closure.channels, ["conda-forge", "bioconda"]);
  assert.deepEqual(plan.pixi_closure.dependencies.map((entry) => [entry.name, entry.match_spec]), [
    ["bowtie2", "bioconda::bowtie2=2.5.4"],
    ["coreutils", "conda-forge::coreutils=9.5"],
    ["r-base", "conda-forge::r-base>=4.0"],
  ]);
  assert.deepEqual(plan.pixi_closure.blockers, []);
});

test("blocks a single closure for conflicting exact package versions", async () => {
  const files = await fixtureFiles();
  const changed = files.map((entry) => entry.path === "modules/prepare/environment.yml"
    ? sourceFile(entry.path, new TextDecoder().decode(entry.bytes).replace("coreutils=9.5", "coreutils=9.4"))
    : entry);
  const plan = planTaskEnvironments(changed, "main.nf");

  assert.equal(plan.pixi_closure.status, "blocked");
  assert.ok(plan.pixi_closure.blockers.some((entry) => entry.code === "conda_exact_version_conflict" && entry.message.includes("coreutils")));

  const builds = files.map((entry) => {
    if (!entry.path.endsWith("environment.yml")) return entry;
    const build = entry.path.includes("prepare") ? "h1111111_0" : "h2222222_0";
    return sourceFile(entry.path, new TextDecoder().decode(entry.bytes).replace("coreutils=9.5", `coreutils=9.5=${build}`));
  });
  assert.ok(planTaskEnvironments(builds, "main.nf").pixi_closure.blockers.some((entry) => entry.code === "conda_exact_build_conflict"));
});

test("fails closed for missing, dynamic, and container-only task environments", async () => {
  const missing = planTaskEnvironments((await fixtureFiles()).filter((entry) => entry.path !== "modules/align/environment.yml"), "main.nf");
  assert.ok(missing.pixi_closure.blockers.some((entry) => entry.code === "conda_environment_missing"));

  const dynamic = planTaskEnvironments([
    sourceFile("main.nf", "process DYNAMIC { conda params.environment; script: \"\"\"true\"\"\" }\n"),
  ], "main.nf");
  assert.ok(dynamic.pixi_closure.blockers.some((entry) => entry.code === "conda_declaration_dynamic"));

  const containerOnly = planTaskEnvironments([
    sourceFile("main.nf", "process CONTAINER_ONLY { container 'ubuntu:24.04'; script: \"\"\"true\"\"\" }\n"),
  ], "main.nf");
  assert.ok(containerOnly.pixi_closure.blockers.some((entry) => entry.code === "process_without_conda_environment"));
});

test("reports config overrides and bounds referenced environment files", () => {
  const configured = planTaskEnvironments([
    sourceFile("main.nf", "process TOOL { conda 'bioconda::samtools=1.20'; script: \"\"\"true\"\"\" }\n"),
    sourceFile("nextflow.config", "process.conda = params.task_environment\n"),
  ], "main.nf");
  assert.ok(configured.pixi_closure.blockers.some((entry) => entry.code === "task_environment_config_override"));

  assert.throws(() => planTaskEnvironments([
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\n"),
    { path: "environment.yml", mode: 0o100644, bytes: new Uint8Array(MAX_TASK_ENVIRONMENT_FILE_BYTES + 1) },
  ], "main.nf"), /environment\.yml exceeds/);
});

test("follows includeConfig regardless of extension and blocks hidden environment overrides", () => {
  const base = [
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\n"),
    sourceFile("environment.yml", "channels: [conda-forge]\ndependencies: [coreutils=9.5]\n"),
  ];
  const plan = planTaskEnvironments([
    ...base,
    sourceFile("nextflow.config", "includeConfig 'conf/custom.conf'\n"),
    sourceFile("conf/custom.conf", "process.conda = params.hidden_environment\n"),
  ], "main.nf");
  assert.ok(plan.declarations.some((entry) => entry.span.path === "conf/custom.conf" && entry.kind === "conda"));
  assert.ok(plan.pixi_closure.blockers.some((entry) => entry.code === "task_environment_config_override"));

  const dynamic = planTaskEnvironments([
    ...base,
    sourceFile("nextflow.config", "includeConfig params.extra_config\n"),
  ], "main.nf");
  assert.ok(dynamic.configuration_issues.some((entry) => entry.code === "task_environment_config_include_unresolved"));

  const missing = planTaskEnvironments([
    ...base,
    sourceFile("nextflow.config", "includeConfig 'conf/missing.conf'\n"),
  ], "main.nf");
  assert.ok(missing.configuration_issues.some((entry) => entry.code === "task_environment_config_include_missing"));
});

test("analyzes only root and entrypoint config closures", () => {
  const plan = planTaskEnvironments([
    sourceFile("workflows/coproid.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\n"),
    sourceFile("workflows/environment.yml", "channels: [conda-forge]\ndependencies: [coreutils=9.5]\n"),
    sourceFile("nextflow.config", "// root runtime config\n"),
    sourceFile("workflows/nextflow.config", "includeConfig 'conf/runtime.conf'\n"),
    sourceFile("workflows/conf/runtime.conf", "process.conda = params.runtime_environment\n"),
    sourceFile("nf-test.config", "plugins { load 'nft-utils@0.0.3' }\n"),
  ], "workflows/coproid.nf");

  assert.ok(plan.declarations.some((entry) => entry.span.path === "workflows/conf/runtime.conf"));
  assert.ok(plan.pixi_closure.blockers.some((entry) => entry.code === "task_environment_config_override"));
  assert.equal(plan.configuration_issues.some((entry) => entry.spans.some((span) => span.path === "nf-test.config")), false);
});

test("preserves case-sensitive channel URLs exactly", () => {
  const plan = planTaskEnvironments([
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\n"),
    sourceFile("environment.yml", "channels: [https://Packages.Example/CaseSensitive]\ndependencies: [coreutils=9.5]\n"),
  ], "main.nf");
  assert.deepEqual(plan.conda_environments[0]?.channels, ["https://Packages.Example/CaseSensitive"]);
});

test("derives a deterministic shared channel order for channel-qualified direct Conda expressions", () => {
  const files = [sourceFile("main.nf", [
    "process COPROID_TABLE { conda 'conda-forge::pandas=1.4.3'; script: \"\"\"true\"\"\" }",
    "process PREPARE { conda 'conda-forge::python=3.11 conda-forge::coreutils=9.5'; script: \"\"\"true\"\"\" }",
    "",
  ].join("\n"))];
  const first = planTaskEnvironments(files, "main.nf");
  const second = planTaskEnvironments([...files].reverse(), "main.nf");

  assert.deepEqual(second, first);
  assert.equal(first.pixi_closure.status, "candidate", JSON.stringify(first.pixi_closure.blockers, null, 2));
  assert.deepEqual(first.pixi_closure.channels, ["conda-forge"]);
  assert.deepEqual(first.pixi_closure.dependencies.map((dependency) => dependency.match_spec), [
    "conda-forge::coreutils=9.5",
    "conda-forge::pandas=1.4.3",
    "conda-forge::python=3.11",
  ]);
  assert.deepEqual(
    first.declarations.filter((declaration) => declaration.kind === "conda")
      .map((declaration) => declaration.direct_dependencies?.map((dependency) => dependency.channel)),
    [["conda-forge"], ["conda-forge", "conda-forge"]],
  );
});

test("blocks multiple direct channels when no source declares their priority order", () => {
  const plan = planTaskEnvironments([sourceFile("main.nf", [
    "process TABLE { conda 'conda-forge::pandas=1.4.3'; script: \"\"\"true\"\"\" }",
    "process ALIGN { conda 'bioconda::samtools=1.20'; script: \"\"\"true\"\"\" }",
    "",
  ].join("\n"))], "main.nf");

  assert.equal(plan.pixi_closure.status, "blocked");
  assert.ok(plan.pixi_closure.blockers.some((entry) => entry.code === "conda_direct_channel_order_unproven"));
});

test("uses one environment-file channel order for direct Conda expressions and blocks absent channels", () => {
  const workflow = sourceFile("main.nf", [
    "process FILE_TOOL { conda \"${projectDir}/environment.yml\"; script: \"\"\"true\"\"\" }",
    "process DIRECT_TOOL { conda 'bioconda::samtools=1.20'; script: \"\"\"true\"\"\" }",
    "",
  ].join("\n"));
  const environment = (channels: string) => sourceFile(
    "environment.yml",
    `channels: [${channels}]\ndependencies: [conda-forge::coreutils=9.5]\n`,
  );
  const candidate = planTaskEnvironments([workflow, environment("conda-forge, bioconda")], "main.nf");

  assert.equal(candidate.pixi_closure.status, "candidate", JSON.stringify(candidate.pixi_closure.blockers, null, 2));
  assert.deepEqual(candidate.pixi_closure.channels, ["conda-forge", "bioconda"]);

  const blockedPlan = planTaskEnvironments([workflow, environment("conda-forge")], "main.nf");
  assert.ok(blockedPlan.pixi_closure.blockers.some((entry) => (
    entry.code === "conda_direct_channel_absent_from_shared_order" && entry.message.includes("bioconda")
  )));
});

test("blocks an unqualified direct Conda package instead of guessing its channel", () => {
  const plan = planTaskEnvironments([
    sourceFile("main.nf", "process TOOL { conda 'pandas=1.4.3'; script: \"\"\"true\"\"\" }\n"),
  ], "main.nf");

  assert.equal(plan.pixi_closure.status, "blocked");
  assert.ok(plan.pixi_closure.blockers.some((entry) => (
    entry.code === "conda_direct_channel_unqualified" && entry.message.includes("pandas=1.4.3")
  )));
});

test("rejects duplicate top-level YAML keys instead of merging their meaning", () => {
  const plan = planTaskEnvironments([
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\n"),
    sourceFile("environment.yml", [
      "channels: [conda-forge]",
      "dependencies: [coreutils=9.5]",
      "dependencies: [samtools=1.20]",
      "",
    ].join("\n")),
  ], "main.nf");
  assert.ok(plan.conda_environments[0]?.problems.some((entry) => entry.code === "conda_environment_duplicate_key"));
  assert.equal(plan.pixi_closure.status, "blocked");
});

test("accepts one bounded YAML document with standalone start and end markers", () => {
  const plan = planTaskEnvironments([
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\n"),
    sourceFile("environment.yml", [
      "---",
      "channels:",
      "  - conda-forge",
      "dependencies:",
      "  - coreutils=9.5",
      "...",
      "",
    ].join("\n")),
  ], "main.nf");
  assert.equal(plan.conda_environments[0]?.problems.length, 0);
  assert.equal(plan.pixi_closure.status, "candidate");

  const trailing = planTaskEnvironments([
    sourceFile("main.nf", "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }\n"),
    sourceFile("environment.yml", "---\nchannels: [conda-forge]\ndependencies: [coreutils=9.5]\n...\nname: late\n"),
  ], "main.nf");
  assert.ok(trailing.conda_environments[0]?.problems.some((entry) => entry.code === "conda_environment_unsupported_yaml"));
});
