import type { WorkspaceBoundary } from "@somite/mcp-runtime";

export const PIXI_PINNING_STRATEGIES = ["semver", "minor", "major", "latest-up", "exact-version", "no-pin"] as const;

type ManifestInput = { manifest_path?: string };

function manifest(boundary: WorkspaceBoundary, input: ManifestInput) {
  return ["--manifest-path", boundary.path(input.manifest_path ?? ".")];
}

function flag(args: string[], name: string, enabled: boolean | undefined) {
  if (enabled) args.push(name);
}

function value(args: string[], name: string, item: string | number | undefined) {
  if (item !== undefined && item !== "") args.push(name, String(item));
}

function repeated(args: string[], name: string, items: readonly string[] | undefined) {
  for (const item of items ?? []) args.push(name, item);
}

export function inspectCommand(boundary: WorkspaceBoundary, input: ManifestInput & {
  view: "workspace" | "packages" | "tasks" | "dependency_tree" | "activation" | "config" | "global";
  environment?: string;
  platform?: string;
  package_filter?: string;
  invert?: boolean;
}) {
  if (input.view === "workspace") return ["info", "--json", "--extended", ...manifest(boundary, input)];
  if (input.view === "packages") {
    const args = ["list", "--json", ...manifest(boundary, input)];
    value(args, "--environment", input.environment);
    value(args, "--platform", input.platform);
    if (input.package_filter) args.push(input.package_filter);
    return args;
  }
  if (input.view === "tasks") {
    const args = ["task", "list", "--json", ...manifest(boundary, input)];
    value(args, "--environment", input.environment);
    return args;
  }
  if (input.view === "dependency_tree") {
    const args = ["tree", ...manifest(boundary, input)];
    value(args, "--environment", input.environment);
    value(args, "--platform", input.platform);
    flag(args, "--invert", input.invert);
    if (input.package_filter) args.push(input.package_filter);
    return args;
  }
  if (input.view === "activation") return ["workspace", "activation", "list", ...manifest(boundary, input)];
  if (input.view === "config") return ["config", "list", "--json", ...manifest(boundary, input)];
  return ["global", "list", "--json"];
}

export function searchCommand(input: { spec: string; channels?: string[]; platform?: string; limit?: number }) {
  const args = ["search", "--json"];
  repeated(args, "--channel", input.channels);
  value(args, "--platform", input.platform);
  args.push(input.spec);
  return args;
}

export type PixiPackageRecord = {
  name: string;
  version: string;
  build: string;
  build_number: number;
  subdir: string;
  channel: string;
  url: string;
  license?: string;
  size?: number;
  timestamp?: number;
  depends: string[];
};

function packageRecord(value: unknown): PixiPackageRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== "string" || typeof record.version !== "string" || typeof record.build !== "string"
    || typeof record.build_number !== "number" || typeof record.subdir !== "string"
    || typeof record.channel !== "string" || typeof record.url !== "string"
  ) return undefined;
  return {
    name: record.name,
    version: record.version,
    build: record.build,
    build_number: record.build_number,
    subdir: record.subdir,
    channel: record.channel,
    url: record.url,
    ...(typeof record.license === "string" ? { license: record.license } : {}),
    ...(typeof record.size === "number" ? { size: record.size } : {}),
    ...(typeof record.timestamp === "number" ? { timestamp: record.timestamp } : {}),
    depends: Array.isArray(record.depends) ? record.depends.filter((item): item is string => typeof item === "string") : [],
  };
}

/** Reduce Pixi's complete JSON registry response before returning it to an agent. */
export function compactSearchResult(stdout: string, limit: number) {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pixi package search returned an unexpected JSON shape");
  const records = Object.values(parsed).flatMap((value) => Array.isArray(value) ? value : []).map(packageRecord).filter((value): value is PixiPackageRecord => Boolean(value));
  return { total_records: records.length, matches: records.slice(0, limit) };
}

export function dependencyCommand(boundary: WorkspaceBoundary, input: ManifestInput & {
  action: "add" | "remove" | "update" | "upgrade";
  packages: string[];
  source?: "conda" | "pypi";
  feature?: string;
  environment?: string;
  platform?: string;
  editable?: boolean;
  index?: string;
  dry_run?: boolean;
  install?: boolean;
}) {
  if (input.action === "update" && input.feature) throw new Error("feature is not supported by pixi update");
  if (input.action === "upgrade" && input.platform) throw new Error("platform is not supported by pixi upgrade");
  if (input.action === "add" && input.source !== "pypi" && (input.editable || input.index)) {
    throw new Error("editable and index apply only to PyPI dependencies");
  }
  const args = [input.action, ...manifest(boundary, input)];
  if (input.action !== "update") value(args, "--feature", input.feature);
  value(args, "--environment", input.environment);
  if (input.action !== "upgrade") value(args, "--platform", input.platform);
  if ((input.action === "add" || input.action === "remove") && input.source === "pypi") args.push("--pypi");
  if (input.action === "add") {
    flag(args, "--editable", input.editable);
    value(args, "--index", input.index);
  }
  if (input.action === "update" || input.action === "upgrade") flag(args, "--dry-run", input.dry_run);
  flag(args, "--no-install", !input.install);
  args.push(...input.packages);
  return args;
}

export function lockCommand(boundary: WorkspaceBoundary, input: ManifestInput & {
  action: "check" | "preview" | "resolve";
}) {
  const args = ["lock", ...manifest(boundary, input)];
  if (input.action === "check") args.push("--check");
  if (input.action === "preview") args.push("--dry-run", "--json");
  if (input.action === "resolve") args.push("--json");
  return args;
}

export function environmentCommand(boundary: WorkspaceBoundary, input: ManifestInput & {
  action: "install" | "reinstall" | "clean" | "activation_environment";
  environment?: string;
  all?: boolean;
  frozen?: boolean;
  locked?: boolean;
}) {
  if (input.action === "activation_environment") {
    const args = ["shell-hook", "--json", ...manifest(boundary, input)];
    value(args, "--environment", input.environment);
    return args;
  }
  const args = [input.action === "clean" ? "clean" : input.action, ...manifest(boundary, input)];
  value(args, "--environment", input.environment);
  flag(args, "--all", input.all && input.action !== "clean");
  flag(args, "--frozen", input.frozen && input.action !== "clean");
  flag(args, "--locked", input.locked && input.action !== "clean");
  return args;
}

export function taskCommand(boundary: WorkspaceBoundary, input: ManifestInput & {
  action: "list" | "add" | "remove" | "alias" | "run";
  name?: string;
  command?: string;
  dependencies?: string[];
  environment?: string;
  arguments?: string[];
}) {
  if (input.action === "list") return inspectCommand(boundary, { ...input, view: "tasks" });
  if (!input.name) throw new Error("name is required for this task action");
  if (input.action === "run") {
    const args = ["run", "--frozen", "--clean-env", ...manifest(boundary, input)];
    value(args, "--environment", input.environment);
    args.push(input.name, ...(input.arguments ?? []));
    return args;
  }
  if (input.action === "remove") {
    const args = ["task", "remove", ...manifest(boundary, input)];
    value(args, "--environment", input.environment);
    args.push(input.name);
    return args;
  }
  if (input.action === "alias") {
    if (!input.dependencies?.length) throw new Error("dependencies are required when creating an alias");
    const args = ["task", "alias", ...manifest(boundary, input)];
    value(args, "--environment", input.environment);
    args.push(input.name, ...input.dependencies);
    return args;
  }
  if (!input.command) throw new Error("command is required when adding a task");
  const args = ["task", "add", ...manifest(boundary, input)];
  value(args, "--environment", input.environment);
  args.push(input.name, input.command);
  return args;
}

export function workspaceCommand(boundary: WorkspaceBoundary, input: ManifestInput & {
  action: "init" | "import" | "export_conda" | "export_explicit" | "platform_add" | "platform_remove" | "environment_add" | "environment_remove" | "channel_add" | "channel_remove";
  path?: string;
  name?: string;
  values?: string[];
  environment?: string;
  feature?: string;
  platforms?: string[];
  channels?: string[];
  format?: "conda-env" | "pypi-txt";
  pinned?: boolean;
  install?: boolean;
}) {
  if (input.action === "init") {
    const args = ["init"];
    repeated(args, "--channel", input.channels);
    repeated(args, "--platform", input.platforms);
    args.push(boundary.path(input.path ?? "."));
    return args;
  }
  if (input.action === "import") {
    if (!input.path || !input.format) throw new Error("path and format are required for import");
    const args = ["import", "--format", input.format, ...manifest(boundary, input)];
    value(args, "--environment", input.environment);
    value(args, "--feature", input.feature);
    repeated(args, "--platform", input.platforms);
    args.push(boundary.path(input.path));
    return args;
  }
  if (input.action === "export_conda" || input.action === "export_explicit") {
    const kind = input.action === "export_conda" ? "conda-environment" : "conda-explicit-spec";
    const args = ["workspace", "export", kind, ...manifest(boundary, input)];
    value(args, "--environment", input.environment);
    if (input.action === "export_conda") flag(args, "--from-lock-file", input.pinned);
    if (input.action === "export_explicit" && !input.path) throw new Error("output directory is required for an explicit specification export");
    if (input.path) args.push(boundary.path(input.path));
    return args;
  }
  const [noun, verb] = input.action.split("_") as [string, string];
  const entries = input.values ?? (input.name ? [input.name] : []);
  if (!entries.length) throw new Error("name or values is required for this workspace action");
  const args = ["workspace", noun, verb, ...manifest(boundary, input)];
  if (noun === "platform" || noun === "channel") {
    value(args, "--environment", input.environment);
    value(args, "--feature", input.feature);
    flag(args, "--no-install", !input.install);
  } else if (noun === "environment" && verb === "add") {
    value(args, "--feature", input.feature);
  }
  args.push(...entries);
  return args;
}

export function globalCommand(input: {
  action: "list" | "install" | "add" | "remove" | "uninstall" | "update" | "sync" | "tree" | "expose_add" | "expose_remove";
  packages?: string[];
  environment?: string;
  exposed_name?: string;
  executable?: string;
}) {
  if (input.action === "list") return ["global", "list", "--json"];
  if (input.action === "sync") return ["global", "sync"];
  if (input.action === "tree") {
    if (!input.environment) throw new Error("environment is required for a global dependency tree");
    return ["global", "tree", "--environment", input.environment];
  }
  if (input.action === "expose_add") {
    if (!input.environment || !input.exposed_name || !input.executable) throw new Error("environment, exposed_name, and executable are required");
    return ["global", "expose", "add", "--environment", input.environment, `${input.exposed_name}=${input.executable}`];
  }
  if (input.action === "expose_remove") {
    if (!input.exposed_name) throw new Error("exposed_name is required");
    return ["global", "expose", "remove", input.exposed_name];
  }
  if (input.action === "add" || input.action === "remove") {
    if (!input.environment) throw new Error(`environment is required for global ${input.action}`);
    if (!input.packages?.length) throw new Error(`packages are required for global ${input.action}`);
    return ["global", input.action, "--environment", input.environment, ...input.packages];
  }
  if (input.action === "install") {
    if (!input.packages?.length) throw new Error("packages are required for global install");
    const args = ["global", "install"];
    value(args, "--environment", input.environment);
    args.push(...input.packages);
    return args;
  }
  const environments = input.packages ?? (input.environment ? [input.environment] : []);
  if (input.action === "uninstall" && !environments.length) throw new Error("environments are required for global uninstall");
  return ["global", input.action, ...environments];
}
