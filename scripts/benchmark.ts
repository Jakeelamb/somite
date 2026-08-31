import { createHash } from "node:crypto";
import { access, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, arch, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_HARNESS_FILES,
  BenchmarkSeriesMismatch,
  MAX_BENCHMARK_REPORT_BYTES,
  compareBenchmarkReports,
  parseBenchmarkReport,
  percentile,
  semanticDigest,
  summarizeBenchmarkSamples,
  tapOutcomeQuality,
  type BenchmarkCaseReport,
  type BenchmarkEnvironment,
  type BenchmarkQuality,
  type BenchmarkReport,
  type BenchmarkSample,
} from "./benchmark-core.ts";
import { spawnOwnedProcess, terminateOwnedProcess, throwIfProcessInterrupted, waitForOwnedProcessTermination } from "./process-owner.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;
const QUICK_TIMEOUT_MS = 120_000;
const RELEASE_TIMEOUT_MS = 30 * 60_000;
const NPM_SCRIPT_CONTRACT = "package.json";

function benchmarkWorkload(...files: readonly string[]) {
  return [...BENCHMARK_HARNESS_FILES, ...files];
}

function npmScriptWorkload(...files: readonly string[]) {
  return [NPM_SCRIPT_CONTRACT, ...benchmarkWorkload(...files)];
}

type QuickCase = Readonly<{
  id: string;
  warmups: number;
  repetitions: number;
  workloadFiles: readonly string[];
}>;

type ChildResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  wallMs: number;
  stdout: string;
  stderr: string;
  outputBytes: number;
  timedOut: boolean;
}>;

type WorkerRecord = Readonly<{
  schema_version: 1;
  id: string;
  wall_ms: number;
  cpu_user_ms: number;
  cpu_system_ms: number;
  peak_rss_bytes: number;
  output_bytes: number;
  stages_ms: Readonly<Record<string, number>>;
  quality: BenchmarkQuality;
}>;

const quickCases: readonly QuickCase[] = [
  { id: "workflow.graph_wide_10k", warmups: 1, repetitions: 5, workloadFiles: benchmarkWorkload("scripts/benchmark-case.ts") },
  { id: "canvas.wide_deep_5k", warmups: 1, repetitions: 5, workloadFiles: benchmarkWorkload("scripts/benchmark-case.ts") },
  { id: "source.index_8k", warmups: 1, repetitions: 5, workloadFiles: benchmarkWorkload("scripts/benchmark-case.ts") },
  { id: "compiler.linear_1k", warmups: 1, repetitions: 3, workloadFiles: benchmarkWorkload("scripts/benchmark-case.ts") },
  { id: "paper.gold_text", warmups: 1, repetitions: 3, workloadFiles: benchmarkWorkload("scripts/benchmark-case.ts", "scripts/benchmark-paper-topology.ts", "testdata/papers/gold.tsv") },
];

const releaseCases = [
  {
    id: "release.production_build",
    command: "npm",
    args: ["run", "build"],
    workloadFiles: npmScriptWorkload(
      "scripts/check-release-size.ts",
      "mcp/pixi/package.json",
      "mcp/nextflow/package.json",
      "web/package.json",
    ),
  },
  {
    id: "release.bundle_size",
    command: process.execPath,
    args: ["--experimental-strip-types", "scripts/check-release-size.ts", "--json"],
    workloadFiles: benchmarkWorkload("scripts/check-release-size.ts"),
  },
  {
    id: "release.browser_outcome",
    command: "npm",
    args: ["run", "smoke:browser"],
    workloadFiles: npmScriptWorkload(
      "runner/tests/production-browser.acceptance.ts",
      "runner/tests/helpers",
      "runner/tests/fixtures/fake-acp-agent.ts",
      "testdata/tiny_R1.fastq",
      "testdata/fastq_to_fastqc.somite.json",
      "testdata/papers/kraken2_methods.txt",
    ),
  },
  {
    id: "release.real_toolchain",
    command: "npm",
    args: ["run", "smoke:release"],
    workloadFiles: npmScriptWorkload(
      "mcp/pixi/tests/toolchain.smoke.ts",
      "mcp/nextflow/tests/toolchain.smoke.ts",
      "runner/tests/production-launcher.smoke.ts",
      "runner/tests/pixi-nextflow.smoke.ts",
      "runner/tests/production-browser-execution.smoke.ts",
      "runner/tests/helpers",
      "testdata/tiny_R1.fastq",
      "testdata/fastq_to_fastqc.somite.json",
      "testdata/assessment-parity-graphs.json",
    ),
  },
] as const;

function usage(): never {
  throw new Error([
    "usage:",
    "  benchmark.ts quick [--output PATH]",
    "  benchmark.ts release [--output PATH]",
    "  benchmark.ts compare BASELINE CANDIDATE [--report-only|--expect-new-series]",
  ].join("\n"));
}

function boundedAppend(chunks: Buffer[], chunk: Buffer, retained: { bytes: number }) {
  if (retained.bytes >= MAX_CHILD_OUTPUT_BYTES) return;
  const available = MAX_CHILD_OUTPUT_BYTES - retained.bytes;
  const kept = chunk.byteLength <= available ? chunk : chunk.subarray(0, available);
  chunks.push(kept);
  retained.bytes += kept.byteLength;
}

async function runChild(command: string, args: readonly string[], options: Readonly<{ timeoutMs: number; echo?: boolean; env?: NodeJS.ProcessEnv }> ): Promise<ChildResult> {
  const started = performance.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const retainedStdout = { bytes: 0 };
  const retainedStderr = { bytes: 0 };
  let outputBytes = 0;
  let timedOut = false;
  const child = spawnOwnedProcess(command, args, {
    cwd: repositoryRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (value: Buffer) => {
    outputBytes += value.byteLength;
    boundedAppend(stdoutChunks, value, retainedStdout);
    if (options.echo) process.stdout.write(value);
  });
  child.stderr!.on("data", (value: Buffer) => {
    outputBytes += value.byteLength;
    boundedAppend(stderrChunks, value, retainedStderr);
    if (options.echo) process.stderr.write(value);
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateOwnedProcess(child);
  }, options.timeoutMs);
  timeout.unref();
  const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveOutcome, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveOutcome({ exitCode, signal }));
  }).finally(() => clearTimeout(timeout));
  await waitForOwnedProcessTermination(child);
  throwIfProcessInterrupted();
  return {
    ...outcome,
    wallMs: performance.now() - started,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    outputBytes,
    timedOut,
  };
}

function failedQuality(id: string): BenchmarkQuality {
  return { passed: false, assertions_passed: 0, assertions_total: 1, semantic_digest: semanticDigest({ id, status: "failed" }) };
}

function failureSample(result: ChildResult): BenchmarkSample {
  return {
    wall_ms: result.wallMs,
    cpu_user_ms: null,
    cpu_system_ms: null,
    peak_rss_bytes: null,
    output_bytes: result.outputBytes,
    stages_ms: { failed_process: result.wallMs },
  };
}

function parseWorker(result: ChildResult, id: string): WorkerRecord | undefined {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) return undefined;
  try {
    const value = JSON.parse(result.stdout) as Partial<WorkerRecord>;
    if (value.schema_version !== 1 || value.id !== id || !value.quality || !value.stages_ms) return undefined;
    for (const metric of [value.wall_ms, value.cpu_user_ms, value.cpu_system_ms, value.peak_rss_bytes, value.output_bytes]) {
      if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) return undefined;
    }
    return value as WorkerRecord;
  } catch {
    return undefined;
  }
}

function workerSample(record: WorkerRecord): BenchmarkSample {
  return {
    wall_ms: record.wall_ms,
    cpu_user_ms: record.cpu_user_ms,
    cpu_system_ms: record.cpu_system_ms,
    peak_rss_bytes: record.peak_rss_bytes,
    output_bytes: record.output_bytes,
    stages_ms: record.stages_ms,
  };
}

async function pathsUnder(path: string): Promise<string[]> {
  const absolute = join(repositoryRoot, path);
  const metadata = await lstat(absolute);
  if (metadata.isFile()) return [path.replaceAll("\\", "/")];
  if (!metadata.isDirectory()) throw new Error(`benchmark workload contains a non-regular path: ${path}`);
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) files.push(...await pathsUnder(join(path, entry.name)));
  return files;
}

async function workloadDigest(paths: readonly string[]) {
  const files = [...new Set((await Promise.all(paths.map(pathsUnder))).flat())].sort();
  const hash = createHash("sha256");
  for (const path of files) {
    const bytes = await readFile(join(repositoryRoot, path));
    hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function quickWorkloadFiles(definition: QuickCase) {
  if (definition.id !== "paper.gold_text") return definition.workloadFiles;
  const rows = (await readFile(join(repositoryRoot, "testdata", "papers", "gold.tsv"), "utf8"))
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  const headers = rows.shift()?.split("\t") ?? [];
  const fixtureIndex = headers.indexOf("fixture");
  if (fixtureIndex < 0) throw new Error("paper gold corpus has no fixture column");
  const fixtures = rows.map((line) => line.split("\t")[fixtureIndex]).filter((value): value is string => Boolean(value));
  if (!fixtures.length || new Set(fixtures).size !== fixtures.length) throw new Error("paper gold corpus fixtures are empty or duplicated");
  if (fixtures.some((fixture) => !/^[A-Za-z0-9._-]+$/.test(fixture))) throw new Error("paper gold corpus contains an unsafe fixture path");
  return [...definition.workloadFiles, ...fixtures.map((fixture) => `testdata/papers/${fixture}`)];
}

function explainFailure(id: string, result: ChildResult) {
  const reason = result.timedOut
    ? "timed out"
    : `exited ${result.exitCode ?? result.signal ?? "without a status"}`;
  process.stderr.write(`Benchmark ${id} ${reason}.\n${result.stderr.slice(-4_000)}\n`);
}

async function runQuickCase(definition: QuickCase): Promise<BenchmarkCaseReport> {
  const command = process.execPath;
  const args = ["--experimental-strip-types", join(repositoryRoot, "scripts", "benchmark-case.ts"), definition.id];
  process.stdout.write(`Measuring ${definition.id} (${definition.warmups} warmup, ${definition.repetitions} samples)\n`);
  let warmupFailure: ChildResult | undefined;
  for (let index = 0; index < definition.warmups; index += 1) {
    const result = await runChild(command, args, { timeoutMs: QUICK_TIMEOUT_MS });
    if (!parseWorker(result, definition.id)) {
      explainFailure(`${definition.id} warmup`, result);
      warmupFailure = result;
      break;
    }
  }
  const samples: BenchmarkSample[] = [];
  const qualities: BenchmarkQuality[] = [];
  if (warmupFailure) {
    samples.push(failureSample(warmupFailure));
    qualities.push(failedQuality(definition.id));
  } else {
    for (let index = 0; index < definition.repetitions; index += 1) {
      const result = await runChild(command, args, { timeoutMs: QUICK_TIMEOUT_MS });
      const record = parseWorker(result, definition.id);
      samples.push(record ? workerSample(record) : failureSample(result));
      qualities.push(record?.quality ?? failedQuality(definition.id));
      if (!record) {
        explainFailure(definition.id, result);
        break;
      }
    }
  }
  const first = qualities[0] ?? failedQuality(definition.id);
  const qualityStable = qualities.every((quality) => quality.passed && quality.semantic_digest === first.semantic_digest
    && quality.assertions_passed === first.assertions_passed && quality.assertions_total === first.assertions_total);
  const quality = qualityStable ? first : failedQuality(definition.id);
  return {
    id: definition.id,
    kind: "deterministic",
    workload_digest: await workloadDigest(await quickWorkloadFiles(definition)),
    warmups: definition.warmups,
    repetitions: samples.length,
    samples,
    summary: summarizeBenchmarkSamples(samples),
    quality,
  };
}

async function version(command: string, args: readonly string[]) {
  const result = await runChild(command, args, { timeoutMs: 15_000 }).catch(() => {
    throwIfProcessInterrupted();
    return undefined;
  });
  if (!result) return null;
  if (result.exitCode !== 0) return null;
  const text = `${result.stdout}\n${result.stderr}`.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, 128) : null;
}

async function environment(suite: BenchmarkReport["suite"]): Promise<BenchmarkEnvironment> {
  const hostnameDigest = semanticDigest(hostname());
  const toolchain = suite === "release"
    ? { pixi: await version("pixi", ["--version"]), nextflow: await version("nextflow", ["-version"]) }
    : { pixi: null, nextflow: null };
  const identity = {
    hostname_digest: hostnameDigest,
    platform: platform(),
    architecture: arch(),
    cpu_model: cpus()[0]?.model ?? "unknown",
    logical_cpus: cpus().length,
    node: process.versions.node,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    toolchain,
  };
  return { series_key: semanticDigest(identity), ...identity };
}

async function git(args: readonly string[]) {
  const result = await runChild("git", args, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function reportIdentity() {
  const [revision, status, packageLock, pixiLock] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["status", "--porcelain", "--untracked-files=normal"]),
    readFile(join(repositoryRoot, "package-lock.json")),
    readFile(join(repositoryRoot, "pixi.lock")),
  ]);
  const lockHash = createHash("sha256");
  for (const [path, bytes] of [["package-lock.json", packageLock], ["pixi.lock", pixiLock]] as const) {
    lockHash.update(`${Buffer.byteLength(path)}:${path}:${bytes.byteLength}:`);
    lockHash.update(bytes);
  }
  return { revision, dirty: Boolean(status), lockfile_digest: `sha256:${lockHash.digest("hex")}` };
}

async function runMeasuredCommand(command: string, args: readonly string[]): Promise<{ sample: BenchmarkSample; quality: BenchmarkQuality; stdout: string }> {
  const timeAvailable = process.platform === "linux" && await access("/usr/bin/time").then(() => true).catch(() => false);
  const temporary = await mkdtemp(join(tmpdir(), "somite-benchmark-time-"));
  const timingPath = join(temporary, "usage.txt");
  try {
    const measuredCommand = timeAvailable ? "/usr/bin/time" : command;
    const commandArgs = timeAvailable
      ? ["-f", "user=%U\nsystem=%S\nrss_kib=%M", "-o", timingPath, "--", command, ...args]
      : [...args];
    const result = await runChild(measuredCommand, commandArgs, { timeoutMs: RELEASE_TIMEOUT_MS, echo: true });
    let cpuUser: number | null = null;
    let cpuSystem: number | null = null;
    let peakRss: number | null = null;
    if (timeAvailable) {
      const usage = await readFile(timingPath, "utf8").catch(() => "");
      const metrics = Object.fromEntries(usage.trim().split("\n").map((line) => line.split("=", 2)));
      const user = Number(metrics.user);
      const system = Number(metrics.system);
      const rss = Number(metrics.rss_kib);
      if (Number.isFinite(user) && Number.isFinite(system) && Number.isFinite(rss)) {
        cpuUser = user * 1_000;
        cpuSystem = system * 1_000;
        peakRss = rss * 1024;
      }
    }
    const passed = result.exitCode === 0 && result.signal === null && !result.timedOut;
    return {
      sample: {
        wall_ms: result.wallMs,
        cpu_user_ms: cpuUser,
        cpu_system_ms: cpuSystem,
        peak_rss_bytes: peakRss,
        output_bytes: result.outputBytes,
        stages_ms: { command: result.wallMs },
      },
      quality: passed
        ? { passed: true, assertions_passed: 1, assertions_total: 1, semantic_digest: semanticDigest({ command: [basename(command), ...args], status: "passed" }) }
        : failedQuality([basename(command), ...args].join(" ")),
      stdout: result.stdout,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runReleaseCase(definition: typeof releaseCases[number]): Promise<BenchmarkCaseReport> {
  process.stdout.write(`Measuring ${definition.id}\n`);
  const result = await runMeasuredCommand(definition.command, definition.args);
  let sample = result.sample;
  let quality = result.quality;
  if ((definition.id === "release.browser_outcome" || definition.id === "release.real_toolchain") && quality.passed) {
    quality = tapOutcomeQuality(definition.id, result.stdout);
  }
  if (definition.id === "release.bundle_size" && quality.passed) {
    try {
      const profile = JSON.parse(result.stdout) as { schema_version?: number; bundle?: { bytes?: number }; limits?: unknown };
      if (profile.schema_version !== 1 || !profile.bundle || !Number.isSafeInteger(profile.bundle.bytes) || profile.bundle.bytes! < 0) {
        throw new Error("invalid bundle profile");
      }
      sample = { ...sample, output_bytes: profile.bundle.bytes! };
      quality = { ...quality, semantic_digest: semanticDigest({ schema_version: profile.schema_version, limits: profile.limits, status: "passed" }) };
    } catch {
      quality = failedQuality(definition.id);
    }
  }
  return {
    id: definition.id,
    kind: "host_trend",
    workload_digest: await workloadDigest(definition.workloadFiles),
    warmups: 0,
    repetitions: 1,
    samples: [sample],
    summary: summarizeBenchmarkSamples([sample]),
    quality,
  };
}

async function atomicReport(path: string, report: BenchmarkReport) {
  const parsed = parseBenchmarkReport(report);
  const contents = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_BENCHMARK_REPORT_BYTES) throw new Error("benchmark report exceeds its byte budget");
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function outputArgument(args: readonly string[]) {
  if (!args.length) return undefined;
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) usage();
  return resolve(args[1]);
}

async function runSuite(suite: BenchmarkReport["suite"], args: readonly string[]) {
  const output = outputArgument(args);
  const startedAt = new Date().toISOString();
  const identity = await reportIdentity();
  const cases: BenchmarkCaseReport[] = [];
  if (suite === "quick") {
    for (const definition of quickCases) cases.push(await runQuickCase(definition));
  } else {
    for (const definition of releaseCases) cases.push(await runReleaseCase(definition));
  }
  const report: BenchmarkReport = {
    schema_version: 1,
    suite,
    ...identity,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    environment: await environment(suite),
    cases,
  };
  const destination = output ?? join(repositoryRoot, "output", "benchmarks", `${startedAt.replace(/[:.]/g, "-")}-${suite}.json`);
  await atomicReport(destination, report);
  process.stdout.write(`Benchmark receipt: ${relative(repositoryRoot, destination) || destination}\n`);
  for (const item of cases) {
    process.stdout.write(`${item.quality.passed ? "PASS" : "FAIL"} ${item.id}: median ${item.summary.median_wall_ms.toFixed(2)} ms, peak RSS ${item.summary.max_peak_rss_bytes === null ? "unavailable" : `${(item.summary.max_peak_rss_bytes / 1024 / 1024).toFixed(1)} MiB`}\n`);
  }
  if (cases.some((item) => !item.quality.passed)) process.exitCode = 1;
}

async function loadReport(path: string) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.size > MAX_BENCHMARK_REPORT_BYTES) throw new Error(`benchmark report ${path} is not a bounded regular file`);
  return parseBenchmarkReport(JSON.parse(await readFile(absolute, "utf8")));
}

function delta(baseline: number | null, candidate: number | null, unit: string, scale = 1) {
  if (baseline === null || candidate === null) return "unavailable";
  const percentage = baseline === 0 ? (candidate === 0 ? 0 : Number.POSITIVE_INFINITY) : (candidate - baseline) / baseline * 100;
  const relative = Number.isFinite(percentage) ? `${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}%` : "+inf%";
  return `${(baseline / scale).toFixed(2)} -> ${(candidate / scale).toFixed(2)} ${unit} (${relative})`;
}

function printComparison(baseline: BenchmarkReport, candidate: BenchmarkReport) {
  const baselineCases = new Map(baseline.cases.map((item) => [item.id, item]));
  for (const current of candidate.cases) {
    const previous = baselineCases.get(current.id)!;
    const stages = Object.keys(current.samples[0]!.stages_ms).sort().map((stage) => {
      const baselineStage = percentile(previous.samples.map((sample) => sample.stages_ms[stage]!), .5);
      const candidateStage = percentile(current.samples.map((sample) => sample.stages_ms[stage]!), .5);
      return `${stage} ${delta(baselineStage, candidateStage, "ms")}`;
    });
    process.stdout.write([
      current.id,
      `wall ${delta(previous.summary.median_wall_ms, current.summary.median_wall_ms, "ms")}`,
      `max ${delta(previous.summary.max_wall_ms, current.summary.max_wall_ms, "ms")}`,
      `CPU ${delta(previous.summary.median_cpu_ms, current.summary.median_cpu_ms, "ms")}`,
      `RSS ${delta(previous.summary.max_peak_rss_bytes, current.summary.max_peak_rss_bytes, "MiB", 1024 * 1024)}`,
      `output ${delta(previous.summary.median_output_bytes, current.summary.median_output_bytes, "KiB", 1024)}`,
      `quality ${previous.quality.semantic_digest === current.quality.semantic_digest ? "unchanged" : "changed"}`,
      `stages [${stages.join(", ")}]`,
    ].join("; ") + "\n");
  }
}

async function compare(args: readonly string[]) {
  const mode = args.at(-1) === "--report-only"
    ? "report-only"
    : args.at(-1) === "--expect-new-series"
      ? "expect-new-series"
      : "blocking";
  const paths = mode === "blocking" ? args : args.slice(0, -1);
  if (paths.length !== 2) usage();
  const [baseline, candidate] = await Promise.all([loadReport(paths[0]!), loadReport(paths[1]!)]);
  let regressions: ReturnType<typeof compareBenchmarkReports>;
  try {
    regressions = compareBenchmarkReports(baseline, candidate);
  } catch (error) {
    const resettable = error instanceof BenchmarkSeriesMismatch
      && error.kind !== "suite"
      && error.kind !== "host";
    if (mode !== "expect-new-series" || !resettable) throw error;
    const failed = [...baseline.cases, ...candidate.cases].find((item) => !item.quality.passed || item.quality.assertions_passed !== item.quality.assertions_total);
    if (failed) throw new Error(`new benchmark series contains a failing outcome: ${failed.id}`);
    process.stdout.write(`Confirmed intentional benchmark series reset (${error.kind}): ${error.message}\n`);
    return;
  }
  if (mode === "expect-new-series") throw new Error("benchmark reports are still comparable; remove the benchmark-series-reset label");
  printComparison(baseline, candidate);
  if (!regressions.length) {
    process.stdout.write("No benchmark regressions crossed the comparison policy.\n");
    return;
  }
  for (const regression of regressions) {
    process.stdout.write(`${regression.case_id} ${regression.metric}: ${regression.baseline} -> ${regression.candidate} (${regression.detail})\n`);
  }
  if (candidate.suite === "release" && regressions.some((regression) => regression.metric !== "quality")) {
    process.stdout.write("Release timings are host trends and do not block changes.\n");
  }
  if (regressions.some((regression) => regression.metric === "quality")
    || (candidate.suite !== "release" && mode !== "report-only")) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
if (command === "quick") await runSuite("quick", args);
else if (command === "release") await runSuite("release", args);
else if (command === "compare") await compare(args);
else usage();
