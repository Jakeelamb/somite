import { byteDigest, canonicalJsonDigest } from "./contentIdentity.ts";
import {
  PINNED_NEXTFLOW_VERSION,
  PINNED_OPENJDK_VERSION,
} from "./nextflow.ts";
import {
  SOURCE_TASK_EXECUTION_PLANNER_REVISION,
  type SourceTaskExecutionDependency,
  type SourceTaskExecutionPlan,
} from "./sourceTaskExecution.ts";

export const SOURCE_TASK_PIXI_RENDERER_REVISION = "source-task-pixi-ts-v1";
export const PINNED_MICROMAMBA_VERSION = "2.9.0";
export const MAX_SOURCE_TASK_PIXI_MANIFEST_BYTES = 1024 * 1024;

const MAX_SOURCE_TASK_ENVIRONMENTS = 511;
const MAX_SOURCE_TASK_PLATFORMS = 16;
const MAX_CHANNEL_BYTES = 2048;
const PLATFORM = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const SUPPORTED_PLATFORMS = new Set(["linux-64", "linux-aarch64", "osx-64", "osx-arm64"]);
const TASK_ENVIRONMENT = /^task-([a-f0-9]{64})$/;
const PACKAGE_NAME = /^[a-z0-9_.-]+$/;
const BUILD = /^[A-Za-z0-9_.+*-]+$/;
const VERSION_SPEC = /^[A-Za-z0-9_.+*<>=!~|,-]+$/;
const encoder = new TextEncoder();

export type SourceTaskPixiWorkspace = Readonly<{
  schema_version: 1;
  renderer_revision: typeof SOURCE_TASK_PIXI_RENDERER_REVISION;
  source_plan_digest: string;
  platforms: readonly string[];
  runtime_environment: "default";
  task_environments: readonly string[];
  expected_environments: readonly string[];
  pixi_toml: string;
  manifest_digest: string;
}>;

export class SourceTaskPixiRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceTaskPixiRenderError";
  }
}

function fail(message: string): never {
  throw new SourceTaskPixiRenderError(message);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tomlString(value: string) {
  if ([...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  })) fail(`Pixi TOML string contains a control character: ${JSON.stringify(value)}`);
  return JSON.stringify(value);
}

function normalizedPlatforms(input: readonly string[]) {
  if (!input.length || input.length > MAX_SOURCE_TASK_PLATFORMS) {
    fail(`source task Pixi workspace must target between 1 and ${MAX_SOURCE_TASK_PLATFORMS} platforms`);
  }
  const platforms = [...input].sort(compareText);
  for (let index = 0; index < platforms.length; index += 1) {
    const platform = platforms[index]!;
    if (!PLATFORM.test(platform)) fail(`invalid source task Pixi platform ${platform}`);
    if (!SUPPORTED_PLATFORMS.has(platform)) fail(`unsupported source task Pixi platform ${platform}`);
    if (index > 0 && platforms[index - 1] === platform) fail(`duplicate source task Pixi platform ${platform}`);
  }
  return platforms;
}

function normalizedChannels(input: readonly string[]) {
  if (!input.length) fail("source task Pixi workspace has no frozen channel order");
  const seen = new Set<string>();
  const channels: string[] = [];
  for (const channel of input) {
    if (!channel || channel !== channel.trim() || encoder.encode(channel).byteLength > MAX_CHANNEL_BYTES) {
      fail(`invalid source task Pixi channel ${JSON.stringify(channel)}`);
    }
    tomlString(channel);
    if (seen.has(channel)) fail(`duplicate source task Pixi channel ${channel}`);
    seen.add(channel);
    channels.push(channel);
  }
  return channels;
}

function expectedExactFields(dependency: SourceTaskExecutionDependency) {
  const exact = /^(?:==|=)([^=<>!~|,*]+)(?:=([A-Za-z0-9_.+*-]+))?$/.exec(dependency.constraint);
  const version = exact?.[1];
  const build = exact?.[2];
  if (dependency.exact_version !== version || dependency.exact_build !== build) {
    fail(`${dependency.match_spec} has inconsistent exact version or build provenance`);
  }
}

function pixiVersion(dependency: SourceTaskExecutionDependency) {
  const constraint = dependency.constraint;
  if (!constraint) return "*";
  if (!VERSION_SPEC.test(constraint)) {
    fail(`${dependency.match_spec} cannot be represented as one proven Pixi VersionSpec`);
  }
  const fuzzy = /^=([^=<>!~|,]+)(?:=([A-Za-z0-9_.+*-]+))?$/.exec(constraint);
  if (fuzzy) {
    const version = fuzzy[1]!;
    return version.endsWith("*") ? version : `${version}.*`;
  }
  const exact = /^==([^=<>!~|,*]+)(?:=[A-Za-z0-9_.+*-]+)?$/.exec(constraint);
  if (exact) return `==${exact[1]!}`;
  if (/(?:^|[|,])=(?!=)/.test(constraint)) {
    fail(`${dependency.match_spec} cannot be represented as one proven Pixi VersionSpec`);
  }
  return constraint;
}

function dependencyLine(
  dependency: SourceTaskExecutionDependency,
  channels: ReadonlySet<string>,
) {
  if (!PACKAGE_NAME.test(dependency.name)) fail(`invalid source task Pixi package name ${dependency.name}`);
  if (dependency.channel && !channels.has(dependency.channel)) {
    fail(`${dependency.match_spec} channel ${dependency.channel} is absent from the frozen workspace channel order`);
  }
  if (dependency.exact_build && !BUILD.test(dependency.exact_build)) {
    fail(`${dependency.match_spec} has an invalid Pixi build selector`);
  }
  const expectedMatchSpec = `${dependency.channel ? `${dependency.channel}::` : ""}${dependency.name}${dependency.constraint}`;
  if (dependency.match_spec !== expectedMatchSpec) {
    fail(`${dependency.match_spec} does not match its structured source dependency fields`);
  }
  expectedExactFields(dependency);
  const version = pixiVersion(dependency);
  const fields = [`version = ${tomlString(version)}`];
  if (dependency.channel) fields.push(`channel = ${tomlString(dependency.channel)}`);
  if (dependency.exact_build) fields.push(`build = ${tomlString(dependency.exact_build)}`);
  return `${tomlString(dependency.name)} = { ${fields.join(", ")} }`;
}

function environmentLines(
  environment: SourceTaskExecutionPlan["environments"][number],
  channels: ReadonlySet<string>,
) {
  const digest = TASK_ENVIRONMENT.exec(environment.name)?.[1];
  if (!digest || environment.source_environment_digest !== `blake3:${digest}`) {
    fail(`invalid source task Pixi environment identity ${environment.name}`);
  }
  if (!environment.dependencies.length) fail(`source task Pixi environment ${environment.name} has no dependencies`);
  const byPackage = new Map<string, string>();
  for (const dependency of [...environment.dependencies].sort((left, right) => (
    compareText(left.name, right.name) || compareText(left.match_spec, right.match_spec)
  ))) {
    const line = dependencyLine(dependency, channels);
    const previous = byPackage.get(dependency.name);
    if (previous && previous !== line) {
      fail(`source task Pixi environment ${environment.name} has multiple requirements for ${dependency.name}`);
    }
    byPackage.set(dependency.name, line);
  }
  return [...byPackage.values()];
}

function assertSourcePlan(plan: SourceTaskExecutionPlan) {
  if (plan.schema_version !== 1 || plan.planner_revision !== SOURCE_TASK_EXECUTION_PLANNER_REVISION) {
    fail("source task Pixi renderer received an unsupported execution plan revision");
  }
  const { plan_digest: _digest, ...base } = plan;
  if (plan.plan_digest !== canonicalJsonDigest(base)) {
    fail("source task Pixi renderer received a plan whose digest does not match its content");
  }
  if (!/^blake3:[a-f0-9]{64}$/.test(plan.source_digest)) {
    fail("source task Pixi renderer received an invalid source digest");
  }
  if (!plan.environments.length || plan.environments.length > MAX_SOURCE_TASK_ENVIRONMENTS) {
    fail(`source task Pixi workspace must contain between 1 and ${MAX_SOURCE_TASK_ENVIRONMENTS} task environments`);
  }
}

/**
 * Render one deterministic Pixi workspace from a reachable task-environment
 * plan. This pure module produces solve input only; it does not lock, install,
 * rewrite source, execute Nextflow, or grant a source execution capability.
 */
export function renderSourceTaskPixiWorkspace(
  plan: SourceTaskExecutionPlan,
  targetPlatforms: readonly string[],
): SourceTaskPixiWorkspace {
  assertSourcePlan(plan);
  const platforms = normalizedPlatforms(targetPlatforms);
  const channels = normalizedChannels(plan.channels);
  const channelSet = new Set(channels);
  const environments = [...plan.environments].sort((left, right) => compareText(left.name, right.name));
  for (let index = 1; index < environments.length; index += 1) {
    if (environments[index - 1]!.name === environments[index]!.name) {
      fail(`duplicate source task Pixi environment ${environments[index]!.name}`);
    }
  }

  const lines = [
    "[workspace]",
    `name = ${tomlString("somite-source-tasks")}`,
    `channels = [${channels.map(tomlString).join(", ")}]`,
    `platforms = [${platforms.map(tomlString).join(", ")}]`,
    "",
    "[dependencies]",
    `${tomlString("micromamba")} = ${tomlString(`==${PINNED_MICROMAMBA_VERSION}`)}`,
    `${tomlString("nextflow")} = ${tomlString(`==${PINNED_NEXTFLOW_VERSION}`)}`,
    `${tomlString("openjdk")} = ${tomlString(`==${PINNED_OPENJDK_VERSION}`)}`,
  ];
  for (const environment of environments) {
    if (environment.channels.length !== channels.length
      || environment.channels.some((channel, index) => channel !== channels[index])) {
      fail(`source task Pixi environment ${environment.name} channel order differs from the frozen workspace channel order`);
    }
    lines.push(
      "",
      `[feature.${environment.name}.dependencies]`,
      ...environmentLines(environment, channelSet),
    );
  }
  lines.push("", "[environments]");
  for (const environment of environments) {
    lines.push(`${environment.name} = { features = [${tomlString(environment.name)}], no-default-feature = true }`);
  }
  const pixiToml = `${lines.join("\n")}\n`;
  const bytes = encoder.encode(pixiToml);
  if (bytes.byteLength > MAX_SOURCE_TASK_PIXI_MANIFEST_BYTES) {
    fail(`source task Pixi manifest exceeds ${MAX_SOURCE_TASK_PIXI_MANIFEST_BYTES} bytes`);
  }
  const taskEnvironments = environments.map((environment) => environment.name);
  return {
    schema_version: 1,
    renderer_revision: SOURCE_TASK_PIXI_RENDERER_REVISION,
    source_plan_digest: plan.plan_digest,
    platforms,
    runtime_environment: "default",
    task_environments: taskEnvironments,
    expected_environments: ["default", ...taskEnvironments].sort(compareText),
    pixi_toml: pixiToml,
    manifest_digest: byteDigest(bytes),
  };
}
