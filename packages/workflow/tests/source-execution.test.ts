import assert from "node:assert/strict";
import test from "node:test";

import { buildSourceManifest, type FrozenSourceFile } from "../nextflowSource.ts";
import { deriveSourceWorkflow } from "../sourceWorkflow.ts";

const encoder = new TextEncoder();

function file(path: string, text: string): FrozenSourceFile {
  return { path, mode: 0o100644, bytes: encoder.encode(text) };
}

function derive(files: readonly FrozenSourceFile[]) {
  const manifest = buildSourceManifest(files);
  return deriveSourceWorkflow(files, {
    provider: "local",
    repository: "local:demo",
    requested_revision: "working-tree",
    resolved_revision: manifest.source_digest.slice("blake3:".length),
    entrypoint: "main.nf",
  }).workflow;
}

const pixiToml = [
  "[workspace]",
  "name = \"demo\"",
  "channels = [\"conda-forge\", \"bioconda\"]",
  "platforms = [\"linux-64\"]",
  "",
  "[dependencies]",
  "nextflow = \"==26.04.6\"",
  "openjdk = \"==25.0.2\"",
  "coreutils = \"*\"",
  "",
].join("\n");
const pixiLock = "version: 6\nenvironments:\n  default:\n    channels: []\n";

test("a source workflow is executable only through its complete root Pixi lock", () => {
  const runnable = derive([
    file("main.nf", "process PREPARE { script: \"\"\"touch ready\"\"\" }\nworkflow { PREPARE() }\n"),
    file("pixi.toml", pixiToml),
    file("pixi.lock", pixiLock),
  ]);
  assert.equal(runnable.capabilities.exact_execution, true);
  assert.equal(runnable.diagnostics?.some((entry) => entry.code.startsWith("source_pixi_")), false);

  const missingLock = derive([file("main.nf", "workflow {}\n"), file("pixi.toml", pixiToml)]);
  assert.equal(missingLock.capabilities.exact_execution, false);
  assert.ok(missingLock.diagnostics?.some((entry) => entry.code === "source_pixi_lock_incomplete"));

  const missingRuntime = derive([
    file("main.nf", "workflow {}\n"),
    file("pixi.toml", pixiToml.replace("openjdk = \"==25.0.2\"\n", "")),
    file("pixi.lock", pixiLock),
  ]);
  assert.equal(missingRuntime.capabilities.exact_execution, false);
  assert.ok(missingRuntime.diagnostics?.some((entry) => entry.code === "source_pixi_runtime_incomplete"));

  const engineOnly = derive([
    file("main.nf", "process PREPARE { script: \"\"\"touch ready\"\"\" }\nworkflow { PREPARE() }\n"),
    file("nextflow.config", "docker.enabled = true\n"),
    file("pixi.toml", pixiToml),
    file("pixi.lock", pixiLock),
  ]);
  assert.equal(engineOnly.capabilities.exact_execution, true);
});

test("a source without root Pixi files advertises exact execution when its per-task plan is deterministic", () => {
  const workflow = derive([
    file("main.nf", [
      "process PREPARE {",
      "  conda \"${moduleDir}/environment.yml\"",
      "  script: \"\"\"touch ready\"\"\"",
      "}",
      "workflow { PREPARE() }",
      "",
    ].join("\n")),
    file("environment.yml", "channels:\n  - conda-forge\ndependencies:\n  - conda-forge::coreutils=9.5\n"),
  ]);

  assert.equal(workflow.capabilities.exact_execution, true);
  assert.equal(workflow.diagnostics?.some((entry) => entry.code === "source_pixi_environment_missing"), false);
});

test("a source without root Pixi files exposes exact per-task planning blockers", () => {
  const environment = file("environment.yml", "channels:\n  - conda-forge\ndependencies:\n  - conda-forge::coreutils=9.5\n");
  const process = (conda: string) => file("main.nf", [
    "process PREPARE {",
    `  conda ${conda}`,
    "  script: \"\"\"touch ready\"\"\"",
    "}",
    "workflow { PREPARE() }",
    "",
  ].join("\n"));

  const includeConfig = derive([
    process("\"${moduleDir}/environment.yml\""),
    environment,
    file("nextflow.config", "includeConfig params.extra_config\n"),
  ]);
  assert.equal(includeConfig.capabilities.exact_execution, false);
  assert.ok(includeConfig.diagnostics?.some((entry) => entry.code === "task_environment_config_include_unresolved"));

  const dynamic = derive([process("params.environment")]);
  assert.equal(dynamic.capabilities.exact_execution, false);
  assert.ok(dynamic.diagnostics?.some((entry) => entry.code === "source_task_conda_dynamic"));
  assert.equal(dynamic.diagnostics?.some((entry) => entry.code === "source_pixi_environment_missing"), false);

  const empty = derive([file("main.nf", "workflow {}\n")]);
  assert.equal(empty.capabilities.exact_execution, false);
  assert.ok(empty.diagnostics?.some((entry) => entry.code === "source_task_no_reachable_processes"));
});

test("external process environments remain inspectable even beside a Pixi lock", () => {
  const workflow = derive([
    file("main.nf", "process PREPARE { container 'ubuntu:latest'; script: \"\"\"touch ready\"\"\" }\nworkflow { PREPARE() }\n"),
    file("pixi.toml", pixiToml),
    file("pixi.lock", pixiLock),
  ]);
  assert.equal(workflow.capabilities.exact_execution, false);
  assert.ok(workflow.diagnostics?.some((entry) => entry.code === "source_external_task_environment"));
});

test("a root Pixi lock fails closed for plugins, unresolved includes, and config selectors", () => {
  const root = [
    file("main.nf", "process PREPARE { script: \"\"\"touch ready\"\"\" }\nworkflow { PREPARE() }\n"),
    file("pixi.toml", pixiToml),
    file("pixi.lock", pixiLock),
  ];
  const plugins = derive([
    ...root,
    file("nextflow.config", "includeConfig 'conf/plugins.conf'\n"),
    file("conf/plugins.conf", "plugins { id 'nf-schema@2.7.2' }\n"),
  ]);
  assert.equal(plugins.capabilities.exact_execution, false);
  const plugin = plugins.diagnostics?.find((entry) => entry.code === "source_config_plugins_unsupported");
  assert.match(plugin?.message ?? "", /nf-schema@2\.7\.2/);
  assert.deepEqual(plugin?.span, { path: "conf/plugins.conf", start_line: 1, end_line: 1 });

  const dynamicInclude = derive([
    ...root,
    file("nextflow.config", "includeConfig params.extra_config\n"),
  ]);
  assert.equal(dynamicInclude.capabilities.exact_execution, false);
  assert.ok(dynamicInclude.diagnostics?.some((entry) => entry.code === "task_environment_config_include_unresolved"));

  const selector = derive([
    ...root,
    file("nextflow.config", "process { withName: PREPARE { cpus = 2 } }\n"),
  ]);
  assert.equal(selector.capabilities.exact_execution, false);
  assert.ok(selector.diagnostics?.some((entry) => entry.code === "source_config_selector_unsupported"));
});
