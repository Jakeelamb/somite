import { byteDigest } from "./contentIdentity.ts";
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
const MAX_TASK_ENVIRONMENT_PLUGIN_DETAILS = 16;

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

function literalAfter(file: FrozenSourceFile, tokens: readonly NextflowToken[], directiveIndex: number) {
  let valueIndex = directiveIndex + 1;
  if (tokens[valueIndex]?.kind === "left_paren") valueIndex += 1;
  const value = tokens[valueIndex];
  if (value?.kind !== "string") return undefined;
  if (value.end - value.start > MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES) {
    throw new Error(`task environment config literal at line ${value.line} exceeds ${MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES} bytes`);
  }
  return tokenText(file.bytes, value);
}

function selectorEndLine(
  file: FrozenSourceFile,
  tokens: readonly NextflowToken[],
  braces: ReadonlyMap<number, number>,
  selectorIndex: number,
) {
  const selector = tokens[selectorIndex]!;
  const next = tokens[selectorIndex + 1];
  const prefixEnd = Math.min(next?.offset ?? file.bytes.byteLength, selector.end + MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES);
  const prefix = decoder.decode(file.bytes.subarray(selector.end, prefixEnd)).trimStart();
  if (!prefix.startsWith(":")) return undefined;
  const limit = Math.min(tokens.length, selectorIndex + 64);
  for (let cursor = selectorIndex + 1; cursor < limit; cursor += 1) {
    const candidate = tokens[cursor]!;
    if (candidate.offset - selector.offset > MAX_TASK_ENVIRONMENT_EXPRESSION_BYTES) break;
    if (candidate.kind === "left_brace") {
      const close = braces.get(cursor);
      return close === undefined ? selector.endLine : tokens[close]!.endLine;
    }
    if (candidate.kind === "right_brace" || candidate.kind === "semicolon") break;
  }
  return selector.endLine;
}

function inspectConfigFile(file: FrozenSourceFile) {
  try {
    decoder.decode(file.bytes);
  } catch {
    throw new Error(`task environment config ${file.path} is not UTF-8`);
  }
  const declarations: TaskEnvironmentDeclaration[] = [];
  const includes: ConfigInclude[] = [];
  const issues: TaskEnvironmentIssue[] = [];
  const tokens = tokenizeNextflow(file.bytes);
  const braces = bracePairs(tokens);
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
      const previous = tokens[index - 1];
      const qualified = previous?.kind !== "dot"
        || (tokens[index - 2]?.kind === "ident" && tokenText(file.bytes, tokens[index - 2]!) === "process");
      if (qualified) {
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
      const end = close === undefined ? index + 1 : close;
      const pluginDetails: string[] = [];
      let pluginDeclarationCount = 0;
      for (let cursor = index + 2; cursor < end; cursor += 1) {
        const candidate = tokens[cursor]!;
        if (candidate.kind !== "ident") continue;
        const directive = tokenText(file.bytes, candidate);
        if (directive !== "id" && directive !== "version") continue;
        const value = literalAfter(file, tokens, cursor);
        if (!value) continue;
        pluginDeclarationCount += 1;
        if (pluginDetails.length < MAX_TASK_ENVIRONMENT_PLUGIN_DETAILS) {
          pluginDetails.push(directive === "id" ? value : `version ${value}`);
        }
      }
      const omitted = pluginDeclarationCount - pluginDetails.length;
      const detail = pluginDetails.length
        ? ` (${pluginDetails.join(", ")}${omitted ? `, plus ${omitted} more declaration${omitted === 1 ? "" : "s"}` : ""})`
        : "";
      pushIssue(issue(
        "source_config_plugins_unsupported",
        `Nextflow plugins block${detail} in ${file.path} is not frozen by Somite's source execution environment.`,
        { path: file.path, start_line: token.line, end_line: tokens[end]?.endLine ?? token.endLine },
      ));
      index = end;
      continue;
    }
    if (name === "withName" || name === "withLabel") {
      const endLine = selectorEndLine(file, tokens, braces, index);
      if (endLine === undefined) continue;
      pushIssue(issue(
        "source_config_selector_unsupported",
        `Nextflow ${name} selector in ${file.path} is not statically resolved by Somite's source execution planner.`,
        { path: file.path, start_line: token.line, end_line: endLine },
      ));
    }
  }
  return { declarations, includes, issues };
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
  const pendingConfigs = [...new Set([entrypointConfig, "nextflow.config"])]
    .filter((path) => fileMap.has(path));
  const visitedConfigs = new Set<string>();
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
    configurationIssues.push(...indexed.issues);
    for (const include of indexed.includes) {
      if (!include.resolved_path) {
        configurationIssues.push(issue(
          "task_environment_config_include_unresolved",
          `includeConfig in ${include.span.path} is not one frozen source-relative literal: ${include.expression}.`,
          include.span,
        ));
      } else if (!fileMap.has(include.resolved_path)) {
        configurationIssues.push(issue(
          "task_environment_config_include_missing",
          `includeConfig in ${include.span.path} refers to missing frozen config ${include.resolved_path}.`,
          include.span,
        ));
      } else pendingConfigs.push(include.resolved_path);
    }
    if (declarations.length > MAX_TASK_ENVIRONMENT_DECLARATIONS) {
      throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_DECLARATIONS} task environment declarations`);
    }
    if (configurationIssues.length > MAX_TASK_ENVIRONMENT_CONFIGURATION_ISSUES) {
      throw new Error(`source exceeds ${MAX_TASK_ENVIRONMENT_CONFIGURATION_ISSUES} configuration issues`);
    }
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
        if (!dependency.channel) problems.push(issue(
          "conda_direct_channel_unqualified",
          `${declaration.process} directly declares ${dependency.match_spec} without an explicit channel; use channel::package so Pixi resolution is reproducible.`,
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
  const channelOrders = [...new Map(condaEnvironments.map((environment) => [environment.channels.join("\0"), environment.channels])).values()];
  if (channelOrders.length > 1) problems.push(issue(
    "conda_channel_order_conflict",
    `Referenced Conda environments use ${channelOrders.length} different channel orders.`,
    ...condaEnvironments.flatMap((environment) => environment.dependencies.slice(0, 1).map((entry) => entry.span)),
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
      `Direct Conda package channels are absent from the referenced environment channel order: ${absent.join(", ")}.`,
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
