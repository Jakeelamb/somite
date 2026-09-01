import type { FrozenSourceFile } from "@somite/workflow/nextflowSource";
import {
  planSourceTaskExecution,
  type SourceTaskExecutionPlan,
} from "@somite/workflow/sourceTaskExecution";
import { planTaskEnvironments } from "@somite/workflow/taskEnvironment";
import {
  renderSourceTaskPixiWorkspace,
  type SourceTaskPixiWorkspace,
} from "@somite/workflow/sourceTaskPixi";

import { PixiCache, type LockedManifest } from "./pixiCache.ts";
import {
  stagePortableSourceTaskExecution,
  stageSourceTaskExecution,
  type StagedSourceTaskExecution,
} from "./sourceTaskRewrite.ts";

const encoder = new TextEncoder();
export const SOURCE_EXECUTION_PROFILE = "somite_frozen_execution";
export const SOURCE_EXECUTION_CONFIG = ".somite/run/source-task-nextflow.config";
export const SOURCE_EXECUTION_PACKAGE_REVISION = "source-execution-package-ts-v3";

export type FrozenSourceExecution = Readonly<{
  mode: "root_lock" | "generated_task_environments";
  locked: LockedManifest;
  source_files: readonly FrozenSourceFile[];
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
  }>;
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

function environmentIdentity(
  frozen: FrozenSourceExecution,
  staged?: StagedSourceTaskExecution,
): RealizedSourceExecution["environment_identity"] {
  return {
    mode: frozen.mode,
    manifest_digest: frozen.locked.manifest_digest,
    lock_digest: frozen.locked.lock_digest,
    ...(frozen.plan ? { source_plan_digest: frozen.plan.plan_digest } : {}),
    ...(staged ? { executed_source_digest: staged.executed_source_digest } : {}),
  };
}

function sourceExecutionConfig(mode: FrozenSourceExecution["mode"]) {
  const generatedTaskEnvironments = mode === "generated_task_environments";
  return encoder.encode([
    "profiles {",
    `  ${SOURCE_EXECUTION_PROFILE} {`,
    "    workDir = '.somite/run/work'",
    "    process.executor = 'local'",
    `    conda.enabled = ${generatedTaskEnvironments ? "true" : "false"}`,
    ...(generatedTaskEnvironments ? ["    conda.useMicromamba = true"] : []),
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

function sourceControlFiles(mode: FrozenSourceExecution["mode"]) {
  return new Map<string, Uint8Array>([[SOURCE_EXECUTION_CONFIG, sourceExecutionConfig(mode)]]);
}

function generatedTaskFiles(
  frozen: FrozenSourceExecution,
  staged: StagedSourceTaskExecution,
) {
  const plan = frozen.plan!;
  const rendered = frozen.rendered!;
  return new Map<string, Uint8Array>([
    ...sourceControlFiles(frozen.mode),
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
): Promise<FrozenSourceExecution> {
  const root = rootEnvironment(files);
  if (root.manifest || root.lock) {
    if (!root.manifest || !root.lock) throw new Error("source workflow has an incomplete root Pixi lock");
    const inventory = planTaskEnvironments(files, entrypoint);
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
    };
  }

  const decision = planSourceTaskExecution(files, entrypoint);
  if (decision.status === "blocked") throw taskPlanFailure(decision);
  const rendered = renderSourceTaskPixiWorkspace(decision.plan, [platform]);
  const locked = await cache.lock(rendered.pixi_toml, platform, signal);
  return {
    mode: "generated_task_environments",
    locked,
    source_files: files,
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
): Promise<RealizedSourceExecution> {
  if (frozen.mode === "root_lock") {
    const environmentManifest = await cache.environment(frozen.locked, platform, signal);
    return {
      mode: frozen.mode,
      locked: frozen.locked,
      environment_manifest: environmentManifest,
      source_files: frozen.source_files,
      generated_files: sourceControlFiles(frozen.mode),
      environment_identity: environmentIdentity(frozen),
    };
  }

  const plan = frozen.plan!;
  const rendered = frozen.rendered!;
  const workspace = await cache.realizeWorkspace(frozen.locked, platform, rendered.expected_environments, signal);
  const staged = stageSourceTaskExecution(frozen.source_files, plan, workspace.prefixes);
  return {
    mode: frozen.mode,
    locked: frozen.locked,
    environment_manifest: workspace.manifestPath,
    source_files: staged.files,
    generated_files: generatedTaskFiles(frozen, staged),
    staged,
    environment_identity: environmentIdentity(frozen, staged),
  };
}

/** Create a host-independent package copy without installing any environment. */
export function packagePortableSourceExecution(
  frozen: FrozenSourceExecution,
): PortableSourceExecution {
  if (frozen.mode === "root_lock") {
    return {
      mode: frozen.mode,
      locked: frozen.locked,
      source_files: frozen.source_files,
      generated_files: sourceControlFiles(frozen.mode),
      environment_identity: environmentIdentity(frozen),
    };
  }
  const staged = stagePortableSourceTaskExecution(frozen.source_files, frozen.plan!);
  return {
    mode: frozen.mode,
    locked: frozen.locked,
    source_files: staged.files,
    generated_files: generatedTaskFiles(frozen, staged),
    staged,
    environment_identity: environmentIdentity(frozen, staged),
  };
}
