import { createHash } from "node:crypto";

export const BENCHMARK_SCHEMA_VERSION = 1 as const;
export const MAX_BENCHMARK_REPORT_BYTES = 2 * 1024 * 1024;
export const MAX_BENCHMARK_CASES = 32;
export const MAX_BENCHMARK_SAMPLES = 20;
export const MAX_BENCHMARK_OUTPUT_BYTES = 512 * 1024 * 1024;
export const BENCHMARK_HARNESS_FILES = [
  "package.json",
  "pixi.toml",
  "scripts/benchmark.ts",
  "scripts/benchmark-core.ts",
  "scripts/process-owner.ts",
] as const;

export type BenchmarkQuality = Readonly<{
  passed: boolean;
  assertions_passed: number;
  assertions_total: number;
  semantic_digest: string;
}>;

export type BenchmarkSample = Readonly<{
  wall_ms: number;
  cpu_user_ms: number | null;
  cpu_system_ms: number | null;
  peak_rss_bytes: number | null;
  output_bytes: number;
  stages_ms: Readonly<Record<string, number>>;
}>;

export type BenchmarkCaseMeasurement = Readonly<{
  schema_version: 1;
  id: string;
  wall_ms: number;
  cpu_user_ms: number | null;
  cpu_system_ms: number | null;
  peak_rss_bytes: number | null;
  output_bytes: number;
  stages_ms: Readonly<Record<string, number>>;
  quality: BenchmarkQuality;
}>;

export type BenchmarkSummary = Readonly<{
  median_wall_ms: number;
  max_wall_ms: number;
  median_cpu_ms: number | null;
  max_peak_rss_bytes: number | null;
  median_output_bytes: number;
}>;

export type BenchmarkCaseReport = Readonly<{
  id: string;
  kind: "deterministic" | "host_trend";
  workload_digest: string;
  warmups: number;
  repetitions: number;
  samples: readonly BenchmarkSample[];
  summary: BenchmarkSummary;
  quality: BenchmarkQuality;
}>;

export type BenchmarkEnvironment = Readonly<{
  series_key: string;
  hostname_digest: string;
  platform: string;
  architecture: string;
  cpu_model: string;
  logical_cpus: number;
  node: string;
  locale: string;
  timezone: string;
  toolchain: Readonly<{
    pixi: string | null;
    nextflow: string | null;
  }>;
}>;

export type BenchmarkReport = Readonly<{
  schema_version: 1;
  suite: "quick" | "release";
  revision: string;
  dirty: boolean;
  lockfile_digest: string;
  started_at: string;
  completed_at: string;
  environment: BenchmarkEnvironment;
  cases: readonly BenchmarkCaseReport[];
}>;

export type BenchmarkRegression = Readonly<{
  case_id: string;
  metric: "quality" | "median_wall_ms" | "median_cpu_ms" | "max_peak_rss_bytes" | "stage_wall_ms";
  baseline: string | number | null;
  candidate: string | number | null;
  detail: string;
}>;

export type BenchmarkSeriesMismatchKind = "suite" | "host" | "dependency_lock" | "case_set" | "workload" | "stage_contract" | "sampling_contract";

export class BenchmarkSeriesMismatch extends Error {
  readonly kind: BenchmarkSeriesMismatchKind;

  constructor(kind: BenchmarkSeriesMismatchKind, message: string) {
    super(message);
    this.name = "BenchmarkSeriesMismatch";
    this.kind = kind;
  }
}

function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number") throw new Error(`${label} must be a bounded non-negative integer`);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${label} must be a bounded non-negative integer`);
  return value;
}

function boundedString(value: unknown, label: string, maximum = 512) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a bounded non-empty string without control characters`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function nullableMetric(value: unknown, label: string) {
  return value === null ? null : finite(value, label);
}

function nullableString(value: unknown, label: string, maximum = 512) {
  return value === null ? null : boundedString(value, label, maximum);
}

function parseSample(value: unknown, label: string): BenchmarkSample {
  const raw = record(value, label);
  exactKeys(raw, ["wall_ms", "cpu_user_ms", "cpu_system_ms", "peak_rss_bytes", "output_bytes", "stages_ms"], label);
  const stages = record(raw.stages_ms, `${label}.stages_ms`);
  if (Object.keys(stages).length > 32) throw new Error(`${label}.stages_ms has too many stages`);
  const parsedStages = Object.fromEntries(Object.entries(stages).map(([key, metric]) => [
    boundedString(key, `${label}.stages_ms key`, 96),
    finite(metric, `${label}.stages_ms.${key}`),
  ]));
  return {
    wall_ms: finite(raw.wall_ms, `${label}.wall_ms`),
    cpu_user_ms: nullableMetric(raw.cpu_user_ms, `${label}.cpu_user_ms`),
    cpu_system_ms: nullableMetric(raw.cpu_system_ms, `${label}.cpu_system_ms`),
    peak_rss_bytes: nullableMetric(raw.peak_rss_bytes, `${label}.peak_rss_bytes`),
    output_bytes: integer(raw.output_bytes, `${label}.output_bytes`),
    stages_ms: parsedStages,
  };
}

function parseQuality(value: unknown, label: string): BenchmarkQuality {
  const raw = record(value, label);
  exactKeys(raw, ["passed", "assertions_passed", "assertions_total", "semantic_digest"], label);
  const total = integer(raw.assertions_total, `${label}.assertions_total`, 1_000_000);
  const passed = integer(raw.assertions_passed, `${label}.assertions_passed`, total);
  if (typeof raw.passed !== "boolean") throw new Error(`${label}.passed must be boolean`);
  if (raw.passed && (total === 0 || passed !== total)) throw new Error(`${label}.passed contradicts its assertion counts`);
  const digest = boundedString(raw.semantic_digest, `${label}.semantic_digest`, 96);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${label}.semantic_digest must be a SHA-256 digest`);
  return { passed: raw.passed, assertions_passed: passed, assertions_total: total, semantic_digest: digest };
}

/** Decode the bounded JSON emitted by one isolated benchmark worker. */
export function parseBenchmarkCaseMeasurement(
  value: unknown,
  expectedId?: string,
): BenchmarkCaseMeasurement {
  const raw = record(value, "benchmark case measurement");
  exactKeys(raw, [
    "schema_version",
    "id",
    "wall_ms",
    "cpu_user_ms",
    "cpu_system_ms",
    "peak_rss_bytes",
    "output_bytes",
    "stages_ms",
    "quality",
  ], "benchmark case measurement");
  if (raw.schema_version !== BENCHMARK_SCHEMA_VERSION) {
    throw new Error("benchmark case measurement schema version is unsupported");
  }
  const id = boundedString(raw.id, "benchmark case measurement.id", 128);
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error(`benchmark case measurement id ${id} does not match ${expectedId}`);
  }
  const sample = parseSample({
    wall_ms: raw.wall_ms,
    cpu_user_ms: raw.cpu_user_ms,
    cpu_system_ms: raw.cpu_system_ms,
    peak_rss_bytes: raw.peak_rss_bytes,
    output_bytes: raw.output_bytes,
    stages_ms: raw.stages_ms,
  }, "benchmark case measurement");
  if (!Object.keys(sample.stages_ms).length) {
    throw new Error("benchmark case measurement must contain at least one stage");
  }
  if (sample.output_bytes > MAX_BENCHMARK_OUTPUT_BYTES) {
    throw new Error(`benchmark case measurement.output_bytes exceeds ${MAX_BENCHMARK_OUTPUT_BYTES}`);
  }
  return {
    schema_version: BENCHMARK_SCHEMA_VERSION,
    id,
    ...sample,
    quality: parseQuality(raw.quality, "benchmark case measurement.quality"),
  };
}

function parseEnvironment(value: unknown): BenchmarkEnvironment {
  const raw = record(value, "environment");
  exactKeys(raw, ["series_key", "hostname_digest", "platform", "architecture", "cpu_model", "logical_cpus", "node", "locale", "timezone", "toolchain"], "environment");
  const toolchain = record(raw.toolchain, "environment.toolchain");
  exactKeys(toolchain, ["pixi", "nextflow"], "environment.toolchain");
  const hostnameDigest = boundedString(raw.hostname_digest, "environment.hostname_digest", 96);
  if (!/^sha256:[0-9a-f]{64}$/.test(hostnameDigest)) throw new Error("environment.hostname_digest must be a SHA-256 digest");
  const seriesKey = boundedString(raw.series_key, "environment.series_key", 96);
  if (!/^sha256:[0-9a-f]{64}$/.test(seriesKey)) throw new Error("environment.series_key must be a SHA-256 digest");
  const identity = {
    hostname_digest: hostnameDigest,
    platform: boundedString(raw.platform, "environment.platform", 64),
    architecture: boundedString(raw.architecture, "environment.architecture", 64),
    cpu_model: boundedString(raw.cpu_model, "environment.cpu_model", 512),
    logical_cpus: integer(raw.logical_cpus, "environment.logical_cpus", 4096),
    node: boundedString(raw.node, "environment.node", 64),
    locale: boundedString(raw.locale, "environment.locale", 128),
    timezone: boundedString(raw.timezone, "environment.timezone", 128),
    toolchain: {
      pixi: nullableString(toolchain.pixi, "environment.toolchain.pixi", 128),
      nextflow: nullableString(toolchain.nextflow, "environment.toolchain.nextflow", 128),
    },
  };
  if (semanticDigest(identity) !== seriesKey) throw new Error("environment.series_key does not match its canonical environment fields");
  return { series_key: seriesKey, ...identity };
}

export function percentile(values: readonly number[], fraction: number) {
  if (!values.length) throw new Error("cannot summarize an empty sample set");
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error("percentile fraction must be between zero and one");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))]!;
}

export function summarizeBenchmarkSamples(samples: readonly BenchmarkSample[]): BenchmarkSummary {
  if (!samples.length || samples.length > MAX_BENCHMARK_SAMPLES) throw new Error("benchmark sample count is out of bounds");
  const cpu = samples.flatMap((sample) => sample.cpu_user_ms === null || sample.cpu_system_ms === null ? [] : [sample.cpu_user_ms + sample.cpu_system_ms]);
  const memory = samples.flatMap((sample) => sample.peak_rss_bytes === null ? [] : [sample.peak_rss_bytes]);
  return {
    median_wall_ms: percentile(samples.map((sample) => sample.wall_ms), .5),
    max_wall_ms: Math.max(...samples.map((sample) => sample.wall_ms)),
    median_cpu_ms: cpu.length === samples.length ? percentile(cpu, .5) : null,
    max_peak_rss_bytes: memory.length === samples.length ? Math.max(...memory) : null,
    median_output_bytes: percentile(samples.map((sample) => sample.output_bytes), .5),
  };
}

function parseSummary(value: unknown, label: string): BenchmarkSummary {
  const raw = record(value, label);
  exactKeys(raw, ["median_wall_ms", "max_wall_ms", "median_cpu_ms", "max_peak_rss_bytes", "median_output_bytes"], label);
  return {
    median_wall_ms: finite(raw.median_wall_ms, `${label}.median_wall_ms`),
    max_wall_ms: finite(raw.max_wall_ms, `${label}.max_wall_ms`),
    median_cpu_ms: nullableMetric(raw.median_cpu_ms, `${label}.median_cpu_ms`),
    max_peak_rss_bytes: nullableMetric(raw.max_peak_rss_bytes, `${label}.max_peak_rss_bytes`),
    median_output_bytes: integer(raw.median_output_bytes, `${label}.median_output_bytes`),
  };
}

export function semanticDigest(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/**
 * V8 snapshots the sampling tree before its sample list. An allocation made
 * while that snapshot is being built can therefore appear only in `samples`.
 * Such a sample has no attributable call frame or matching `selfSize`, so keep
 * the completed tree authoritative and omit only those dangling samples.
 */
export function normalizeSamplingHeapProfile(value: unknown) {
  const profile = record(value, "sampling heap profile");
  const head = record(profile.head, "sampling heap profile head");
  if (!Array.isArray(profile.samples)) throw new Error("sampling heap profile samples must be an array");

  const nodeIds = new Set<number>();
  const pending: unknown[] = [head];
  while (pending.length) {
    const node = record(pending.pop(), "sampling heap profile node");
    const id = integer(node.id, "sampling heap profile node id");
    if (!Array.isArray(node.children)) throw new Error("sampling heap profile node children must be an array");
    nodeIds.add(id);
    pending.push(...node.children);
  }

  const samples = profile.samples.filter((value, index) => {
    const sample = record(value, `sampling heap profile sample ${index}`);
    return nodeIds.has(integer(sample.nodeId, `sampling heap profile sample ${index} nodeId`));
  });
  return samples.length === profile.samples.length ? profile : { ...profile, samples };
}

export function tapOutcomeQuality(id: string, stdout: string): BenchmarkQuality {
  const lines = stdout
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+\([^()]*(?:ms|s)\)$/, ""))
    .filter((line) => /^(?:✔ .+|✖ .+|ok \d+ - .+|not ok \d+ - .+|(?:ℹ|#) (?:tests|suites|pass|fail|cancelled|skipped|todo) \d+|(?:# )?SOMITE_MANAGED_LOCK_DIGEST blake3:[0-9a-f]{64})$/.test(line));
  const passCounts = lines.flatMap((line) => {
    const match = line.match(/^(?:ℹ|#) pass (\d+)$/);
    return match ? [Number(match[1])] : [];
  });
  const assertions = passCounts.length ? passCounts.reduce((total, count) => total + count, 0) : lines.filter((line) => /^(?:✔|ok \d+ -)/.test(line)).length;
  const managedLocks = lines.filter((line) => /^(?:# )?SOMITE_MANAGED_LOCK_DIGEST blake3:[0-9a-f]{64}$/.test(line));
  if (!lines.length || assertions === 0) {
    return { passed: false, assertions_passed: 0, assertions_total: 1, semantic_digest: semanticDigest({ id, status: "failed" }) };
  }
  const requiresManagedLock = id === "release.real_toolchain";
  if (requiresManagedLock && managedLocks.length !== 1) {
    return {
      passed: false,
      assertions_passed: assertions,
      assertions_total: assertions + 1,
      semantic_digest: semanticDigest({ id, test_outcome: lines, managed_lock_markers: managedLocks.length }),
    };
  }
  const total = assertions + (requiresManagedLock ? 1 : 0);
  return {
    passed: true,
    assertions_passed: total,
    assertions_total: total,
    semantic_digest: semanticDigest({ id, test_outcome: lines }),
  };
}

export function parseBenchmarkReport(value: unknown): BenchmarkReport {
  const raw = record(value, "benchmark report");
  exactKeys(raw, ["schema_version", "suite", "revision", "dirty", "lockfile_digest", "started_at", "completed_at", "environment", "cases"], "benchmark report");
  if (raw.schema_version !== BENCHMARK_SCHEMA_VERSION) throw new Error("benchmark report schema version is unsupported");
  if (raw.suite !== "quick" && raw.suite !== "release") throw new Error("benchmark report suite is unsupported");
  if (typeof raw.dirty !== "boolean") throw new Error("benchmark report dirty must be boolean");
  if (!Array.isArray(raw.cases) || !raw.cases.length || raw.cases.length > MAX_BENCHMARK_CASES) throw new Error("benchmark report cases are out of bounds");
  const cases = raw.cases.map((value, index): BenchmarkCaseReport => {
    const label = `benchmark report cases[${index}]`;
    const item = record(value, label);
    exactKeys(item, ["id", "kind", "workload_digest", "warmups", "repetitions", "samples", "summary", "quality"], label);
    if (item.kind !== "deterministic" && item.kind !== "host_trend") throw new Error(`${label}.kind is unsupported`);
    if (!Array.isArray(item.samples) || !item.samples.length || item.samples.length > MAX_BENCHMARK_SAMPLES) throw new Error(`${label}.samples are out of bounds`);
    const samples = item.samples.map((sample, sampleIndex) => parseSample(sample, `${label}.samples[${sampleIndex}]`));
    const stageNames = Object.keys(samples[0]!.stages_ms).sort();
    if (!stageNames.length || samples.some((sample) => JSON.stringify(Object.keys(sample.stages_ms).sort()) !== JSON.stringify(stageNames))) {
      throw new Error(`${label}.samples must share one non-empty stage contract`);
    }
    const repetitions = integer(item.repetitions, `${label}.repetitions`, MAX_BENCHMARK_SAMPLES);
    if (repetitions !== samples.length) throw new Error(`${label}.repetitions does not match samples`);
    const summary = summarizeBenchmarkSamples(samples);
    const advertised = parseSummary(item.summary, `${label}.summary`);
    if (Object.keys(summary).some((key) => summary[key as keyof BenchmarkSummary] !== advertised[key as keyof BenchmarkSummary])) {
      throw new Error(`${label}.summary does not match its samples`);
    }
    const workloadDigest = boundedString(item.workload_digest, `${label}.workload_digest`, 96);
    if (!/^sha256:[0-9a-f]{64}$/.test(workloadDigest)) throw new Error(`${label}.workload_digest must be a SHA-256 digest`);
    return {
      id: boundedString(item.id, `${label}.id`, 128),
      kind: item.kind,
      workload_digest: workloadDigest,
      warmups: integer(item.warmups, `${label}.warmups`, 20),
      repetitions,
      samples,
      summary,
      quality: parseQuality(item.quality, `${label}.quality`),
    };
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("benchmark report contains duplicate case ids");
  const started = boundedString(raw.started_at, "benchmark report started_at", 64);
  const completed = boundedString(raw.completed_at, "benchmark report completed_at", 64);
  if (Number.isNaN(Date.parse(started)) || Number.isNaN(Date.parse(completed))) throw new Error("benchmark report timestamps must be ISO dates");
  if (Date.parse(completed) < Date.parse(started)) throw new Error("benchmark report completed before it started");
  const lockfileDigest = boundedString(raw.lockfile_digest, "benchmark report lockfile_digest", 96);
  if (!/^sha256:[0-9a-f]{64}$/.test(lockfileDigest)) throw new Error("benchmark report lockfile_digest must be a SHA-256 digest");
  return {
    schema_version: BENCHMARK_SCHEMA_VERSION,
    suite: raw.suite,
    revision: boundedString(raw.revision, "benchmark report revision", 128),
    dirty: raw.dirty,
    lockfile_digest: lockfileDigest,
    started_at: started,
    completed_at: completed,
    environment: parseEnvironment(raw.environment),
    cases,
  };
}

function regressed(baseline: number, candidate: number, relative: number, absolute: number) {
  return candidate - baseline > absolute && candidate > baseline * (1 + relative);
}

export function compareBenchmarkReports(baseline: BenchmarkReport, candidate: BenchmarkReport): readonly BenchmarkRegression[] {
  if (baseline.suite !== candidate.suite) throw new BenchmarkSeriesMismatch("suite", "benchmark suites are not comparable");
  if (baseline.environment.series_key !== candidate.environment.series_key) throw new BenchmarkSeriesMismatch("host", "benchmark hosts are not comparable; keep them as separate performance series");
  if (baseline.lockfile_digest !== candidate.lockfile_digest) throw new BenchmarkSeriesMismatch("dependency_lock", "benchmark dependency locks are not comparable; start a new performance series");
  const baselineCases = new Map(baseline.cases.map((item) => [item.id, item]));
  if (baselineCases.size !== candidate.cases.length) throw new BenchmarkSeriesMismatch("case_set", "benchmark case sets are not comparable");
  const regressions: BenchmarkRegression[] = [];
  for (const current of candidate.cases) {
    const previous = baselineCases.get(current.id);
    if (!previous) throw new BenchmarkSeriesMismatch("case_set", `benchmark case ${current.id} is missing from the baseline`);
    if (previous.kind !== current.kind || previous.workload_digest !== current.workload_digest) {
      throw new BenchmarkSeriesMismatch("workload", `benchmark case ${current.id} changed its workload or scorer and needs a new performance series`);
    }
    const previousStages = Object.keys(previous.samples[0]!.stages_ms).sort();
    const currentStages = Object.keys(current.samples[0]!.stages_ms).sort();
    if (JSON.stringify(previousStages) !== JSON.stringify(currentStages)) {
      throw new BenchmarkSeriesMismatch("stage_contract", `benchmark case ${current.id} changed its named stages and needs a new performance series`);
    }
    if (previous.warmups !== current.warmups || previous.repetitions !== current.repetitions) {
      throw new BenchmarkSeriesMismatch("sampling_contract", `benchmark case ${current.id} changed its warmup or repetition contract and needs a new performance series`);
    }
    if (!previous.quality.passed || previous.quality.assertions_passed !== previous.quality.assertions_total) {
      throw new Error(`benchmark baseline case ${current.id} did not pass its adjudicated assertions`);
    }
    if (!current.quality.passed || current.quality.assertions_passed !== current.quality.assertions_total
      || current.quality.semantic_digest !== previous.quality.semantic_digest) {
      regressions.push({
        case_id: current.id,
        metric: "quality",
        baseline: previous.quality.semantic_digest,
        candidate: current.quality.semantic_digest,
        detail: "deterministic outcome changed or its adjudicated assertions did not all pass",
      });
    }
    if (regressed(previous.summary.median_wall_ms, current.summary.median_wall_ms, .25, 10)) {
      regressions.push({ case_id: current.id, metric: "median_wall_ms", baseline: previous.summary.median_wall_ms, candidate: current.summary.median_wall_ms, detail: "median wall time regressed by more than 25% and 10 ms" });
    }
    if (previous.summary.median_cpu_ms !== null && current.summary.median_cpu_ms !== null
      && regressed(previous.summary.median_cpu_ms, current.summary.median_cpu_ms, .25, 10)) {
      regressions.push({ case_id: current.id, metric: "median_cpu_ms", baseline: previous.summary.median_cpu_ms, candidate: current.summary.median_cpu_ms, detail: "median CPU time regressed by more than 25% and 10 ms" });
    }
    if (previous.summary.max_peak_rss_bytes !== null && current.summary.max_peak_rss_bytes !== null
      && regressed(previous.summary.max_peak_rss_bytes, current.summary.max_peak_rss_bytes, .15, 16 * 1024 * 1024)) {
      regressions.push({ case_id: current.id, metric: "max_peak_rss_bytes", baseline: previous.summary.max_peak_rss_bytes, candidate: current.summary.max_peak_rss_bytes, detail: "peak RSS regressed by more than 15% and 16 MiB" });
    }
    if (current.kind === "deterministic") {
      for (const stage of currentStages) {
        const baselineStage = percentile(previous.samples.map((sample) => sample.stages_ms[stage]!), .5);
        const candidateStage = percentile(current.samples.map((sample) => sample.stages_ms[stage]!), .5);
        if (regressed(baselineStage, candidateStage, .25, 10)) {
          regressions.push({ case_id: current.id, metric: "stage_wall_ms", baseline: baselineStage, candidate: candidateStage, detail: `${stage} median stage time regressed by more than 25% and 10 ms` });
        }
      }
    }
  }
  return regressions;
}
