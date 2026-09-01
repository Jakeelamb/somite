import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { atomicWrite, ensurePrivateDirectory } from "../runner/src/files.ts";
import { spawnOwnedProcess, terminateOwnedProcess, throwIfProcessInterrupted, waitForOwnedProcessTermination } from "./process-owner.ts";

const RECEIPT_BYTES = 64 * 1024;
const ERROR_MESSAGE_BYTES = 2 * 1024;
const TEMPORARY_PREFIX = "somite-source-proof-";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

type PhaseReceipt = Readonly<{
  name: string;
  duration_ms: number;
  result: "passed" | "failed";
}>;

class CommandError extends Error {
  constructor(label: string, code: number | null, signal: NodeJS.Signals | null) {
    super(`${label} exited with ${code === null ? `signal ${signal ?? "unknown"}` : `status ${code}`}`);
    this.name = "CommandError";
  }
}

function boundedText(value: unknown, maximumBytes: number) {
  const text = value instanceof Error ? value.message : String(value);
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maximumBytes) return text;
  return `${bytes.subarray(0, Math.max(0, maximumBytes - 3)).toString("utf8").replace(/\uFFFD+$/u, "")}...`;
}

function run(command: string, args: readonly string[], options: Readonly<{
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  label: string;
  timeoutMs: number;
}>) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let timedOut = false;
    const child = spawnOwnedProcess(command, args, {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      stdio: "inherit",
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateOwnedProcess(child);
    }, options.timeoutMs);
    timeout.unref();
    child.once("error", rejectPromise);
    child.once("close", async (code, signal) => {
      clearTimeout(timeout);
      await waitForOwnedProcessTermination(child);
      try { throwIfProcessInterrupted(); } catch (error) { rejectPromise(error); return; }
      if (timedOut) rejectPromise(new Error(`${options.label} exceeded ${options.timeoutMs} ms`));
      else if (code === 0) resolvePromise();
      else rejectPromise(new CommandError(options.label, code, signal));
    });
  });
}

function capture(command: string, args: readonly string[], options: Readonly<{
  cwd: string;
  label: string;
  maximumBytes: number;
  timeoutMs: number;
}>) {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let timedOut = false;
    const child = spawnOwnedProcess(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateOwnedProcess(child, 0);
    }, options.timeoutMs);
    timeout.unref();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maximumBytes) {
        overflow = true;
        terminateOwnedProcess(child, 0);
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", rejectPromise);
    child.once("close", async (code, signal) => {
      clearTimeout(timeout);
      await waitForOwnedProcessTermination(child);
      try { throwIfProcessInterrupted(); } catch (error) { rejectPromise(error); return; }
      if (timedOut) {
        rejectPromise(new Error(`${options.label} exceeded ${options.timeoutMs} ms`));
      } else if (overflow) {
        rejectPromise(new Error(`${options.label} exceeded ${options.maximumBytes} output bytes`));
      } else if (code !== 0) {
        rejectPromise(new CommandError(options.label, code, signal));
      } else {
        resolvePromise(Buffer.concat(chunks).toString("utf8"));
      }
    });
  });
}

async function timed(phases: PhaseReceipt[], name: string, action: () => Promise<void>) {
  const started = performance.now();
  try {
    await action();
    phases.push({ name, duration_ms: Math.round(performance.now() - started), result: "passed" });
  } catch (error) {
    phases.push({ name, duration_ms: Math.round(performance.now() - started), result: "failed" });
    throw error;
  }
}

async function temporaryBase() {
  const configured = process.env.RUNNER_TEMP;
  if (configured !== undefined && !isAbsolute(configured)) throw new Error("RUNNER_TEMP must be an absolute path");
  const selected = configured ?? tmpdir();
  const metadata = await lstat(selected);
  if (!metadata.isDirectory()) throw new Error("temporary base must be a directory");
  return realpath(selected);
}

async function removeProofRoot(base: string, proofRoot: string) {
  const canonicalBase = await realpath(base);
  const resolvedProof = resolve(proofRoot);
  const fromBase = relative(canonicalBase, resolvedProof);
  const metadata = await lstat(resolvedProof);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || dirname(resolvedProof) !== canonicalBase
    || !basename(resolvedProof).startsWith(TEMPORARY_PREFIX)
    || !fromBase
    || fromBase === ".."
    || fromBase.startsWith(`..${sep}`)
    || isAbsolute(fromBase)
  ) {
    throw new Error("refusing to clean an invalid source-proof temporary path");
  }
  await rm(resolvedProof, { recursive: true, force: false });
}

const phases: PhaseReceipt[] = [];
const startedAt = new Date().toISOString();
let completedAt = startedAt;
let sourceCommit: string | undefined;
let base: string | undefined;
let proofRoot: string | undefined;
let failure: unknown;

try {
  base = await temporaryBase();
  proofRoot = await mkdtemp(join(base, TEMPORARY_PREFIX));
  const sourceRoot = join(proofRoot, "source");
  const archivePath = join(proofRoot, "source.tar");
  const npmCache = join(proofRoot, "npm-cache");
  const npmUserConfig = join(proofRoot, "npmrc");
  await Promise.all([mkdir(sourceRoot), mkdir(npmCache)]);
  await atomicWrite(npmUserConfig, "");
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(childEnvironment)) {
    if (name.toLowerCase().startsWith("npm_config_")) delete childEnvironment[name];
  }
  childEnvironment.NPM_CONFIG_CACHE = npmCache;
  childEnvironment.NPM_CONFIG_USERCONFIG = npmUserConfig;

  sourceCommit = (await capture("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    label: "git rev-parse HEAD",
    maximumBytes: 256,
    timeoutMs: 30_000,
  })).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("git rev-parse HEAD returned an invalid commit identity");

  await timed(phases, "archive", () => run("git", ["archive", "--format=tar", `--output=${archivePath}`, "HEAD"], {
    cwd: repositoryRoot,
    label: "git archive HEAD",
    timeoutMs: 30_000,
  }));
  await timed(phases, "extract", () => run("tar", ["-xf", archivePath, "-C", sourceRoot], {
    cwd: proofRoot!,
    label: "extract source archive",
    timeoutMs: 30_000,
  }));
  await timed(phases, "source_size", () => run(process.execPath, ["--experimental-strip-types", "scripts/check-release-size.ts", "--source-only"], {
    cwd: sourceRoot,
    environment: childEnvironment,
    label: "strict source-size check",
    timeoutMs: 30_000,
  }));
  await timed(phases, "npm_ci", () => run("npm", ["ci"], {
    cwd: sourceRoot,
    environment: childEnvironment,
    label: "npm ci",
    timeoutMs: 10 * 60_000,
  }));
  await timed(phases, "build", () => run("npm", ["run", "build"], {
    cwd: sourceRoot,
    environment: childEnvironment,
    label: "npm run build",
    timeoutMs: 10 * 60_000,
  }));
  await timed(phases, "launcher_smoke", () => run("npm", ["run", "smoke:launcher"], {
    cwd: sourceRoot,
    environment: childEnvironment,
    label: "npm run smoke:launcher",
    timeoutMs: 2 * 60_000,
  }));
} catch (error) {
  failure = error;
} finally {
  if (base !== undefined && proofRoot !== undefined) {
    try {
      await timed(phases, "cleanup", () => removeProofRoot(base!, proofRoot!));
    } catch (cleanupError) {
      failure = failure === undefined
        ? cleanupError
        : new AggregateError([failure, cleanupError], "source proof and cleanup both failed");
    }
  }
  completedAt = new Date().toISOString();
}

const receipt = {
  schema_version: 1,
  kind: "clean_source_proof",
  result: failure === undefined ? "passed" : "failed",
  started_at: startedAt,
  completed_at: completedAt,
  source_commit: sourceCommit ?? null,
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  phases,
  ...(failure === undefined ? {} : { error: boundedText(failure, ERROR_MESSAGE_BYTES) }),
} as const;
const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
if (receiptBytes.byteLength > RECEIPT_BYTES) throw new Error(`source-proof receipt exceeds ${RECEIPT_BYTES} bytes`);
const receiptDirectory = await ensurePrivateDirectory(repositoryRoot, "output/benchmarks");
const receiptName = `source-proof-${startedAt.replace(/[:.]/gu, "-")}-${process.pid}.json`;
const receiptPath = join(receiptDirectory, receiptName);
await atomicWrite(receiptPath, receiptBytes);
process.stdout.write(`${JSON.stringify({ receipt: relative(repositoryRoot, receiptPath), result: receipt.result })}\n`);

if (failure !== undefined) throw failure;
