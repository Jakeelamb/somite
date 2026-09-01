import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { byteDigest, canonicalJsonDigest } from "@somite/workflow/contentIdentity";

import { terminateProcessTree, withoutEnvironmentPrefix } from "./process.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_JSON_NODES = 200_000;
const MAX_JSON_DEPTH = 128;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export type NextflowInspectProcess = JsonObject & Readonly<{ name: string }>;
export type NextflowInspectDocument = JsonObject & Readonly<{
  processes: readonly NextflowInspectProcess[];
}>;

export type NextflowConfigProbeInput = Readonly<{
  pixiBinary: string;
  frozenManifestPath: string;
  projectDirectory: string;
  entrypoint: string;
  configurationPaths: readonly string[];
  profiles: readonly string[];
  paramsFile: string;
  frozenPluginDirectory: string;
  allowedPluginIds: readonly string[];
  signal?: AbortSignal;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
}>;

export type NextflowProbeCommandRequest = Readonly<{
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}>;

export type NextflowProbeCommandResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export type NextflowProbeCommandRunner = (
  request: NextflowProbeCommandRequest,
) => Promise<NextflowProbeCommandResult>;

export type NextflowSyntaxParserMode = "default" | "v1";
export type NextflowParserFallbackReason = "mixed_variable_declarations_and_config_statements";

export type NextflowProbeCommandReceipt = Readonly<{
  schema_version: 2;
  stage: "config" | "inspect";
  attempt: number;
  parser_mode: NextflowSyntaxParserMode;
  argv: readonly string[];
  cwd: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_digest: string;
  stderr_digest: string;
  receipt_digest: string;
}>;

export type NextflowConfigProbe = Readonly<{
  schema_version: 2;
  parser_mode: NextflowSyntaxParserMode;
  fallback_reason: NextflowParserFallbackReason | null;
  config: Readonly<{
    attempts: readonly NextflowProbeCommandReceipt[];
    receipt: NextflowProbeCommandReceipt;
    document: JsonObject;
  }>;
  inspect: Readonly<{
    attempts: readonly NextflowProbeCommandReceipt[];
    receipt: NextflowProbeCommandReceipt;
    document: NextflowInspectDocument;
  }>;
  proof_digest: string;
}>;

export type NextflowConfigProbeErrorCode =
  | "invalid_input"
  | "cancelled"
  | "timed_out"
  | "output_limit"
  | "command_error"
  | "command_failed"
  | "invalid_json"
  | "invalid_shape";

export class NextflowConfigProbeError extends Error {
  readonly code: NextflowConfigProbeErrorCode;
  readonly stage?: "config" | "inspect";
  readonly receipt?: NextflowProbeCommandReceipt;
  readonly attempts?: readonly NextflowProbeCommandReceipt[];
  readonly fallbackReason?: NextflowParserFallbackReason;

  constructor(
    code: NextflowConfigProbeErrorCode,
    message: string,
    options: Readonly<{
      stage?: "config" | "inspect";
      receipt?: NextflowProbeCommandReceipt;
      attempts?: readonly NextflowProbeCommandReceipt[];
      fallbackReason?: NextflowParserFallbackReason;
      cause?: unknown;
    }> = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NextflowConfigProbeError";
    this.code = code;
    this.stage = options.stage;
    this.receipt = options.receipt;
    this.attempts = options.attempts;
    this.fallbackReason = options.fallbackReason;
  }
}

class CommandOutputLimitError extends Error {}

function invalidInput(message: string): never {
  throw new NextflowConfigProbeError("invalid_input", message);
}

function exactAbsolutePath(value: string, label: string) {
  if (!value || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    invalidInput(`${label} must be one exact absolute path`);
  }
  return value;
}

function exactCliPath(value: string, label: string) {
  if (!value || /[\0\r\n,]/.test(value)) {
    invalidInput(`${label} must be one exact path without control characters or commas`);
  }
  return value;
}

function uniqueValues(values: readonly string[], label: string, pattern: RegExp) {
  const seen = new Set<string>();
  for (const value of values) {
    if (!pattern.test(value)) invalidInput(`${label} contains an invalid value: ${value}`);
    if (seen.has(value)) invalidInput(`${label} contains duplicate value: ${value}`);
    seen.add(value);
  }
  return [...values];
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    invalidInput(`${label} must be an integer between 1 and ${maximum}`);
  }
  return selected;
}

function validatedInput(input: NextflowConfigProbeInput) {
  const configurationPaths = input.configurationPaths.map((path, index) => (
    exactCliPath(path, `configurationPaths[${index}]`)
  ));
  if (!configurationPaths.length) invalidInput("configurationPaths must contain the explicit -C configuration set");
  return {
    pixiBinary: exactAbsolutePath(input.pixiBinary, "pixiBinary"),
    frozenManifestPath: exactAbsolutePath(input.frozenManifestPath, "frozenManifestPath"),
    projectDirectory: exactAbsolutePath(input.projectDirectory, "projectDirectory"),
    entrypoint: exactCliPath(input.entrypoint, "entrypoint"),
    configurationPaths,
    profiles: uniqueValues(input.profiles, "profiles", PROFILE_NAME),
    paramsFile: exactCliPath(input.paramsFile, "paramsFile"),
    frozenPluginDirectory: exactAbsolutePath(input.frozenPluginDirectory, "frozenPluginDirectory"),
    allowedPluginIds: uniqueValues(input.allowedPluginIds, "allowedPluginIds", PLUGIN_ID),
    signal: input.signal,
    commandTimeoutMs: boundedInteger(
      input.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      MAX_COMMAND_TIMEOUT_MS,
      "commandTimeoutMs",
    ),
    maxOutputBytes: boundedInteger(
      input.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    ),
  };
}

function copyBytes(chunks: readonly Buffer[], byteLength: number) {
  return new Uint8Array(Buffer.concat(chunks, byteLength));
}

function commandDiagnostic(bytes: Uint8Array) {
  let decoded: string;
  try {
    decoded = decoder.decode(bytes);
  } catch {
    return "command wrote non-UTF-8 diagnostics";
  }
  const lines = decoded.replaceAll("\r", "").split("\n")
    .map((line) => line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?"))
    .filter((line) => line.trim())
    .slice(-8);
  const detail = lines.join(" | ");
  return detail.length > 4_096 ? detail.slice(detail.length - 4_096) : detail;
}

function parserCompatibilityFailure(
  result: NextflowProbeCommandResult,
): NextflowParserFallbackReason | undefined {
  if (typeof result.code !== "number" || result.code === 0 || result.signal !== null) return undefined;
  let stderr: string;
  try {
    stderr = decoder.decode(result.stderr);
  } catch {
    return undefined;
  }
  const lines = stderr.replaceAll("\r\n", "\n").split("\n");
  const hasMixedDeclarationError = lines.some((line) => (
    /^Error [^\r\n]+:\d+:\d+: Variable declarations cannot be mixed with config statements$/.test(line)
  ));
  const hasConfigParsingSummary = lines.some((line) => line === "ERROR ~ Config parsing failed");
  return hasMixedDeclarationError && hasConfigParsingSummary
    ? "mixed_variable_declarations_and_config_statements"
    : undefined;
}

async function runNativeCommand(request: NextflowProbeCommandRequest): Promise<NextflowProbeCommandResult> {
  if (request.signal.aborted) throw new Error("operation cancelled");
  const child = spawn(request.file, request.args, {
    cwd: request.cwd,
    detached: process.platform !== "win32",
    env: request.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  const completed = new Promise<NextflowProbeCommandResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const capture = (target: Buffer[], stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const nextBytes = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
      if (nextBytes > request.maxOutputBytes) {
        terminateProcessTree(child);
        rejectOnce(new CommandOutputLimitError(`${stream} exceeded ${request.maxOutputBytes} bytes`));
        return;
      }
      target.push(chunk);
      if (stream === "stdout") stdoutBytes = nextBytes;
      else stderrBytes = nextBytes;
    };
    child.stdout!.on("data", capture(stdout, "stdout"));
    child.stderr!.on("data", capture(stderr, "stderr"));
    child.once("error", rejectOnce);
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        code,
        signal: closeSignal,
        stdout: copyBytes(stdout, stdoutBytes),
        stderr: copyBytes(stderr, stderrBytes),
      });
    });
  });
  const cancel = () => terminateProcessTree(child);
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  try {
    return await completed;
  } finally {
    request.signal.removeEventListener("abort", cancel);
  }
}

function validateJsonTree(root: unknown, stage: "config" | "inspect") {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new NextflowConfigProbeError("invalid_shape", `${stage} JSON exceeds the decoded shape limits`, { stage });
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new NextflowConfigProbeError("invalid_shape", `${stage} JSON contains a non-finite number`, { stage });
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    throw new NextflowConfigProbeError("invalid_shape", `${stage} JSON contains an unsupported value`, { stage });
  }
}

function parsedObject(bytes: Uint8Array, stage: "config" | "inspect"): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new NextflowConfigProbeError("invalid_json", `${stage} did not emit one UTF-8 JSON document`, {
      stage,
      cause: error,
    });
  }
  validateJsonTree(parsed, stage);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NextflowConfigProbeError("invalid_shape", `${stage} JSON root must be an object`, { stage });
  }
  return parsed as JsonObject;
}

function inspectDocument(bytes: Uint8Array): NextflowInspectDocument {
  const document = parsedObject(bytes, "inspect");
  if (!Array.isArray(document.processes)) {
    throw new NextflowConfigProbeError("invalid_shape", "inspect JSON must contain a processes array", { stage: "inspect" });
  }
  for (const process of document.processes) {
    if (!process || typeof process !== "object" || Array.isArray(process)
      || typeof (process as { name?: unknown }).name !== "string"
      || !(process as { name: string }).name) {
      throw new NextflowConfigProbeError("invalid_shape", "every inspect process must contain a non-empty name", { stage: "inspect" });
    }
  }
  return document as NextflowInspectDocument;
}

function commandReceipt(
  stage: "config" | "inspect",
  attempt: number,
  parserMode: NextflowSyntaxParserMode,
  file: string,
  args: readonly string[],
  cwd: string,
  result: NextflowProbeCommandResult,
): NextflowProbeCommandReceipt {
  const base = {
    schema_version: 2 as const,
    stage,
    attempt,
    parser_mode: parserMode,
    argv: [file, ...args],
    cwd,
    exit_code: result.code,
    signal: result.signal,
    stdout_bytes: result.stdout.byteLength,
    stderr_bytes: result.stderr.byteLength,
    stdout_digest: byteDigest(result.stdout),
    stderr_digest: byteDigest(result.stderr),
  };
  return { ...base, receipt_digest: canonicalJsonDigest(base) };
}

function decodeReceipt<T>(
  decode: () => T,
  receipt: NextflowProbeCommandReceipt,
  attempts: readonly NextflowProbeCommandReceipt[],
  fallbackReason?: NextflowParserFallbackReason,
): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof NextflowConfigProbeError && !error.receipt) {
      throw new NextflowConfigProbeError(error.code, error.message, {
        stage: error.stage,
        receipt,
        attempts,
        fallbackReason,
        cause: error,
      });
    }
    throw error;
  }
}

async function boundedCommand(
  stage: "config" | "inspect",
  attempt: number,
  parserMode: NextflowSyntaxParserMode,
  input: ReturnType<typeof validatedInput>,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  runner: NextflowProbeCommandRunner,
) {
  if (input.signal?.aborted) {
    throw new NextflowConfigProbeError("cancelled", "Nextflow configuration proof was cancelled", { stage });
  }
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${stage} timed out`));
  }, input.commandTimeoutMs);
  const aborted = new Promise<never>((_resolve, rejectPromise) => {
    controller.signal.addEventListener("abort", () => rejectPromise(controller.signal.reason), { once: true });
  });

  let result: NextflowProbeCommandResult;
  try {
    result = await Promise.race([
      runner({
        file: input.pixiBinary,
        args,
        cwd: input.projectDirectory,
        env,
        signal: controller.signal,
        timeoutMs: input.commandTimeoutMs,
        maxOutputBytes: input.maxOutputBytes,
      }),
      aborted,
    ]);
  } catch (error) {
    if (timedOut) {
      throw new NextflowConfigProbeError("timed_out", `${stage} exceeded ${input.commandTimeoutMs} ms`, { stage, cause: error });
    }
    if (input.signal?.aborted) {
      throw new NextflowConfigProbeError("cancelled", "Nextflow configuration proof was cancelled", { stage, cause: error });
    }
    if (error instanceof CommandOutputLimitError) {
      throw new NextflowConfigProbeError("output_limit", `${stage} exceeded the ${input.maxOutputBytes}-byte stream limit`, { stage, cause: error });
    }
    if (error instanceof NextflowConfigProbeError) throw error;
    throw new NextflowConfigProbeError("command_error", `${stage} could not be executed`, { stage, cause: error });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", cancel);
  }

  if (result.stdout.byteLength > input.maxOutputBytes || result.stderr.byteLength > input.maxOutputBytes) {
    throw new NextflowConfigProbeError("output_limit", `${stage} exceeded the ${input.maxOutputBytes}-byte stream limit`, { stage });
  }
  const receipt = commandReceipt(
    stage,
    attempt,
    parserMode,
    input.pixiBinary,
    args,
    input.projectDirectory,
    result,
  );
  if (result.code !== 0 || result.signal !== null) {
    const diagnostic = commandDiagnostic(result.stderr) || commandDiagnostic(result.stdout);
    const fallbackReason = parserCompatibilityFailure(result);
    throw new NextflowConfigProbeError(
      "command_failed",
      `${stage} exited with ${result.code ?? result.signal ?? "unknown status"}${diagnostic ? `: ${diagnostic}` : ""}`,
      {
        stage,
        receipt,
        attempts: [receipt],
        fallbackReason,
      },
    );
  }
  return { result, receipt };
}

function withAttemptHistory(
  error: unknown,
  attempts: readonly NextflowProbeCommandReceipt[],
  fallbackReason: NextflowParserFallbackReason,
): never {
  if (!(error instanceof NextflowConfigProbeError)) throw error;
  const completeAttempts = error.receipt
    && !attempts.some((attempt) => attempt.receipt_digest === error.receipt!.receipt_digest)
    ? [...attempts, error.receipt]
    : [...attempts];
  const attemptSummary = completeAttempts
    .map((attempt) => `${attempt.parser_mode}=${attempt.receipt_digest}`)
    .join(", ");
  throw new NextflowConfigProbeError(
    error.code,
    `${error.message}; parser fallback attempts: ${attemptSummary}`,
    {
      stage: error.stage,
      receipt: error.receipt,
      attempts: completeAttempts,
      fallbackReason,
      cause: error,
    },
  );
}

/**
 * Ask the pinned Nextflow binary to resolve configuration and inspect process
 * settings. Success proves only that both native commands succeeded and their
 * outputs matched the decoded JSON shapes returned here.
 */
export async function probeNextflowConfiguration(
  rawInput: NextflowConfigProbeInput,
  runner: NextflowProbeCommandRunner = runNativeCommand,
): Promise<NextflowConfigProbe> {
  const input = validatedInput(rawInput);
  const nextflowHome = await mkdtemp(join(tmpdir(), "somite-nextflow-config-proof-"));
  try {
    const commonNextflowArgs = [
      "run",
      "--frozen",
      "--manifest-path",
      input.frozenManifestPath,
      "--",
      "env",
      "-u",
      "CONDA_PREFIX",
      "nextflow",
    ];
    const configSet = input.configurationPaths.join(",");
    const profileArgs = input.profiles.length ? ["-profile", input.profiles.join(",")] : [];
    const env: NodeJS.ProcessEnv = {
      ...withoutEnvironmentPrefix(process.env, "NXF_"),
      NXF_ANSI_LOG: "false",
      NXF_CACHE_DIR: join(nextflowHome, "cache"),
      NXF_DISABLE_CHECK_LATEST: "true",
      NXF_HOME: nextflowHome,
      NXF_OFFLINE: "true",
      NXF_PLUGINS_ALLOWED: input.allowedPluginIds.join(","),
      NXF_PLUGINS_DEFAULT: "false",
      NXF_PLUGINS_DIR: input.frozenPluginDirectory,
      NXF_WORK: join(nextflowHome, "work"),
    };

    const configArgs = [
      ...commonNextflowArgs,
      "-log",
      join(nextflowHome, "config.log"),
      "-C",
      configSet,
      "config",
      ".",
      ...profileArgs,
      "-o",
      "json",
    ];
    let parserMode: NextflowSyntaxParserMode = "default";
    let fallbackReason: NextflowParserFallbackReason | null = null;
    const configAttempts: NextflowProbeCommandReceipt[] = [];
    let configRun: Awaited<ReturnType<typeof boundedCommand>>;
    try {
      configRun = await boundedCommand(
        "config",
        1,
        "default",
        input,
        configArgs,
        env,
        runner,
      );
    } catch (error) {
      if (!(error instanceof NextflowConfigProbeError)
        || error.code !== "command_failed"
        || error.stage !== "config"
        || error.fallbackReason !== "mixed_variable_declarations_and_config_statements"
        || !error.receipt) {
        throw error;
      }
      configAttempts.push(error.receipt);
      parserMode = "v1";
      fallbackReason = error.fallbackReason;
      try {
        configRun = await boundedCommand(
          "config",
          2,
          parserMode,
          input,
          configArgs,
          { ...env, NXF_SYNTAX_PARSER: "v1" },
          runner,
        );
      } catch (retryError) {
        withAttemptHistory(retryError, configAttempts, fallbackReason);
      }
    }
    configAttempts.push(configRun.receipt);
    const config = decodeReceipt(
      () => parsedObject(configRun.result.stdout, "config"),
      configRun.receipt,
      configAttempts,
      fallbackReason ?? undefined,
    );

    const inspectArgs = [
      ...commonNextflowArgs,
      "-log",
      join(nextflowHome, "inspect.log"),
      "-C",
      configSet,
      "inspect",
      input.entrypoint,
      ...profileArgs,
      "-params-file",
      input.paramsFile,
      "-format",
      "json",
    ];
    const inspectEnv = parserMode === "v1"
      ? { ...env, NXF_SYNTAX_PARSER: "v1" }
      : env;
    const inspectRun = await boundedCommand(
      "inspect",
      1,
      parserMode,
      input,
      inspectArgs,
      inspectEnv,
      runner,
    );
    const inspectAttempts = [inspectRun.receipt];
    const inspect = decodeReceipt(
      () => inspectDocument(inspectRun.result.stdout),
      inspectRun.receipt,
      inspectAttempts,
      fallbackReason ?? undefined,
    );
    const base = {
      schema_version: 2 as const,
      parser_mode: parserMode,
      fallback_reason: fallbackReason,
      config: {
        attempts: configAttempts,
        receipt: configRun.receipt,
        document: config,
      },
      inspect: {
        attempts: inspectAttempts,
        receipt: inspectRun.receipt,
        document: inspect,
      },
    };
    return { ...base, proof_digest: canonicalJsonDigest(base) };
  } finally {
    await rm(nextflowHome, { recursive: true, force: true, maxRetries: 3 });
  }
}
