import { byteDigest, canonicalJsonDigest } from "./contentIdentity.ts";
import {
  PINNED_NEXTFLOW_VERSION,
  PINNED_OPENJDK_VERSION,
} from "./nextflow.ts";
import {
  MAX_SOURCE_FILES,
  safeSourcePath,
} from "./nextflowSource.ts";
import {
  MAX_NEXTFLOW_CONDA_CHANNELS,
  MAX_NEXTFLOW_PLUGIN_REQUIREMENTS,
} from "./taskEnvironment.ts";
import {
  SOURCE_TASK_EXECUTION_PLANNER_REVISION,
  type SourceTaskExecutionDependency,
  type SourceTaskExecutionPlan,
} from "./sourceTaskExecution.ts";

export const SOURCE_TASK_PIXI_RENDERER_REVISION = "source-task-pixi-ts-v8";
export const PINNED_BASH_VERSION = "5.2.37";
export const PINNED_COREUTILS_VERSION = "9.11";
export const PINNED_GAWK_VERSION = "5.4.1";
export const PINNED_GREP_VERSION = "3.12";
export const PINNED_MICROMAMBA_VERSION = "2.9.0";
export const PINNED_PROCPS_VERSION = "4.0.6";
export const PINNED_SED_VERSION = "4.10";
export const MAX_SOURCE_TASK_PIXI_MANIFEST_BYTES = 1024 * 1024;
export const SOURCE_TASK_RUNTIME_CHANNELS = ["conda-forge", "bioconda"] as const;
export const CONDA_DEFAULTS_UNIX_CHANNELS = [
  "https://repo.anaconda.com/pkgs/main",
  "https://repo.anaconda.com/pkgs/r",
] as const;

const MAX_SOURCE_TASK_ENVIRONMENTS = 511;
const MAX_SOURCE_TASK_PLATFORMS = 16;
const MAX_SOURCE_TASK_CONFIG_INCLUDES = 25_000;
const MAX_SOURCE_TASK_CONFIG_BINDINGS = 10_000;
const MAX_SOURCE_TASK_CONFIG_EXPRESSION_BYTES = 16 * 1024;
const MAX_SOURCE_TASK_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_TASK_PLUGIN_SPANS = 1_024;
const MAX_CHANNEL_BYTES = 2048;
const PLATFORM = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const SUPPORTED_PLATFORMS = new Set(["linux-64", "linux-aarch64", "osx-64", "osx-arm64"]);
const TASK_ENVIRONMENT = /^task-([a-f0-9]{64})$/;
const PACKAGE_NAME = /^[a-z0-9_.-]+$/;
const BUILD = /^[A-Za-z0-9_.+*-]+$/;
const VERSION_SPEC = /^[A-Za-z0-9_.+*<>=!~|,-]+$/;
const CONFIG_PARAMETER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLUGIN_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PLUGIN_VERSION = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
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

export class SourceTaskExecutionPlanContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceTaskExecutionPlanContractError";
  }
}

function fail(message: string): never {
  throw new SourceTaskPixiRenderError(message);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contractFail(message: string): never {
  throw new SourceTaskExecutionPlanContractError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    contractFail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    contractFail(`${label} has an invalid contract`);
  }
}

function boundedText(value: unknown, maximumBytes: number, label: string) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || encoder.encode(value).byteLength > maximumBytes
    || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) {
    contractFail(`${label} is not bounded text`);
  }
  return value;
}

function claimMetadataBytes(current: number, value: string) {
  const next = current + encoder.encode(value).byteLength + 32;
  if (!Number.isSafeInteger(next) || next > MAX_SOURCE_TASK_METADATA_BYTES) {
    contractFail(`source task execution plan config and plugin metadata exceeds ${MAX_SOURCE_TASK_METADATA_BYTES} bytes`);
  }
  return next;
}

function checkedSpan(
  value: unknown,
  label: string,
  configPaths: ReadonlySet<string>,
): SourceTaskExecutionPlan["nextflow_plugins"][number]["spans"][number] {
  const span = record(value, label);
  exactKeys(span, ["path", "start_line", "end_line"], label);
  if (typeof span.path !== "string" || !safeSourcePath(span.path) || !configPaths.has(span.path)
    || !Number.isSafeInteger(span.start_line) || (span.start_line as number) < 1
    || !Number.isSafeInteger(span.end_line) || (span.end_line as number) < (span.start_line as number)) {
    contractFail(`${label} is not one valid frozen-config span`);
  }
  return span as SourceTaskExecutionPlan["nextflow_plugins"][number]["spans"][number];
}

function compareSpans(
  left: SourceTaskExecutionPlan["nextflow_plugins"][number]["spans"][number],
  right: SourceTaskExecutionPlan["nextflow_plugins"][number]["spans"][number],
) {
  return compareText(left.path, right.path)
    || left.start_line - right.start_line
    || left.end_line - right.end_line;
}

function checkedConfigScalar(value: unknown, label: string) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && encoder.encode(value).byteLength <= MAX_SOURCE_TASK_CONFIG_EXPRESSION_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value)) return value;
  contractFail(`${label} is not one bounded scalar`);
}

function checkedChannelOrder(value: unknown, label: string) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_NEXTFLOW_CONDA_CHANNELS) {
    contractFail(`${label} must contain between 1 and ${MAX_NEXTFLOW_CONDA_CHANNELS} channels`);
  }
  const channels = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const channel = boundedText(value[index], MAX_CHANNEL_BYTES, `${label} channel ${index}`);
    if (channels.has(channel)) contractFail(`${label} repeats channel ${channel}`);
    channels.add(channel);
  }
  return channels;
}

/**
 * Reject transport-forged or malformed config/plugin metadata before any
 * source rewrite, Pixi solve input, or plugin installation can consume it.
 * The digest binds the complete plan; this validator also enforces the
 * canonical shape and bounded provenance that TypeScript types cannot protect
 * after JSON transport.
 */
export function assertSourceTaskExecutionPlanContract(plan: SourceTaskExecutionPlan) {
  const raw = record(plan, "source task execution plan");
  exactKeys(raw, [
    "schema_version",
    "planner_revision",
    "source_digest",
    "entrypoint",
    "config_closure",
    "nextflow_plugins",
    "environments",
    "assignments",
    "rewrites",
    "plan_digest",
  ], "source task execution plan");
  if (plan.schema_version !== 2 || plan.planner_revision !== SOURCE_TASK_EXECUTION_PLANNER_REVISION) {
    contractFail("source task execution plan has an unsupported revision");
  }
  if (!/^blake3:[a-f0-9]{64}$/.test(plan.source_digest)) {
    contractFail("source task execution plan has an invalid source digest");
  }
  if (typeof plan.entrypoint !== "string" || !safeSourcePath(plan.entrypoint)) {
    contractFail("source task execution plan has an unsafe entrypoint");
  }
  if (!Array.isArray(plan.environments) || !Array.isArray(plan.assignments) || !Array.isArray(plan.rewrites)) {
    contractFail("source task execution plan has invalid execution collections");
  }

  const closure = record(plan.config_closure, "source task execution plan config closure");
  exactKeys(closure, [
    "paths",
    "includes",
    ...(plan.config_closure.conda_channel_order ? ["conda_channel_order"] : []),
    ...(plan.config_closure.conda_profile ? ["conda_profile"] : []),
  ], "source task execution plan config closure");
  if (!Array.isArray(plan.config_closure.paths) || plan.config_closure.paths.length > MAX_SOURCE_FILES) {
    contractFail(`source task execution plan has more than ${MAX_SOURCE_FILES} config paths`);
  }
  if (!Array.isArray(plan.config_closure.includes)
    || plan.config_closure.includes.length > MAX_SOURCE_TASK_CONFIG_INCLUDES) {
    contractFail(`source task execution plan has more than ${MAX_SOURCE_TASK_CONFIG_INCLUDES} config includes`);
  }

  let metadataBytes = 0;
  const configPaths = new Set<string>();
  let previousConfigPath: string | undefined;
  for (const path of plan.config_closure.paths) {
    if (typeof path !== "string" || !safeSourcePath(path)) {
      contractFail(`source task execution plan has an unsafe config path ${JSON.stringify(path)}`);
    }
    if (previousConfigPath !== undefined && compareText(previousConfigPath, path) >= 0) {
      contractFail("source task execution plan config paths are not unique and canonical");
    }
    configPaths.add(path);
    previousConfigPath = path;
    metadataBytes = claimMetadataBytes(metadataBytes, path);
  }

  const parameterValues = new Map<string, unknown>();
  const sourceTargets = new Set<string>();
  let bindingCount = 0;
  let previousIncludeKey: string | undefined;
  for (let includeIndex = 0; includeIndex < plan.config_closure.includes.length; includeIndex += 1) {
    const include = record(
      plan.config_closure.includes[includeIndex],
      `source task execution plan config include ${includeIndex}`,
    );
    exactKeys(include, [
      "expression", "span", "status", "resolved_path", "parameters", "environment",
    ], `source task execution plan config include ${includeIndex}`);
    const expression = boundedText(
      include.expression,
      MAX_SOURCE_TASK_CONFIG_EXPRESSION_BYTES,
      `source task execution plan config include ${includeIndex} expression`,
    );
    const span = checkedSpan(
      include.span,
      `source task execution plan config include ${includeIndex} span`,
      configPaths,
    );
    const includeKey = `${span.path}\0${String(span.start_line).padStart(16, "0")}\0${expression}`;
    if (previousIncludeKey !== undefined && compareText(previousIncludeKey, includeKey) >= 0) {
      contractFail("source task execution plan config includes are not unique and canonical");
    }
    previousIncludeKey = includeKey;
    metadataBytes = claimMetadataBytes(metadataBytes, expression);

    if (include.status === "source") {
      if (typeof include.resolved_path !== "string" || !safeSourcePath(include.resolved_path)
        || !configPaths.has(include.resolved_path)) {
        contractFail(`source task execution plan config include ${includeIndex} has an invalid frozen target`);
      }
      sourceTargets.add(include.resolved_path);
      metadataBytes = claimMetadataBytes(metadataBytes, include.resolved_path);
    } else if (include.status === "ignored") {
      if (include.resolved_path !== "/dev/null") {
        contractFail(`source task execution plan config include ${includeIndex} is not the bounded offline sentinel`);
      }
    } else {
      contractFail(`source task execution plan config include ${includeIndex} is not execution-closed`);
    }

    if (!Array.isArray(include.parameters) || !Array.isArray(include.environment)) {
      contractFail(`source task execution plan config include ${includeIndex} has invalid bindings`);
    }
    let previousParameter: string | undefined;
    for (let parameterIndex = 0; parameterIndex < include.parameters.length; parameterIndex += 1) {
      bindingCount += 1;
      if (bindingCount > MAX_SOURCE_TASK_CONFIG_BINDINGS) {
        contractFail(`source task execution plan exceeds ${MAX_SOURCE_TASK_CONFIG_BINDINGS} config bindings`);
      }
      const parameter = record(
        include.parameters[parameterIndex],
        `source task execution plan config parameter ${includeIndex}:${parameterIndex}`,
      );
      exactKeys(parameter, ["name", "value"], `source task execution plan config parameter ${includeIndex}:${parameterIndex}`);
      if (typeof parameter.name !== "string" || !CONFIG_PARAMETER.test(parameter.name)
        || previousParameter !== undefined && compareText(previousParameter, parameter.name) >= 0) {
        contractFail(`source task execution plan config include ${includeIndex} parameters are not unique and canonical`);
      }
      const scalar = checkedConfigScalar(
        parameter.value,
        `source task execution plan config parameter ${parameter.name}`,
      );
      const encoded = JSON.stringify(scalar);
      const previousValue = parameterValues.get(parameter.name);
      if (previousValue !== undefined && JSON.stringify(previousValue) !== encoded) {
        contractFail(`source task execution plan config parameter ${parameter.name} has conflicting values`);
      }
      parameterValues.set(parameter.name, scalar);
      previousParameter = parameter.name;
      metadataBytes = claimMetadataBytes(metadataBytes, parameter.name);
      if (typeof scalar === "string") metadataBytes = claimMetadataBytes(metadataBytes, scalar);
    }
    let previousEnvironment: string | undefined;
    for (let environmentIndex = 0; environmentIndex < include.environment.length; environmentIndex += 1) {
      bindingCount += 1;
      if (bindingCount > MAX_SOURCE_TASK_CONFIG_BINDINGS) {
        contractFail(`source task execution plan exceeds ${MAX_SOURCE_TASK_CONFIG_BINDINGS} config bindings`);
      }
      const environment = record(
        include.environment[environmentIndex],
        `source task execution plan config environment ${includeIndex}:${environmentIndex}`,
      );
      exactKeys(environment, ["name", "value"], `source task execution plan config environment ${includeIndex}:${environmentIndex}`);
      if (environment.name !== "NXF_OFFLINE" || environment.value !== "true"
        || previousEnvironment !== undefined && compareText(previousEnvironment, environment.name) >= 0) {
        contractFail(`source task execution plan config include ${includeIndex} has an unproven environment binding`);
      }
      previousEnvironment = environment.name;
      metadataBytes = claimMetadataBytes(metadataBytes, environment.name);
      metadataBytes = claimMetadataBytes(metadataBytes, environment.value);
    }
  }

  const entrypointDirectory = plan.entrypoint.split("/").slice(0, -1).join("/");
  const rootConfigs = new Set(["nextflow.config", `${entrypointDirectory ? `${entrypointDirectory}/` : ""}nextflow.config`]);
  for (const path of configPaths) {
    if (!rootConfigs.has(path) && !sourceTargets.has(path)) {
      contractFail(`source task execution plan config path ${path} is not rooted in the frozen include closure`);
    }
  }

  const channelOrder = plan.config_closure.conda_channel_order;
  if (channelOrder) {
    const rawOrder = record(channelOrder, "source task execution plan Conda channel order");
    exactKeys(rawOrder, [
      "channels",
      "origin",
      ...(channelOrder.profile ? ["profile"] : []),
      "span",
      "expression_provenance",
    ], "source task execution plan Conda channel order");
    if (!Array.isArray(channelOrder.channels) || !channelOrder.channels.length
      || channelOrder.channels.length > MAX_NEXTFLOW_CONDA_CHANNELS) {
      contractFail(`source task execution plan Conda channel order must contain between 1 and ${MAX_NEXTFLOW_CONDA_CHANNELS} channels`);
    }
    const seenChannels = new Set<string>();
    for (const channel of channelOrder.channels) {
      const value = boundedText(channel, MAX_CHANNEL_BYTES, "source task execution plan Conda channel");
      if (seenChannels.has(value)) contractFail(`source task execution plan repeats Conda channel ${value}`);
      seenChannels.add(value);
      metadataBytes = claimMetadataBytes(metadataBytes, value);
    }
    if (channelOrder.origin !== "top_level" && channelOrder.origin !== "profile") {
      contractFail("source task execution plan Conda channel order has an invalid origin");
    }
    if (channelOrder.origin === "profile" ? channelOrder.profile !== "conda" : channelOrder.profile !== undefined) {
      contractFail("source task execution plan Conda channel order has inconsistent profile provenance");
    }
    checkedSpan(channelOrder.span, "source task execution plan Conda channel order span", configPaths);
    const expression = record(
      channelOrder.expression_provenance,
      "source task execution plan Conda channel expression provenance",
    );
    exactKeys(expression, ["start_byte", "end_byte", "digest"], "source task execution plan Conda channel expression provenance");
    if (!Number.isSafeInteger(expression.start_byte) || (expression.start_byte as number) < 0
      || !Number.isSafeInteger(expression.end_byte) || (expression.end_byte as number) <= (expression.start_byte as number)
      || typeof expression.digest !== "string" || !/^blake3:[a-f0-9]{64}$/.test(expression.digest)) {
      contractFail("source task execution plan Conda channel expression provenance is invalid");
    }
  }

  const condaProfile = plan.config_closure.conda_profile;
  if (condaProfile) {
    const rawProfile = record(condaProfile, "source task execution plan Conda profile");
    exactKeys(rawProfile, ["name", "blocks"], "source task execution plan Conda profile");
    if (condaProfile.name !== "conda" || !Array.isArray(condaProfile.blocks)
      || !condaProfile.blocks.length || condaProfile.blocks.length > MAX_SOURCE_TASK_CONFIG_INCLUDES) {
      contractFail("source task execution plan Conda profile has an invalid contract");
    }
    let previousBlockKey: string | undefined;
    for (let blockIndex = 0; blockIndex < condaProfile.blocks.length; blockIndex += 1) {
      const block = record(condaProfile.blocks[blockIndex], `source task execution plan Conda profile block ${blockIndex}`);
      exactKeys(block, ["span", "digest"], `source task execution plan Conda profile block ${blockIndex}`);
      const span = checkedSpan(block.span, `source task execution plan Conda profile block ${blockIndex} span`, configPaths);
      if (typeof block.digest !== "string" || !/^blake3:[a-f0-9]{64}$/.test(block.digest)) {
        contractFail(`source task execution plan Conda profile block ${blockIndex} has an invalid digest`);
      }
      const key = `${span.path}\0${String(span.start_line).padStart(16, "0")}\0${String(span.end_line).padStart(16, "0")}\0${block.digest}`;
      if (previousBlockKey !== undefined && compareText(previousBlockKey, key) >= 0) {
        contractFail("source task execution plan Conda profile blocks are not unique and canonical");
      }
      previousBlockKey = key;
      metadataBytes = claimMetadataBytes(metadataBytes, block.digest);
    }
  }
  if (channelOrder?.origin === "profile" && !condaProfile) {
    contractFail("source task execution plan Conda channel order refers to a missing Conda profile");
  }

  if (!Array.isArray(plan.nextflow_plugins)
    || plan.nextflow_plugins.length > MAX_NEXTFLOW_PLUGIN_REQUIREMENTS) {
    contractFail(`source task execution plan has more than ${MAX_NEXTFLOW_PLUGIN_REQUIREMENTS} Nextflow plugins`);
  }
  let previousPlugin: string | undefined;
  let pluginSpans = 0;
  for (let pluginIndex = 0; pluginIndex < plan.nextflow_plugins.length; pluginIndex += 1) {
    const plugin = record(plan.nextflow_plugins[pluginIndex], `source task execution plan plugin ${pluginIndex}`);
    exactKeys(plugin, ["name", "version", "requirement", "spans"], `source task execution plan plugin ${pluginIndex}`);
    if (typeof plugin.name !== "string" || !PLUGIN_NAME.test(plugin.name) || encoder.encode(plugin.name).byteLength > 128
      || previousPlugin !== undefined && compareText(previousPlugin, plugin.name) >= 0) {
      contractFail("source task execution plan plugins are not unique and canonical");
    }
    if (typeof plugin.version !== "string" || !PLUGIN_VERSION.test(plugin.version)
      || encoder.encode(plugin.version).byteLength > 128
      || plugin.requirement !== `${plugin.name}@${plugin.version}`) {
      contractFail(`source task execution plan plugin ${plugin.name} is not one exact requirement`);
    }
    if (!Array.isArray(plugin.spans) || !plugin.spans.length) {
      contractFail(`source task execution plan plugin ${plugin.name} has no source provenance`);
    }
    let previousSpan: SourceTaskExecutionPlan["nextflow_plugins"][number]["spans"][number] | undefined;
    for (let spanIndex = 0; spanIndex < plugin.spans.length; spanIndex += 1) {
      pluginSpans += 1;
      if (pluginSpans > MAX_SOURCE_TASK_PLUGIN_SPANS) {
        contractFail(`source task execution plan exceeds ${MAX_SOURCE_TASK_PLUGIN_SPANS} plugin source spans`);
      }
      const span = checkedSpan(
        plugin.spans[spanIndex],
        `source task execution plan plugin ${plugin.name} span ${spanIndex}`,
        configPaths,
      );
      if (previousSpan && compareSpans(previousSpan, span) >= 0) {
        contractFail(`source task execution plan plugin ${plugin.name} spans are not unique and canonical`);
      }
      previousSpan = span;
      metadataBytes = claimMetadataBytes(metadataBytes, span.path);
    }
    previousPlugin = plugin.name;
    metadataBytes = claimMetadataBytes(metadataBytes, plugin.name);
    metadataBytes = claimMetadataBytes(metadataBytes, plugin.version);
  }

  if (!plan.environments.length || plan.environments.length > MAX_SOURCE_TASK_ENVIRONMENTS) {
    contractFail(`source task execution plan must contain between 1 and ${MAX_SOURCE_TASK_ENVIRONMENTS} environments`);
  }
  const environmentNames = new Set<string>();
  for (let environmentIndex = 0; environmentIndex < plan.environments.length; environmentIndex += 1) {
    const environment = record(
      plan.environments[environmentIndex],
      `source task execution plan environment ${environmentIndex}`,
    );
    exactKeys(environment, [
      "name",
      "source_environment_digest",
      "source_paths",
      "channels",
      "dependencies",
      "process_scope_ids",
      "invocation_ids",
    ], `source task execution plan environment ${environmentIndex}`);
    if (typeof environment.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(environment.name)
      || environmentNames.has(environment.name)) {
      contractFail("source task execution plan environments are invalid or repeated");
    }
    environmentNames.add(environment.name);
    if (typeof environment.source_environment_digest !== "string"
      || !/^blake3:[a-f0-9]{64}$/.test(environment.source_environment_digest)) {
      contractFail(`source task execution plan environment ${environment.name} has an invalid source digest`);
    }
    const channels = checkedChannelOrder(
      environment.channels,
      `source task execution plan environment ${environment.name} channel order`,
    );
    if (!Array.isArray(environment.source_paths) || !environment.source_paths.length
      || !Array.isArray(environment.dependencies)
      || !Array.isArray(environment.process_scope_ids) || !Array.isArray(environment.invocation_ids)) {
      contractFail(`source task execution plan environment ${environment.name} has invalid collections`);
    }
    const sourcePaths = new Set<string>();
    for (const sourcePath of environment.source_paths) {
      if (typeof sourcePath !== "string"
        || !(safeSourcePath(sourcePath) || /^direct-conda:blake3:[a-f0-9]{64}$/.test(sourcePath))
        || sourcePaths.has(sourcePath)) {
        contractFail(`source task execution plan environment ${environment.name} source paths are invalid or repeated`);
      }
      sourcePaths.add(sourcePath);
    }
    let previousDependencyKey: string | undefined;
    for (let dependencyIndex = 0; dependencyIndex < environment.dependencies.length; dependencyIndex += 1) {
      const dependency = record(
        environment.dependencies[dependencyIndex],
        `source task execution plan environment ${environment.name} dependency ${dependencyIndex}`,
      );
      exactKeys(dependency, [
        "name",
        "match_spec",
        ...(dependency.channel === undefined ? [] : ["channel"]),
        "constraint",
        ...(dependency.exact_version === undefined ? [] : ["exact_version"]),
        ...(dependency.exact_build === undefined ? [] : ["exact_build"]),
      ], `source task execution plan environment ${environment.name} dependency ${dependencyIndex}`);
      if (typeof dependency.name !== "string" || !PACKAGE_NAME.test(dependency.name)
        || typeof dependency.match_spec !== "string" || !dependency.match_spec
        || encoder.encode(dependency.match_spec).byteLength > MAX_SOURCE_TASK_CONFIG_EXPRESSION_BYTES
        || typeof dependency.constraint !== "string"
        || encoder.encode(dependency.constraint).byteLength > MAX_SOURCE_TASK_CONFIG_EXPRESSION_BYTES) {
        contractFail(`source task execution plan environment ${environment.name} has an invalid dependency`);
      }
      if (dependency.channel !== undefined
        && (typeof dependency.channel !== "string" || !channels.has(dependency.channel))) {
        contractFail(`source task execution plan dependency ${dependency.match_spec} channel ${String(dependency.channel)} is absent from its task environment channel order`);
      }
      if (dependency.exact_version !== undefined && (typeof dependency.exact_version !== "string" || !dependency.exact_version)) {
        contractFail(`source task execution plan dependency ${dependency.match_spec} has an invalid exact version`);
      }
      if (dependency.exact_build !== undefined
        && (typeof dependency.exact_build !== "string" || !BUILD.test(dependency.exact_build))) {
        contractFail(`source task execution plan dependency ${dependency.match_spec} has an invalid exact build`);
      }
      const dependencyKey = `${dependency.name}\0${dependency.match_spec}`;
      if (previousDependencyKey !== undefined && compareText(previousDependencyKey, dependencyKey) >= 0) {
        contractFail(`source task execution plan environment ${environment.name} dependencies are not unique and canonical`);
      }
      previousDependencyKey = dependencyKey;
    }
  }

  const { plan_digest: advertised, ...base } = plan;
  if (typeof advertised !== "string" || canonicalJsonDigest(base) !== advertised) {
    contractFail("source task execution plan does not match its content digest");
  }
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

/**
 * Pixi treats the bare name `defaults` as an ordinary channel under
 * conda.anaconda.org. Conda instead defines it as an ordered multichannel.
 * Somite currently targets Unix Pixi platforms, whose canonical expansion is
 * main followed by r. Keep the source plan untouched and expand only while
 * rendering the solve input so the original declaration remains auditable.
 */
function renderedChannels(input: readonly string[]) {
  const frozen = normalizedChannels(input);
  const rendered: string[] = [];
  const seen = new Set<string>();
  for (const channel of frozen) {
    const expansion = channel === "defaults" ? CONDA_DEFAULTS_UNIX_CHANNELS : [channel];
    for (const value of expansion) {
      if (seen.has(value)) {
        fail(`frozen channel order becomes ambiguous after expanding Conda defaults: duplicate ${value}`);
      }
      seen.add(value);
      rendered.push(value);
    }
  }
  return { frozen, rendered };
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
  if (dependency.channel === "defaults") {
    fail(`${dependency.match_spec} uses an explicit defaults:: MatchSpec, which cannot be represented as one Pixi channel without changing Conda multichannel semantics`);
  }
  if (dependency.channel && !channels.has(dependency.channel)) {
    fail(`${dependency.match_spec} channel ${dependency.channel} is absent from its frozen task environment channel order`);
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
  return [...byPackage].sort(([left], [right]) => compareText(left, right)).map(([, line]) => line);
}

function assertSourcePlan(plan: SourceTaskExecutionPlan) {
  assertSourceTaskExecutionPlanContract(plan);
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
  const runtimeChannels = normalizedChannels(SOURCE_TASK_RUNTIME_CHANNELS);
  const environments = [...plan.environments].sort((left, right) => compareText(left.name, right.name));
  for (let index = 1; index < environments.length; index += 1) {
    if (environments[index - 1]!.name === environments[index]!.name) {
      fail(`duplicate source task Pixi environment ${environments[index]!.name}`);
    }
  }

  const lines = [
    "[workspace]",
    `name = ${tomlString("somite-source-tasks")}`,
    `channels = [${runtimeChannels.map(tomlString).join(", ")}]`,
    `channel-priority = ${tomlString("strict")}`,
    `platforms = [${platforms.map(tomlString).join(", ")}]`,
    "",
    "[dependencies]",
    `${tomlString("bash")} = ${tomlString(`==${PINNED_BASH_VERSION}`)}`,
    `${tomlString("coreutils")} = ${tomlString(`==${PINNED_COREUTILS_VERSION}`)}`,
    `${tomlString("gawk")} = ${tomlString(`==${PINNED_GAWK_VERSION}`)}`,
    `${tomlString("grep")} = ${tomlString(`==${PINNED_GREP_VERSION}`)}`,
    `${tomlString("micromamba")} = ${tomlString(`==${PINNED_MICROMAMBA_VERSION}`)}`,
    `${tomlString("nextflow")} = ${tomlString(`==${PINNED_NEXTFLOW_VERSION}`)}`,
    `${tomlString("openjdk")} = ${tomlString(`==${PINNED_OPENJDK_VERSION}`)}`,
    `${tomlString("sed")} = ${tomlString(`==${PINNED_SED_VERSION}`)}`,
  ];
  for (const platform of platforms.filter((platform) => platform.startsWith("linux-"))) {
    lines.push(
      "",
      `[target.${platform}.dependencies]`,
      `${tomlString("procps-ng")} = ${tomlString(`==${PINNED_PROCPS_VERSION}`)}`,
    );
  }
  for (const environment of environments) {
    const channels = renderedChannels(environment.channels);
    const frozenChannelSet = new Set(channels.frozen);
    lines.push(
      "",
      `[feature.${environment.name}]`,
      `channels = [${channels.rendered.map(tomlString).join(", ")}]`,
      `channel-priority = ${tomlString("strict")}`,
      "",
      `[feature.${environment.name}.dependencies]`,
      ...environmentLines(environment, frozenChannelSet),
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
