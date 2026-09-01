import { canonicalJsonDigest } from "./contentIdentity.ts";
import type { SourceInvocation, SourceScope, SourceSpan } from "./model.ts";
import {
  buildSourceManifest,
  indexNextflowSource,
  type FrozenSourceFile,
} from "./nextflowSource.ts";
import {
  planTaskEnvironments,
  type CondaDependency,
  type CondaEnvironment,
  type NextflowConfigClosure,
  type NextflowPluginRequirement,
  type TaskEnvironmentPlan,
  type TaskEnvironmentPlanningOptions,
  type TaskEnvironmentDeclaration,
  type TaskEnvironmentIssue,
  type TaskEnvironmentProcess,
} from "./taskEnvironment.ts";

export const SOURCE_TASK_EXECUTION_PLANNER_REVISION = "source-task-execution-ts-v6";

export type SourceTaskExecutionDependency = Readonly<{
  name: string;
  match_spec: string;
  channel?: string;
  constraint: string;
  exact_version?: string;
  exact_build?: string;
}>;

export type SourceTaskExecutionEnvironment = Readonly<{
  name: string;
  source_environment_digest: string;
  source_paths: readonly string[];
  channels: readonly string[];
  dependencies: readonly SourceTaskExecutionDependency[];
  process_scope_ids: readonly string[];
  invocation_ids: readonly string[];
}>;

export type SourceTaskExecutionAssignment = Readonly<{
  process_id: string;
  process_scope_id: string;
  process: string;
  span: SourceSpan;
  invocation_ids: readonly string[];
  environment: string;
  source_environment_path: string;
  conda_expression: string;
}>;

export type SourceTaskExecutionRewrite = Readonly<{
  path: string;
  start_byte: number;
  end_byte: number;
  expected_digest: string;
  process_scope_id: string;
  environment: string;
}>;

export type SourceTaskExecutionPlan = Readonly<{
  schema_version: 2;
  planner_revision: typeof SOURCE_TASK_EXECUTION_PLANNER_REVISION;
  source_digest: string;
  entrypoint: string;
  config_closure: NextflowConfigClosure;
  nextflow_plugins: readonly NextflowPluginRequirement[];
  environments: readonly SourceTaskExecutionEnvironment[];
  assignments: readonly SourceTaskExecutionAssignment[];
  rewrites: readonly SourceTaskExecutionRewrite[];
  plan_digest: string;
}>;

export type SourceTaskExecutionDecision =
  | Readonly<{
      status: "blocked";
      source_digest: string;
      blockers: readonly TaskEnvironmentIssue[];
    }>
  | Readonly<{
      status: "candidate";
      plan: SourceTaskExecutionPlan;
    }>;

/** @internal Validated source analysis shared only by source derivation internals. */
export type SourceTaskExecutionAnalysis = Readonly<{
  entrypoint: string;
  source_digest: string;
  outline: Pick<ReturnType<typeof indexNextflowSource>, "scopes" | "invocations">;
  inventory: TaskEnvironmentPlan;
}>;

type ReachableOutline = Readonly<{
  processScopes: readonly SourceScope[];
  invocationIdsByProcess: ReadonlyMap<string, readonly string[]>;
}>;

type PendingAssignment = Readonly<{
  process: TaskEnvironmentProcess;
  scope: SourceScope;
  invocationIds: readonly string[];
  declaration: TaskEnvironmentDeclaration;
  environment: ResolvedTaskEnvironment;
}>;

type ResolvedTaskEnvironment = Readonly<{
  origin: "file" | "direct";
  reference: string;
  digest: string;
  channels: readonly string[];
  dependencies: readonly CondaDependency[];
  problems: readonly TaskEnvironmentIssue[];
}>;

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSpans(left: SourceSpan, right: SourceSpan) {
  return compareText(left.path, right.path)
    || left.start_line - right.start_line
    || left.end_line - right.end_line;
}

function issue(code: string, message: string, ...spans: SourceSpan[]): TaskEnvironmentIssue {
  return { code, message, spans };
}

function sortedIssue(entry: TaskEnvironmentIssue): TaskEnvironmentIssue {
  return { ...entry, spans: [...entry.spans].sort(compareSpans) };
}

function issueKey(entry: TaskEnvironmentIssue) {
  return JSON.stringify(sortedIssue(entry));
}

function addIssue(target: Map<string, TaskEnvironmentIssue>, entry: TaskEnvironmentIssue) {
  target.set(issueKey(entry), sortedIssue(entry));
}

function sortedIssues(entries: Iterable<TaskEnvironmentIssue>) {
  return [...entries].sort((left, right) => compareSpans(
    left.spans[0] ?? { path: "", start_line: 0, end_line: 0 },
    right.spans[0] ?? { path: "", start_line: 0, end_line: 0 },
  ) || compareText(left.code, right.code) || compareText(left.message, right.message));
}

function processKey(path: string, line: number, name: string) {
  return `${path}\0${line}\0${name}`;
}

function reachableOutline(
  scopes: readonly SourceScope[],
  invocations: readonly SourceInvocation[],
  entrypoint: string,
  blockers: Map<string, TaskEnvironmentIssue>,
): ReachableOutline {
  const scopeById = new Map<string, SourceScope>();
  for (const scope of scopes) {
    if (scopeById.has(scope.id)) {
      addIssue(blockers, issue("source_task_scope_id_ambiguous", `Source scope ${scope.id} is not unique.`, scope.span));
    } else scopeById.set(scope.id, scope);
  }
  const entries = scopes.filter((scope) => scope.kind === "entry_workflow" && scope.span.path === entrypoint);
  if (entries.length !== 1) {
    addIssue(blockers, issue(
      entries.length ? "source_task_entrypoint_ambiguous" : "source_task_entrypoint_missing",
      entries.length
        ? `Entrypoint ${entrypoint} has ${entries.length} entry workflow scopes.`
        : `Entrypoint ${entrypoint} has no indexed entry workflow scope.`,
      ...entries.map((entry) => entry.span),
    ));
    return { processScopes: [], invocationIdsByProcess: new Map() };
  }

  const byCaller = new Map<string, SourceInvocation[]>();
  for (const invocation of invocations) {
    const group = byCaller.get(invocation.caller) ?? [];
    group.push(invocation);
    byCaller.set(invocation.caller, group);
  }
  for (const group of byCaller.values()) group.sort((left, right) => compareSpans(left.span, right.span) || compareText(left.id, right.id));

  const visited = new Set<string>();
  const processScopes = new Map<string, SourceScope>();
  const invocationIdsByProcess = new Map<string, string[]>();
  const pending = [entries[0]!.id];
  let pendingIndex = 0;
  while (pendingIndex < pending.length) {
    const caller = pending[pendingIndex++]!;
    if (visited.has(caller)) continue;
    visited.add(caller);
    for (const invocation of byCaller.get(caller) ?? []) {
      if (!invocation.callee) {
        addIssue(blockers, issue(
          "source_task_reachable_invocation_unresolved",
          `Reachable invocation ${invocation.name} has no resolved local workflow or process declaration.`,
          invocation.span,
        ));
        continue;
      }
      const callee = scopeById.get(invocation.callee);
      if (!callee) {
        addIssue(blockers, issue(
          "source_task_reachable_callee_missing",
          `Reachable invocation ${invocation.name} refers to missing source scope ${invocation.callee}.`,
          invocation.span,
        ));
        continue;
      }
      if (callee.kind === "process") {
        processScopes.set(callee.id, callee);
        const ids = invocationIdsByProcess.get(callee.id) ?? [];
        ids.push(invocation.id);
        invocationIdsByProcess.set(callee.id, ids);
      } else pending.push(callee.id);
    }
  }
  return {
    processScopes: [...processScopes.values()].sort((left, right) => compareSpans(left.span, right.span) || compareText(left.id, right.id)),
    invocationIdsByProcess: new Map([...invocationIdsByProcess].map(([id, invocationIds]) => [id, [...invocationIds].sort(compareText)])),
  };
}

function withinEnvironmentIssues(environment: ResolvedTaskEnvironment) {
  const problems: TaskEnvironmentIssue[] = [];
  const channelSet = new Set(environment.channels);
  if (!environment.channels.length || channelSet.size !== environment.channels.length) problems.push(issue(
    "source_task_environment_channel_order_invalid",
    `Environment ${environment.reference} does not declare one non-empty unique channel order.`,
    ...environment.dependencies.slice(0, 1).map((dependency) => dependency.span),
  ));
  const absentChannels = [...new Set(environment.dependencies.flatMap((dependency) => (
    dependency.channel && !channelSet.has(dependency.channel) ? [dependency.channel] : []
  )))].sort(compareText);
  if (absentChannels.length) problems.push(issue(
    "source_task_environment_channel_absent",
    `Environment ${environment.reference} pins dependencies to channels absent from its own order: ${absentChannels.join(", ")}.`,
    ...environment.dependencies.filter((dependency) => (
      dependency.channel && absentChannels.includes(dependency.channel)
    )).map((dependency) => dependency.span),
  ));
  const dependenciesByName = new Map<string, CondaDependency[]>();
  for (const dependency of environment.dependencies) {
    const group = dependenciesByName.get(dependency.name) ?? [];
    group.push(dependency);
    dependenciesByName.set(dependency.name, group);
  }
  for (const [name, dependencies] of [...dependenciesByName].sort(([left], [right]) => compareText(left, right))) {
    const channels = [...new Set(dependencies.flatMap((entry) => entry.channel ? [entry.channel] : []))].sort(compareText);
    const exactVersions = [...new Set(dependencies.flatMap((entry) => entry.exact_version ? [entry.exact_version] : []))].sort(compareText);
    const exactBuilds = [...new Set(dependencies.flatMap((entry) => entry.exact_build ? [entry.exact_build] : []))].sort(compareText);
    const constrained = [...new Set(dependencies.map((entry) => entry.constraint).filter(Boolean))].sort(compareText);
    if (channels.length > 1) problems.push(issue(
      "source_task_environment_channel_conflict",
      `Environment ${environment.reference} pins ${name} to multiple explicit channels: ${channels.join(", ")}.`,
      ...dependencies.map((entry) => entry.span),
    ));
    if (exactVersions.length > 1) problems.push(issue(
      "source_task_environment_version_conflict",
      `Environment ${environment.reference} pins ${name} to conflicting exact versions: ${exactVersions.join(", ")}.`,
      ...dependencies.map((entry) => entry.span),
    ));
    if (exactVersions.length === 1 && exactBuilds.length > 1) problems.push(issue(
      "source_task_environment_build_conflict",
      `Environment ${environment.reference} pins ${name} ${exactVersions[0]} to conflicting builds: ${exactBuilds.join(", ")}.`,
      ...dependencies.map((entry) => entry.span),
    ));
    const nonExact = constrained.filter((constraint) => !dependencies.some((entry) => entry.constraint === constraint && entry.exact_version));
    if (nonExact.length > 1 || (nonExact.length > 0 && exactVersions.length > 0)) problems.push(issue(
      "source_task_environment_constraint_overlap_unproven",
      `Environment ${environment.reference} has ${name} constraints whose intersection has not been proven: ${constrained.join(", ")}.`,
      ...dependencies.map((entry) => entry.span),
    ));
  }
  return problems;
}

function dependencyProjection(dependency: CondaDependency): SourceTaskExecutionDependency {
  return {
    name: dependency.name,
    match_spec: dependency.match_spec,
    ...(dependency.channel ? { channel: dependency.channel } : {}),
    constraint: dependency.constraint,
    ...(dependency.exact_version ? { exact_version: dependency.exact_version } : {}),
    ...(dependency.exact_build ? { exact_build: dependency.exact_build } : {}),
  };
}

function environmentName(digest: string) {
  return `task-${digest.slice("blake3:".length)}`;
}

function fileTaskEnvironment(environment: CondaEnvironment): ResolvedTaskEnvironment {
  return {
    origin: "file",
    reference: environment.path,
    digest: environment.digest,
    channels: environment.channels,
    dependencies: environment.dependencies,
    problems: environment.problems,
  };
}

function directTaskEnvironment(
  declaration: TaskEnvironmentDeclaration,
  configChannels: readonly string[] | undefined,
): ResolvedTaskEnvironment | undefined {
  const dependencies = declaration.direct_dependencies;
  const provenance = declaration.expression_provenance;
  if (!dependencies?.length || !provenance) return undefined;
  const explicitChannels = [...new Set(dependencies.flatMap((dependency) => dependency.channel ? [dependency.channel] : []))];
  // A direct package's explicit channel identifies that package, not the
  // complete source set needed to solve its transitive dependencies. When the
  // frozen config declares an order, Nextflow supplies it to the whole direct
  // Conda expression, so preserve that complete order here as well.
  const channels = configChannels ? [...configChannels] : explicitChannels;
  return {
    origin: "direct",
    reference: `direct-conda:${provenance.digest}`,
    digest: canonicalJsonDigest({
      kind: "nextflow-direct-conda-expression",
      expression: declaration.expression,
      channels,
    }),
    channels,
    dependencies,
    problems: [],
  };
}

/**
 * Derive a deterministic, source-provenanced Pixi named-environment plan for
 * reachable Nextflow process declarations. This is planning evidence only: it
 * never claims that a manifest was generated, solved, installed, or executed.
 */
export function planSourceTaskExecution(
  files: readonly FrozenSourceFile[],
  entrypoint: string,
  options: TaskEnvironmentPlanningOptions = {},
): SourceTaskExecutionDecision {
  const manifest = buildSourceManifest(files);
  const outline = indexNextflowSource(files, entrypoint, manifest.source_digest);
  const inventory = planTaskEnvironments(files, entrypoint, options);
  return planAnalyzedSourceTaskExecution({
    entrypoint,
    source_digest: manifest.source_digest,
    outline,
    inventory,
  });
}

/** @internal Reuse already-validated immutable source analysis without repeating it. */
export function planAnalyzedSourceTaskExecution(
  analysis: SourceTaskExecutionAnalysis,
): SourceTaskExecutionDecision {
  const { entrypoint, source_digest: sourceDigest, outline, inventory } = analysis;
  const configChannelOrder = inventory.config_closure.conda_channel_order;
  const blockers = new Map<string, TaskEnvironmentIssue>();
  const reachable = reachableOutline(outline.scopes, outline.invocations, entrypoint, blockers);
  if (!reachable.processScopes.length) addIssue(blockers, issue(
    "source_task_no_reachable_processes",
    "The source entry workflow has no reachable process to assign to a frozen task environment.",
    { path: entrypoint, start_line: 1, end_line: 1 },
  ));

  for (const problem of inventory.configuration_issues) addIssue(blockers, problem);

  for (const declaration of inventory.declarations) {
    if (declaration.origin !== "config") continue;
    addIssue(blockers, issue(
      "source_task_config_override",
      `${declaration.kind} is assigned in ${declaration.span.path}; selector and profile precedence is not frozen.`,
      declaration.span,
    ));
  }

  const processesByKey = new Map<string, TaskEnvironmentProcess[]>();
  for (const process of inventory.processes) {
    const key = processKey(process.span.path, process.span.start_line, process.name);
    const group = processesByKey.get(key) ?? [];
    group.push(process);
    processesByKey.set(key, group);
  }
  const declarationsByProcess = new Map<string, TaskEnvironmentDeclaration[]>();
  for (const declaration of inventory.declarations) {
    if (declaration.origin !== "process" || !declaration.process_id) continue;
    const group = declarationsByProcess.get(declaration.process_id) ?? [];
    group.push(declaration);
    declarationsByProcess.set(declaration.process_id, group);
  }
  const environmentsByPath = new Map(inventory.conda_environments.map((environment) => [environment.path, environment]));
  const assignments: PendingAssignment[] = [];

  for (const scope of reachable.processScopes) {
    const name = scope.symbol ?? scope.title;
    const matches = processesByKey.get(processKey(scope.span.path, scope.span.start_line, name)) ?? [];
    if (matches.length !== 1) {
      addIssue(blockers, issue(
        matches.length ? "source_task_process_mapping_ambiguous" : "source_task_process_mapping_missing",
        matches.length
          ? `Reachable process scope ${name} matches ${matches.length} task-environment declarations.`
          : `Reachable process scope ${name} has no task-environment declaration identity.`,
        scope.span,
        ...matches.map((entry) => entry.span),
      ));
      continue;
    }
    const process = matches[0]!;
    const declarations = declarationsByProcess.get(process.id) ?? [];
    const external = declarations.filter((entry) => entry.kind === "spack" || entry.kind === "module");
    for (const declaration of external) addIssue(blockers, issue(
      "source_task_external_environment_unsupported",
      `${name} uses the unsupported ${declaration.kind} task environment.`,
      declaration.span,
    ));
    const conda = declarations.filter((entry) => entry.kind === "conda");
    if (conda.length !== 1) {
      addIssue(blockers, issue(
        conda.length ? "source_task_conda_mapping_ambiguous" : "source_task_conda_mapping_missing",
        conda.length
          ? `${name} has ${conda.length} process-level Conda declarations.`
          : `${name} has no process-level Conda declaration.`,
        ...(conda.length ? conda.map((entry) => entry.span) : [scope.span]),
      ));
      continue;
    }
    const declaration = conda[0]!;
    if (declaration.resolution === "dynamic") {
      addIssue(blockers, issue("source_task_conda_dynamic", `${name} selects its Conda environment dynamically.`, declaration.span));
      continue;
    }
    if (declaration.resolution !== "static" || !declaration.expression_provenance) {
      addIssue(blockers, issue(
        "source_task_conda_unsupported",
        `${name} does not use one bounded, source-relative Conda environment file or direct package literal.`,
        declaration.span,
      ));
      continue;
    }
    let environment: ResolvedTaskEnvironment | undefined;
    if (declaration.resolved_path) {
      const fileEnvironment = environmentsByPath.get(declaration.resolved_path);
      if (!fileEnvironment) {
        addIssue(blockers, issue(
          "source_task_environment_missing",
          `${name} references missing frozen environment ${declaration.resolved_path}.`,
          declaration.span,
        ));
        continue;
      }
      environment = fileTaskEnvironment(fileEnvironment);
      if (environment.problems.length) {
        for (const problem of environment.problems) addIssue(blockers, problem);
        continue;
      }
    } else {
      environment = directTaskEnvironment(declaration, configChannelOrder?.channels);
      if (!environment) {
        addIssue(blockers, issue(
          "source_task_conda_unsupported",
          `${name} has a direct Conda expression that is not a bounded package MatchSpec list.`,
          declaration.span,
        ));
        continue;
      }
      const unqualified = environment.dependencies.filter((dependency) => !dependency.channel);
      if (unqualified.length && !configChannelOrder) {
        for (const dependency of unqualified) addIssue(blockers, issue(
          "source_task_direct_conda_channel_unqualified",
          `${name} directly declares ${dependency.match_spec} without an explicit channel and the frozen config has no exact conda.channels order.`,
          dependency.span,
        ));
        continue;
      }
    }
    assignments.push({
      process,
      scope,
      invocationIds: reachable.invocationIdsByProcess.get(scope.id) ?? [],
      declaration,
      environment,
    });
  }

  const usedEnvironments = new Map<string, ResolvedTaskEnvironment>();
  for (const assignment of assignments) usedEnvironments.set(assignment.environment.digest, assignment.environment);
  for (const environment of usedEnvironments.values()) {
    for (const problem of withinEnvironmentIssues(environment)) addIssue(blockers, problem);
  }

  if (blockers.size) {
    return { status: "blocked", source_digest: sourceDigest, blockers: sortedIssues(blockers.values()) };
  }

  const sortedAssignments = [...assignments].sort((left, right) => compareSpans(left.scope.span, right.scope.span) || compareText(left.scope.id, right.scope.id));
  const namesByDigest = new Map([...usedEnvironments].map(([digest]) => [digest, environmentName(digest)]));
  const environmentGroups = new Map<string, PendingAssignment[]>();
  for (const assignment of sortedAssignments) {
    const group = environmentGroups.get(assignment.environment.digest) ?? [];
    group.push(assignment);
    environmentGroups.set(assignment.environment.digest, group);
  }
  const environments: SourceTaskExecutionEnvironment[] = [...environmentGroups].map(([digest, group]) => {
    const sameDigestPaths = [...new Set(group.map((assignment) => assignment.environment.reference))]
      .sort(compareText);
    const representative = group[0]!.environment;
    return {
      name: namesByDigest.get(digest)!,
      source_environment_digest: digest,
      source_paths: sameDigestPaths,
      channels: [...representative.channels],
      dependencies: representative.dependencies
        .map(dependencyProjection)
        .sort((left, right) => compareText(left.name, right.name) || compareText(left.match_spec, right.match_spec)),
      process_scope_ids: [...new Set(group.map((entry) => entry.scope.id))].sort(compareText),
      invocation_ids: [...new Set(group.flatMap((entry) => entry.invocationIds))].sort(compareText),
    };
  }).sort((left, right) => compareText(left.name, right.name));
  const projectedAssignments: SourceTaskExecutionAssignment[] = sortedAssignments.map((assignment) => ({
    process_id: assignment.process.id,
    process_scope_id: assignment.scope.id,
    process: assignment.process.name,
    span: assignment.scope.span,
    invocation_ids: [...assignment.invocationIds],
    environment: namesByDigest.get(assignment.environment.digest)!,
    source_environment_path: assignment.environment.reference,
    conda_expression: assignment.declaration.expression,
  }));
  const rewrites: SourceTaskExecutionRewrite[] = sortedAssignments.map((assignment) => ({
    path: assignment.declaration.span.path,
    start_byte: assignment.declaration.expression_provenance!.start_byte,
    end_byte: assignment.declaration.expression_provenance!.end_byte,
    expected_digest: assignment.declaration.expression_provenance!.digest,
    process_scope_id: assignment.scope.id,
    environment: namesByDigest.get(assignment.environment.digest)!,
  })).sort((left, right) => compareText(left.path, right.path) || left.start_byte - right.start_byte || compareText(left.process_scope_id, right.process_scope_id));
  const base: Omit<SourceTaskExecutionPlan, "plan_digest"> = {
    schema_version: 2 as const,
    planner_revision: SOURCE_TASK_EXECUTION_PLANNER_REVISION,
    source_digest: sourceDigest,
    entrypoint,
    config_closure: inventory.config_closure,
    nextflow_plugins: inventory.nextflow_plugins,
    environments,
    assignments: projectedAssignments,
    rewrites,
  };
  return {
    status: "candidate",
    plan: { ...base, plan_digest: canonicalJsonDigest(base) },
  };
}
