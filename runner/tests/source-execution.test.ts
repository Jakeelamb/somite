import assert from "node:assert/strict";
import test from "node:test";

import { byteDigest } from "@somite/workflow/contentIdentity";
import type { FrozenSourceFile } from "@somite/workflow/nextflowSource";

import type { LockedManifest, PixiCache } from "../src/pixiCache.ts";
import {
  freezeSourceExecution,
  packagePortableSourceExecution,
  realizeSourceExecution,
} from "../src/sourceExecution.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function file(path: string, text: string): FrozenSourceFile {
  return { path, mode: 0o100644, bytes: encoder.encode(text) };
}

function locked(
  manifestInput: Uint8Array<ArrayBufferLike>,
  lockInput: Uint8Array<ArrayBufferLike> = encoder.encode("version: 6\nenvironments:\n"),
): LockedManifest {
  const manifest = Uint8Array.from(manifestInput);
  const lock = Uint8Array.from(lockInput);
  return {
    pixi: "/tools/pixi",
    manifest,
    lock,
    manifest_digest: byteDigest(manifest),
    lock_digest: byteDigest(lock),
  };
}

test("freezes, realizes, and audits one generated per-task source execution contract", async () => {
  const files = [
    file("main.nf", [
      "process TOOL {",
      "  conda \"${moduleDir}/environment.yml\"",
      "  script: \"\"\"true\"\"\"",
      "}",
      "workflow { TOOL() }",
      "",
    ].join("\n")),
    file("environment.yml", "channels: [conda-forge]\ndependencies: [coreutils=9.5]\n"),
  ];
  let renderedManifest = "";
  const cache = {
    async lock(manifest: string) {
      renderedManifest = manifest;
      return locked(encoder.encode(manifest));
    },
    async realizeWorkspace(frozen: LockedManifest, _platform: string, environments: readonly string[]) {
      return {
        manifestPath: "/cache/workspace/pixi.toml",
        prefixes: new Map(environments.filter((environment) => environment !== "default")
          .map((environment) => [environment, `/cache/workspace/.pixi/envs/${environment}`])),
      };
    },
  } as unknown as PixiCache;

  const frozen = await freezeSourceExecution(files, "main.nf", "linux-64", cache);
  assert.equal(frozen.mode, "generated_task_environments");
  assert.match(renderedManifest, /\[environments\]/);
  const portable = packagePortableSourceExecution(frozen);
  const portableMain = decoder.decode(portable.source_files.find((entry) => entry.path === "main.nf")!.bytes);
  assert.match(portableMain, /"\$\{projectDir\}\/\.pixi\/envs\/task-[a-f0-9]{64}"/);
  assert.doesNotMatch(portableMain, /\/cache\/workspace/);
  assert.equal(portable.generated_files.has("pixi.toml"), true);
  assert.equal(portable.generated_files.has("pixi.lock"), true);
  const realized = await realizeSourceExecution(frozen, "linux-64", cache);
  assert.equal(realized.environment_manifest, "/cache/workspace/pixi.toml");
  assert.equal(realized.generated_files.has("pixi.toml"), true);
  assert.equal(realized.generated_files.has("pixi.lock"), true);
  assert.equal(realized.generated_files.has(".somite/run/source-task-plan.json"), true);
  const executionConfig = decoder.decode(realized.generated_files.get(".somite/run/source-task-nextflow.config")!);
  assert.match(executionConfig, /process\.executor = 'local'/);
  assert.match(executionConfig, /conda\.enabled = true/);
  assert.match(executionConfig, /docker\.enabled = false/);
  assert.match(executionConfig, /singularity\.enabled = false/);
  assert.match(executionConfig, /wave\.enabled = false/);
  assert.match(decoder.decode(realized.source_files.find((entry) => entry.path === "main.nf")!.bytes), /\/cache\/workspace\/\.pixi\/envs\/task-[a-f0-9]{64}/);
  assert.match(realized.environment_identity.source_plan_digest ?? "", /^blake3:[a-f0-9]{64}$/);
  assert.match(realized.environment_identity.executed_source_digest ?? "", /^blake3:[a-f0-9]{64}$/);
});

test("retains the trusted root-lock path and rejects an incomplete root lock", async () => {
  const pixiToml = encoder.encode("[workspace]\nchannels = [\"conda-forge\"]\nplatforms = [\"linux-64\"]\n");
  const pixiLock = encoder.encode("version: 6\nenvironments:\n  default: {}\n");
  const cache = {
    async adoptLock(manifest: Uint8Array, lockBytes: Uint8Array) { return locked(manifest, lockBytes); },
    async environment() { return "/cache/root/pixi.toml"; },
  } as unknown as PixiCache;
  const files = [file("main.nf", "workflow {}\n"), { path: "pixi.toml", mode: 0o100644 as const, bytes: pixiToml }, { path: "pixi.lock", mode: 0o100644 as const, bytes: pixiLock }];
  const frozen = await freezeSourceExecution(files, "main.nf", "linux-64", cache);
  assert.equal(frozen.mode, "root_lock");
  const realized = await realizeSourceExecution(frozen, "linux-64", cache);
  assert.equal(realized.environment_manifest, "/cache/root/pixi.toml");
  assert.equal(realized.source_files, files);
  assert.deepEqual([...realized.generated_files.keys()], [".somite/run/source-task-nextflow.config"]);
  const policy = decoder.decode(realized.generated_files.get(".somite/run/source-task-nextflow.config")!);
  assert.match(policy, /somite_frozen_execution/);
  assert.match(policy, /process\.executor = 'local'/);
  assert.match(policy, /conda\.enabled = false/);

  await assert.rejects(
    freezeSourceExecution(files.filter((entry) => entry.path !== "pixi.lock"), "main.nf", "linux-64", cache),
    /incomplete root Pixi lock/,
  );
  const testConfig = file("nf-test.config", "plugins { load 'nft-utils@0.0.3' }\n");
  const withUnreferencedTestConfig = await freezeSourceExecution([
    ...files,
    testConfig,
  ], "main.nf", "linux-64", cache);
  assert.equal(withUnreferencedTestConfig.mode, "root_lock");
  await assert.rejects(
    freezeSourceExecution([
      ...files,
      file("nextflow.config", "includeConfig 'nf-test.config'\n"),
      testConfig,
    ], "main.nf", "linux-64", cache),
    /source_config_plugins_unsupported/,
  );
  await assert.rejects(
    freezeSourceExecution([
      ...files,
      file("nextflow.config", "plugins { id 'nf-schema@2.7.2' }\n"),
    ], "main.nf", "linux-64", cache),
    /source_config_plugins_unsupported/,
  );
});
