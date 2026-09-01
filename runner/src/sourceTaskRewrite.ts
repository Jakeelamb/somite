import { isAbsolute, posix } from "node:path";

import { byteDigest, canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import {
  buildSourceManifest,
  MAX_SOURCE_FILE_BYTES,
  type FrozenSourceFile,
} from "@somite/workflow/nextflowSource";
import { assertSourceTaskExecutionPlanContract } from "@somite/workflow/sourceTaskPixi";
import type {
  SourceTaskExecutionPlan,
  SourceTaskExecutionRewrite,
} from "@somite/workflow/sourceTaskExecution";
import {
  planTaskEnvironments,
} from "@somite/workflow/taskEnvironment";

const MAX_PREFIX_BYTES = 4096;
const PIXI_ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const encoder = new TextEncoder();
type NextflowConfigScalar = SourceTaskExecutionPlan["config_closure"]["includes"][number]["parameters"][number]["value"];

export type StagedSourceTaskRewrite = Readonly<{
  path: string;
  start_byte: number;
  end_byte: number;
  expected_digest: string;
  applied_start_byte: number;
  applied_end_byte: number;
  replacement_digest: string;
  replacement_bytes: number;
  process_scope_id: string;
  environment: string;
}>;

export type StagedSourceTaskFile = Readonly<{
  path: string;
  original_digest: string;
  executed_digest: string;
}>;

export type StagedSourceTaskExecution = Readonly<{
  source_digest: string;
  executed_source_digest: string;
  files: readonly FrozenSourceFile[];
  rewritten_files: readonly StagedSourceTaskFile[];
  rewrites: readonly StagedSourceTaskRewrite[];
}>;

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueMembers(values: readonly string[], label: string) {
  const members = new Set<string>();
  for (const value of values) {
    if (members.has(value)) throw new Error(`source task execution plan has duplicate ${label} ${value}`);
    members.add(value);
  }
  return members;
}

function verifyFrozenConfigAndPluginProvenance(
  sourceFiles: readonly FrozenSourceFile[],
  plan: SourceTaskExecutionPlan,
) {
  const parameters: Record<string, NextflowConfigScalar> = {};
  for (const include of plan.config_closure.includes) {
    for (const parameter of include.parameters) parameters[parameter.name] = parameter.value;
  }
  const derived = planTaskEnvironments(sourceFiles, plan.entrypoint, { parameters });
  if (derived.configuration_issues.length) {
    const codes = [...new Set(derived.configuration_issues.map((entry) => entry.code))].sort(compareText);
    throw new Error(`source task execution plan frozen config has unresolved declarations: ${codes.join(", ")}`);
  }
  const configOverrides = derived.declarations.filter((declaration) => declaration.origin === "config");
  if (configOverrides.length) {
    throw new Error("source task execution plan frozen config contains an unclosed task-environment override");
  }
  if (canonicalJsonDigest(derived.config_closure) !== canonicalJsonDigest(plan.config_closure)) {
    throw new Error("source task execution plan config closure does not match the frozen source");
  }
  if (canonicalJsonDigest(derived.nextflow_plugins) !== canonicalJsonDigest(plan.nextflow_plugins)) {
    throw new Error("source task execution plan plugin requirements do not match the frozen source");
  }
}

function verifyAssignmentMembership(plan: SourceTaskExecutionPlan) {
  const environments = new Map<string, SourceTaskExecutionPlan["environments"][number]>();
  const sourcePathsByEnvironment = new Map<string, ReadonlySet<string>>();
  const environmentByProcessScope = new Map<string, string>();
  const environmentByInvocation = new Map<string, string>();
  for (const environment of plan.environments) {
    if (environments.has(environment.name)) {
      throw new Error(`source task execution plan has duplicate environment ${environment.name}`);
    }
    environments.set(environment.name, environment);
    sourcePathsByEnvironment.set(
      environment.name,
      uniqueMembers(environment.source_paths, `source path in environment ${environment.name}`),
    );
    for (const processScopeId of uniqueMembers(environment.process_scope_ids, `process scope in environment ${environment.name}`)) {
      const owner = environmentByProcessScope.get(processScopeId);
      if (owner !== undefined) {
        throw new Error(`source task execution plan process scope ${processScopeId} belongs to both ${owner} and ${environment.name}`);
      }
      environmentByProcessScope.set(processScopeId, environment.name);
    }
    for (const invocationId of uniqueMembers(environment.invocation_ids, `invocation in environment ${environment.name}`)) {
      const owner = environmentByInvocation.get(invocationId);
      if (owner !== undefined) {
        throw new Error(`source task execution plan invocation ${invocationId} belongs to both ${owner} and ${environment.name}`);
      }
      environmentByInvocation.set(invocationId, environment.name);
    }
  }

  const assignmentsByProcessScope = new Map<string, SourceTaskExecutionPlan["assignments"][number]>();
  const assignmentByInvocation = new Map<string, string>();
  for (const assignment of plan.assignments) {
    if (assignmentsByProcessScope.has(assignment.process_scope_id)) {
      throw new Error(`source task execution plan has duplicate assignment for process scope ${assignment.process_scope_id}`);
    }
    if (!environments.has(assignment.environment)) {
      throw new Error(`source task execution plan assignment for process scope ${assignment.process_scope_id} refers to unknown environment ${assignment.environment}`);
    }
    if (!sourcePathsByEnvironment.get(assignment.environment)!.has(assignment.source_environment_path)) {
      throw new Error(`source task execution plan assignment source environment ${assignment.source_environment_path} does not belong to ${assignment.environment}`);
    }
    const owner = environmentByProcessScope.get(assignment.process_scope_id);
    if (owner !== assignment.environment) {
      throw new Error(`source task execution plan assignment for process scope ${assignment.process_scope_id} does not match environment membership`);
    }
    for (const invocationId of uniqueMembers(assignment.invocation_ids, `invocation in assignment ${assignment.process_scope_id}`)) {
      if (environmentByInvocation.get(invocationId) !== assignment.environment) {
        throw new Error(`source task execution plan assignment invocation ${invocationId} does not match environment membership`);
      }
      const assignedScope = assignmentByInvocation.get(invocationId);
      if (assignedScope !== undefined) {
        throw new Error(`source task execution plan invocation ${invocationId} belongs to assignments ${assignedScope} and ${assignment.process_scope_id}`);
      }
      assignmentByInvocation.set(invocationId, assignment.process_scope_id);
    }
    assignmentsByProcessScope.set(assignment.process_scope_id, assignment);
  }
  for (const processScopeId of environmentByProcessScope.keys()) {
    if (!assignmentsByProcessScope.has(processScopeId)) {
      throw new Error(`source task execution plan process scope ${processScopeId} has no assignment`);
    }
  }
  for (const invocationId of environmentByInvocation.keys()) {
    if (!assignmentByInvocation.has(invocationId)) {
      throw new Error(`source task execution plan invocation ${invocationId} has no assignment`);
    }
  }
  return assignmentsByProcessScope;
}

function verifyRewriteMembership(
  plan: SourceTaskExecutionPlan,
  assignmentsByProcessScope: ReadonlyMap<string, SourceTaskExecutionPlan["assignments"][number]>,
) {
  const rewrittenProcessScopes = new Set<string>();
  for (const rewrite of plan.rewrites) {
    if (rewrittenProcessScopes.has(rewrite.process_scope_id)) {
      throw new Error(`source task execution plan has multiple rewrites for process scope ${rewrite.process_scope_id}`);
    }
    const assignment = assignmentsByProcessScope.get(rewrite.process_scope_id);
    if (!assignment) {
      throw new Error(`source task execution plan rewrite refers to unassigned process scope ${rewrite.process_scope_id}`);
    }
    if (rewrite.environment !== assignment.environment) {
      throw new Error(`source task execution plan rewrite for process scope ${rewrite.process_scope_id} does not match its assignment environment`);
    }
    if (rewrite.path !== assignment.span.path) {
      throw new Error(`source task execution plan rewrite for process scope ${rewrite.process_scope_id} does not match its assignment path`);
    }
    if (rewrite.expected_digest !== byteDigest(encoder.encode(assignment.conda_expression))) {
      throw new Error(`source task execution plan rewrite for process scope ${rewrite.process_scope_id} does not match its assignment expression`);
    }
    rewrittenProcessScopes.add(rewrite.process_scope_id);
  }
  for (const processScopeId of assignmentsByProcessScope.keys()) {
    if (!rewrittenProcessScopes.has(processScopeId)) {
      throw new Error(`source task execution plan assignment for process scope ${processScopeId} has no rewrite`);
    }
  }
}

function safePrefix(environment: string, prefix: string) {
  const bytes = encoder.encode(prefix);
  if (!isAbsolute(prefix) || bytes.byteLength === 0 || bytes.byteLength > MAX_PREFIX_BYTES
    || [...prefix].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })) {
    throw new Error(`Pixi environment ${environment} has an unsafe execution prefix`);
  }
  return bytes;
}

function escapedGroovyContent(prefix: string, quote: number) {
  let escaped = prefix.replaceAll("\\", "\\\\");
  if (quote === 39) return escaped.replaceAll("'", "\\'");
  escaped = escaped.replaceAll('"', '\\"').replaceAll("$", "\\$");
  return escaped;
}

type RewriteReplacement = Readonly<{
  bytes: Uint8Array;
  appliedStartByte: number;
  appliedEndByte: number;
}>;

type RewriteStrategy = Readonly<{
  validateEnvironment(environment: string): void;
  replacement(rewrite: SourceTaskExecutionRewrite, openingQuote: number): RewriteReplacement;
}>;

function hostRewriteStrategy(prefixes: ReadonlyMap<string, string>): RewriteStrategy {
  return {
    validateEnvironment() {},
    replacement(rewrite, openingQuote) {
      const prefix = prefixes.get(rewrite.environment);
      if (prefix === undefined) throw new Error(`Pixi environment ${rewrite.environment} has no realized prefix`);
      safePrefix(rewrite.environment, prefix);
      return {
        bytes: encoder.encode(escapedGroovyContent(prefix, openingQuote)),
        appliedStartByte: rewrite.start_byte,
        appliedEndByte: rewrite.end_byte,
      };
    },
  };
}

function portableRewriteStrategy(entrypoint: string): RewriteStrategy {
  // Nextflow's projectDir follows the main script, which can be nested below
  // the exported archive root that contains pixi.toml and .pixi/.
  const entrypointDirectory = posix.dirname(entrypoint);
  const archiveRoot = posix.relative(entrypointDirectory, ".");
  if (archiveRoot && !/^(?:\.\.(?:\/|$))+$/.test(archiveRoot)) {
    throw new Error(`source task execution plan has unsafe entrypoint directory ${entrypointDirectory}`);
  }
  const rootPrefix = archiveRoot ? `${archiveRoot}/` : "";
  return {
    validateEnvironment(environment) {
      if (!PIXI_ENVIRONMENT_NAME.test(environment)) {
        throw new Error(`source task execution plan has unsafe portable Pixi environment name ${environment}`);
      }
    },
    replacement(rewrite) {
      const literal = `"\${projectDir}/${rootPrefix}.pixi/envs/${rewrite.environment}"`;
      return {
        bytes: encoder.encode(literal),
        appliedStartByte: rewrite.start_byte - 1,
        appliedEndByte: rewrite.end_byte + 1,
      };
    },
  };
}

function validateRanges(path: string, rewrites: readonly SourceTaskExecutionRewrite[]) {
  const ordered = [...rewrites].sort((left, right) => left.start_byte - right.start_byte || left.end_byte - right.end_byte);
  let previousEnd = -1;
  for (const rewrite of ordered) {
    if (!Number.isSafeInteger(rewrite.start_byte) || !Number.isSafeInteger(rewrite.end_byte)
      || rewrite.start_byte <= 0 || rewrite.end_byte <= rewrite.start_byte) {
      throw new Error(`source task rewrite for ${path} has an invalid byte range`);
    }
    if (rewrite.start_byte < previousEnd) throw new Error(`source task rewrites for ${path} overlap`);
    previousEnd = rewrite.end_byte;
  }
  return ordered;
}

function stagedFile(
  file: FrozenSourceFile,
  rewrites: readonly SourceTaskExecutionRewrite[],
  assignmentsByProcessScope: ReadonlyMap<string, SourceTaskExecutionPlan["assignments"][number]>,
  strategy: RewriteStrategy,
) {
  const ordered = validateRanges(file.path, rewrites);
  const staged: StagedSourceTaskRewrite[] = [];
  const replacements: RewriteReplacement[] = [];
  let executedBytes = file.bytes.byteLength;
  let scannedByte = 0;
  let scannedLine = 1;
  let previousAppliedEnd = -1;
  for (const rewrite of ordered) {
    if (rewrite.end_byte >= file.bytes.byteLength) {
      throw new Error(`source task rewrite for ${file.path} is outside the frozen source`);
    }
    while (scannedByte < rewrite.start_byte) {
      if (file.bytes[scannedByte] === 10) scannedLine += 1;
      scannedByte += 1;
    }
    const startLine = scannedLine;
    while (scannedByte < rewrite.end_byte) {
      if (file.bytes[scannedByte] === 10) scannedLine += 1;
      scannedByte += 1;
    }
    const assignment = assignmentsByProcessScope.get(rewrite.process_scope_id)!;
    if (startLine < assignment.span.start_line || scannedLine > assignment.span.end_line) {
      throw new Error(`source task execution plan rewrite for process scope ${rewrite.process_scope_id} is outside its assignment span`);
    }
    const original = file.bytes.subarray(rewrite.start_byte, rewrite.end_byte);
    if (byteDigest(original) !== rewrite.expected_digest) {
      throw new Error(`source task rewrite for ${file.path} does not match its frozen expression`);
    }
    const openingQuote = file.bytes[rewrite.start_byte - 1];
    const closingQuote = file.bytes[rewrite.end_byte];
    if ((openingQuote !== 39 && openingQuote !== 34) || closingQuote !== openingQuote) {
      throw new Error(`source task rewrite for ${file.path} is not bounded by one quoted literal`);
    }
    const replacement = strategy.replacement(rewrite, openingQuote);
    if (!Number.isSafeInteger(replacement.appliedStartByte) || !Number.isSafeInteger(replacement.appliedEndByte)
      || replacement.appliedStartByte < 0 || replacement.appliedEndByte <= replacement.appliedStartByte
      || replacement.appliedEndByte > file.bytes.byteLength) {
      throw new Error(`source task rewrite for ${file.path} has invalid applied bounds`);
    }
    if (replacement.appliedStartByte < previousAppliedEnd) {
      throw new Error(`source task applied rewrites for ${file.path} overlap`);
    }
    previousAppliedEnd = replacement.appliedEndByte;
    executedBytes += replacement.bytes.byteLength - (replacement.appliedEndByte - replacement.appliedStartByte);
    if (!Number.isSafeInteger(executedBytes) || executedBytes < 0 || executedBytes > MAX_SOURCE_FILE_BYTES) {
      throw new Error(`source task rewrites for ${file.path} overflow the staged byte count`);
    }
    replacements.push(replacement);
    staged.push({
      ...rewrite,
      applied_start_byte: replacement.appliedStartByte,
      applied_end_byte: replacement.appliedEndByte,
      replacement_digest: byteDigest(replacement.bytes),
      replacement_bytes: replacement.bytes.byteLength,
    });
  }
  const bytes = new Uint8Array(executedBytes);
  let sourceOffset = 0;
  let executedOffset = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const replacement = replacements[index]!;
    const unchanged = file.bytes.subarray(sourceOffset, replacement.appliedStartByte);
    bytes.set(unchanged, executedOffset);
    executedOffset += unchanged.byteLength;
    bytes.set(replacement.bytes, executedOffset);
    executedOffset += replacement.bytes.byteLength;
    sourceOffset = replacement.appliedEndByte;
  }
  bytes.set(file.bytes.subarray(sourceOffset), executedOffset);
  return { file: { ...file, bytes }, rewrites: staged };
}

function stageSourceTaskExecutionWithStrategy(
  sourceFiles: readonly FrozenSourceFile[],
  plan: SourceTaskExecutionPlan,
  strategy: RewriteStrategy,
): StagedSourceTaskExecution {
  assertSourceTaskExecutionPlanContract(plan);
  const assignmentsByProcessScope = verifyAssignmentMembership(plan);
  verifyRewriteMembership(plan, assignmentsByProcessScope);
  for (const environment of plan.environments) strategy.validateEnvironment(environment.name);
  const sourceManifest = buildSourceManifest(sourceFiles);
  if (sourceManifest.source_digest !== plan.source_digest) {
    throw new Error("source task execution plan does not describe the frozen source");
  }
  verifyFrozenConfigAndPluginProvenance(sourceFiles, plan);
  const rewritesByPath = new Map<string, SourceTaskExecutionRewrite[]>();
  for (const rewrite of plan.rewrites) {
    const group = rewritesByPath.get(rewrite.path) ?? [];
    group.push(rewrite);
    rewritesByPath.set(rewrite.path, group);
  }
  const sourcePaths = new Set(sourceFiles.map((file) => file.path));
  for (const path of rewritesByPath.keys()) {
    if (!sourcePaths.has(path)) throw new Error(`source task rewrite refers to missing frozen file ${path}`);
  }

  const files: FrozenSourceFile[] = [];
  const rewrittenFiles: StagedSourceTaskFile[] = [];
  const applied: StagedSourceTaskRewrite[] = [];
  for (const file of sourceFiles) {
    const rewrites = rewritesByPath.get(file.path) ?? [];
    if (!rewrites.length) {
      files.push(file);
      continue;
    }
    const staged = stagedFile(file, rewrites, assignmentsByProcessScope, strategy);
    files.push(staged.file);
    applied.push(...staged.rewrites);
    rewrittenFiles.push({
      path: file.path,
      original_digest: byteDigest(file.bytes),
      executed_digest: byteDigest(staged.file.bytes),
    });
  }
  if (applied.length !== plan.rewrites.length) throw new Error("source task execution did not apply every planned rewrite");
  const executedManifest = buildSourceManifest(files);
  return {
    source_digest: sourceManifest.source_digest,
    executed_source_digest: executedManifest.source_digest,
    files,
    rewritten_files: rewrittenFiles.sort((left, right) => compareText(left.path, right.path)),
    rewrites: applied.sort((left, right) => compareText(left.path, right.path) || left.start_byte - right.start_byte),
  };
}

/**
 * Create a host-specific run copy whose static process Conda literals point to
 * already-verified Pixi prefixes. The supplied frozen source bytes are never
 * mutated, and every rewrite is guarded by the portable plan and byte digest.
 */
export function stageSourceTaskExecution(
  sourceFiles: readonly FrozenSourceFile[],
  plan: SourceTaskExecutionPlan,
  prefixes: ReadonlyMap<string, string>,
): StagedSourceTaskExecution {
  return stageSourceTaskExecutionWithStrategy(sourceFiles, plan, hostRewriteStrategy(prefixes));
}

/**
 * Create a portable export copy whose task environments resolve inside the
 * exported Pixi workspace after `pixi install --all --frozen`.
 */
export function stagePortableSourceTaskExecution(
  sourceFiles: readonly FrozenSourceFile[],
  plan: SourceTaskExecutionPlan,
): StagedSourceTaskExecution {
  return stageSourceTaskExecutionWithStrategy(sourceFiles, plan, portableRewriteStrategy(plan.entrypoint));
}
