import assert from "node:assert/strict";
import test from "node:test";

import { byteDigest, canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import type { FrozenSourceFile } from "@somite/workflow/nextflowSource";

import type { LockedManifest, PixiCache } from "../src/pixiCache.ts";
import {
  NEXTFLOW_PLUGIN_FREEZER_REVISION,
  type FrozenNextflowPluginStore,
} from "../src/nextflowPluginCache.ts";
import {
  freezeSourceExecution,
  freezeSourceExecutionPluginStore,
  packagePortableSourceExecution,
  realizeSourceExecution,
  SOURCE_EXECUTION_PLUGIN_DIRECTORY,
  SOURCE_EXECUTION_PLUGIN_MANIFEST,
  type FrozenSourceExecution,
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

function pluginStore(
  frozen: FrozenSourceExecution,
  platform = "linux-64",
): FrozenNextflowPluginStore {
  const requirements = frozen.plugin_requirements.map((requirement) => ({
    id: requirement.name,
    version: requirement.version,
    spec: requirement.requirement,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const files = requirements.map((requirement) => {
    const bytes = encoder.encode(`frozen:${requirement.spec}\n`);
    return {
      path: `${requirement.spec}/plugin.jar`,
      mode: 0o100644 as const,
      bytes,
      digest: byteDigest(bytes),
    };
  });
  const records = files.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    bytes: entry.bytes.byteLength,
    digest: entry.digest,
  }));
  const request = {
    schema_version: 1 as const,
    freezer_revision: NEXTFLOW_PLUGIN_FREEZER_REVISION as typeof NEXTFLOW_PLUGIN_FREEZER_REVISION,
    platform,
    runtime_manifest_digest: frozen.locked.manifest_digest,
    runtime_lock_digest: frozen.locked.lock_digest,
    requirements,
  };
  const material = {
    ...request,
    request_digest: canonicalJsonDigest(request),
    files: records,
    total_bytes: files.reduce((total, entry) => total + entry.bytes.byteLength, 0),
  };
  const manifest = { ...material, store_digest: canonicalJsonDigest(material) };
  return {
    digest: manifest.store_digest,
    manifest,
    files,
    cache_path: "/cache/nextflow-plugins",
    cached: false,
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
  const realized = await realizeSourceExecution(frozen, "linux-64", cache, undefined, {
    freezePluginStore: async () => {
      throw new Error("plugin freezer must not run for a workflow without plugins");
    },
  });
  assert.equal(realized.environment_manifest, "/cache/workspace/pixi.toml");
  assert.equal(realized.generated_files.has("pixi.toml"), true);
  assert.equal(realized.generated_files.has("pixi.lock"), true);
  assert.equal(realized.generated_files.has(".somite/run/source-task-plan.json"), true);
  const executionConfig = decoder.decode(realized.generated_files.get(".somite/run/source-task-nextflow.config")!);
  assert.match(executionConfig, /withName: \/\.\*\/ \{\n        executor = 'local'/);
  assert.match(executionConfig, /conda\.enabled = true/);
  assert.match(executionConfig, /shell = \["\$\{System\.getenv\('PIXI_PROJECT_ROOT'\)\}\/\.pixi\/envs\/default\/bin\/bash", '-ue'\]/);
  assert.match(executionConfig, /scratch = false/);
  assert.match(executionConfig, /trace\.enabled = false/);
  assert.match(executionConfig, /docker\.enabled = false/);
  assert.match(executionConfig, /singularity\.enabled = false/);
  assert.match(executionConfig, /wave\.enabled = false/);
  assert.match(decoder.decode(realized.source_files.find((entry) => entry.path === "main.nf")!.bytes), /\/cache\/workspace\/\.pixi\/envs\/task-[a-f0-9]{64}/);
  assert.match(realized.environment_identity.source_plan_digest ?? "", /^blake3:[a-f0-9]{64}$/);
  assert.match(realized.environment_identity.executed_source_digest ?? "", /^blake3:[a-f0-9]{64}$/);
  assert.equal(realized.nextflow_plugins, undefined);
});

test("freezes exact plugins only after Pixi realization and packages their immutable allowlisted store", async () => {
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
    file("nextflow.config", [
      "plugins {",
      "  id 'nf-schema@2.7.2'",
      "  id 'nf-core-utils@1.2.3'",
      "}",
      "",
    ].join("\n")),
  ];
  const calls: Array<{ manifestPath: string; requirements: readonly string[] }> = [];
  let workspaceRealizations = 0;
  let defaultRealizations = 0;
  const cache = {
    async lock(manifest: string) { return locked(encoder.encode(manifest)); },
    async environment() {
      defaultRealizations += 1;
      return "/cache/runtime/pixi.toml";
    },
    async realizeWorkspace(frozen: LockedManifest, _platform: string, environments: readonly string[]) {
      workspaceRealizations += 1;
      return {
        manifestPath: "/cache/workspace/pixi.toml",
        prefixes: new Map(environments.filter((environment) => environment !== "default")
          .map((environment) => [environment, `/cache/workspace/.pixi/envs/${environment}`])),
      };
    },
  } as unknown as PixiCache;

  const frozen = await freezeSourceExecution(files, "main.nf", "linux-64", cache);
  assert.deepEqual(frozen.plugin_requirements.map((entry) => entry.requirement), [
    "nf-core-utils@1.2.3",
    "nf-schema@2.7.2",
  ]);
  assert.throws(
    () => packagePortableSourceExecution(frozen),
    /plugins must be frozen from the realized Pixi runtime/,
  );

  const portablePlugins = await freezeSourceExecutionPluginStore(frozen, "linux-64", cache, undefined, {
    freezePluginStore: async (input) => {
      calls.push({
        manifestPath: input.runtime.manifestPath,
        requirements: input.requirements.map((entry) => entry.spec),
      });
      return pluginStore(frozen);
    },
  });
  assert.equal(defaultRealizations, 1);
  assert.equal(workspaceRealizations, 0, "portable plugin freezing must not realize scientific task prefixes");
  assert.equal(portablePlugins?.store_digest, pluginStore(frozen).digest);
  const pluginPortable = packagePortableSourceExecution(frozen, portablePlugins);
  assert.equal(pluginPortable.environment_identity.plugin_store_digest, portablePlugins?.store_digest);

  const realized = await realizeSourceExecution(frozen, "linux-64", cache, undefined, {
    freezePluginStore: async (input) => {
      calls.push({
        manifestPath: input.runtime.manifestPath,
        requirements: input.requirements.map((entry) => entry.spec),
      });
      return pluginStore(frozen);
    },
  });
  assert.deepEqual(calls, [{
    manifestPath: "/cache/runtime/pixi.toml",
    requirements: ["nf-core-utils@1.2.3", "nf-schema@2.7.2"],
  }, {
    manifestPath: "/cache/workspace/pixi.toml",
    requirements: ["nf-core-utils@1.2.3", "nf-schema@2.7.2"],
  }]);
  assert.equal(workspaceRealizations, 1);
  assert.deepEqual(realized.nextflow_plugins?.allowed_plugin_ids, ["nf-core-utils", "nf-schema"]);
  assert.equal(realized.nextflow_plugins?.directory, SOURCE_EXECUTION_PLUGIN_DIRECTORY);
  assert.equal(
    realized.environment_identity.plugin_store_digest,
    realized.nextflow_plugins?.store_digest,
  );
  assert.equal(realized.generated_files.has(SOURCE_EXECUTION_PLUGIN_MANIFEST), true);
  assert.equal(realized.generated_files.has(
    `${SOURCE_EXECUTION_PLUGIN_DIRECTORY}/nf-core-utils@1.2.3/plugin.jar`,
  ), true);
  assert.equal(realized.generated_files.has(
    `${SOURCE_EXECUTION_PLUGIN_DIRECTORY}/nf-schema@2.7.2/plugin.jar`,
  ), true);

  const portable = packagePortableSourceExecution(frozen, realized.nextflow_plugins);
  assert.equal(portable.environment_identity.plugin_store_digest, realized.nextflow_plugins?.store_digest);
  assert.deepEqual(portable.nextflow_plugins, realized.nextflow_plugins);
  assert.equal(portable.generated_files.has(SOURCE_EXECUTION_PLUGIN_MANIFEST), true);
  assert.equal(
    decoder.decode(portable.generated_files.get(
      `${SOURCE_EXECUTION_PLUGIN_DIRECTORY}/nf-schema@2.7.2/plugin.jar`,
    )!),
    "frozen:nf-schema@2.7.2\n",
  );

  await assert.rejects(
    realizeSourceExecution(frozen, "linux-64", cache, undefined, {
      freezePluginStore: async () => {
        throw new Error("plugin registry unavailable");
      },
    }),
    /plugin registry unavailable/,
  );
  assert.throws(
    () => packagePortableSourceExecution(frozen, {
      ...realized.nextflow_plugins!,
      store_digest: "blake3:" + "0".repeat(64),
    }),
    /digest does not match its manifest/,
  );
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
  assert.match(policy, /withName: \/\.\*\/ \{[\s\S]*executor = 'local'/);
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
    /source_config_plugin_declaration_unsupported/,
  );

  const parameterizedFiles = [
    ...files,
    file("nextflow.config", "includeConfig params.plugin_config\n"),
    file("plugins.config", "plugins { id 'nf-schema@2.7.2' }\n"),
  ];
  await assert.rejects(
    freezeSourceExecution(parameterizedFiles, "main.nf", "linux-64", cache),
    /task_environment_config_include_unresolved/,
  );
  const withPinnedPlugin = await freezeSourceExecution(
    parameterizedFiles,
    "main.nf",
    "linux-64",
    cache,
    undefined,
    { parameters: { plugin_config: "plugins.config" } },
  );
  assert.deepEqual(withPinnedPlugin.plugin_requirements.map((entry) => entry.requirement), ["nf-schema@2.7.2"]);
  assert.throws(
    () => packagePortableSourceExecution(withPinnedPlugin),
    /plugins must be frozen from the realized Pixi runtime/,
  );
  const pluginRealized = await realizeSourceExecution(withPinnedPlugin, "linux-64", cache, undefined, {
    freezePluginStore: async (input) => {
      assert.equal(input.runtime.manifestPath, "/cache/root/pixi.toml");
      return pluginStore(withPinnedPlugin);
    },
  });
  assert.deepEqual(pluginRealized.nextflow_plugins?.allowed_plugin_ids, ["nf-schema"]);
  assert.equal(pluginRealized.generated_files.has(SOURCE_EXECUTION_PLUGIN_MANIFEST), true);
});
