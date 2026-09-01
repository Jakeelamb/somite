import { byteDigest } from "./contentIdentity.ts";
import {
  extractNextflowConfigScalarDefaults,
  resolveNextflowConfigExpression,
  type NextflowConfigScalar,
} from "./nextflowConfigExpression.ts";
import {
  safeSourcePath,
  tokenizeNextflow,
  type FrozenSourceFile,
} from "./nextflowSource.ts";
import type { SourceSpan } from "./model.ts";

export const MAX_TASK_ENVIRONMENT_FILE_BYTES = 1024 * 1024;
const MAX_TASK_ENVIRONMENT_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_TASK_ENVIRONMENT_PROCESSES = 25_000;
const MAX_TASK_ENVIRONMENT_DECLARATIONS = 25_000;
const MAX_TASK_ENVIRONMENT_DEPENDENCIES = 100_000;
const MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES = 16 * 1024;
const MAX_TASK_ENVIRONMENT_CONFIGURATION_ISSUES = 25_000;
const MAX_TASK_ENVIRONMENT_PLUGIN_DECLARATIONS = 1_024;
export const MAX_NEXTFLOW_PLUGIN_REQUIREMENTS = 64;
export const MAX_NEXTFLOW_CONDA_CHANNELS = 64;

export type TaskEnvironmentProcess = Readonly<{
  id: string;
  name: string;
  span: SourceSpan;
}>;

export type TaskEnvironmentDeclaration = Readonly<{
  kind: "conda" | "container" | "spack" | "module";
  origin: "process" | "config";
  resolution: "static" | "dynamic" | "unsupported" | "missing";
  expression: string;
  span: SourceSpan;
  process_id?: string;
  process?: string;
  resolved_path?: string;
  direct_dependencies?: readonly CondaDependency[];
  candidates?: readonly string[];
  expression_provenance?: Readonly<{
    start_byte: number;
    end_byte: number;
    digest: string;
  }>;
}>;

export type CondaDependency = Readonly<{
  name: string;
  match_spec: string;
  channel?: string;
  constraint: string;
  exact_version?: string;
  exact_build?: string;
  span: SourceSpan;
}>;

export type CondaEnvironment = Readonly<{
  path: string;
  digest: string;
  channels: readonly string[];
  dependencies: readonly CondaDependency[];
  problems: readonly TaskEnvironmentIssue[];
  referenced_by: readonly Readonly<{
    process_id: string;
    process: string;
    span: SourceSpan;
  }>[];
}>;

export type TaskEnvironmentIssue = Readonly<{
  code: string;
  message: string;
  spans: readonly SourceSpan[];
}>;

export type NextflowPluginRequirement = Readonly<{
  name: string;
  version: string;
  requirement: string;
  spans: readonly SourceSpan[];
}>;

export type NextflowConfigIncludeResolution = Readonly<{
  expression: string;
  span: SourceSpan;
  status: "source" | "ignored" | "unresolved" | "missing" | "external";
  resolved_path?: string;
  reason?: string;
  parameters: readonly Readonly<{ name: string; value: NextflowConfigScalar }>[];
  environment: readonly Readonly<{ name: string; value?: string }>[];
}>;

export type NextflowCondaChannelOrder = Readonly<{
  channels: readonly string[];
  origin: "top_level" | "profile";
  profile?: "conda";
  span: SourceSpan;
  expression_provenance: Readonly<{
    start_byte: number;
    end_byte: number;
    digest: string;
  }>;
}>;

export type NextflowCondaProfileProvenance = Readonly<{
  name: "conda";
  blocks: readonly Readonly<{
    span: SourceSpan;
    digest: string;
  }>[];
}>;

export type NextflowConfigClosure = Readonly<{
  paths: readonly string[];
  includes: readonly NextflowConfigIncludeResolution[];
  conda_channel_order?: NextflowCondaChannelOrder;
  conda_profile?: NextflowCondaProfileProvenance;
}>;

export type TaskEnvironmentPlanningOptions = Readonly<{
  parameters?: Readonly<Record<string, NextflowConfigScalar>>;
}>;

export type PixiClosureDependency = Readonly<{
  name: string;
  match_spec: string;
  sources: readonly Readonly<{
    match_spec: string;
    span: SourceSpan;
  }>[];
}>;

export type TaskEnvironmentPlan = Readonly<{
  schema_version: 1;
  processes: readonly TaskEnvironmentProcess[];
  covered_processes: number;
  declarations: readonly TaskEnvironmentDeclaration[];
  configuration_issues: readonly TaskEnvironmentIssue[];
  config_closure: NextflowConfigClosure;
  nextflow_plugins: readonly NextflowPluginRequirement[];
  conda_environments: readonly CondaEnvironment[];
  pixi_closure: Readonly<{
    status: "candidate" | "blocked";
    channels: readonly string[];
    dependencies: readonly PixiClosureDependency[];
    blockers: readonly TaskEnvironmentIssue[];
  }>;
}>;

type NextflowToken = ReturnType<typeof tokenizeNextflow>[number];
type MutableEnvironment = {
  path: string;
  digest: string;
  channels: string[];
  dependencies: CondaDependency[];
  problems: TaskEnvironmentIssue[];
  complete: boolean;
  referenced_by: Array<{
    process_id: string;
    process: string;
    span: SourceSpan;
  }>;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tokenText(bytes: Uint8Array, token: NextflowToken) {
  return decoder.decode(bytes.subarray(token.start, token.end));
}

function issue(code: string, message: string, ...spans: SourceSpan[]): TaskEnvironmentIssue {
  return { code, message, spans };
}

function processId(path: string, line: number, name: string) {
  return `${path}:${line}:${name}`;
}

function bracePairs(tokens: readonly NextflowToken[]) {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]!.kind === "left_brace") stack.push(index);
    else if (tokens[index]!.kind === "right_brace") {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, index);
    }
  }
  return pairs;
}

function sourceLineRemainder(bytes: Uint8Array, offset: number) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 10) end += 1;
  return decoder.decode(bytes.subarray(offset, end)).split(";", 1)[0]!.trim();
}

function expressionAfter(
  bytes: Uint8Array,
  tokens: readonly NextflowToken[],
  directiveIndex: number,
): Readonly<{
  expression: string;
  endLine: number;
  stringLiteral: boolean;
  provenance?: Readonly<{ start_byte: number; end_byte: number; digest: string }>;
}> | undefined {
  const directive = tokens[directiveIndex]!;
  let valueIndex = directiveIndex + 1;
  if (tokens[valueIndex]?.kind === "left_paren") valueIndex += 1;
  const value = tokens[valueIndex];
  if (!value) return undefined;
  const gap = decoder.decode(bytes.subarray(directive.end, value.offset));
  if (!/^\s*\(?\s*$/.test(gap)) return undefined;
  if (value.kind === "string") {
    const expression = tokenText(bytes, value);
    if (new TextEncoder().encode(expression).byteLength > MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES) {
      throw new Error(`task environment expression at line ${directive.line} exceeds ${MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES} bytes`);
    }
    return {
      expression,
      endLine: value.endLine,
      stringLiteral: true,
      provenance: {
        start_byte: value.start,
        end_byte: value.end,
        digest: byteDigest(bytes.subarray(value.start, value.end)),
      },
    };
  }
  const expression = sourceLineRemainder(bytes, directive.end);
  if (!expression) return undefined;
  if (new TextEncoder().encode(expression).byteLength > MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES) {
    throw new Error(`task environment expression at line ${directive.line} exceeds ${MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES} bytes`);
  }
  return { expression, endLine: directive.line, stringLiteral: false };
}

function containerCandidates(expression: string) {
  const candidates = new Set<string>();
  for (const match of expression.matchAll(/(['"])([\s\S]*?)\1/g)) {
    const value = match[2]!.trim();
    if (/^(?:https?:\/\/|docker:\/\/|oras:\/\/|shub:\/\/)/.test(value)
      || (value.includes("/") && /(?::[^/]+|@sha256:[a-f0-9]+)$/i.test(value))) candidates.add(value);
  }
  return [...candidates].sort(compareText);
}

function classifyContainer(expression: string, stringLiteral: boolean) {
  const dynamic = !stringLiteral || /\$\{|\$[A-Za-z_]|\?|\b(?:workflow|task|params)\./.test(expression);
  const candidates = dynamic ? containerCandidates(expression) : [];
  return {
    resolution: dynamic ? "dynamic" as const : "static" as const,
    ...(candidates.length ? { candidates } : {}),
  };
}

function normalizePath(base: readonly string[], relative: string) {
  const parts = [...base];
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) return undefined;
    } else parts.push(part);
  }
  const resolved = parts.join("/");
  return safeSourcePath(resolved) ? resolved : undefined;
}

function condaEnvironmentPath(sourcePath: string, expression: string) {
  const modulePrefixes = ["${moduleDir}/", "$moduleDir/"];
  const projectPrefixes = ["${projectDir}/", "$projectDir/"];
  for (const prefix of modulePrefixes) {
    if (expression.startsWith(prefix)) {
      const relative = expression.slice(prefix.length);
      if (/\$|\{|\}/.test(relative)) return { kind: "dynamic" as const };
      return { kind: "path" as const, path: normalizePath(sourcePath.split("/").slice(0, -1), relative) };
    }
  }
  for (const prefix of projectPrefixes) {
    if (expression.startsWith(prefix)) {
      const relative = expression.slice(prefix.length);
      if (/\$|\{|\}/.test(relative)) return { kind: "dynamic" as const };
      return { kind: "path" as const, path: normalizePath([], relative) };
    }
  }
  if (/\$\{|\$[A-Za-z_]|\b(?:params|task|workflow)\./.test(expression)) return { kind: "dynamic" as const };
  if (/^(?:\/|~\/|https?:\/\/)/.test(expression) || /\.txt$/i.test(expression)) return { kind: "unsupported" as const };
  if (/\.ya?ml$/i.test(expression)) {
    // Bare relative paths are resolved by launch context in some Nextflow
    // configurations. Only moduleDir/projectDir references are frozen here.
    return { kind: "unsupported" as const };
  }
  return { kind: "packages" as const };
}

function unquoteYamlScalar(value: string) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === "'" || quote === '"') && trimmed.at(-1) === quote) {
    const inner = trimmed.slice(1, -1);
    if (quote === "'" ? inner.includes("'") : inner.includes('"') || inner.includes("\\")) return undefined;
    return inner;
  }
  if (!trimmed || /^[\[\]{}&*!|>]/.test(trimmed)) return undefined;
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseMatchSpec(value: string, span: SourceSpan): CondaDependency | undefined {
  const scalar = unquoteYamlScalar(value);
  if (!scalar || /\s/.test(scalar)) return undefined;
  const match = /^(?:([A-Za-z0-9_.-]+)::)?([A-Za-z0-9_.-]+)(.*)$/.exec(scalar);
  if (!match) return undefined;
  const channel = match[1];
  const name = match[2]!.toLocaleLowerCase("en-US");
  const constraint = match[3] ?? "";
  if (constraint && !/^(?:[=<>!~]|\d)[A-Za-z0-9_.+*<>=!~|,-]*$/.test(constraint)) return undefined;
  const exact = /^(?:==|=)([^=<>!~|,*]+)(?:=([A-Za-z0-9_.+*-]+))?$/.exec(constraint);
  return {
    name,
    match_spec: `${channel ? `${channel}::` : ""}${name}${constraint}`,
    ...(channel ? { channel } : {}),
    constraint,
    ...(exact ? { exact_version: exact[1] } : {}),
    ...(exact?.[2] ? { exact_build: exact[2] } : {}),
    span,
  };
}

function directDependencies(expression: string, span: SourceSpan) {
  const dependencies: CondaDependency[] = [];
  for (const spec of expression.trim().split(/\s+/)) {
    const dependency = parseMatchSpec(spec, span);
    if (!dependency) return undefined;
    dependencies.push(dependency);
  }
  return dependencies.length ? dependencies : undefined;
}

function parseInlineList(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  const items: string[] = [];
  for (const part of body.split(",")) {
    const item = unquoteYamlScalar(part);
    if (!item) return undefined;
    items.push(item);
  }
  return items;
}

function parseCondaEnvironment(file: FrozenSourceFile): Readonly<{
  channels: string[];
  dependencies: CondaDependency[];
  problems: TaskEnvironmentIssue[];
}> {
  if (file.bytes.byteLength > MAX_TASK_ENVIRONMENT_FILE_BYTES) {
    throw new Error(`task environment ${file.path} exceeds ${MAX_TASK_ENVIRONMENT_FILE_BYTES} bytes`);
  }
  let source: string;
  try {
    source = decoder.decode(file.bytes);
  } catch {
    return {
      channels: [],
      dependencies: [],
      problems: [issue("conda_environment_not_utf8", `Conda environment ${file.path} is not UTF-8.`, { path: file.path, start_line: 1, end_line: 1 })],
    };
  }
  const channels: string[] = [];
  const dependencies: CondaDependency[] = [];
  const problems: TaskEnvironmentIssue[] = [];
  let section: "channels" | "dependencies" | undefined;
  let documentStarted = false;
  let documentEnded = false;
  let contentSeen = false;
  const topLevelKeys = new Set<string>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const span = { path: file.path, start_line: index + 1, end_line: index + 1 };
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const trimmed = raw.trim();
    if (trimmed === "---") {
      if (documentStarted || documentEnded || contentSeen || raw !== trimmed) {
        problems.push(issue("conda_environment_unsupported_yaml", `Conda environment ${file.path} contains a misplaced YAML document-start marker.`, span));
      } else {
        documentStarted = true;
        section = undefined;
      }
      continue;
    }
    if (trimmed === "...") {
      if (documentEnded || !contentSeen || raw !== trimmed) {
        problems.push(issue("conda_environment_unsupported_yaml", `Conda environment ${file.path} contains a misplaced YAML document-end marker.`, span));
      } else {
        documentEnded = true;
        section = undefined;
      }
      continue;
    }
    if (documentEnded) {
      problems.push(issue("conda_environment_unsupported_yaml", `Conda environment ${file.path} contains content after its YAML document-end marker.`, span));
      continue;
    }
    contentSeen = true;
    if (raw.includes("\t")) {
      problems.push(issue("conda_environment_unsupported_yaml", `Conda environment ${file.path} uses tab indentation, which the bounded planner does not interpret.`, span));
      continue;
    }
    const topLevel = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(raw);
    if (topLevel) {
      const key = topLevel[1]!.toLocaleLowerCase("en-US");
      const value = (topLevel[2] ?? "").trim();
      section = key === "channels" || key === "dependencies" ? key : undefined;
      if (topLevelKeys.has(key)) {
        problems.push(issue("conda_environment_duplicate_key", `Conda environment ${file.path} repeats top-level key ${key}.`, span));
        continue;
      }
      topLevelKeys.add(key);
      if (key === "name" && value) continue;
      if (key !== "name" && key !== "channels" && key !== "dependencies") {
        problems.push(issue("conda_environment_unsupported_yaml", `Conda environment ${file.path} contains unsupported top-level key ${key}.`, span));
        continue;
      }
      if (value) {
        const inline = parseInlineList(value);
        if (!inline) {
          problems.push(issue("conda_environment_unsupported_yaml", `Conda environment ${file.path} uses an unsupported inline ${key} value.`, span));
          continue;
        }
        if (key === "channels") channels.push(...inline);
        else if (key === "dependencies") {
          for (const entry of inline) {
            const dependency = parseMatchSpec(entry, span);
            if (dependency) dependencies.push(dependency);
            else problems.push(issue("conda_dependency_unsupported", `Conda dependency ${entry} in ${file.path} is not a bounded package MatchSpec.`, span));
          }
        }
      }
      continue;
    }
    const listItem = /^\s+-\s+(.+?)\s*$/.exec(raw);
    if (!listItem || !section) {
      problems.push(issue("conda_environment_unsupported_yaml", `Conda environment ${file.path} contains unsupported YAML structure.`, span));
      continue;
    }
    const value = unquoteYamlScalar(listItem[1]!);
    if (!value) {
      problems.push(issue("conda_environment_unsupported_yaml", `Conda environment ${file.path} contains an unsupported ${section} entry.`, span));
      continue;
    }
    if (section === "channels") channels.push(value);
    else {
      const dependency = parseMatchSpec(value, span);
      if (dependency) dependencies.push(dependency);
      else problems.push(issue("conda_dependency_unsupported", `Conda dependency ${value} in ${file.path} is not a bounded package MatchSpec.`, span));
    }
    if (dependencies.length > MAX_TASK_ENVIRONMENT_DEPENDENCIES) {
      throw new Error(`task environments exceed ${MAX_TASK_ENVIRONMENT_DEPENDENCIES} dependencies`);
    }
  }
  if (!channels.length) problems.push(issue(
    "conda_channels_unresolved",
    `Conda environment ${file.path} does not freeze channel order.`,
    { path: file.path, start_line: 1, end_line: 1 },
  ));
  if (!dependencies.length) problems.push(issue(
    "conda_dependencies_missing",
    `Conda environment ${file.path} contains no bounded package dependencies.`,
    { path: file.path, start_line: 1, end_line: 1 },
  ));
  return { channels, dependencies, problems };
}

function processDeclarations(file: FrozenSourceFile) {
  const tokens = tokenizeNextflow(file.bytes);
  const braces = bracePairs(tokens);
  const processes: TaskEnvironmentProcess[] = [];
  const declarations: TaskEnvironmentDeclaration[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "ident" || tokenText(file.bytes, token) !== "process"
      || tokens[index + 1]?.kind !== "ident" || tokens[index + 2]?.kind !== "left_brace") continue;
    const close = braces.get(index + 2);
    if (close === undefined) continue;
    const name = tokenText(file.bytes, tokens[index + 1]!);
    const process: TaskEnvironmentProcess = {
      id: processId(file.path, token.line, name),
      name,
      span: { path: file.path, start_line: token.line, end_line: tokens[close]!.endLine },
    };
    processes.push(process);
    let depth = 0;
    for (let cursor = index + 3; cursor < close; cursor += 1) {
      const candidate = tokens[cursor]!;
      if (candidate.kind === "left_brace") {
        depth += 1;
        continue;
      }
      if (candidate.kind === "right_brace") {
        depth -= 1;
        continue;
      }
      if (depth !== 0 || candidate.kind !== "ident" || tokens[cursor - 1]?.kind === "dot") continue;
      const kind = tokenText(file.bytes, candidate);
      if (kind !== "conda" && kind !== "container" && kind !== "spack" && kind !== "module") continue;
      const value = expressionAfter(file.bytes, tokens, cursor);
      if (!value) continue;
      const span = { path: file.path, start_line: candidate.line, end_line: value.endLine };
      if (kind === "container") {
        declarations.push({
          kind,
          origin: "process",
          expression: value.expression,
          span,
          process_id: process.id,
          process: name,
          ...(value.provenance ? { expression_provenance: value.provenance } : {}),
          ...classifyContainer(value.expression, value.stringLiteral),
        });
      } else if (kind === "conda") {
        const target = value.stringLiteral ? condaEnvironmentPath(file.path, value.expression) : { kind: "dynamic" as const };
        const direct = target.kind === "packages" ? directDependencies(value.expression, span) : undefined;
        declarations.push({
          kind,
          origin: "process",
          expression: value.expression,
          span,
          process_id: process.id,
          process: name,
          ...(value.provenance ? { expression_provenance: value.provenance } : {}),
          resolution: target.kind === "dynamic" ? "dynamic"
            : target.kind === "unsupported" ? "unsupported"
              : target.kind === "path" && !target.path ? "unsupported"
                : target.kind === "packages" && !direct ? "unsupported"
                  : "static",
          ...(target.kind === "path" && target.path ? { resolved_path: target.path } : {}),
          ...(direct ? { direct_dependencies: direct } : {}),
        });
      } else {
        declarations.push({
          kind,
          origin: "process",
          expression: value.expression,
          span,
          process_id: process.id,
          process: name,
          ...(value.provenance ? { expression_provenance: value.provenance } : {}),
          resolution: "unsupported",
        });
      }
      if (declarations.length > MAX_TASK_ENVIRONMENT_DECLARATIONS) {
        throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_DECLARATIONS} task environment declarations`);
      }
    }
    index = close;
    if (processes.length > MAX_TASK_ENVIRONMENT_PROCESSES) {
      throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_PROCESSES} processes while planning task environments`);
    }
  }
  return { processes, declarations };
}

type ConfigInclude = Readonly<{
  expression: string;
  span: SourceSpan;
  resolved_path?: string;
}>;

type ConfigPluginDeclaration = Readonly<{
  directive: string;
  expression: string;
  literal: boolean;
  span: SourceSpan;
}>;

type ConfigCondaChannelDeclaration = Readonly<{
  origin: "top_level" | "profile";
  resolution: "static" | "dynamic";
  channels?: readonly string[];
  span: SourceSpan;
  expression_provenance?: Readonly<{
    start_byte: number;
    end_byte: number;
    digest: string;
  }>;
  reason?: string;
}>;

type ConfigCondaProfileBlock = Readonly<{
  span: SourceSpan;
  digest: string;
}>;

type ConfigBlock = Readonly<{
  role: "profiles" | "conda_profile" | "other";
}>;

function skipConfigTrivia(bytes: Uint8Array, start: number, limit: number) {
  let cursor = start;
  while (cursor < limit) {
    const byte = bytes[cursor]!;
    if (byte === 32 || byte === 9 || byte === 10 || byte === 13 || byte === 12 || byte === 11) {
      cursor += 1;
      continue;
    }
    if (byte === 47 && bytes[cursor + 1] === 47) {
      cursor += 2;
      while (cursor < limit && bytes[cursor] !== 10) cursor += 1;
      continue;
    }
    if (byte === 47 && bytes[cursor + 1] === 42) {
      const commentStart = cursor;
      cursor += 2;
      while (cursor + 1 < limit && !(bytes[cursor] === 42 && bytes[cursor + 1] === 47)) cursor += 1;
      if (cursor + 1 >= limit) return { cursor: commentStart, complete: false };
      cursor += 2;
      continue;
    }
    break;
  }
  return { cursor, complete: true };
}

function configExpressionEndLine(bytes: Uint8Array, start: number, end: number, startLine: number) {
  let line = startLine;
  for (let cursor = start; cursor < end; cursor += 1) if (bytes[cursor] === 10) line += 1;
  return line;
}

function staticChannelValue(value: string) {
  if (!value || new TextEncoder().encode(value).byteLength > 2_048) return false;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 32 || point === 127 || character === "$" || character === "\\") return false;
  }
  return true;
}

function parseStaticCondaChannelList(
  file: FrozenSourceFile,
  channelToken: NextflowToken,
): Omit<ConfigCondaChannelDeclaration, "origin"> {
  const bytes = file.bytes;
  const limit = Math.min(bytes.byteLength, channelToken.end + MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES);
  let skipped = skipConfigTrivia(bytes, channelToken.end, limit);
  let cursor = skipped.cursor;
  const dynamic = (reason: string): Omit<ConfigCondaChannelDeclaration, "origin"> => ({
    resolution: "dynamic",
    span: { path: file.path, start_line: channelToken.line, end_line: channelToken.endLine },
    reason,
  });
  if (!skipped.complete) return dynamic("the assignment contains an unclosed comment");
  if (bytes[cursor] !== 61) return dynamic("the declaration is not one direct assignment");
  cursor += 1;
  skipped = skipConfigTrivia(bytes, cursor, limit);
  cursor = skipped.cursor;
  if (!skipped.complete) return dynamic("the assignment contains an unclosed comment");
  if (bytes[cursor] !== 91) return dynamic("the assigned value is not one literal list");
  const expressionStart = cursor;
  cursor += 1;
  const channels: string[] = [];
  while (cursor < limit) {
    skipped = skipConfigTrivia(bytes, cursor, limit);
    cursor = skipped.cursor;
    if (!skipped.complete) return dynamic("the channel list contains an unclosed comment");
    if (bytes[cursor] === 93) {
      cursor += 1;
      break;
    }
    if (channels.length >= MAX_NEXTFLOW_CONDA_CHANNELS) {
      return dynamic(`the channel list exceeds ${MAX_NEXTFLOW_CONDA_CHANNELS} entries`);
    }
    const quote = bytes[cursor];
    if (quote !== 39 && quote !== 34) return dynamic("every channel must be one quoted literal");
    const valueStart = ++cursor;
    while (cursor < limit && bytes[cursor] !== quote) {
      if (bytes[cursor] === 10 || bytes[cursor] === 13 || bytes[cursor] === 92) {
        return dynamic("channel literals cannot contain newlines or escapes");
      }
      cursor += 1;
    }
    if (cursor >= limit) return dynamic("the channel list contains an unclosed literal");
    const value = decoder.decode(bytes.subarray(valueStart, cursor));
    if (!staticChannelValue(value)) return dynamic("the channel list contains an unsupported literal");
    channels.push(value);
    cursor += 1;
    skipped = skipConfigTrivia(bytes, cursor, limit);
    cursor = skipped.cursor;
    if (!skipped.complete) return dynamic("the channel list contains an unclosed comment");
    if (bytes[cursor] === 44) {
      cursor += 1;
      continue;
    }
    if (bytes[cursor] === 93) {
      cursor += 1;
      break;
    }
    return dynamic("channel literals are not separated by commas");
  }
  if (!channels.length || bytes[cursor - 1] !== 93) return dynamic("the channel list is empty or unclosed");
  if (new Set(channels).size !== channels.length) return dynamic("the channel list repeats a channel");

  let tail = cursor;
  while (tail < bytes.byteLength) {
    const byte = bytes[tail]!;
    if (byte === 32 || byte === 9 || byte === 13 || byte === 12 || byte === 11) {
      tail += 1;
      continue;
    }
    if (byte === 10 || byte === 59 || byte === 125) break;
    if (byte === 47 && bytes[tail + 1] === 47) break;
    if (byte === 47 && bytes[tail + 1] === 42) {
      tail += 2;
      let lineBreak = false;
      while (tail + 1 < bytes.byteLength && !(bytes[tail] === 42 && bytes[tail + 1] === 47)) {
        if (bytes[tail] === 10) lineBreak = true;
        tail += 1;
      }
      if (tail + 1 >= bytes.byteLength) return dynamic("the assignment contains an unclosed trailing comment");
      tail += 2;
      if (lineBreak) break;
      continue;
    }
    return dynamic("the literal list is followed by a dynamic expression");
  }

  return {
    resolution: "static",
    channels,
    span: {
      path: file.path,
      start_line: channelToken.line,
      end_line: configExpressionEndLine(bytes, channelToken.end, cursor, channelToken.line),
    },
    expression_provenance: {
      start_byte: expressionStart,
      end_byte: cursor,
      digest: byteDigest(bytes.subarray(expressionStart, cursor)),
    },
  };
}

function inspectCondaConfig(
  file: FrozenSourceFile,
  tokens: readonly NextflowToken[],
  braces: ReadonlyMap<number, number>,
) {
  const declarations: ConfigCondaChannelDeclaration[] = [];
  const profiles: ConfigCondaProfileBlock[] = [];
  const stack: ConfigBlock[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "right_brace") {
      stack.pop();
      continue;
    }
    if (token.kind === "left_brace") {
      const owner = tokens[index - 1];
      const ownerName = owner?.kind === "ident" ? tokenText(file.bytes, owner) : undefined;
      let role: ConfigBlock["role"] = "other";
      if (ownerName === "profiles" && stack.length === 0 && braces.has(index)) role = "profiles";
      else if (ownerName === "conda" && stack.length === 1 && stack[0]?.role === "profiles" && braces.has(index)) {
        role = "conda_profile";
        const close = tokens[braces.get(index)!]!;
        const start = owner!.offset;
        const end = close.offset + 1;
        profiles.push({
          span: { path: file.path, start_line: owner!.line, end_line: close.endLine },
          digest: byteDigest(file.bytes.subarray(start, end)),
        });
      }
      stack.push({ role });
      continue;
    }
    if (token.kind !== "ident" || tokenText(file.bytes, token) !== "conda"
      || tokens[index - 1]?.kind === "dot" || tokens[index + 1]?.kind !== "dot"
      || tokens[index + 2]?.kind !== "ident" || tokenText(file.bytes, tokens[index + 2]!) !== "channels") continue;
    const origin = stack.length === 0 ? "top_level" as const
      : stack.length === 2 && stack[0]?.role === "profiles" && stack[1]?.role === "conda_profile"
        ? "profile" as const
        : undefined;
    if (!origin) continue;
    declarations.push({ origin, ...parseStaticCondaChannelList(file, tokens[index + 2]!) });
  }
  return { declarations, profiles };
}

function configLineRemainder(bytes: Uint8Array, offset: number, line: number) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 59) end += 1;
  if (end - offset > MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES) {
    throw new Error(`task environment config expression at line ${line} exceeds ${MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES} bytes`);
  }
  return decoder.decode(bytes.subarray(offset, end)).trim();
}

function configArgument(
  file: FrozenSourceFile,
  tokens: readonly NextflowToken[],
  directiveIndex: number,
): Readonly<{ expression: string; span: SourceSpan; literal: boolean }> {
  const directive = tokens[directiveIndex]!;
  const parenthesized = tokens[directiveIndex + 1]?.kind === "left_paren";
  const valueIndex = directiveIndex + (parenthesized ? 2 : 1);
  const value = tokens[valueIndex];
  const fallback = configLineRemainder(file.bytes, directive.end, directive.line);
  if (!value) return {
    expression: fallback || "<missing>",
    span: { path: file.path, start_line: directive.line, end_line: directive.endLine },
    literal: false,
  };
  if (value.offset - directive.end > MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES
    || value.kind === "string" && value.end - value.start > MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES) {
    throw new Error(`task environment config expression at line ${directive.line} exceeds ${MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES} bytes`);
  }
  const gap = decoder.decode(file.bytes.subarray(directive.end, value.offset));
  let boundaryIndex = valueIndex + 1;
  if (parenthesized) {
    if (tokens[boundaryIndex]?.kind !== "right_paren") return {
      expression: fallback || tokenText(file.bytes, value),
      span: { path: file.path, start_line: directive.line, end_line: value.endLine },
      literal: false,
    };
    boundaryIndex += 1;
  }
  const boundary = tokens[boundaryIndex];
  const literal = value.kind === "string"
    && directive.line === value.endLine
    && /^[ \t\r\f\v]*\(?[ \t\r\f\v]*$/.test(gap)
    && (!boundary || boundary.line > value.endLine
      || boundary.kind === "semicolon" || boundary.kind === "right_brace");
  const expression = literal ? tokenText(file.bytes, value) : fallback || tokenText(file.bytes, value);
  return {
    expression,
    span: { path: file.path, start_line: directive.line, end_line: value.endLine },
    literal,
  };
}

function inspectConfigFile(file: FrozenSourceFile) {
  try {
    decoder.decode(file.bytes);
  } catch {
    throw new Error(`task environment config ${file.path} is not UTF-8`);
  }
  const declarations: TaskEnvironmentDeclaration[] = [];
  const includes: ConfigInclude[] = [];
  const pluginDeclarations: ConfigPluginDeclaration[] = [];
  const issues: TaskEnvironmentIssue[] = [];
  const tokens = tokenizeNextflow(file.bytes);
  const braces = bracePairs(tokens);
  const condaConfig = inspectCondaConfig(file, tokens, braces);
  const pushIssue = (entry: TaskEnvironmentIssue) => {
    if (issues.length >= MAX_TASK_ENVIRONMENT_CONFIGURATION_ISSUES) {
      throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_CONFIGURATION_ISSUES} configuration issues`);
    }
    issues.push(entry);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "ident") continue;
    const name = tokenText(file.bytes, token);
    if (name === "conda" || name === "container" || name === "spack" || name === "module") {
      const assignment = /^=\s*([\s\S]*)$/.exec(configLineRemainder(file.bytes, token.end, token.line));
      if (assignment) {
        const expression = assignment[1]!.trim();
        declarations.push({
          kind: name,
          origin: "config",
          expression,
          resolution: "dynamic",
          span: { path: file.path, start_line: token.line, end_line: token.endLine },
        });
      }
    }
    if (name === "includeConfig" && tokens[index - 1]?.kind !== "dot") {
      const argument = configArgument(file, tokens, index);
      const resolved = argument.literal && !/^(?:\/|~\/|https?:\/\/)/.test(argument.expression)
        && !/\$|\{|\}/.test(argument.expression)
        ? normalizePath(file.path.split("/").slice(0, -1), argument.expression)
        : undefined;
      includes.push({
        expression: argument.expression,
        span: argument.span,
        ...(resolved ? { resolved_path: resolved } : {}),
      });
      continue;
    }
    if (name === "plugins" && tokens[index - 1]?.kind !== "dot" && tokens[index + 1]?.kind === "left_brace") {
      const close = braces.get(index + 1);
      if (close === undefined) {
        pushIssue(issue(
          "source_config_plugins_unclosed",
          `Nextflow plugins block in ${file.path} is not closed.`,
          { path: file.path, start_line: token.line, end_line: token.endLine },
        ));
        continue;
      }
      let depth = 0;
      for (let cursor = index + 2; cursor < close; cursor += 1) {
        const candidate = tokens[cursor]!;
        if (candidate.kind === "left_brace") {
          depth += 1;
          continue;
        }
        if (candidate.kind === "right_brace") {
          depth -= 1;
          continue;
        }
        if (depth !== 0 || candidate.kind !== "ident") continue;
        const directive = tokenText(file.bytes, candidate);
        const argument = configArgument(file, tokens, cursor);
        pluginDeclarations.push({
          directive,
          expression: argument.expression,
          literal: argument.literal,
          span: argument.span,
        });
        if (pluginDeclarations.length > MAX_TASK_ENVIRONMENT_PLUGIN_DECLARATIONS) {
          throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_PLUGIN_DECLARATIONS} Nextflow plugin declarations`);
        }
      }
      index = close;
      continue;
    }
  }
  return {
    declarations,
    includes,
    pluginDeclarations,
    condaChannelDeclarations: condaConfig.declarations,
    condaProfiles: condaConfig.profiles,
    issues,
  };
}

function sortSpans(spans: readonly SourceSpan[]) {
  return [...spans].sort((left, right) => compareText(left.path, right.path)
    || left.start_line - right.start_line || left.end_line - right.end_line);
}

function sortIssues(issues: readonly TaskEnvironmentIssue[]) {
  return [...issues].map((entry) => ({ ...entry, spans: sortSpans(entry.spans) })).sort((left, right) =>
    compareText(left.spans[0]?.path ?? "", right.spans[0]?.path ?? "")
    || (left.spans[0]?.start_line ?? 0) - (right.spans[0]?.start_line ?? 0)
    || compareText(left.code, right.code)
    || compareText(left.message, right.message));
}

function freezeCondaChannelOrder(
  declarations: readonly ConfigCondaChannelDeclaration[],
  problems: TaskEnvironmentIssue[],
): NextflowCondaChannelOrder | undefined {
  const sorted = [...declarations].sort((left, right) => compareText(left.span.path, right.span.path)
    || left.span.start_line - right.span.start_line || compareText(left.origin, right.origin));
  const dynamic = sorted.filter((declaration) => declaration.resolution === "dynamic");
  for (const declaration of dynamic) problems.push(issue(
    "source_config_conda_channels_dynamic",
    `conda.channels in ${declaration.span.path} is not one exact static channel list: ${declaration.reason ?? "the expression is not bounded"}.`,
    declaration.span,
  ));
  const exact = sorted.filter((declaration): declaration is ConfigCondaChannelDeclaration & Readonly<{
    resolution: "static";
    channels: readonly string[];
    expression_provenance: NonNullable<ConfigCondaChannelDeclaration["expression_provenance"]>;
  }> => declaration.resolution === "static" && !!declaration.channels && !!declaration.expression_provenance);
  if (exact.length > 1) {
    const orders = new Set(exact.map((declaration) => declaration.channels.join("\0")));
    problems.push(issue(
      orders.size > 1 ? "source_config_conda_channels_conflict" : "source_config_conda_channels_ambiguous",
      orders.size > 1
        ? `The frozen config declares ${orders.size} conflicting conda.channels orders.`
        : "The frozen config repeats conda.channels; Somite requires one unambiguous source declaration.",
      ...exact.map((declaration) => declaration.span),
    ));
  }
  if (dynamic.length || exact.length !== 1) return undefined;
  const selected = exact[0]!;
  return {
    channels: [...selected.channels],
    origin: selected.origin,
    ...(selected.origin === "profile" ? { profile: "conda" as const } : {}),
    span: selected.span,
    expression_provenance: selected.expression_provenance,
  };
}

function condaProfileProvenance(
  blocks: readonly ConfigCondaProfileBlock[],
): NextflowCondaProfileProvenance | undefined {
  if (!blocks.length) return undefined;
  const unique = new Map<string, ConfigCondaProfileBlock>();
  for (const block of blocks) unique.set(JSON.stringify([block.span, block.digest]), block);
  return {
    name: "conda",
    blocks: [...unique.values()].sort((left, right) => compareText(left.span.path, right.span.path)
      || left.span.start_line - right.span.start_line || left.span.end_line - right.span.end_line
      || compareText(left.digest, right.digest)),
  };
}

function validConfigScalar(value: unknown): value is NextflowConfigScalar {
  return value === null || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string"
      && new TextEncoder().encode(value).byteLength <= MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES
      && [...value].every((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point >= 32 && point !== 127;
      }));
}

function configParameters(
  rootConfigs: readonly FrozenSourceFile[],
  overrides: Readonly<Record<string, NextflowConfigScalar>> | undefined,
) {
  const candidates = new Map<string, NextflowConfigScalar[]>();
  for (const file of rootConfigs) {
    const defaults = extractNextflowConfigScalarDefaults(file.bytes);
    for (const [name, value] of Object.entries(defaults.values)) {
      const entries = candidates.get(name) ?? [];
      entries.push(value);
      candidates.set(name, entries);
    }
  }
  const parameters: Record<string, NextflowConfigScalar> = {};
  for (const [name, values] of [...candidates].sort(([left], [right]) => compareText(left, right))) {
    const encoded = new Set(values.map((value) => JSON.stringify(value)));
    if (encoded.size === 1) parameters[name] = values[0]!;
  }
  const overrideEntries = Object.entries(overrides ?? {}).sort(([left], [right]) => compareText(left, right));
  if (overrideEntries.length > 10_000) throw new Error("source task config parameter override count exceeds 10000");
  for (const [name, value] of overrideEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !validConfigScalar(value)) {
      throw new Error(`source task config parameter ${name} is not one bounded scalar override`);
    }
    parameters[name] = value;
  }
  return parameters;
}

function configIncludeResolution(
  include: ConfigInclude,
  includingPath: string,
  parameters: Readonly<Record<string, NextflowConfigScalar>>,
  fileMap: ReadonlyMap<string, FrozenSourceFile>,
): NextflowConfigIncludeResolution {
  const evaluated = include.resolved_path
    ? {
        status: "resolved" as const,
        value: include.resolved_path,
        parameters: [] as readonly string[],
        environment: [] as readonly string[],
      }
    : resolveNextflowConfigExpression(include.expression, {
        parameters,
        environment: { NXF_OFFLINE: "true" },
      });
  const usedParameters = evaluated.parameters.flatMap((name) => (
    Object.hasOwn(parameters, name) ? [{ name, value: parameters[name]! }] : []
  ));
  const usedEnvironment = evaluated.environment.map((name) => ({
    name,
    ...(name === "NXF_OFFLINE" ? { value: "true" } : {}),
  }));
  const base = {
    expression: include.expression,
    span: include.span,
    parameters: usedParameters,
    environment: usedEnvironment,
  };
  if (evaluated.status === "unresolved") {
    return { ...base, status: "unresolved", reason: evaluated.reason };
  }
  const ambientEnvironment = evaluated.environment.filter((name) => name !== "NXF_OFFLINE");
  if (ambientEnvironment.length) {
    return {
      ...base,
      status: "unresolved",
      reason: `includeConfig depends on ambient environment ${ambientEnvironment.join(", ")}`,
    };
  }
  if (typeof evaluated.value !== "string") {
    return { ...base, status: "unresolved", reason: "includeConfig expression did not resolve to a path string" };
  }
  if (evaluated.value === "/dev/null") return { ...base, status: "ignored", resolved_path: "/dev/null" };
  if (/^(?:\/|~\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(evaluated.value)) {
    return {
      ...base,
      status: "external",
      reason: `includeConfig resolved outside the frozen source: ${evaluated.value}`,
    };
  }
  const resolvedPath = include.resolved_path
    ?? normalizePath(includingPath.split("/").slice(0, -1), evaluated.value);
  if (!resolvedPath) {
    return { ...base, status: "external", reason: `includeConfig resolved to unsafe path ${evaluated.value}` };
  }
  if (!fileMap.has(resolvedPath)) {
    return { ...base, status: "missing", resolved_path: resolvedPath };
  }
  return { ...base, status: "source", resolved_path: resolvedPath };
}

function freezeNextflowPlugins(
  declarations: readonly ConfigPluginDeclaration[],
  problems: TaskEnvironmentIssue[],
) {
  const parsed = new Map<string, Array<Readonly<{
    version: string;
    requirement: string;
    span: SourceSpan;
  }>>>();
  const exactVersion = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
  const pluginName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
  for (const declaration of [...declarations].sort((left, right) => compareText(left.span.path, right.span.path)
    || left.span.start_line - right.span.start_line || compareText(left.directive, right.directive))) {
    if (declaration.directive !== "id") {
      problems.push(issue(
        "source_config_plugin_declaration_unsupported",
        `Nextflow plugins block in ${declaration.span.path} uses unsupported ${declaration.directive} syntax; use id 'name@exact-version'.`,
        declaration.span,
      ));
      continue;
    }
    if (!declaration.literal) {
      problems.push(issue(
        "source_config_plugin_declaration_dynamic",
        `Nextflow plugin declaration in ${declaration.span.path} is not one literal name@exact-version requirement.`,
        declaration.span,
      ));
      continue;
    }
    const separator = declaration.expression.lastIndexOf("@");
    if (separator < 1) {
      problems.push(issue(
        "source_config_plugin_unpinned",
        `Nextflow plugin ${declaration.expression} in ${declaration.span.path} has no exact version pin.`,
        declaration.span,
      ));
      continue;
    }
    const name = declaration.expression.slice(0, separator);
    const version = declaration.expression.slice(separator + 1);
    if (!pluginName.test(name)) {
      problems.push(issue(
        "source_config_plugin_name_invalid",
        `Nextflow plugin requirement ${declaration.expression} in ${declaration.span.path} has an invalid plugin name.`,
        declaration.span,
      ));
      continue;
    }
    if (!exactVersion.test(version)) {
      problems.push(issue(
        "source_config_plugin_version_not_exact",
        `Nextflow plugin ${name} in ${declaration.span.path} uses non-exact version ${version || "<missing>"}.`,
        declaration.span,
      ));
      continue;
    }
    const group = parsed.get(name) ?? [];
    group.push({ version, requirement: `${name}@${version}`, span: declaration.span });
    parsed.set(name, group);
  }

  const requirements: NextflowPluginRequirement[] = [];
  for (const [name, entries] of [...parsed].sort(([left], [right]) => compareText(left, right))) {
    const versions = [...new Set(entries.map((entry) => entry.version))].sort(compareText);
    if (versions.length > 1) {
      problems.push(issue(
        "source_config_plugin_conflict",
        `Nextflow plugin ${name} has conflicting exact versions: ${versions.join(", ")}.`,
        ...entries.map((entry) => entry.span),
      ));
      continue;
    }
    const version = versions[0]!;
    const uniqueSpans = new Map<string, SourceSpan>();
    for (const entry of entries) uniqueSpans.set(JSON.stringify(entry.span), entry.span);
    requirements.push({
      name,
      version,
      requirement: `${name}@${version}`,
      spans: sortSpans([...uniqueSpans.values()]),
    });
  }
  if (requirements.length > MAX_NEXTFLOW_PLUGIN_REQUIREMENTS) {
    problems.push(issue(
      "source_config_plugin_limit",
      `Source requires ${requirements.length} Nextflow plugins; Somite freezes at most ${MAX_NEXTFLOW_PLUGIN_REQUIREMENTS}.`,
      ...requirements.slice(0, MAX_NEXTFLOW_PLUGIN_REQUIREMENTS + 1).flatMap((requirement) => requirement.spans.slice(0, 1)),
    ));
    return [];
  }
  return requirements;
}

function mergedDependencies(dependencies: readonly CondaDependency[], problems: TaskEnvironmentIssue[]) {
  const grouped = new Map<string, CondaDependency[]>();
  for (const dependency of dependencies) {
    const group = grouped.get(dependency.name) ?? [];
    group.push(dependency);
    grouped.set(dependency.name, group);
  }
  const merged: PixiClosureDependency[] = [];
  for (const [name, sources] of [...grouped.entries()].sort(([left], [right]) => compareText(left, right))) {
    const channels = [...new Set(sources.flatMap((entry) => entry.channel ? [entry.channel] : []))].sort(compareText);
    const exactVersions = [...new Set(sources.flatMap((entry) => entry.exact_version ? [entry.exact_version] : []))].sort(compareText);
    const exactBuilds = [...new Set(sources.flatMap((entry) => entry.exact_build ? [entry.exact_build] : []))].sort(compareText);
    const constrained = [...new Set(sources.map((entry) => entry.constraint).filter(Boolean))].sort(compareText);
    if (channels.length > 1) problems.push(issue(
      "conda_explicit_channel_conflict",
      `Package ${name} is pinned to multiple explicit channels: ${channels.join(", ")}.`,
      ...sources.map((entry) => entry.span),
    ));
    if (exactVersions.length > 1) problems.push(issue(
      "conda_exact_version_conflict",
      `Package ${name} has conflicting exact versions: ${exactVersions.join(", ")}.`,
      ...sources.map((entry) => entry.span),
    ));
    if (exactVersions.length === 1 && exactBuilds.length > 1) problems.push(issue(
      "conda_exact_build_conflict",
      `Package ${name} has conflicting exact builds for ${exactVersions[0]}: ${exactBuilds.join(", ")}.`,
      ...sources.map((entry) => entry.span),
    ));
    const nonExact = constrained.filter((constraint) => !sources.some((entry) => entry.constraint === constraint && entry.exact_version));
    if (nonExact.length > 1 || (nonExact.length && exactVersions.length)) problems.push(issue(
      "conda_constraint_overlap_unproven",
      `Package ${name} has constraints whose intersection has not been proven: ${constrained.join(", ")}.`,
      ...sources.map((entry) => entry.span),
    ));
    const preferred = sources.find((entry) => entry.exact_build)
      ?? sources.find((entry) => entry.exact_version)
      ?? sources.find((entry) => entry.constraint)
      ?? sources[0]!;
    const channel = channels.length === 1 ? channels[0] : preferred.channel;
    merged.push({
      name,
      match_spec: `${channel ? `${channel}::` : ""}${name}${preferred.constraint}`,
      sources: [...sources]
        .sort((left, right) => compareText(left.span.path, right.span.path) || left.span.start_line - right.span.start_line)
        .map((entry) => ({ match_spec: entry.match_spec, span: entry.span })),
    });
  }
  return merged;
}

/**
 * Inventory the task-scoped software environments in an immutable Nextflow
 * source snapshot. A candidate closure is declarative input for a later Pixi
 * solve; it is never evidence that a manifest was locked, installed, or run.
 */
export function planTaskEnvironments(
  files: readonly FrozenSourceFile[],
  entrypoint: string,
  options: TaskEnvironmentPlanningOptions = {},
): TaskEnvironmentPlan {
  if (!safeSourcePath(entrypoint)) throw new Error(`task environment entrypoint is not one safe source path: ${entrypoint}`);
  const fileMap = new Map<string, FrozenSourceFile>();
  for (const file of files) {
    if (!safeSourcePath(file.path) || fileMap.has(file.path)) throw new Error(`task environment source contains invalid or duplicate path ${file.path}`);
    fileMap.set(file.path, file);
  }
  const processes: TaskEnvironmentProcess[] = [];
  const declarations: TaskEnvironmentDeclaration[] = [];
  const configurationIssues: TaskEnvironmentIssue[] = [];
  const pluginDeclarations: ConfigPluginDeclaration[] = [];
  const condaChannelDeclarations: ConfigCondaChannelDeclaration[] = [];
  const condaProfiles: ConfigCondaProfileBlock[] = [];
  let sourceBytes = 0;
  const sortedFiles = [...files].sort((left, right) => compareText(left.path, right.path));
  for (const file of sortedFiles) {
    if (!file.path.endsWith(".nf")) continue;
    sourceBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes > MAX_TASK_ENVIRONMENT_SOURCE_BYTES) {
      throw new Error(`task environment source exceeds ${MAX_TASK_ENVIRONMENT_SOURCE_BYTES} bytes`);
    }
    const indexed = processDeclarations(file);
    processes.push(...indexed.processes);
    declarations.push(...indexed.declarations);
    if (processes.length > MAX_TASK_ENVIRONMENT_PROCESSES) {
      throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_PROCESSES} processes while planning task environments`);
    }
    if (declarations.length > MAX_TASK_ENVIRONMENT_DECLARATIONS) {
      throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_DECLARATIONS} task environment declarations`);
    }
  }

  // Somite passes only the root config and, for a nested entrypoint, the config
  // beside that entrypoint to Nextflow. Inspect that same root set, then follow
  // every statically resolvable include regardless of its file extension.
  const entrypointConfig = [...entrypoint.split("/").slice(0, -1), "nextflow.config"].join("/");
  const rootConfigPaths = [...new Set([entrypointConfig, "nextflow.config"])]
    .filter((path) => fileMap.has(path));
  const parameters = configParameters(rootConfigPaths.map((path) => fileMap.get(path)!), options.parameters);
  const pendingConfigs = [...rootConfigPaths];
  const visitedConfigs = new Set<string>();
  const includeResolutions: NextflowConfigIncludeResolution[] = [];
  let pendingConfigIndex = 0;
  while (pendingConfigIndex < pendingConfigs.length) {
    const configPath = pendingConfigs[pendingConfigIndex++]!;
    if (visitedConfigs.has(configPath)) continue;
    visitedConfigs.add(configPath);
    const file = fileMap.get(configPath);
    if (!file) {
      configurationIssues.push(issue(
        "task_environment_config_include_missing",
        `Included Nextflow config ${configPath} is absent from the frozen source.`,
        { path: configPath, start_line: 1, end_line: 1 },
      ));
      continue;
    }
    sourceBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes > MAX_TASK_ENVIRONMENT_SOURCE_BYTES) {
      throw new Error(`task environment source exceeds ${MAX_TASK_ENVIRONMENT_SOURCE_BYTES} bytes`);
    }
    const indexed = inspectConfigFile(file);
    declarations.push(...indexed.declarations);
    pluginDeclarations.push(...indexed.pluginDeclarations);
    condaChannelDeclarations.push(...indexed.condaChannelDeclarations);
    condaProfiles.push(...indexed.condaProfiles);
    if (pluginDeclarations.length > MAX_TASK_ENVIRONMENT_PLUGIN_DECLARATIONS) {
      throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_PLUGIN_DECLARATIONS} Nextflow plugin declarations`);
    }
    configurationIssues.push(...indexed.issues);
    for (const include of indexed.includes) {
      const resolution = configIncludeResolution(include, configPath, parameters, fileMap);
      includeResolutions.push(resolution);
      if (resolution.status === "source") {
        pendingConfigs.push(resolution.resolved_path!);
      } else if (resolution.status === "unresolved") {
        configurationIssues.push(issue(
          "task_environment_config_include_unresolved",
          `includeConfig in ${include.span.path} could not be resolved from bounded frozen inputs: ${include.expression}. ${resolution.reason ?? ""}`.trim(),
          include.span,
        ));
      } else if (resolution.status === "missing") {
        configurationIssues.push(issue(
          "task_environment_config_include_missing",
          `includeConfig in ${include.span.path} refers to missing frozen config ${resolution.resolved_path}.`,
          include.span,
        ));
      } else if (resolution.status === "external") {
        configurationIssues.push(issue(
          "task_environment_config_include_external",
          `includeConfig in ${include.span.path} resolves outside the frozen source: ${include.expression}. ${resolution.reason ?? ""}`.trim(),
          include.span,
        ));
      }
    }
    if (declarations.length > MAX_TASK_ENVIRONMENT_DECLARATIONS) {
      throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_DECLARATIONS} task environment declarations`);
    }
    if (configurationIssues.length > MAX_TASK_ENVIRONMENT_CONFIGURATION_ISSUES) {
      throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_CONFIGURATION_ISSUES} configuration issues`);
    }
  }

  const nextflowPlugins = freezeNextflowPlugins(pluginDeclarations, configurationIssues);
  const condaChannelOrder = freezeCondaChannelOrder(condaChannelDeclarations, configurationIssues);
  const condaProfile = condaProfileProvenance(condaProfiles);
  const configClosure: NextflowConfigClosure = {
    paths: [...visitedConfigs].sort(compareText),
    includes: [...includeResolutions].sort((left, right) => compareText(left.span.path, right.span.path)
      || left.span.start_line - right.span.start_line
      || compareText(left.expression, right.expression)),
    ...(condaChannelOrder ? { conda_channel_order: condaChannelOrder } : {}),
    ...(condaProfile ? { conda_profile: condaProfile } : {}),
  };
  if (configurationIssues.length > MAX_TASK_ENVIRONMENT_CONFIGURATION_ISSUES) {
    throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_CONFIGURATION_ISSUES} configuration issues`);
  }
  const problems: TaskEnvironmentIssue[] = [...configurationIssues];
  const direct: CondaDependency[] = [];
  const environments = new Map<string, MutableEnvironment>();
  const covered = new Set<string>();
  const condaByProcess = new Map<string, TaskEnvironmentDeclaration[]>();
  for (const declaration of declarations) {
    if (declaration.origin === "config") {
      problems.push(issue(
        "task_environment_config_override",
        `${declaration.kind} is assigned in ${declaration.span.path}; profile and selector resolution is required before one Pixi closure can be derived.`,
        declaration.span,
      ));
      continue;
    }
    if (declaration.kind === "spack" || declaration.kind === "module") {
      problems.push(issue(
        "external_task_environment_unsupported",
        `${declaration.process} uses the ${declaration.kind} task environment, which cannot be represented as a Pixi Conda closure.`,
        declaration.span,
      ));
      continue;
    }
    if (declaration.kind !== "conda") continue;
    const entries = condaByProcess.get(declaration.process_id!) ?? [];
    entries.push(declaration);
    condaByProcess.set(declaration.process_id!, entries);
    if (declaration.resolution === "dynamic") {
      problems.push(issue("conda_declaration_dynamic", `${declaration.process} selects its Conda environment dynamically.`, declaration.span));
      continue;
    }
    if (declaration.resolution === "unsupported") {
      problems.push(issue(
        "conda_declaration_unsupported",
        `${declaration.process} uses a Conda path or expression whose frozen location cannot be proven.`,
        declaration.span,
      ));
      continue;
    }
    if (!declaration.resolved_path) {
      const dependencies = declaration.direct_dependencies;
      if (!dependencies) {
        problems.push(issue("conda_declaration_unsupported", `${declaration.process} has an unsupported Conda package expression.`, declaration.span));
        continue;
      }
      direct.push(...dependencies);
      for (const dependency of dependencies) {
        if (!dependency.channel && !condaChannelOrder) problems.push(issue(
          "conda_direct_channel_unqualified",
          `${declaration.process} directly declares ${dependency.match_spec} without an explicit channel and the frozen config has no exact conda.channels order.`,
          dependency.span,
        ));
      }
      covered.add(declaration.process_id!);
      continue;
    }
    const environmentFile = fileMap.get(declaration.resolved_path);
    if (!environmentFile) {
      problems.push(issue(
        "conda_environment_missing",
        `${declaration.process} references missing frozen environment ${declaration.resolved_path}.`,
        declaration.span,
      ));
      continue;
    }
    let environment = environments.get(declaration.resolved_path);
    if (!environment) {
      const parsed = parseCondaEnvironment(environmentFile);
      problems.push(...parsed.problems);
      environment = {
        path: environmentFile.path,
        digest: byteDigest(environmentFile.bytes),
        channels: parsed.channels,
        dependencies: parsed.dependencies,
        problems: parsed.problems,
        complete: parsed.problems.length === 0,
        referenced_by: [],
      };
      environments.set(environmentFile.path, environment);
    }
    environment.referenced_by.push({
      process_id: declaration.process_id!,
      process: declaration.process!,
      span: declaration.span,
    });
    if (environment.complete) covered.add(declaration.process_id!);
  }

  const processIds = new Set(processes.map((process) => process.id));
  for (const [id, entries] of condaByProcess) {
    if (entries.length > 1) problems.push(issue(
      "multiple_conda_declarations",
      `${entries[0]!.process} has multiple process-level Conda declarations.`,
      ...entries.map((entry) => entry.span),
    ));
    if (!processIds.has(id)) throw new Error(`task environment declaration refers to unknown process ${id}`);
  }
  for (const process of processes) {
    if (!condaByProcess.has(process.id)) problems.push(issue(
      "process_without_conda_environment",
      `${process.name} has no process-level Conda declaration from which a Pixi task environment can be derived.`,
      process.span,
    ));
  }

  const condaEnvironments = [...environments.values()].sort((left, right) => compareText(left.path, right.path));
  const channelOrderMap = new Map<string, readonly string[]>();
  for (const environment of condaEnvironments) channelOrderMap.set(environment.channels.join("\0"), environment.channels);
  if (condaChannelOrder) channelOrderMap.set(condaChannelOrder.channels.join("\0"), condaChannelOrder.channels);
  const channelOrders = [...channelOrderMap.values()];
  if (channelOrders.length > 1) problems.push(issue(
    "conda_channel_order_conflict",
    `Frozen Conda inputs use ${channelOrders.length} different channel orders.`,
    ...condaEnvironments.flatMap((environment) => environment.dependencies.slice(0, 1).map((entry) => entry.span)),
    ...(condaChannelOrder ? [condaChannelOrder.span] : []),
  ));
  const directChannels = [...new Set(direct.flatMap((dependency) => dependency.channel ? [dependency.channel] : []))]
    .sort(compareText);
  let sharedChannels: readonly string[] = [];
  if (channelOrders.length === 1) {
    sharedChannels = channelOrders[0]!;
    const sharedChannelSet = new Set(sharedChannels);
    const absent = directChannels.filter((channel) => !sharedChannelSet.has(channel));
    if (absent.length) problems.push(issue(
      "conda_direct_channel_absent_from_shared_order",
      `Direct Conda package channels are absent from the frozen shared channel order: ${absent.join(", ")}.`,
      ...direct.filter((dependency) => dependency.channel && absent.includes(dependency.channel)).map((dependency) => dependency.span),
    ));
  } else if (channelOrders.length === 0 && directChannels.length === 1) {
    sharedChannels = directChannels;
  } else if (channelOrders.length === 0 && directChannels.length > 1) {
    problems.push(issue(
      "conda_direct_channel_order_unproven",
      `Direct Conda package declarations name multiple channels without declaring their shared priority order: ${directChannels.join(", ")}.`,
      ...direct.map((dependency) => dependency.span),
    ));
  }
  const dependencies = [...condaEnvironments.flatMap((environment) => environment.dependencies), ...direct];
  if (dependencies.length > MAX_TASK_ENVIRONMENT_DEPENDENCIES) {
    throw new Error(`task environments exceed ${MAX_TASK_ENVIRONMENT_DEPENDENCIES} dependencies`);
  }
  const merged = mergedDependencies(dependencies, problems);
  const blockers = sortIssues(problems);
  return {
    schema_version: 1,
    processes: [...processes].sort((left, right) => compareText(left.span.path, right.span.path)
      || left.span.start_line - right.span.start_line || compareText(left.name, right.name)),
    covered_processes: covered.size,
    declarations: [...declarations].sort((left, right) => compareText(left.span.path, right.span.path)
      || left.span.start_line - right.span.start_line || compareText(left.kind, right.kind)),
    configuration_issues: sortIssues(configurationIssues),
    config_closure: configClosure,
    nextflow_plugins: nextflowPlugins,
    conda_environments: condaEnvironments.map((environment) => ({
      path: environment.path,
      digest: environment.digest,
      channels: environment.channels,
      dependencies: environment.dependencies,
      problems: environment.problems,
      referenced_by: [...environment.referenced_by].sort((left, right) => compareText(left.span.path, right.span.path)
        || left.span.start_line - right.span.start_line),
    })),
    pixi_closure: {
      status: blockers.length ? "blocked" : "candidate",
      channels: sharedChannels,
      dependencies: merged,
      blockers,
    },
  };
}
