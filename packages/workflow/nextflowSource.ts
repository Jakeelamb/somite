import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { byteDigest } from "./contentIdentity.ts";
import type { SourceDiagnostic, SourceInvocation, SourceScope } from "./model.ts";

export type FrozenSourceFile = Readonly<{
  path: string;
  mode: 0o100644 | 0o100755;
  bytes: Uint8Array;
}>;

export type SourceFileManifest = Readonly<{
  path: string;
  mode: 0o100644 | 0o100755;
  bytes: number;
  digest: string;
}>;

export type SourceManifest = Readonly<{
  schema_version: 1;
  source_digest: string;
  source_bytes: number;
  files: readonly SourceFileManifest[];
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_TOKENS = 1_000_000;
const MAX_SCOPES = 25_000;
const MAX_INVOCATIONS = 50_000;

function less(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function u32le(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64le(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("source length is outside the safe integer domain");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

function framed(hasher: ReturnType<typeof blake3.create>, bytes: Uint8Array) {
  hasher.update(u64le(bytes.byteLength));
  hasher.update(bytes);
}

export function safeSourcePath(path: string) {
  if (!path.trim() || path.length > 4096 || path.includes("\\") || path.startsWith("/") || [...path].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) return false;
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function portablePathKey(path: string) {
  return path.split("/").map((part) => {
    const normalized = part.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[ .]+$/u, "");
    const stem = normalized.split(".")[0] ?? normalized;
    if (!normalized || /[<>:"|?*]/u.test(normalized)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(stem)) {
      throw new Error(`source path ${path} is not portable across supported filesystems`);
    }
    return normalized;
  }).join("/");
}

export function buildSourceManifest(files: readonly FrozenSourceFile[]): SourceManifest {
  if (!files.length || files.length > MAX_FILES) throw new Error(`source must contain between 1 and ${MAX_FILES} files`);
  const sorted = [...files].sort((left, right) => less(left.path, right.path));
  const portable = new Map<string, string>();
  const hasher = blake3.create();
  hasher.update(encoder.encode("somite-source-manifest-v1\0"));
  const manifest: SourceFileManifest[] = [];
  let total = 0;
  let previous = "";
  for (const file of sorted) {
    if (!safeSourcePath(file.path) || file.path.split("/").includes(".git") || (previous && previous >= file.path)) {
      throw new Error(`source contains invalid or duplicate path ${file.path}`);
    }
    if (file.mode !== 0o100644 && file.mode !== 0o100755) throw new Error(`source file ${file.path} has an unsupported mode`);
    if (file.bytes.byteLength > MAX_FILE_BYTES) throw new Error(`source file ${file.path} exceeds ${MAX_FILE_BYTES} bytes`);
    total += file.bytes.byteLength;
    if (total > MAX_SOURCE_BYTES) throw new Error(`source exceeds ${MAX_SOURCE_BYTES} bytes`);
    const portableKey = portablePathKey(file.path);
    const collision = portable.get(portableKey);
    if (collision) throw new Error(`source paths ${collision} and ${file.path} collide on a portable filesystem`);
    portable.set(portableKey, file.path);
    const pathBytes = encoder.encode(file.path);
    framed(hasher, pathBytes);
    hasher.update(u32le(file.mode));
    hasher.update(u64le(file.bytes.byteLength));
    framed(hasher, file.bytes);
    manifest.push({ path: file.path, mode: file.mode, bytes: file.bytes.byteLength, digest: byteDigest(file.bytes) });
    previous = file.path;
  }
  return {
    schema_version: 1,
    source_digest: `blake3:${bytesToHex(hasher.digest())}`,
    source_bytes: total,
    files: manifest,
  };
}

type TokenKind = "ident" | "string" | "left_brace" | "right_brace" | "left_paren" | "right_paren" | "dot" | "semicolon";
type Token = Readonly<{ kind: TokenKind; start: number; end: number; line: number; endLine: number; offset: number }>;

function asciiAlpha(byte: number) {
  return (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

function asciiNumeric(byte: number) {
  return byte >= 48 && byte <= 57;
}

function text(bytes: Uint8Array, token: Token) {
  return decoder.decode(bytes.subarray(token.start, token.end));
}

export function tokenizeNextflow(bytes: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  const push = (token: Token) => {
    if (tokens.length >= MAX_TOKENS) throw new Error(`source outline exceeds ${MAX_TOKENS} tokens`);
    tokens.push(token);
  };
  while (index < bytes.length) {
    const byte = bytes[index]!;
    if (byte === 10) {
      line += 1;
      index += 1;
    } else if (byte === 32 || byte === 9 || byte === 13 || byte === 12 || byte === 11) {
      index += 1;
    } else if (byte === 47 && bytes[index + 1] === 47) {
      index += 2;
      while (index < bytes.length && bytes[index] !== 10) index += 1;
    } else if (byte === 47 && bytes[index + 1] === 42) {
      index += 2;
      while (index + 1 < bytes.length) {
        if (bytes[index] === 10) line += 1;
        if (bytes[index] === 42 && bytes[index + 1] === 47) {
          index += 2;
          break;
        }
        index += 1;
      }
    } else if (byte === 39 || byte === 34) {
      const start = index;
      const startLine = line;
      const triple = bytes[index + 1] === byte && bytes[index + 2] === byte;
      index += triple ? 3 : 1;
      const contentStart = index;
      let contentEnd = index;
      while (index < bytes.length) {
        if (bytes[index] === 10) line += 1;
        if (triple && bytes[index] === byte && bytes[index + 1] === byte && bytes[index + 2] === byte) {
          contentEnd = index;
          index += 3;
          break;
        }
        if (!triple && bytes[index] === byte) {
          contentEnd = index;
          index += 1;
          break;
        }
        if (!triple && bytes[index] === 92 && index + 1 < bytes.length) index += 2;
        else index += 1;
      }
      if (!triple) push({ kind: "string", start: contentStart, end: contentEnd, line: startLine, endLine: line, offset: start });
    } else if (asciiAlpha(byte) || byte === 95) {
      const start = index++;
      while (index < bytes.length && (asciiAlpha(bytes[index]!) || asciiNumeric(bytes[index]!) || bytes[index] === 95)) index += 1;
      if (index - start > 1024) throw new Error("Nextflow identifier exceeds 1024 bytes");
      push({ kind: "ident", start, end: index, line, endLine: line, offset: start });
    } else {
      const kind: TokenKind | undefined = byte === 123 ? "left_brace"
        : byte === 125 ? "right_brace"
          : byte === 40 ? "left_paren"
            : byte === 41 ? "right_paren"
              : byte === 46 ? "dot"
                : byte === 59 ? "semicolon"
                  : undefined;
      if (kind) push({ kind, start: index, end: index, line, endLine: line, offset: index });
      index += 1;
    }
  }
  return tokens;
}

function tokenPairs(tokens: readonly Token[], open: TokenKind, close: TokenKind) {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  tokens.forEach((token, index) => {
    if (token.kind === open) stack.push(index);
    else if (token.kind === close) {
      const start = stack.pop();
      if (start !== undefined) pairs.set(start, index);
    }
  });
  return pairs;
}

function stableId(namespace: string, parts: readonly string[]) {
  const hasher = blake3.create();
  hasher.update(encoder.encode("somite-source-outline-v1\0"));
  for (const part of parts) framed(hasher, encoder.encode(part));
  return `${namespace}:${bytesToHex(hasher.digest())}`;
}

type IndexedScope = Readonly<{ value: SourceScope; open: number; close: number }>;
type Include = Readonly<{ alias: string; symbol: string; target?: string }>;
type IndexedFile = Readonly<{
  path: string;
  bytes: Uint8Array;
  tokens: readonly Token[];
  scopes: readonly IndexedScope[];
  includes: readonly Include[];
  parens: ReadonlyMap<number, number>;
}>;

function resolveInclude(current: string, requested: string, paths: ReadonlySet<string>) {
  if (!requested.startsWith("./") && !requested.startsWith("../")) return undefined;
  const parts = current.split("/").slice(0, -1);
  for (const part of requested.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) return undefined;
    } else parts.push(part);
  }
  const base = parts.join("/");
  return [base, `${base}.nf`, `${base}/main.nf`].find((candidate) => paths.has(candidate));
}

function indexFile(file: FrozenSourceFile, entrypoint: string, sourceDigest: string, paths: ReadonlySet<string>): IndexedFile {
  const tokens = tokenizeNextflow(file.bytes);
  const braces = tokenPairs(tokens, "left_brace", "right_brace");
  const parens = tokenPairs(tokens, "left_paren", "right_paren");
  const scopes: IndexedScope[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "ident") return;
    const keyword = text(file.bytes, token);
    let kind: SourceScope["kind"];
    let symbol: string | undefined;
    let open: number;
    if (keyword === "process" && tokens[index + 1]?.kind === "ident" && tokens[index + 2]?.kind === "left_brace") {
      kind = "process";
      symbol = text(file.bytes, tokens[index + 1]!);
      open = index + 2;
    } else if (keyword === "workflow" && tokens[index + 1]?.kind === "left_brace") {
      kind = file.path === entrypoint ? "entry_workflow" : "workflow";
      open = index + 1;
    } else if (keyword === "workflow" && tokens[index + 1]?.kind === "ident" && tokens[index + 2]?.kind === "left_brace") {
      kind = "workflow";
      symbol = text(file.bytes, tokens[index + 1]!);
      open = index + 2;
    } else return;
    const close = braces.get(open);
    if (close === undefined) return;
    if (scopes.length >= MAX_SCOPES) throw new Error(`source outline exceeds ${MAX_SCOPES} scopes`);
    const value: SourceScope = {
      id: stableId("scope", [sourceDigest, file.path, kind, symbol ?? "<entry>", String(token.offset)]),
      title: symbol ?? "Entry workflow",
      ...(symbol ? { symbol } : {}),
      kind,
      span: { path: file.path, start_line: token.line, end_line: tokens[close]!.endLine },
    };
    scopes.push({ value, open, close });
  });

  const includes: Include[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "ident" || text(file.bytes, token) !== "include" || tokens[index + 1]?.kind !== "left_brace") return;
    const open = index + 1;
    const close = braces.get(open);
    if (close === undefined || tokens[close + 1]?.kind !== "ident" || text(file.bytes, tokens[close + 1]!) !== "from" || tokens[close + 2]?.kind !== "string") return;
    const requested = text(file.bytes, tokens[close + 2]!);
    const target = resolveInclude(file.path, requested, paths);
    let cursor = open + 1;
    while (cursor < close) {
      if (tokens[cursor]?.kind !== "ident") {
        cursor += 1;
        continue;
      }
      const symbol = text(file.bytes, tokens[cursor]!);
      if (symbol === "as") {
        cursor += 1;
        continue;
      }
      let alias = symbol;
      if (tokens[cursor + 1]?.kind === "ident" && text(file.bytes, tokens[cursor + 1]!) === "as" && tokens[cursor + 2]?.kind === "ident") {
        alias = text(file.bytes, tokens[cursor + 2]!);
        cursor += 2;
      }
      includes.push({ alias, symbol, ...(target ? { target } : {}) });
      cursor += 1;
    }
  });
  return { path: file.path, bytes: file.bytes, tokens, scopes, includes, parens };
}

export function indexNextflowSource(files: readonly FrozenSourceFile[], entrypoint: string, sourceDigest: string) {
  const paths = new Set(files.map((file) => file.path));
  const diagnostics: SourceDiagnostic[] = [];
  const indexed: IndexedFile[] = [];
  for (const file of [...files].sort((left, right) => less(left.path, right.path))) {
    if (!file.path.endsWith(".nf")) continue;
    try {
      decoder.decode(file.bytes);
      indexed.push(indexFile(file, entrypoint, sourceDigest, paths));
    } catch (error) {
      if (error instanceof TypeError) {
        diagnostics.push({ code: "non_utf8_nextflow_source", message: `${file.path} is retained exactly but cannot be indexed as UTF-8.` });
      } else throw error;
    }
  }
  const scopeLookup = new Map<string, Map<string, string[]>>();
  for (const file of indexed) {
    const symbols = scopeLookup.get(file.path) ?? new Map<string, string[]>();
    for (const scope of file.scopes) {
      if (!scope.value.symbol) continue;
      symbols.set(scope.value.symbol, [...(symbols.get(scope.value.symbol) ?? []), scope.value.id]);
    }
    scopeLookup.set(file.path, symbols);
  }

  const invocations: SourceInvocation[] = [];
  for (const file of indexed) {
    const aliases = new Map(file.includes.map((include) => [include.alias, include]));
    const active: number[] = [];
    let nextScope = 0;
    for (let tokenIndex = 0; tokenIndex < file.tokens.length; tokenIndex += 1) {
      while (active.length && file.scopes[active.at(-1)!]!.close <= tokenIndex) active.pop();
      while (file.scopes[nextScope] && file.scopes[nextScope]!.open < tokenIndex) active.push(nextScope++);
      const scope = active.length ? file.scopes[active.at(-1)!] : undefined;
      if (!scope || scope.value.kind === "process") continue;
      const token = file.tokens[tokenIndex]!;
      if (token.kind !== "ident" || file.tokens[tokenIndex + 1]?.kind !== "left_paren" || file.tokens[tokenIndex - 1]?.kind === "dot") continue;
      const name = text(file.bytes, token);
      const alias = aliases.get(name);
      const local = scopeLookup.get(file.path)?.get(name);
      if (!alias && !local) continue;
      const candidates = alias?.target ? scopeLookup.get(alias.target)?.get(alias.symbol) : local;
      const callee = candidates?.length === 1 ? candidates[0] : undefined;
      const close = file.parens.get(tokenIndex + 1) ?? tokenIndex + 1;
      const span = { path: file.path, start_line: token.line, end_line: file.tokens[close]?.endLine ?? token.endLine };
      const id = stableId("invocation", [sourceDigest, scope.value.id, name, String(token.offset)]);
      if (!callee) diagnostics.push({
        code: "source_only_invocation",
        message: `${name} is retained as an exact source invocation; no local workflow or process declaration was resolved.`,
        span,
      });
      if (invocations.length >= MAX_INVOCATIONS) throw new Error(`source outline exceeds ${MAX_INVOCATIONS} invocations`);
      invocations.push({ id, caller: scope.value.id, name, ...(callee ? { callee } : {}), span });
    }
  }
  const scopes = indexed.flatMap((file) => file.scopes.map((scope) => scope.value));
  scopes.sort((left, right) => less(left.span.path, right.span.path) || left.span.start_line - right.span.start_line || less(left.id, right.id));
  invocations.sort((left, right) => less(left.span.path, right.span.path) || left.span.start_line - right.span.start_line || less(left.id, right.id));
  diagnostics.sort((left, right) => less(left.span?.path ?? "", right.span?.path ?? "")
    || (left.span?.start_line ?? 0) - (right.span?.start_line ?? 0)
    || less(left.code, right.code)
    || less(left.message, right.message));
  if (!scopes.length) diagnostics.push({ code: "source_outline_empty", message: "No Nextflow workflow or process declarations were indexed." });
  return { scopes, invocations, diagnostics };
}
