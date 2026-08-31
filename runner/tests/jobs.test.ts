import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { operatorPorts } from "@somite/workflow/catalog";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { byteDigest } from "@somite/workflow/contentIdentity";
import type { SomiteGraph } from "@somite/workflow/model";
import type { FrozenSourceFile } from "@somite/workflow/nextflowSource";
import { applySourceWorkflowEdits, deriveSourceWorkflow, promoteSourceInvocations } from "@somite/workflow/sourceWorkflow";
import { SOMITE_TYPESCRIPT_RUNNER_IDENTITY } from "@somite/workflow/version";
import {
  FrozenPackageSizeError,
  RunManager,
  enforceFrozenArchiveSize,
  enforceFrozenPackageFiles,
} from "../src/jobs.ts";
import { PixiCache } from "../src/pixiCache.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const testCacheParent = await mkdtemp(join(tmpdir(), "somite-ts-jobs-cache-"));
const testCacheRoot = join(testCacheParent, "pixi");
const previousPixiCacheRoot = process.env.SOMITE_PIXI_CACHE_DIR;
process.env.SOMITE_PIXI_CACHE_DIR = testCacheRoot;
after(async () => {
  if (previousPixiCacheRoot === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
  else process.env.SOMITE_PIXI_CACHE_DIR = previousPixiCacheRoot;
  await rm(testCacheParent, { recursive: true, force: true });
});

async function graphFixture() {
  const cases = JSON.parse(await readFile(join(repositoryRoot, "testdata", "assessment-parity-graphs.json"), "utf8")) as Array<{ name: string; graph: SomiteGraph }>;
  return cases.find((candidate) => candidate.name === "connected local FastQC workflow is ready")!.graph;
}

async function promotedVariantFixture() {
  const paths = [
    "main.nf",
    "modules/odgi_stats.nf",
    "modules/wfmash.nf",
    "nextflow_schema.json",
    "subworkflows/odgi_qc.nf",
    "workflows/pangenome.nf",
  ];
  const files = await Promise.all(paths.map(async (path): Promise<FrozenSourceFile> => ({
    path,
    mode: 0o100644,
    bytes: await readFile(join(repositoryRoot, "testdata", "source-workflow", path)),
  })));
  const { workflow } = deriveSourceWorkflow(files, {
    provider: "nf_core",
    repository: "https://github.com/nf-core/pangenome",
    requested_revision: "fixture",
    resolved_revision: "0123456789abcdef0123456789abcdef01234567",
    entrypoint: "main.nf",
  });
  const invocations = workflow.invocations?.slice(0, 2) ?? [];
  assert.equal(invocations.length, 2);
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const imported = catalog.get("files.import")!;
  const fastqc = catalog.get("qc.fastqc")!;
  const edited = applySourceWorkflowEdits(workflow, workflow.workflow_revision, [{
    kind: "replace_invocation",
    invocation_id: invocations[0]!.id,
    operator: imported.id,
    operator_revision: imported.revision,
    params: { path: "data/reads.fastq" },
  }, {
    kind: "replace_invocation",
    invocation_id: invocations[1]!.id,
    operator: fastqc.id,
    operator_revision: fastqc.revision,
    params: {},
  }]);
  const source = catalog.get("workflow.source")!;
  const promoted = promoteSourceInvocations({
    schema_version: 3,
    name: "Promoted source validation",
    nodes: [{
      id: "source",
      operator: source.id,
      operator_revision: source.revision,
      ports: operatorPorts(source),
      params: {},
      source_workflow: edited,
      layout: { x: 0, y: 0 },
    }],
    edges: [],
  }, edited.workflow_revision, invocations.map((invocation) => invocation.id), catalog);
  return {
    catalog,
    graph: {
      ...promoted,
      edges: [{
        id: "reads-to-fastqc",
        from_node: promoted.variant_origin!.promoted_invocations![invocations[0]!.id]!,
        from_port: "file",
        to_node: promoted.variant_origin!.promoted_invocations![invocations[1]!.id]!,
        to_port: "fastq",
      }],
    } satisfies SomiteGraph,
  };
}

async function mockProject() {
  const root = await mkdtemp(join(tmpdir(), "somite-ts-jobs-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "reads.fastq"), "@read\nACGT\n+\n!!!!\n");
  const pixi = join(bin, "pixi");
  await writeFile(pixi, `#!/usr/bin/env node
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
await appendFile(join(dirname(process.argv[1]), "invocations.log"), args[0] + "\\n");
if (args[0] === "lock") {
  const manifest = args[args.indexOf("--manifest-path") + 1];
  const delay = Number(process.env.SOMITE_MOCK_LOCK_DELAY_MS ?? 0);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  await writeFile(join(dirname(manifest), "pixi.lock"), "version: 6\\n");
  process.exit(0);
}
if (args[0] === "install") {
  const manifest = args[args.indexOf("--manifest-path") + 1];
  await mkdir(join(dirname(manifest), ".pixi", "envs", "default"), { recursive: true });
  process.exit(0);
}
const delay = Number(process.env.SOMITE_MOCK_RUN_DELAY_MS ?? 0);
if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
if (process.env.SOMITE_MOCK_RUN_FAILURE) {
  process.stdout.write("Nextflow console failure detail\\n");
  const padding = process.env.SOMITE_MOCK_RUN_LARGE_LOG ? "x".repeat(256 * 1024) + "\\n" : "";
  await writeFile(join(process.cwd(), ".nextflow.log"), padding + "Nextflow internal failure detail\\n");
  process.exit(31);
}
const params = JSON.parse(await readFile(join(process.cwd(), "params.json"), "utf8"));
for (const input of Object.values(params.inputs ?? {})) await lstat(input);
const nodeMap = JSON.parse(await readFile(join(process.cwd(), "node-map.json"), "utf8"));
await mkdir(join(process.cwd(), ".somite"), { recursive: true });
const processes = Object.values(nodeMap.nodes).map((entry) => entry.process).filter(Boolean);
await writeFile(join(process.cwd(), ".somite", "trace.tsv"), "name\\tstatus\\texit\\thash\\n" + processes.map((name) => name + "\\tCOMPLETED\\t0\\tmock").join("\\n") + "\\n");
await mkdir(join(process.cwd(), "results"), { recursive: true });
await writeFile(join(process.cwd(), "results", "output.txt"), "ok\\n");
`, "utf8");
  await chmod(pixi, 0o755);
  return { root, path: `${bin}${delimiter}${process.env.PATH ?? ""}`, log: join(bin, "invocations.log") };
}

async function terminalStatus(manager: RunManager, id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await manager.status(id, 100);
    if (["completed", "failed", "cancelled"].includes(status.phase)) return status;
  }
  throw new Error("run did not become terminal");
}

test("frozen package limits reject one complete component or archive beyond its envelope", () => {
  const limits = { workflowDocumentBytes: 4, pixiLockBytes: 4, generatedBytes: 4, archiveBytes: 12 };
  assert.equal(enforceFrozenPackageFiles(new Map([
    ["workflow.somite.json", new Uint8Array(4)],
    ["pixi.lock", new Uint8Array(4)],
    ["main.nf", new Uint8Array(4)],
  ]), limits), 12);

  assert.throws(
    () => enforceFrozenPackageFiles(new Map([
      ["workflow.somite.json", new Uint8Array(5)],
      ["pixi.lock", new Uint8Array(1)],
    ]), limits),
    (error: unknown) => error instanceof FrozenPackageSizeError
      && error.code === "workflow_document_too_large"
      && error.actual_bytes === 5
      && error.maximum_bytes === 4,
  );
  assert.doesNotThrow(() => enforceFrozenArchiveSize(8, 8));
  assert.throws(
    () => enforceFrozenArchiveSize(9, 8),
    (error: unknown) => error instanceof FrozenPackageSizeError
      && error.code === "frozen_package_too_large"
      && error.actual_bytes === 9
      && error.maximum_bytes === 8,
  );
});

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
    const runMarker = JSON.parse(await readFile(join(project.root, ".somite", "runs", started.run_id, "run-status.json"), "utf8"));
    assert.equal(runMarker.phase, "completed");
    assert.equal(runMarker.closure_digest, run.closure_digest);

    const validationStarted = await manager.start(graph, "validation");
    const validation = await terminalStatus(manager, validationStarted.run_id);
    assert.equal(validation.phase, "completed", validation.error);
    assert.equal(validation.evidence_receipt?.result, "passed");
    assert.equal(validation.evidence_receipt?.verifier, SOMITE_TYPESCRIPT_RUNNER_IDENTITY);
    assert.equal(validation.evidence_receipt?.fixture_digests.length, 1);
    const validationMarker = JSON.parse(await readFile(join(project.root, ".somite", "runs", validationStarted.run_id, "run-status.json"), "utf8"));
    assert.equal(validationMarker.evidence_receipt_digest, validation.evidence_receipt?.receipt_digest);
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
    const environmentRoot = join(testCacheRoot, "v1");
    const platforms = await readdir(environmentRoot);
    assert.equal(platforms.length, 1);
    assert.equal((await readdir(join(environmentRoot, platforms[0]!))).length, 1, "one exact lock must reuse one Pixi environment");
    await assert.rejects(lstat(join(project.root, ".somite", "runs", started.run_id, ".pixi")), { code: "ENOENT" });
    await assert.rejects(lstat(join(project.root, ".somite", "runs", validationStarted.run_id, ".pixi")), { code: "ENOENT" });

    const exported = await manager.export(graph, { archiveName: "RNA seq", platform: "linux-64" });
    assert.equal(exported.filename, "RNA-seq.somite-run.zip");
    assert.deepEqual([...exported.bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    assert.deepEqual((await readFile(project.log, "utf8")).trim().split("\n").sort(), ["install", "lock", "run", "run"]);
  } finally {
    process.env.PATH = previousPath;
    await rm(project.root, { recursive: true, force: true });
  }
});

test("concurrent run retries reserve one idempotency key before preparation", async () => {
  const project = await mockProject();
  const previousPath = process.env.PATH;
  process.env.PATH = project.path;
  process.env.SOMITE_MOCK_LOCK_DELAY_MS = "100";
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const manager = new RunManager(project.root, repositoryRoot, catalog);
    const graph = await graphFixture();
    const [first, replay] = await Promise.all([
      manager.start(graph, "run", "same-run-key"),
      manager.start(graph, "run", "same-run-key"),
    ]);
    assert.equal(first.run_id, replay.run_id);
    assert.deepEqual(new Set([first.replayed, replay.replayed]), new Set([false, true]));
    await terminalStatus(manager, first.run_id);
    await manager.shutdown();
  } finally {
    delete process.env.SOMITE_MOCK_LOCK_DELAY_MS;
    process.env.PATH = previousPath;
    await rm(project.root, { recursive: true, force: true });
  }
});

test("a progressively promoted source variant validates and exports through the native runner with provenance", async () => {
  const project = await mockProject();
  const previousPath = process.env.PATH;
  process.env.PATH = project.path;
  try {
    const { catalog, graph } = await promotedVariantFixture();
    const manager = new RunManager(project.root, repositoryRoot, catalog);
    const started = await manager.start(graph, "validation");
    const validation = await terminalStatus(manager, started.run_id);
    assert.equal(validation.phase, "completed", validation.error);
    assert.equal(validation.evidence_receipt?.result, "passed");
    const nodeMap = JSON.parse(await readFile(join(project.root, ".somite", "runs", started.run_id, "node-map.json"), "utf8")) as {
      nodes: Record<string, { source?: { invocation_id: string; source_digest: string } }>;
    };
    const sourceEntries = Object.values(nodeMap.nodes).map((entry) => entry.source).filter(Boolean);
    assert.equal(sourceEntries.length, 2);
    assert.ok(sourceEntries.every((entry) => entry?.source_digest === graph.variant_origin?.source_node.source_workflow?.source.source_digest));
    const exported = await manager.export(graph, { archiveName: "Promoted variant", platform: "linux-64" });
    assert.equal(exported.filename, "Promoted-variant.somite-run.zip");
    assert.deepEqual([...exported.bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    await manager.shutdown();
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

test("failed runs surface Nextflow stdout and log evidence when stderr is empty", async () => {
  const project = await mockProject();
  const previousPath = process.env.PATH;
  let manager: RunManager | undefined;
  process.env.PATH = project.path;
  process.env.SOMITE_MOCK_RUN_FAILURE = "1";
  process.env.SOMITE_MOCK_RUN_LARGE_LOG = "1";
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    manager = new RunManager(project.root, repositoryRoot, catalog);
    const started = await manager.start(await graphFixture(), "validation");
    const failed = await terminalStatus(manager, started.run_id);

    assert.equal(failed.phase, "failed");
    assert.equal(failed.exit_code, 31);
    assert.match(failed.error ?? "", /stdout:\nNextflow console failure detail/);
    assert.match(failed.error ?? "", /\.nextflow\.log:\n\[earlier log bytes omitted\]/);
    assert.match(failed.error ?? "", /Nextflow internal failure detail/);
    assert.ok((failed.error?.length ?? 0) <= 70 * 1024, "failure evidence must remain byte-bounded");
    assert.equal(failed.evidence_receipt?.result, "failed");
    const nextflowLog = Buffer.from(`${"x".repeat(256 * 1024)}\nNextflow internal failure detail\n`);
    assert.ok(failed.evidence_receipt?.log_digests.includes(byteDigest(nextflowLog)));
  } finally {
    await manager?.shutdown();
    delete process.env.SOMITE_MOCK_RUN_FAILURE;
    delete process.env.SOMITE_MOCK_RUN_LARGE_LOG;
    process.env.PATH = previousPath;
    await rm(project.root, { recursive: true, force: true });
  }
});

test("production runs resolve graph-relative inputs before entering the run directory", async () => {
  const project = await mockProject();
  const previousPath = process.env.PATH;
  process.env.PATH = project.path;
  try {
    const graphBase = join(project.root, "graphs");
    await mkdir(join(graphBase, "data"), { recursive: true });
    await writeFile(join(graphBase, "data", "reads.fastq"), "@graph\nTGCA\n+\n!!!!\n");
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const graph = await graphFixture();
    const manager = new RunManager(project.root, repositoryRoot, catalog);

    const started = await manager.start(graph, "run", undefined, { graphBase, relativeInputOrder: "graph_first" });
    const run = await terminalStatus(manager, started.run_id);
    assert.equal(run.phase, "completed", run.error);
    const params = JSON.parse(await readFile(join(project.root, ".somite", "runs", started.run_id, "params.json"), "utf8"));
    assert.deepEqual(Object.values(params.inputs), [join(graphBase, "data", "reads.fastq")]);
    assert.equal(graph.nodes[0]?.params?.path, "data/reads.fastq");
    await manager.shutdown();
  } finally {
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

test("cancelling one Pixi cache waiter does not cancel another", async () => {
  const project = await mockProject();
  const previousPath = process.env.PATH;
  process.env.PATH = project.path;
  process.env.SOMITE_MOCK_LOCK_DELAY_MS = "100";
  try {
    const cache = new PixiCache(project.root);
    const firstAbort = new AbortController();
    const first = cache.lock("[workspace]\nname='one'\n", "linux-64", firstAbort.signal);
    const survivor = cache.lock("[workspace]\nname='one'\n", "linux-64");
    const firstRejected = assert.rejects(first, /operation cancelled/);
    firstAbort.abort();
    await firstRejected;
    assert.match((await survivor).lock_digest, /^blake3:/);

    const kept = cache.lock("[workspace]\nname='two'\n", "linux-64");
    const lateAbort = new AbortController();
    const cancelled = cache.lock("[workspace]\nname='two'\n", "linux-64", lateAbort.signal);
    const cancelledRejected = assert.rejects(cancelled, /operation cancelled/);
    lateAbort.abort();
    await cancelledRejected;
    assert.match((await kept).lock_digest, /^blake3:/);

    assert.equal((await readFile(project.log, "utf8")).trim().split("\n").filter((command) => command === "lock").length, 2);
  } finally {
    delete process.env.SOMITE_MOCK_LOCK_DELAY_MS;
    process.env.PATH = previousPath;
    await rm(project.root, { recursive: true, force: true });
  }
});
