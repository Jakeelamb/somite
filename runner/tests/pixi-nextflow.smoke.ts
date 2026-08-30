import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { byteDigest } from "@somite/workflow/contentIdentity";
import type { SomiteGraph } from "@somite/workflow/model";
import { RunManager, type RunStatus } from "../src/jobs.ts";
import { pixiPlatform } from "../src/system.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function representativeGraph() {
  const cases = JSON.parse(await readFile(join(repositoryRoot, "testdata", "assessment-parity-graphs.json"), "utf8")) as Array<{ name: string; graph: SomiteGraph }>;
  const fixture = cases.find((candidate) => candidate.name === "connected local FastQC workflow is ready");
  assert.ok(fixture);
  return fixture.graph;
}

async function terminalStatus(manager: RunManager, id: string) {
  const deadline = Date.now() + 15 * 60_000;
  let status: RunStatus;
  do {
    status = await manager.status(id, 1_000);
    if (["completed", "failed", "cancelled"].includes(status.phase)) return status;
  } while (Date.now() < deadline);
  throw new Error(`real execution ${id} did not become terminal`);
}

test("RunManager completes representative validation through real Pixi and Nextflow", { timeout: 20 * 60_000 }, async (context) => {
  assert.notEqual(process.platform, "win32", "the real execution smoke requires a supported POSIX host");
  const projectRoot = await mkdtemp(join(tmpdir(), "somite-pixi-nextflow-smoke-"));
  const cacheParent = await mkdtemp(join(tmpdir(), "somite-pixi-nextflow-cache-"));
  const cacheRoot = join(cacheParent, "pixi");
  const previousCacheRoot = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.SOMITE_PIXI_CACHE_DIR = cacheRoot;
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const manager = new RunManager(projectRoot, repositoryRoot, catalog);
  context.after(async () => {
    await manager.shutdown();
    if (previousCacheRoot === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCacheRoot;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(cacheParent, { recursive: true, force: true });
  });

  const started = await manager.start(await representativeGraph(), "validation", "release-smoke-validation");
  const status = await terminalStatus(manager, started.run_id);
  assert.equal(status.phase, "completed", status.error);
  assert.equal(status.exit_code, 0);
  assert.equal(status.states.input1, "done");
  assert.ok(["done", "cached"].includes(status.states.fastqc1));
  assert.match(status.closure_digest ?? "", /^blake3:/);
  assert.equal(status.evidence_receipt?.result, "passed");
  assert.equal(status.evidence_receipt?.fixture_digests.length, 1);

  const packageRoot = join(projectRoot, ".somite", "runs", started.run_id);
  await assert.rejects(lstat(join(packageRoot, ".pixi")), { code: "ENOENT" });
  const lockBytes = await readFile(join(packageRoot, "pixi.lock"));
  const lock = lockBytes.toString("utf8");
  assert.match(lock, /fastqc/);
  assert.match(lock, /nextflow/);
  assert.match(lock, /openjdk/);
  const lockDigest = byteDigest(lockBytes).slice("blake3:".length);
  const manifestDigest = byteDigest(await readFile(join(packageRoot, "pixi.toml"))).slice("blake3:".length);
  await assert.rejects(lstat(join(projectRoot, ".somite", "pixi", "environments")), { code: "ENOENT" });
  const platformRoot = join(cacheRoot, "v1", pixiPlatform());
  const entries = await readdir(platformRoot);
  assert.equal(entries.length, 1, "one frozen lock should install one shared environment");
  const environmentRoot = join(platformRoot, entries[0]!);
  assert.ok((await stat(join(environmentRoot, ".pixi", "envs", "default"))).isDirectory());
  const environment = JSON.parse(await readFile(join(environmentRoot, "environment.json"), "utf8")) as Record<string, unknown>;
  assert.equal(environment.lock_digest, `blake3:${lockDigest}`);
  assert.equal(environment.manifest_digest, `blake3:${manifestDigest}`);
  assert.equal(environment.platform, pixiPlatform());
  const trace = await readFile(join(packageRoot, ".somite", "trace.tsv"), "utf8");
  assert.match(trace, /COMPLETED|CACHED/);
});
