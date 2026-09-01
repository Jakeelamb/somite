import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { cpus, hostname } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { ensurePrivateDirectory, immutableWrite } from "../runner/src/files.ts";
import { parseBenchmarkCaseMeasurement, semanticDigest } from "./benchmark-core.ts";
import { benchmarkProfileContractDigest } from "./benchmark-profile-contract.ts";
import { spawnOwnedProcess, terminateOwnedProcess, throwIfProcessInterrupted, waitForOwnedProcessTermination } from "./process-owner.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const supportedCases = new Set([
  "workflow.graph_wide_10k",
  "canvas.wide_deep_5k",
  "source.index_8k",
  "compiler.linear_1k",
  "paper.gold_text",
]);
const [kind, benchmarkCase, ...extra] = process.argv.slice(2);
if ((kind !== "cpu" && kind !== "heap") || !benchmarkCase || !supportedCases.has(benchmarkCase) || extra.length) {
  throw new Error(`usage: profile-benchmark.ts cpu|heap ${[...supportedCases].join("|")}`);
}

const profileDirectory = await ensurePrivateDirectory(repositoryRoot, "output/profiles");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const extension = kind === "cpu" ? "cpuprofile" : "heapprofile";
const name = `${timestamp}-${benchmarkCase}.${extension}`;
const destination = join(profileDirectory, name);

const child = spawnOwnedProcess(process.execPath, [
  "--experimental-strip-types",
  join(repositoryRoot, "scripts", "benchmark-case.ts"),
  benchmarkCase,
  "--profile",
  kind,
  "--profile-output",
  destination,
], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: ["ignore", "pipe", "inherit"],
});
const stdoutChunks: Buffer[] = [];
let stdoutBytes = 0;
child.stdout!.on("data", (chunk: Buffer) => {
  stdoutBytes += chunk.byteLength;
  if (stdoutBytes > 4 * 1024 * 1024) terminateOwnedProcess(child, 0);
  else stdoutChunks.push(chunk);
  process.stdout.write(chunk);
});
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  terminateOwnedProcess(child);
}, 5 * 60_000);
const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveOutcome, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolveOutcome({ code, signal }));
}).finally(() => clearTimeout(timeout));
await waitForOwnedProcessTermination(child);
throwIfProcessInterrupted();
if (timedOut) throw new Error("profiled benchmark exceeded 300000 ms");
if (outcome.code !== 0) throw new Error(`profiled benchmark exited with ${outcome.code ?? outcome.signal ?? "unknown status"}`);
const metadata = await lstat(destination);
if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > 256 * 1024 * 1024) {
  throw new Error("generated benchmark profile is missing, empty, or exceeds 256 MiB");
}
const worker = parseBenchmarkCaseMeasurement(
  JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as unknown,
  benchmarkCase,
);
if (!worker.quality.passed) throw new Error("profiled benchmark did not return a passing quality receipt");

const profileBytes = await readFile(destination);
const [{ stdout: revisionOutput }, { stdout: statusOutput }, lockfile, contractDigest] = await Promise.all([
  execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1024 }),
  execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1024 * 1024 }),
  readFile(join(repositoryRoot, "package-lock.json")),
  benchmarkProfileContractDigest(repositoryRoot, benchmarkCase),
]);
const receipt = {
  schema_version: 1,
  kind: "benchmark_profile",
  profile_kind: kind,
  benchmark_case: benchmarkCase,
  created_at: new Date().toISOString(),
  revision: revisionOutput.trim(),
  dirty: Boolean(statusOutput.trim()),
  lockfile_digest: `sha256:${createHash("sha256").update(lockfile).digest("hex")}`,
  contract_digest: contractDigest,
  benchmark_quality: worker.quality,
  environment: {
    hostname_digest: semanticDigest(hostname()),
    platform: process.platform,
    architecture: process.arch,
    cpu_model: cpus()[0]?.model ?? "unknown",
    logical_cpus: cpus().length,
    node: process.versions.node,
  },
  profile: {
    path: relative(repositoryRoot, destination),
    bytes: metadata.size,
    digest: `sha256:${createHash("sha256").update(profileBytes).digest("hex")}`,
  },
} as const;
const receiptPath = `${destination}.json`;
await immutableWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`Profile: ${relative(repositoryRoot, destination)} (${metadata.size} bytes)\nReceipt: ${relative(repositoryRoot, receiptPath)}\n`);
