import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const benchmarkCaseCli = fileURLToPath(new URL("../../scripts/benchmark-case.ts", import.meta.url));
const benchmarkCase = "workflow.graph_wide_10k";

type JsonRecord = Record<string, unknown>;

function assertRecord(value: unknown, label: string): asserts value is JsonRecord {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  assert.ok(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number`);
}

function assertCallFrame(value: unknown, label: string) {
  assertRecord(value, label);
  assert.equal(typeof value.functionName, "string", `${label}.functionName must be a string`);
  assert.equal(typeof value.scriptId, "string", `${label}.scriptId must be a string`);
  assert.equal(typeof value.url, "string", `${label}.url must be a string`);
  assertFiniteNumber(value.lineNumber, `${label}.lineNumber`);
  assertFiniteNumber(value.columnNumber, `${label}.columnNumber`);
}

function runProfile(kind: "cpu" | "heap", outputPath: string) {
  const profiled = spawnSync(process.execPath, [
    "--experimental-strip-types",
    benchmarkCaseCli,
    benchmarkCase,
    "--profile",
    kind,
    "--profile-output",
    outputPath,
  ], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(profiled.status, 0, profiled.stderr || profiled.error?.message);
  const receipt = JSON.parse(profiled.stdout) as unknown;
  assertRecord(receipt, "benchmark receipt");
  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.id, benchmarkCase);
  assertRecord(receipt.quality, "benchmark receipt quality");
  assert.equal(receipt.quality.passed, true);
}

test("scoped CPU profiling emits a valid V8 CPU profile", { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-cpu-profile-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "benchmark.cpuprofile");

  runProfile("cpu", outputPath);

  const profile = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
  assertRecord(profile, "CPU profile");
  assertFiniteNumber(profile.startTime, "CPU profile startTime");
  assertFiniteNumber(profile.endTime, "CPU profile endTime");
  assert.ok(profile.endTime >= profile.startTime, "CPU profile endTime precedes startTime");
  assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0, "CPU profile must contain nodes");
  assert.ok(Array.isArray(profile.samples) && profile.samples.length > 0, "CPU profile must contain samples");
  assert.ok(Array.isArray(profile.timeDeltas), "CPU profile must contain timeDeltas");
  assert.equal(profile.timeDeltas.length, profile.samples.length, "CPU samples and timeDeltas must align");

  const nodeIds = new Set<number>();
  for (const [index, node] of profile.nodes.entries()) {
    assertRecord(node, `CPU profile node ${index}`);
    assertFiniteNumber(node.id, `CPU profile node ${index}.id`);
    assertCallFrame(node.callFrame, `CPU profile node ${index}.callFrame`);
    nodeIds.add(node.id);
  }
  for (const [index, sample] of profile.samples.entries()) {
    assertFiniteNumber(sample, `CPU profile sample ${index}`);
    assert.ok(nodeIds.has(sample), `CPU profile sample ${index} references an unknown node`);
  }
  for (const [index, delta] of profile.timeDeltas.entries()) {
    assertFiniteNumber(delta, `CPU profile timeDelta ${index}`);
    assert.ok(delta >= 0, `CPU profile timeDelta ${index} must not be negative`);
  }
});

test("scoped heap profiling emits a valid V8 sampling heap profile", { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-heap-profile-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "benchmark.heapprofile");

  runProfile("heap", outputPath);

  const profile = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
  assertRecord(profile, "heap profile");
  assertRecord(profile.head, "heap profile head");
  assert.ok(Array.isArray(profile.samples) && profile.samples.length > 0, "heap profile must contain samples");

  const nodeIds = new Set<number>();
  const pending: unknown[] = [profile.head];
  while (pending.length) {
    const node = pending.pop();
    assertRecord(node, "heap profile node");
    assertFiniteNumber(node.id, "heap profile node.id");
    assertFiniteNumber(node.selfSize, "heap profile node.selfSize");
    assertCallFrame(node.callFrame, "heap profile node.callFrame");
    assert.ok(Array.isArray(node.children), "heap profile node.children must be an array");
    nodeIds.add(node.id);
    pending.push(...node.children);
  }
  for (const [index, sample] of profile.samples.entries()) {
    assertRecord(sample, `heap profile sample ${index}`);
    assertFiniteNumber(sample.size, `heap profile sample ${index}.size`);
    assertFiniteNumber(sample.nodeId, `heap profile sample ${index}.nodeId`);
    assertFiniteNumber(sample.ordinal, `heap profile sample ${index}.ordinal`);
    assert.ok(nodeIds.has(sample.nodeId), `heap profile sample ${index} references an unknown node`);
  }
});

test("profiling rejects malformed arguments before writing an artifact", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-invalid-profile-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "must-not-exist.cpuprofile");
  const malformedArguments = [
    [benchmarkCase, "--profile", "cpu"],
    [benchmarkCase, "--profile", "alloc", "--profile-output", outputPath],
    [benchmarkCase, "--profile", "cpu", "--profile-output", "relative.cpuprofile"],
    [benchmarkCase, "--profile", "cpu", "--profile-output", outputPath, "unexpected"],
  ];

  for (const args of malformedArguments) {
    const profiled = spawnSync(process.execPath, ["--experimental-strip-types", benchmarkCaseCli, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.notEqual(profiled.status, 0, `malformed arguments unexpectedly passed: ${args.join(" ")}`);
    assert.match(profiled.stderr, /benchmark profile arguments are invalid/);
  }
  assert.equal(existsSync(outputPath), false, "malformed profile arguments wrote an artifact");
  assert.equal(existsSync(join(root, "relative.cpuprofile")), false, "relative profile output was accepted");
});
