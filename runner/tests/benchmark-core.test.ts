import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_HARNESS_FILES,
  compareBenchmarkReports,
  MAX_BENCHMARK_OUTPUT_BYTES,
  parseBenchmarkCaseMeasurement,
  parseBenchmarkReport,
  percentile,
  semanticDigest,
  summarizeBenchmarkSamples,
  tapOutcomeQuality,
  type BenchmarkReport,
  type BenchmarkSample,
} from "../../scripts/benchmark-core.ts";

const MEBIBYTE = 1024 * 1024;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const benchmarkCli = fileURLToPath(new URL("../../scripts/benchmark.ts", import.meta.url));

test("benchmark identity binds the npm and Pixi task entrypoints", () => {
  assert.ok(BENCHMARK_HARNESS_FILES.includes("package.json"));
  assert.ok(BENCHMARK_HARNESS_FILES.includes("pixi.toml"));
});

function sample(overrides: Partial<BenchmarkSample> = {}): BenchmarkSample {
  return {
    wall_ms: 100,
    cpu_user_ms: 60,
    cpu_system_ms: 20,
    peak_rss_bytes: 100 * MEBIBYTE,
    output_bytes: 1_024,
    stages_ms: { work: 90 },
    ...overrides,
  };
}

function report(options: Readonly<{
  hostCharacter?: string;
  lockCharacter?: string;
  workloadDigest?: string;
  samples?: readonly BenchmarkSample[];
  quality?: BenchmarkReport["cases"][number]["quality"];
  suite?: BenchmarkReport["suite"];
}> = {}): BenchmarkReport {
  const samples = options.samples ?? [sample()];
  const environmentIdentity = {
    hostname_digest: digest(options.hostCharacter ?? "f"),
    platform: "linux",
    architecture: "x64",
    cpu_model: "Test CPU",
    logical_cpus: 8,
    node: "22.19.0",
    locale: "en-US",
    timezone: "UTC",
    toolchain: { pixi: null, nextflow: null },
  } as const;
  return {
    schema_version: 1,
    suite: options.suite ?? "quick",
    revision: "benchmark-revision",
    dirty: false,
    lockfile_digest: digest(options.lockCharacter ?? "a"),
    started_at: "2026-08-30T18:00:00.000Z",
    completed_at: "2026-08-30T18:00:01.000Z",
    environment: {
      series_key: semanticDigest(environmentIdentity),
      ...environmentIdentity,
    },
    cases: [{
      id: "workflow.graph_wide_10k",
      kind: "deterministic",
      workload_digest: options.workloadDigest ?? digest("b"),
      warmups: 1,
      repetitions: samples.length,
      samples,
      summary: summarizeBenchmarkSamples(samples),
      quality: options.quality ?? {
        passed: true,
        assertions_passed: 3,
        assertions_total: 3,
        semantic_digest: digest("c"),
      },
    }],
  };
}

test("isolated benchmark measurements are decoded before becoming evidence", () => {
  const valid = {
    schema_version: 1,
    id: "source.index_8k",
    ...sample(),
    quality: {
      passed: true,
      assertions_passed: 5,
      assertions_total: 5,
      semantic_digest: digest("c"),
    },
  };
  assert.deepEqual(parseBenchmarkCaseMeasurement(structuredClone(valid), valid.id), valid);
  assert.throws(
    () => parseBenchmarkCaseMeasurement({ ...structuredClone(valid), unexpected: true }, valid.id),
    /unknown or missing fields/,
  );
  assert.throws(
    () => parseBenchmarkCaseMeasurement({ ...structuredClone(valid), id: "paper.gold_text" }, valid.id),
    /does not match/,
  );
  assert.throws(
    () => parseBenchmarkCaseMeasurement({
      ...structuredClone(valid),
      output_bytes: MAX_BENCHMARK_OUTPUT_BYTES + 1,
    }),
    /output_bytes exceeds/,
  );
  assert.throws(
    () => parseBenchmarkCaseMeasurement({
      ...structuredClone(valid),
      quality: { ...valid.quality, assertions_passed: 4 },
    }),
    /contradicts its assertion counts/,
  );
});

test("benchmark report parsing accepts the exact schema and rejects forged summaries or extra fields", () => {
  const valid = report();
  assert.deepEqual(parseBenchmarkReport(structuredClone(valid)), valid);

  const staleSummary = {
    ...structuredClone(valid),
    cases: valid.cases.map((benchmarkCase, index) => index === 0
      ? { ...benchmarkCase, summary: { ...benchmarkCase.summary, median_wall_ms: 99_999 } }
      : benchmarkCase),
  };
  assert.throws(
    () => parseBenchmarkReport(staleSummary),
    /summary does not match its samples/,
  );

  assert.throws(
    () => parseBenchmarkReport({ ...structuredClone(valid), unexpected: true }),
    /unknown or missing fields/,
  );
  const forgedHost = structuredClone(valid);
  (forgedHost.environment as { series_key: string }).series_key = digest("0");
  assert.throws(() => parseBenchmarkReport(forgedHost), /does not match its canonical environment fields/);
  const nullWallTime = structuredClone(valid);
  (nullWallTime.cases[0]!.samples[0] as { wall_ms: unknown }).wall_ms = null;
  assert.throws(() => parseBenchmarkReport(nullWallTime), /wall_ms must be a finite non-negative number/);
});

test("percentiles and summaries use nearest-rank samples without averaging measurements", () => {
  const samples = [
    sample({ wall_ms: 90, cpu_user_ms: 9, cpu_system_ms: 5, peak_rss_bytes: 110, output_bytes: 500 }),
    sample({ wall_ms: 10, cpu_user_ms: 3, cpu_system_ms: 3, peak_rss_bytes: 90, output_bytes: 100 }),
    sample({ wall_ms: 50, cpu_user_ms: 6, cpu_system_ms: 4, peak_rss_bytes: 150, output_bytes: 300 }),
    sample({ wall_ms: 30, cpu_user_ms: 4, cpu_system_ms: 4, peak_rss_bytes: 120, output_bytes: 200 }),
    sample({ wall_ms: 70, cpu_user_ms: 7, cpu_system_ms: 5, peak_rss_bytes: 130, output_bytes: 400 }),
  ];

  assert.equal(percentile([90, 10, 50, 30, 70], .5), 50);
  assert.equal(percentile([90, 10, 50, 30, 70], .95), 90);
  assert.equal(percentile([90, 10, 50, 30, 70], 0), 10);
  assert.deepEqual(summarizeBenchmarkSamples(samples), {
    median_wall_ms: 50,
    max_wall_ms: 90,
    median_cpu_ms: 10,
    max_peak_rss_bytes: 150,
    median_output_bytes: 300,
  });
  assert.throws(() => percentile([], .5), /empty sample set/);
  assert.throws(() => percentile([1], 1.01), /between zero and one/);

  const unavailable = summarizeBenchmarkSamples([
    sample(),
    sample({ cpu_system_ms: null, peak_rss_bytes: null }),
  ]);
  assert.equal(unavailable.median_cpu_ms, null);
  assert.equal(unavailable.max_peak_rss_bytes, null);
});

test("release TAP quality binds the actual managed Pixi lock closure", () => {
  const prefix = "✔ managed execution passed (12.3ms)\nℹ pass 1\n";
  const first = tapOutcomeQuality("release.real_toolchain", `${prefix}SOMITE_MANAGED_LOCK_DIGEST blake3:${"a".repeat(64)}\n`);
  const second = tapOutcomeQuality("release.real_toolchain", `${prefix}# SOMITE_MANAGED_LOCK_DIGEST blake3:${"b".repeat(64)}\n`);
  assert.equal(first.passed, true);
  assert.equal(first.assertions_passed, 2);
  assert.notEqual(first.semantic_digest, second.semantic_digest);

  const missing = tapOutcomeQuality("release.real_toolchain", prefix);
  const duplicated = tapOutcomeQuality("release.real_toolchain", `${prefix}SOMITE_MANAGED_LOCK_DIGEST blake3:${"a".repeat(64)}\nSOMITE_MANAGED_LOCK_DIGEST blake3:${"a".repeat(64)}\n`);
  assert.equal(missing.passed, false);
  assert.equal(duplicated.passed, false);
  assert.equal(missing.assertions_passed, 1);
  assert.equal(missing.assertions_total, 2);
});

test("benchmark comparison reports independent quality, wall, CPU, and RSS regressions", () => {
  const baseline = report();
  const candidate = report({
    samples: [sample({
      wall_ms: 140,
      cpu_user_ms: 100,
      cpu_system_ms: 15,
      peak_rss_bytes: 140 * MEBIBYTE,
    })],
    quality: {
      passed: false,
      assertions_passed: 2,
      assertions_total: 3,
      semantic_digest: digest("d"),
    },
  });

  const regressions = compareBenchmarkReports(baseline, candidate);
  assert.deepEqual(regressions.map(({ metric }) => metric), [
    "quality",
    "median_wall_ms",
    "median_cpu_ms",
    "max_peak_rss_bytes",
  ]);
  assert.deepEqual(regressions.map(({ baseline, candidate }) => [baseline, candidate]), [
    [digest("c"), digest("d")],
    [100, 140],
    [80, 115],
    [100 * MEBIBYTE, 140 * MEBIBYTE],
  ]);
});

test("benchmark comparison reports a product-stage regression hidden by whole-case timing", () => {
  const baseline = report({ samples: [sample({ wall_ms: 200, stages_ms: { product_hot_path: 50, scoring: 100 } })] });
  const candidate = report({ samples: [sample({ wall_ms: 200, stages_ms: { product_hot_path: 80, scoring: 70 } })] });
  const regressions = compareBenchmarkReports(baseline, candidate);
  assert.deepEqual(regressions.map(({ metric, detail }) => [metric, detail]), [[
    "stage_wall_ms",
    "product_hot_path median stage time regressed by more than 25% and 10 ms",
  ]]);
});

test("benchmark comparison rejects renamed or missing stages despite unchanged aggregate timing", () => {
  const baseline = report({
    samples: [sample({ wall_ms: 200, stages_ms: { product_hot_path: 50, scoring: 100 } })],
  });
  const renamedStage = report({
    samples: [sample({ wall_ms: 200, stages_ms: { renamed_hot_path: 50, scoring: 100 } })],
  });
  const missingStage = report({
    samples: [sample({ wall_ms: 200, stages_ms: { scoring: 100 } })],
  });

  assert.throws(
    () => compareBenchmarkReports(baseline, renamedStage),
    /changed its named stages and needs a new performance series/,
  );
  assert.throws(
    () => compareBenchmarkReports(baseline, missingStage),
    /changed its named stages and needs a new performance series/,
  );
});

test("benchmark comparison refuses incomparable host series and changed workloads", () => {
  const baseline = report();
  assert.throws(
    () => compareBenchmarkReports(baseline, report({ hostCharacter: "9" })),
    /hosts are not comparable/,
  );
  assert.throws(
    () => compareBenchmarkReports(baseline, report({ workloadDigest: digest("e") })),
    /changed its workload or scorer/,
  );
  assert.throws(
    () => compareBenchmarkReports(baseline, report({ lockCharacter: "e" })),
    /dependency locks are not comparable/,
  );
});

test("report-only comparisons keep semantic quality and comparability blocking", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-benchmark-compare-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const baselinePath = join(root, "baseline.json");
  const candidatePath = join(root, "candidate.json");
  const baseline = report();
  const changedQuality = report({
    quality: {
      passed: true,
      assertions_passed: 3,
      assertions_total: 3,
      semantic_digest: digest("d"),
    },
  });
  await Promise.all([
    writeFile(baselinePath, JSON.stringify(baseline)),
    writeFile(candidatePath, JSON.stringify(changedQuality)),
  ]);
  const quality = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCli, "compare", baselinePath, candidatePath, "--report-only"], { encoding: "utf8" });
  assert.equal(quality.status, 1, quality.stderr);
  assert.match(quality.stdout, /quality/);

  await writeFile(candidatePath, JSON.stringify(report({ hostCharacter: "9" })));
  const separateHost = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCli, "compare", baselinePath, candidatePath, "--report-only"], { encoding: "utf8" });
  assert.notEqual(separateHost.status, 0);
  assert.match(separateHost.stderr, /hosts are not comparable/);
});

test("an explicit series reset accepts only a changed contract with passing outcomes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-benchmark-series-reset-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const baselinePath = join(root, "baseline.json");
  const candidatePath = join(root, "candidate.json");
  const baseline = report();
  await writeFile(baselinePath, JSON.stringify(baseline));

  await writeFile(candidatePath, JSON.stringify(report({ workloadDigest: digest("e") })));
  const reset = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCli, "compare", baselinePath, candidatePath, "--expect-new-series"], { encoding: "utf8" });
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /Confirmed intentional benchmark series reset \(workload\)/);

  await writeFile(candidatePath, JSON.stringify(baseline));
  const unnecessary = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCli, "compare", baselinePath, candidatePath, "--expect-new-series"], { encoding: "utf8" });
  assert.notEqual(unnecessary.status, 0);
  assert.match(unnecessary.stderr, /reports are still comparable/);

  await writeFile(candidatePath, JSON.stringify(report({ hostCharacter: "9", workloadDigest: digest("e") })));
  const differentHost = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCli, "compare", baselinePath, candidatePath, "--expect-new-series"], { encoding: "utf8" });
  assert.notEqual(differentHost.status, 0);
  assert.match(differentHost.stderr, /hosts are not comparable/);

  await writeFile(candidatePath, JSON.stringify(report({
    workloadDigest: digest("e"),
    quality: { passed: false, assertions_passed: 2, assertions_total: 3, semantic_digest: digest("d") },
  })));
  const failedOutcome = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCli, "compare", baselinePath, candidatePath, "--expect-new-series"], { encoding: "utf8" });
  assert.notEqual(failedOutcome.status, 0);
  assert.match(failedOutcome.stderr, /new benchmark series contains a failing outcome/);
});

test("release report-only comparisons keep semantic outcome changes blocking", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-release-benchmark-compare-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const baselinePath = join(root, "baseline.json");
  const candidatePath = join(root, "candidate.json");
  await Promise.all([
    writeFile(baselinePath, JSON.stringify(report({ suite: "release" }))),
    writeFile(candidatePath, JSON.stringify(report({
      suite: "release",
      quality: {
        passed: true,
        assertions_passed: 3,
        assertions_total: 3,
        semantic_digest: digest("d"),
      },
    }))),
  ]);

  const comparison = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCli, "compare", baselinePath, candidatePath, "--report-only"], { encoding: "utf8" });
  assert.equal(comparison.status, 1, comparison.stderr);
  assert.match(comparison.stdout, /quality/);
});

test("release report-only comparisons keep timing regressions informational", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-release-benchmark-timing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const baselinePath = join(root, "baseline.json");
  const candidatePath = join(root, "candidate.json");
  await Promise.all([
    writeFile(baselinePath, JSON.stringify(report({ suite: "release" }))),
    writeFile(candidatePath, JSON.stringify(report({
      suite: "release",
      samples: [sample({ wall_ms: 140 })],
    }))),
  ]);

  const comparison = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCli, "compare", baselinePath, candidatePath, "--report-only"], { encoding: "utf8" });
  assert.equal(comparison.status, 0, comparison.stderr);
  assert.match(comparison.stdout, /Release timings are host trends and do not block changes/);
});

test("quick benchmark fails closed with a diagnostic receipt when warmups cannot run", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-benchmark-warmup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const preloadPath = join(root, "fail-benchmark-worker.cjs");
  const outputPath = join(root, "failed-warmup.json");
  await writeFile(preloadPath, "if (process.argv.some((arg) => arg.endsWith('scripts/benchmark-case.ts'))) process.exit(42);\n");

  const benchmark = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCli, "quick", "--output", outputPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preloadPath}`.trim(),
    },
  });
  assert.equal(benchmark.status, 1, benchmark.stderr);
  assert.match(benchmark.stderr, /warmup exited 42/);

  const receipt = parseBenchmarkReport(JSON.parse(await readFile(outputPath, "utf8")));
  assert.equal(receipt.cases.length, 5);
  assert.ok(receipt.cases.every((benchmarkCase) => !benchmarkCase.quality.passed
    && benchmarkCase.repetitions === 1
    && benchmarkCase.samples.length === 1
    && "failed_process" in benchmarkCase.samples[0]!.stages_ms));
});
