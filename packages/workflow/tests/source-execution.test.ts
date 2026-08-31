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
