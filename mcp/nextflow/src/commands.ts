import type { WorkspaceBoundary } from "@somite/mcp-runtime";

export type ProjectTarget = { source: "local" | "remote"; project: string };
export type ParameterValue = string | number | boolean;

const REMOTE_PROJECT = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|https:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+)$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

function value(args: string[], name: string, item: string | number | undefined) {
  if (item !== undefined && item !== "") args.push(name, String(item));
}

function flag(args: string[], name: string, enabled: boolean | undefined) {
  if (enabled) args.push(name);
}

function repeated(args: string[], name: string, items: readonly string[] | undefined) {
  for (const item of items ?? []) args.push(name, item);
}

export function projectTarget(boundary: WorkspaceBoundary, input: ProjectTarget) {
  if (input.source === "local") return boundary.path(input.project);
  if (!REMOTE_PROJECT.test(input.project) || input.project.includes("@")) throw new Error("remote project must be owner/repository or a credential-free HTTPS URL");
  return input.project;
}

export function projectCommand(boundary: WorkspaceBoundary, input: { action: "list" } | (ProjectTarget & {
  action: "info" | "view" | "pull" | "clone" | "drop";
  revision?: string;
  destination?: string;
  list_files?: boolean;
})) {
  if (input.action === "list") return ["list"];
  if (input.source !== "remote") {
    throw new Error(`${input.action} requires a remote project identity`);
  }
  const target = projectTarget(boundary, input);
  if (input.action === "info") {
    if (input.revision) throw new Error("revision is not supported by nextflow info");
    return ["info", "-o", "json", target];
  }
  const args = [input.action, target];
  value(args, "-r", input.revision);
  flag(args, "-l", input.list_files && input.action === "view");
  if (input.action === "clone") {
    if (!input.destination) throw new Error("destination is required when cloning a project");
    args.push(boundary.path(input.destination));
  }
  return args;
}

export function analysisCommand(boundary: WorkspaceBoundary, input: ProjectTarget & {
  action: "lint" | "config" | "inspect" | "preview_dag";
  paths?: string[];
  profiles?: string[];
  params_file?: string;
  revision?: string;
  dag_file?: string;
  config_format?: "json" | "yaml" | "flat" | "canonical" | "properties";
}) {
  const target = projectTarget(boundary, input);
  if (input.action === "lint") {
    const project = input.source === "local" ? target : boundary.root;
    const args = ["lint", "-o", "json", "-project-dir", project];
    const paths = input.paths?.length ? input.paths.map((path) => boundary.path(path)) : [project];
    args.push(...paths);
    return args;
  }
  if (input.action === "config") {
    const args = ["config", "-o", input.config_format ?? "json", target];
    value(args, "-profile", input.profiles?.join(","));
    value(args, "-r", input.revision);
    return args;
  }
  if (input.action === "inspect") {
    const args = ["inspect", "-format", "json", target];
    value(args, "-profile", input.profiles?.join(","));
    value(args, "-params-file", input.params_file ? boundary.path(input.params_file) : undefined);
    value(args, "-r", input.revision);
    return args;
  }
  return runCommand(boundary, {
    ...input,
    mode: "preview",
    dag_file: input.dag_file ?? ".somite/evidence/preview-dag.html",
  });
}

export function runCommand(boundary: WorkspaceBoundary, input: ProjectTarget & {
  mode: "preview" | "stub" | "fixture" | "full";
  revision?: string;
  profiles?: string[];
  params_file?: string;
  parameters?: Record<string, ParameterValue>;
  entry?: string;
  run_name?: string;
  resume?: boolean;
  offline?: boolean;
  output_dir?: string;
  work_dir?: string;
  dag_file?: string;
  trace_file?: string;
  report_file?: string;
  timeline_file?: string;
  container_runtime?: "docker" | "podman" | "apptainer" | "singularity" | "charliecloud";
}) {
  if (input.mode === "fixture"
    && !input.params_file
    && !Object.keys(input.parameters ?? {}).length
    && !input.profiles?.some((profile) => profile === "test" || profile === "test_full")) {
    throw new Error("fixture run requires explicit fixture parameters, a params file, or a test/test_full profile");
  }
  const args = ["run", projectTarget(boundary, input), "-ansi-log", "false"];
  if (input.mode === "preview") args.push("-preview");
  if (input.mode === "stub") args.push("-stub-run");
  value(args, "-r", input.revision);
  value(args, "-profile", input.profiles?.join(","));
  value(args, "-params-file", input.params_file ? boundary.path(input.params_file) : undefined);
  value(args, "-entry", input.entry);
  value(args, "-name", input.run_name);
  flag(args, "-resume", input.resume);
  flag(args, "-offline", input.offline);
  value(args, "-output-dir", input.output_dir ? boundary.path(input.output_dir) : undefined);
  value(args, "-work-dir", input.work_dir ? boundary.path(input.work_dir) : undefined);
  value(args, "-with-dag", input.dag_file ? boundary.path(input.dag_file) : undefined);
  value(args, "-with-trace", input.trace_file ? boundary.path(input.trace_file) : undefined);
  value(args, "-with-report", input.report_file ? boundary.path(input.report_file) : undefined);
  value(args, "-with-timeline", input.timeline_file ? boundary.path(input.timeline_file) : undefined);
  if (input.container_runtime) args.push(`-with-${input.container_runtime}`);
  for (const [name, item] of Object.entries(input.parameters ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (!IDENTIFIER.test(name)) throw new Error(`invalid pipeline parameter name: ${name}`);
    args.push(`--${name}`, String(item));
  }
  return args;
}

export function moduleCommand(boundary: WorkspaceBoundary, input: {
  action: "search" | "view" | "list" | "install" | "remove" | "validate" | "spec" | "publish_preview" | "run";
  module?: string;
  query?: string;
  version?: string;
  limit?: number;
  path?: string;
  force?: boolean;
  keep_files?: boolean;
  parameters?: Record<string, ParameterValue>;
  namespace?: string;
}) {
  if (input.action === "search") {
    if (!input.query?.trim()) throw new Error("query is required for module search");
    return ["module", "search", "-o", "json", "-limit", String(input.limit ?? 20), input.query];
  }
  if (input.action === "list") return ["module", "list", "-o", "json"];
  const target = input.path ? boundary.path(input.path) : input.module;
  if (!target) throw new Error("module or path is required for this module action");
  if (input.action === "view") {
    const args = ["module", "view", "-o", "json"];
    value(args, "-version", input.version);
    args.push(target);
    return args;
  }
  if (input.action === "install") {
    const args = ["module", "install"];
    value(args, "-version", input.version);
    flag(args, "-force", input.force);
    args.push(target);
    return args;
  }
  if (input.action === "remove") {
    const args = ["module", "remove"];
    flag(args, "-force", input.force);
    flag(args, "-keep-files", input.keep_files);
    args.push(target);
    return args;
  }
  if (input.action === "validate") return ["module", "validate", target];
  if (input.action === "spec") {
    if (input.path && !input.namespace) throw new Error("namespace is required when generating a spec from a local module path");
    const args = ["module", "spec", "-dry-run"];
    value(args, "-namespace", input.namespace);
    args.push(target);
    return args;
  }
  if (input.action === "publish_preview") return ["module", "publish", "-dry-run", target];
  const args = ["module", "run", target, "-ansi-log", "false"];
  value(args, "-version", input.version);
  for (const [name, item] of Object.entries(input.parameters ?? {})) {
    if (!IDENTIFIER.test(name)) throw new Error(`invalid module parameter name: ${name}`);
    args.push(`--${name}`, String(item));
  }
  return args;
}

export function historyCommand(boundary: WorkspaceBoundary, input: {
  action: "runs" | "tasks" | "lineage_list" | "lineage_view" | "lineage_find" | "lineage_check" | "lineage_diff" | "lineage_render";
  run?: string;
  fields?: string[];
  query?: string;
  lineage_ids?: string[];
  output_file?: string;
}) {
  if (input.action === "runs") return ["log", "-q"];
  if (input.action === "tasks") {
    const args = ["log", input.run ?? "last"];
    if (input.fields?.length) args.push("-f", input.fields.join(","));
    return args;
  }
  const action = input.action.replace("lineage_", "");
  const args = ["lineage", action];
  const ids = input.lineage_ids ?? [];
  if (action === "find") {
    if (!input.query) throw new Error("query is required for lineage find");
    args.push(input.query);
  } else if (action === "list") {
    if (ids.length) throw new Error("lineage list does not accept lineage IDs");
  } else {
    const expected = action === "diff" ? 2 : 1;
    if (ids.length !== expected) throw new Error(`lineage ${action} requires exactly ${expected} lineage ID${expected === 1 ? "" : "s"}`);
    args.push(...ids);
  }
  if (action === "render" && input.output_file) args.push(boundary.path(input.output_file));
  return args;
}

function storageValue(boundary: WorkspaceBoundary, value: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const uri = new URL(value);
    if (uri.username || uri.password) throw new Error("storage URIs may not contain credentials");
    return value;
  }
  return boundary.path(value);
}

export function storageCommand(boundary: WorkspaceBoundary, input: {
  action: "list" | "stat" | "cat" | "copy" | "move" | "remove";
  source: string;
  destination?: string;
}) {
  const operations = { list: "ls", stat: "stat", cat: "cat", copy: "cp", move: "mv", remove: "rm" } as const;
  const args = ["fs", operations[input.action], storageValue(boundary, input.source)];
  if (input.action === "copy" || input.action === "move") {
    if (!input.destination) throw new Error("destination is required for copy or move");
    args.push(storageValue(boundary, input.destination));
  }
  return args;
}

export function maintenanceCommand(input: {
  action: "clean_preview" | "clean";
  run?: string;
  before?: string;
  after?: string;
  keep_logs?: boolean;
}) {
  const args = ["clean"];
  if (input.run) args.push(input.run);
  value(args, "-before", input.before);
  value(args, "-after", input.after);
  flag(args, "-keep-logs", input.keep_logs);
  args.push(input.action === "clean_preview" ? "-n" : "-f");
  return args;
}

export function platformCommand(boundary: WorkspaceBoundary, input: ProjectTarget & {
  action: "auth_status" | "auth_logout" | "launch" | "secrets_list" | "secrets_delete";
  workspace?: string;
  compute_environment?: string;
  revision?: string;
  profiles?: string[];
  params_file?: string;
  run_name?: string;
  secret_name?: string;
}) {
  if (input.action.startsWith("auth_")) return ["auth", input.action.slice("auth_".length)];
  if (input.action.startsWith("secrets_")) {
    const action = input.action.slice("secrets_".length);
    const args = ["secrets", action];
    if (action !== "list") {
      if (!input.secret_name) throw new Error("secret_name is required");
      args.push(input.secret_name);
    }
    return args;
  }
  const args = ["launch", projectTarget(boundary, input)];
  value(args, "-workspace", input.workspace);
  value(args, "-compute-env", input.compute_environment);
  value(args, "-r", input.revision);
  value(args, "-profile", input.profiles?.join(","));
  value(args, "-params-file", input.params_file ? boundary.path(input.params_file) : undefined);
  value(args, "-name", input.run_name);
  return args;
}

export function pluginCommand(input: { action: "install"; plugin: string }) {
  return ["plugin", "install", input.plugin];
}
