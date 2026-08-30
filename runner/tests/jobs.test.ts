import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import type { SomiteGraph } from "@somite/workflow/model";
import { RunManager } from "../src/jobs.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function graphFixture() {
  const cases = JSON.parse(await readFile(join(repositoryRoot, "testdata", "assessment-parity-graphs.json"), "utf8")) as Array<{ name: string; graph: SomiteGraph }>;
  return cases.find((candidate) => candidate.name === "connected local FastQC workflow is ready")!.graph;
}

async function mockProject() {
  const root = await mkdtemp(join(tmpdir(), "somite-ts-jobs-"));
  const bin = join(root, "bin");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const pixi = join(bin, "pixi");
  await writeFile(pixi, `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "lock") {
  const manifest = args[args.indexOf("--manifest-path") + 1];
  await writeFile(join(dirname(manifest), "pixi.lock"), "version: 6\\n");
  process.exit(0);
}
const delay = Number(process.env.SOMITE_MOCK_RUN_DELAY_MS ?? 0);
if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
const nodeMap = JSON.parse(await readFile(join(process.cwd(), "node-map.json"), "utf8"));
await mkdir(join(process.cwd(), ".somite"), { recursive: true });
const processes = Object.values(nodeMap.nodes).map((entry) => entry.process).filter(Boolean);
await writeFile(join(process.cwd(), ".somite", "trace.tsv"), "name\\tstatus\\texit\\thash\\n" + processes.map((name) => name + "\\tCOMPLETED\\t0\\tmock").join("\\n") + "\\n");
await mkdir(join(process.cwd(), "results"), { recursive: true });
await writeFile(join(process.cwd(), "results", "output.txt"), "ok\\n");
`, "utf8");
  await chmod(pixi, 0o755);
  return { root, path: `${bin}${delimiter}${process.env.PATH ?? ""}` };
}

async function terminalStatus(manager: RunManager, id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await manager.status(id, 100);
    if (["completed", "failed", "cancelled"].includes(status.phase)) return status;
  }
  throw new Error("run did not become terminal");
}

test("TypeScript runner freezes, executes, traces, validates, and exports one path", async () => {
  const project = await mockProject();
  const previousPath = process.env.PATH;
  process.env.PATH = project.path;
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const graph = await graphFixture();
    const manager = new RunManager(project.root, repositoryRoot, catalog);

    const started = await manager.start(graph, "run");
    const run = await terminalStatus(manager, started.run_id);
    assert.equal(run.phase, "completed", run.error);
    assert.equal(run.states.input1, "done");
    assert.equal(run.states.fastqc1, "done");
    assert.match(run.closure_digest ?? "", /^blake3:/);

    const validationStarted = await manager.start(graph, "validation");
    const validation = await terminalStatus(manager, validationStarted.run_id);
    assert.equal(validation.phase, "completed", validation.error);
    assert.equal(validation.evidence_receipt?.result, "passed");
    assert.equal(validation.evidence_receipt?.fixture_digests.length, 1);
    const evidence = await manager.validationStatus(graph);
    assert.equal(evidence.receipt?.receipt_digest, validation.evidence_receipt?.receipt_digest);
    const receiptPath = join(
      project.root,
      ".somite",
      "evidence",
      "receipts",
      `${validation.evidence_receipt!.receipt_digest.slice("blake3:".length)}.json`,
    );
    assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).receipt_digest, validation.evidence_receipt?.receipt_digest);

    const exported = await manager.export(graph, { archiveName: "RNA seq", platform: "linux-64" });
    assert.equal(exported.filename, "RNA-seq.somite-run.zip");
    assert.deepEqual([...exported.bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  } finally {
    process.env.PATH = previousPath;
    await rm(project.root, { recursive: true, force: true });
  }
});

test("cancellation terminates the active process tree and settles honestly", async () => {
  const project = await mockProject();
  const previousPath = process.env.PATH;
  process.env.PATH = project.path;
  process.env.SOMITE_MOCK_RUN_DELAY_MS = "5000";
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const manager = new RunManager(project.root, repositoryRoot, catalog);
    const started = await manager.start(await graphFixture(), "run");
    let status = await manager.status(started.run_id, 100);
    while (status.phase === "preparing") status = await manager.status(started.run_id, 100);
    await manager.cancel(started.run_id);
    const cancelled = await terminalStatus(manager, started.run_id);
    assert.equal(cancelled.phase, "cancelled");
    assert.ok(Object.values(cancelled.states).every((state) => ["done", "cached", "cancelled", "skipped"].includes(state)));
  } finally {
    delete process.env.SOMITE_MOCK_RUN_DELAY_MS;
    process.env.PATH = previousPath;
    await rm(project.root, { recursive: true, force: true });
  }
});

test("runner shutdown cancels active workflow process trees before returning", async () => {
  const project = await mockProject();
  const previousPath = process.env.PATH;
  process.env.PATH = project.path;
  process.env.SOMITE_MOCK_RUN_DELAY_MS = "5000";
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const manager = new RunManager(project.root, repositoryRoot, catalog);
    const started = await manager.start(await graphFixture(), "run");
    let status = await manager.status(started.run_id, 100);
    while (status.phase === "preparing") status = await manager.status(started.run_id, 100);

    await manager.shutdown();

    const stopped = await manager.status(started.run_id);
    assert.equal(stopped.phase, "cancelled");
  } finally {
    delete process.env.SOMITE_MOCK_RUN_DELAY_MS;
    process.env.PATH = previousPath;
    await rm(project.root, { recursive: true, force: true });
  }
});

test("evidence lookup fails closed when its durable index is malformed", async () => {
  const project = await mockProject();
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const manager = new RunManager(project.root, repositoryRoot, catalog);
    const evidenceDirectory = join(project.root, ".somite", "evidence");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(evidenceDirectory, { recursive: true }));
    await writeFile(join(evidenceDirectory, "index.json"), "{not valid json\n", "utf8");

    await assert.rejects(
      manager.evidence("blake3:subject"),
      /evidence index is malformed/,
    );
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});
