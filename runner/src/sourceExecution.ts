import {
  byteDigest,
  canonicalJsonDigest,
  canonicalJsonValue,
} from "@somite/workflow/contentIdentity";
import { safeSourcePath, type FrozenSourceFile } from "@somite/workflow/nextflowSource";
import {
  planSourceTaskExecution,
  type SourceTaskExecutionPlan,
} from "@somite/workflow/sourceTaskExecution";
import {
  planTaskEnvironments,
  type NextflowPluginRequirement as PlannedNextflowPluginRequirement,
  type TaskEnvironmentPlanningOptions,
} from "@somite/workflow/taskEnvironment";
import {
  renderSourceTaskPixiWorkspace,
  type SourceTaskPixiWorkspace,
} from "@somite/workflow/sourceTaskPixi";

import { PixiCache, type LockedManifest } from "./pixiCache.ts";
import {
  NEXTFLOW_PLUGIN_FREEZER_REVISION,
  freezeNextflowPluginStore,
  type FreezeNextflowPluginStoreInput,
  type FrozenNextflowPluginFile,
  type FrozenNextflowPluginStore,
  type FrozenNextflowPluginStoreManifest,
} from "./nextflowPluginCache.ts";
import {
  stagePortableSourceTaskExecution,
  stageSourceTaskExecution,
  type StagedSourceTaskExecution,
} from "./sourceTaskRewrite.ts";

const encoder = new TextEncoder();
const NEXTFLOW_PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const NEXTFLOW_PLUGIN_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
export const SOURCE_EXECUTION_PROFILE = "somite_frozen_execution";
export const SOURCE_EXECUTION_CONFIG = ".somite/run/source-task-nextflow.config";
export const SOURCE_EXECUTION_PLUGIN_DIRECTORY = ".somite/run/nextflow-plugins";
export const SOURCE_EXECUTION_PLUGIN_MANIFEST = ".somite/run/nextflow-plugin-store.json";
export const SOURCE_EXECUTION_PACKAGE_REVISION = "source-execution-package-ts-v5";

export type SourceExecutionPluginFreezer = (
  input: FreezeNextflowPluginStoreInput,
) => Promise<FrozenNextflowPluginStore>;

export type RealizeSourceExecutionOptions = Readonly<{
  freezePluginStore?: SourceExecutionPluginFreezer;
}>;

export type FrozenSourceExecutionPluginStore = Readonly<{
  directory: typeof SOURCE_EXECUTION_PLUGIN_DIRECTORY;
  store_digest: string;
  request_digest: string;
  allowed_plugin_ids: readonly string[];
  manifest: FrozenNextflowPluginStoreManifest;
  files: readonly FrozenNextflowPluginFile[];
}>;

export type FrozenSourceExecution = Readonly<{
  mode: "root_lock" | "generated_task_environments";
  locked: LockedManifest;
  source_files: readonly FrozenSourceFile[];
  plugin_requirements: readonly PlannedNextflowPluginRequirement[];
  plan?: SourceTaskExecutionPlan;
  rendered?: SourceTaskPixiWorkspace;
}>;

export type RealizedSourceExecution = Readonly<{
  mode: FrozenSourceExecution["mode"];
  locked: LockedManifest;
  environment_manifest: string;
  source_files: readonly FrozenSourceFile[];
  generated_files: ReadonlyMap<string, Uint8Array>;
  environment_identity: Readonly<{
    mode: FrozenSourceExecution["mode"];
    manifest_digest: string;
    lock_digest: string;
    source_plan_digest?: string;
    executed_source_digest?: string;
    plugin_store_digest?: string;
  }>;
  nextflow_plugins?: FrozenSourceExecutionPluginStore;
  staged?: StagedSourceTaskExecution;
}>;

export type PortableSourceExecution = Readonly<Omit<RealizedSourceExecution, "environment_manifest">>;

function rootEnvironment(files: readonly FrozenSourceFile[]) {
  return {
    manifest: files.find((file) => file.path === "pixi.toml"),
    lock: files.find((file) => file.path === "pixi.lock"),
  };
}

function taskPlanFailure(decision: Extract<ReturnType<typeof planSourceTaskExecution>, { status: "blocked" }>) {
  const details = decision.blockers.slice(0, 8).map((blocker) => `${blocker.code}: ${blocker.message}`).join("; ");
  const omitted = decision.blockers.length - Math.min(decision.blockers.length, 8);
  return new Error(`source task environments cannot be frozen${details ? `: ${details}` : ""}${omitted ? `; ${omitted} more blocker${omitted === 1 ? "" : "s"}` : ""}`);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactPluginRequirements(requirements: readonly PlannedNextflowPluginRequirement[]) {
  const normalized = requirements.map((requirement) => ({
    id: requirement.name,
    version: requirement.version,
    spec: requirement.requirement,
  })).sort((left, right) => compareText(left.id, right.id) || compareText(left.version, right.version));
  for (let index = 0; index < normalized.length; index += 1) {
    const requirement = normalized[index]!;
    if (!NEXTFLOW_PLUGIN_ID.test(requirement.id)
      || !NEXTFLOW_PLUGIN_VERSION.test(requirement.version)
      || requirement.version.toLowerCase() === "latest"
      || /[*^~<>=/:]/.test(requirement.version)
      || requirement.spec !== `${requirement.id}@${requirement.version}`) {
      throw new Error(`source Nextflow plugin requirement ${requirement.spec} is not one exact ID and version`);
    }
    if (index > 0 && normalized[index - 1]!.id === requirement.id) {
      throw new Error(`source Nextflow plugin ${requirement.id} is declared more than once`);
    }
  }
  return normalized;
}

function frozenPluginRequirements(requirements: readonly PlannedNextflowPluginRequirement[]) {
  exactPluginRequirements(requirements);
  return requirements.map((requirement) => ({
    ...requirement,
    spans: requirement.spans.map((span) => ({ ...span })),
  }));
}

type PluginStoreMaterial = Readonly<{
  digest: string;
  manifest: FrozenNextflowPluginStoreManifest;
  files: readonly FrozenNextflowPluginFile[];
}>;

function verifiedPluginStore(
  frozen: FrozenSourceExecution,
  store: PluginStoreMaterial,
  platform?: string,
): FrozenSourceExecutionPluginStore {
  const expectedRequirements = exactPluginRequirements(frozen.plugin_requirements);
  if (!expectedRequirements.length) throw new Error("a Nextflow plugin store was supplied for a source workflow with no plugins");
  if (platform !== undefined && store.manifest.platform !== platform) {
    throw new Error(`frozen Nextflow plugin store targets ${store.manifest.platform}, not ${platform}`);
  }
  if (store.digest !== store.manifest.store_digest) {
    throw new Error("frozen Nextflow plugin store digest does not match its manifest");
  }
  if (store.manifest.freezer_revision !== NEXTFLOW_PLUGIN_FREEZER_REVISION
    || store.manifest.runtime_manifest_digest !== frozen.locked.manifest_digest
    || store.manifest.runtime_lock_digest !== frozen.locked.lock_digest) {
    throw new Error("frozen Nextflow plugin store does not match the immutable Pixi runtime");
  }
  if (JSON.stringify(store.manifest.requirements) !== JSON.stringify(expectedRequirements)) {
    throw new Error("frozen Nextflow plugin store does not match the source plugin requirements");
  }
  const expectedRequestDigest = canonicalJsonDigest({
    schema_version: 1,
    freezer_revision: NEXTFLOW_PLUGIN_FREEZER_REVISION,
    platform: store.manifest.platform,
    runtime_manifest_digest: frozen.locked.manifest_digest,
    runtime_lock_digest: frozen.locked.lock_digest,
    requirements: expectedRequirements,
  });
  if (store.manifest.request_digest !== expectedRequestDigest) {
    throw new Error("frozen Nextflow plugin store request digest is invalid");
  }
  const { store_digest: _storedDigest, ...manifestMaterial } = store.manifest;
  if (canonicalJsonDigest(manifestMaterial) !== store.manifest.store_digest) {
    throw new Error("frozen Nextflow plugin store manifest is not content-addressed by its digest");
  }
  if (store.files.length !== store.manifest.files.length) {
    throw new Error("frozen Nextflow plugin store file inventory is incomplete");
  }
  const files: FrozenNextflowPluginFile[] = [];
  let totalBytes = 0;
  for (let index = 0; index < store.files.length; index += 1) {
    const file = store.files[index]!;
    const record = store.manifest.files[index]!;
    if (!safeSourcePath(file.path)
      || index > 0 && compareText(store.files[index - 1]!.path, file.path) >= 0
      || file.path !== record.path
      || file.mode !== record.mode
      || file.bytes.byteLength !== record.bytes
      || file.digest !== record.digest
      || byteDigest(file.bytes) !== file.digest) {
      throw new Error(`frozen Nextflow plugin store file ${file.path || index} does not match its manifest`);
    }
    totalBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes)) throw new Error("frozen Nextflow plugin store byte count overflowed");
    files.push({ ...file, bytes: Uint8Array.from(file.bytes) });
  }
  if (totalBytes !== store.manifest.total_bytes) {
    throw new Error("frozen Nextflow plugin store byte total does not match its manifest");
  }
  const manifest: FrozenNextflowPluginStoreManifest = {
    ...store.manifest,
    requirements: store.manifest.requirements.map((requirement) => ({ ...requirement })),
    files: store.manifest.files.map((file) => ({ ...file })),
  };
  return {
    directory: SOURCE_EXECUTION_PLUGIN_DIRECTORY,
    store_digest: store.digest,
    request_digest: manifest.request_digest,
    allowed_plugin_ids: expectedRequirements.map((requirement) => requirement.id),
    manifest,
    files,
  };
}

function verifiedPortablePluginStore(
  frozen: FrozenSourceExecution,
  store: FrozenSourceExecutionPluginStore | undefined,
) {
  if (!frozen.plugin_requirements.length) {
    if (store !== undefined) throw new Error("a Nextflow plugin store was supplied for a source workflow with no plugins");
    return undefined;
  }
  if (!store) {
    throw new Error("source workflow plugins must be frozen from the realized Pixi runtime before portable packaging");
  }
  if (store.directory !== SOURCE_EXECUTION_PLUGIN_DIRECTORY
    || store.request_digest !== store.manifest.request_digest) {
    throw new Error("portable Nextflow plugin store contract is invalid");
  }
  const verified = verifiedPluginStore(frozen, {
    digest: store.store_digest,
    manifest: store.manifest,
    files: store.files,
  });
  if (JSON.stringify(store.allowed_plugin_ids) !== JSON.stringify(verified.allowed_plugin_ids)) {
    throw new Error("portable Nextflow plugin allowlist does not match the frozen requirements");
  }
  return verified;
}

function pluginStoreFiles(plugins: FrozenSourceExecutionPluginStore | undefined) {
  if (!plugins) return new Map<string, Uint8Array>();
  const metadata = {
    schema_version: 1,
    directory: plugins.directory,
    store_digest: plugins.store_digest,
    request_digest: plugins.request_digest,
    allowed_plugin_ids: plugins.allowed_plugin_ids,
    manifest: plugins.manifest,
  };
  return new Map<string, Uint8Array>([
    [SOURCE_EXECUTION_PLUGIN_MANIFEST, encoder.encode(`${JSON.stringify(canonicalJsonValue(metadata), null, 2)}\n`)],
    ...plugins.files.map((file) => [`${SOURCE_EXECUTION_PLUGIN_DIRECTORY}/${file.path}`, file.bytes] as const),
  ]);
}

async function realizePluginStore(
  frozen: FrozenSourceExecution,
  environmentManifest: string,
  platform: string,
  signal: AbortSignal | undefined,
  freezer: SourceExecutionPluginFreezer,
) {
  if (!frozen.plugin_requirements.length) return undefined;
  const pluginSignal = signal ?? new AbortController().signal;
  const store = await freezer({
    requirements: frozen.plugin_requirements.map((requirement) => ({
      id: requirement.name,
      version: requirement.version,
      spec: requirement.requirement,
      ...(requirement.spans[0] ? { span: requirement.spans[0] } : {}),
    })),
    runtime: { pixi: frozen.locked.pixi, manifestPath: environmentManifest },
    signal: pluginSignal,
    platform,
  });
  return verifiedPluginStore(frozen, store, platform);
}

/**
 * Freeze plugins from only the locked default runtime. Portable packaging may
 * need plugin bytes, but it must not realize every scientific task prefix.
 */
export async function freezeSourceExecutionPluginStore(
  frozen: FrozenSourceExecution,
  platform: string,
  cache: PixiCache,
  signal?: AbortSignal,
  options: RealizeSourceExecutionOptions = {},
) {
  if (!frozen.plugin_requirements.length) return undefined;
  const environmentManifest = await cache.environment(frozen.locked, platform, signal);
  return realizePluginStore(
    frozen,
    environmentManifest,
    platform,
    signal,
    options.freezePluginStore ?? freezeNextflowPluginStore,
  );
}

function environmentIdentity(
  frozen: FrozenSourceExecution,
  staged?: StagedSourceTaskExecution,
  plugins?: FrozenSourceExecutionPluginStore,
): RealizedSourceExecution["environment_identity"] {
  return {
    mode: frozen.mode,
    manifest_digest: frozen.locked.manifest_digest,
    lock_digest: frozen.locked.lock_digest,
    ...(frozen.plan ? { source_plan_digest: frozen.plan.plan_digest } : {}),
    ...(staged ? { executed_source_digest: staged.executed_source_digest } : {}),
    ...(plugins ? { plugin_store_digest: plugins.store_digest } : {}),
  };
}

function sourceExecutionConfig(mode: FrozenSourceExecution["mode"]) {
  const generatedTaskEnvironments = mode === "generated_task_environments";
  return encoder.encode([
    "profiles {",
    `  ${SOURCE_EXECUTION_PROFILE} {`,
    "    workDir = '.somite/run/work'",
    `    conda.enabled = ${generatedTaskEnvironments ? "true" : "false"}`,
    ...(generatedTaskEnvironments ? [
      "    conda.useMicromamba = true",
    ] : []),
    "    trace.enabled = false",
    "    timeline.enabled = false",
    "    report.enabled = false",
    "    process {",
    "      withName: /.*/ {",
    "        executor = 'local'",
    ...(generatedTaskEnvironments ? [
      "        shell = [\"${System.getenv('PIXI_PROJECT_ROOT')}/.pixi/envs/default/bin/bash\", '-ue']",
      "        scratch = false",
    ] : []),
    "      }",
    "    }",
    "    docker.enabled = false",
    "    singularity.enabled = false",
    "    apptainer.enabled = false",
    "    podman.enabled = false",
    "    shifter.enabled = false",
    "    charliecloud.enabled = false",
    "    wave.enabled = false",
    "    fusion.enabled = false",
    "  }",
    "}",
    "",
  ].join("\n"));
}

function sourceControlFiles(
  mode: FrozenSourceExecution["mode"],
  plugins?: FrozenSourceExecutionPluginStore,
) {
  return new Map<string, Uint8Array>([
    [SOURCE_EXECUTION_CONFIG, sourceExecutionConfig(mode)],
    ...pluginStoreFiles(plugins),
  ]);
}

function generatedTaskFiles(
  frozen: FrozenSourceExecution,
  staged: StagedSourceTaskExecution,
  plugins?: FrozenSourceExecutionPluginStore,
) {
  const plan = frozen.plan!;
  const rendered = frozen.rendered!;
  return new Map<string, Uint8Array>([
    ...sourceControlFiles(frozen.mode, plugins),
    ["pixi.toml", encoder.encode(rendered.pixi_toml)],
    ["pixi.lock", frozen.locked.lock],
    [".somite/run/source-task-plan.json", encoder.encode(`${JSON.stringify(plan, null, 2)}\n`)],
    [".somite/run/source-task-rewrites.json", encoder.encode(`${JSON.stringify({
      schema_version: 1,
      source_digest: staged.source_digest,
      executed_source_digest: staged.executed_source_digest,
      rewritten_files: staged.rewritten_files,
      rewrites: staged.rewrites,
    }, null, 2)}\n`)],
  ]);
}

/** Freeze the portable software closure without installing or rewriting it. */
export async function freezeSourceExecution(
  files: readonly FrozenSourceFile[],
  entrypoint: string,
  platform: string,
  cache: PixiCache,
  signal?: AbortSignal,
  planningOptions: TaskEnvironmentPlanningOptions = {},
): Promise<FrozenSourceExecution> {
  const root = rootEnvironment(files);
  if (root.manifest || root.lock) {
    if (!root.manifest || !root.lock) throw new Error("source workflow has an incomplete root Pixi lock");
    const inventory = planTaskEnvironments(files, entrypoint, planningOptions);
    if (inventory.configuration_issues.length || inventory.declarations.length) {
      const first = inventory.configuration_issues[0];
      throw new Error(first
        ? `source root Pixi execution has unresolved configuration: ${first.code}: ${first.message}`
        : "source root Pixi execution cannot delegate process environments outside its frozen root lock");
    }
    return {
      mode: "root_lock",
      locked: await cache.adoptLock(root.manifest.bytes, root.lock.bytes),
      source_files: files,
      plugin_requirements: frozenPluginRequirements(inventory.nextflow_plugins),
    };
  }

  const decision = planSourceTaskExecution(files, entrypoint, planningOptions);
  if (decision.status === "blocked") throw taskPlanFailure(decision);
  const rendered = renderSourceTaskPixiWorkspace(decision.plan, [platform]);
  const locked = await cache.lock(rendered.pixi_toml, platform, signal);
  return {
    mode: "generated_task_environments",
    locked,
    source_files: files,
    plugin_requirements: frozenPluginRequirements(decision.plan.nextflow_plugins),
    plan: decision.plan,
    rendered,
  };
}

/** Install the frozen closure and create an exact host-specific execution copy. */
export async function realizeSourceExecution(
  frozen: FrozenSourceExecution,
  platform: string,
  cache: PixiCache,
  signal?: AbortSignal,
  options: RealizeSourceExecutionOptions = {},
): Promise<RealizedSourceExecution> {
  const freezer = options.freezePluginStore ?? freezeNextflowPluginStore;
  if (frozen.mode === "root_lock") {
    const environmentManifest = await cache.environment(frozen.locked, platform, signal);
    const plugins = await realizePluginStore(frozen, environmentManifest, platform, signal, freezer);
    return {
      mode: frozen.mode,
      locked: frozen.locked,
      environment_manifest: environmentManifest,
      source_files: frozen.source_files,
      generated_files: sourceControlFiles(frozen.mode, plugins),
      environment_identity: environmentIdentity(frozen, undefined, plugins),
      ...(plugins ? { nextflow_plugins: plugins } : {}),
    };
  }

  const plan = frozen.plan!;
  const rendered = frozen.rendered!;
  const workspace = await cache.realizeWorkspace(frozen.locked, platform, rendered.expected_environments, signal);
  const staged = stageSourceTaskExecution(frozen.source_files, plan, workspace.prefixes);
  const plugins = await realizePluginStore(frozen, workspace.manifestPath, platform, signal, freezer);
  return {
    mode: frozen.mode,
    locked: frozen.locked,
    environment_manifest: workspace.manifestPath,
    source_files: staged.files,
    generated_files: generatedTaskFiles(frozen, staged, plugins),
    staged,
    environment_identity: environmentIdentity(frozen, staged, plugins),
    ...(plugins ? { nextflow_plugins: plugins } : {}),
  };
}

/** Create a host-independent package copy without installing any environment. */
export function packagePortableSourceExecution(
  frozen: FrozenSourceExecution,
  plugins?: FrozenSourceExecutionPluginStore,
): PortableSourceExecution {
  const portablePlugins = verifiedPortablePluginStore(frozen, plugins);
  if (frozen.mode === "root_lock") {
    return {
      mode: frozen.mode,
      locked: frozen.locked,
      source_files: frozen.source_files,
      generated_files: sourceControlFiles(frozen.mode, portablePlugins),
      environment_identity: environmentIdentity(frozen, undefined, portablePlugins),
      ...(portablePlugins ? { nextflow_plugins: portablePlugins } : {}),
    };
  }
  const staged = stagePortableSourceTaskExecution(frozen.source_files, frozen.plan!);
  return {
    mode: frozen.mode,
    locked: frozen.locked,
    source_files: staged.files,
    generated_files: generatedTaskFiles(frozen, staged, portablePlugins),
    staged,
    environment_identity: environmentIdentity(frozen, staged, portablePlugins),
    ...(portablePlugins ? { nextflow_plugins: portablePlugins } : {}),
  };
}
