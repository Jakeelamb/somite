import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { byteDigest } from "@somite/workflow/contentIdentity";
import type { SomiteGraph } from "@somite/workflow/model";
import { applySourceWorkflowEdits } from "@somite/workflow/sourceWorkflow";
import { RunManager, type RunStatus } from "../src/jobs.ts";
import { ProjectGateway } from "../src/projectGateway.ts";
import { pixiPlatform } from "../src/system.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const execFileAsync = promisify(execFile);

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

async function findNamedFile(root: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findNamedFile(candidate, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name) return candidate;
  }
  return undefined;
}

test("RunManager completes representative validation through real Pixi and Nextflow", { timeout: 20 * 60_000 }, async (context) => {
  assert.notEqual(process.platform, "win32", "the real execution smoke requires a supported POSIX host");
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "somite-pixi-nextflow-smoke-")));
  const cacheParent = await realpath(await mkdtemp(join(tmpdir(), "somite-pixi-nextflow-cache-")));
  const cacheRoot = join(cacheParent, "pixi");
  const previousCacheRoot = process.env.SOMITE_PIXI_CACHE_DIR;
  const previousNextflowHome = process.env.NXF_HOME;
  const hostileNextflowHome = join(cacheParent, "hostile-nextflow-home");
  await mkdir(hostileNextflowHome);
  await writeFile(join(hostileNextflowHome, "config"), "process.executor = 'slurm'\n");
  process.env.SOMITE_PIXI_CACHE_DIR = cacheRoot;
  process.env.NXF_HOME = hostileNextflowHome;
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const manager = new RunManager(projectRoot, repositoryRoot, catalog);
  context.after(async () => {
    await manager.shutdown();
    if (previousCacheRoot === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCacheRoot;
    if (previousNextflowHome === undefined) delete process.env.NXF_HOME;
    else process.env.NXF_HOME = previousNextflowHome;
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
  process.stdout.write(`SOMITE_MANAGED_LOCK_DIGEST blake3:${lockDigest}\n`);
  const manifestDigest = byteDigest(await readFile(join(packageRoot, "pixi.toml"))).slice("blake3:".length);
  await assert.rejects(lstat(join(projectRoot, ".somite", "pixi", "environments")), { code: "ENOENT" });
  const platformRoot = join(cacheRoot, "v3", pixiPlatform());
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

  const sourceRoot = join(projectRoot, "source-demo");
  await mkdir(sourceRoot);
  await Promise.all([
    writeFile(join(sourceRoot, "main.nf"), [
      "nextflow.enable.dsl=2",
      "",
      "process HELLO {",
      "  output:",
      "  path 'hello.txt'",
      "",
      "  script:",
      "  \"\"\"",
      "  printf 'hello from frozen source\\n' > hello.txt",
      "  \"\"\"",
      "}",
      "",
      "workflow { HELLO() }",
      "",
    ].join("\n")),
    writeFile(join(sourceRoot, "pixi.toml"), await readFile(join(packageRoot, "pixi.toml"))),
    writeFile(join(sourceRoot, "pixi.lock"), lockBytes),
  ]);
  const imported = await new ProjectGateway(projectRoot, catalog).open({ path: "source-demo" });
  assert.equal(imported.kind, "nextflow");
  assert.equal(imported.graph.nodes[0]?.source_workflow?.capabilities.exact_execution, true);

  const sourceValidation = await manager.start(imported.graph, "validation", "source-preview-smoke");
  const sourceValidationStatus = await terminalStatus(manager, sourceValidation.run_id);
  assert.equal(sourceValidationStatus.phase, "completed", sourceValidationStatus.error);
  assert.equal(sourceValidationStatus.exit_code, 0);
  assert.equal(sourceValidationStatus.evidence_receipt?.kind, "source_preview_validation");
  assert.equal(sourceValidationStatus.evidence_receipt?.scope, "nextflow_source_compile_and_dag");
  assert.deepEqual(sourceValidationStatus.evidence_receipt?.fixture_digests, []);
  assert.equal(sourceValidationStatus.evidence_receipt?.artifact_digests.length, 2);
  const sourceValidationRoot = join(projectRoot, ".somite", "runs", sourceValidation.run_id, ".somite", "run");
  assert.ok((await stat(join(sourceValidationRoot, "source-preview-dag.html"))).size > 0);
  const sourceConfigProof = JSON.parse(await readFile(join(sourceValidationRoot, "nextflow-config-proof.json"), "utf8"));
  assert.equal(sourceConfigProof.schema_version, 2);
  assert.equal(sourceConfigProof.status, "passed");

  const sourceRun = await manager.start(imported.graph, "run", "source-run-smoke");
  const sourceRunStatus = await terminalStatus(manager, sourceRun.run_id);
  assert.equal(sourceRunStatus.phase, "completed", sourceRunStatus.error);
  assert.equal(sourceRunStatus.exit_code, 0);
  assert.equal(sourceRunStatus.states[imported.graph.nodes[0]!.id], "done");
  assert.match(await readFile(join(projectRoot, ".somite", "runs", sourceRun.run_id, ".somite", "run", "nextflow.log"), "utf8"), /HELLO/);

  const taskFixtureRoot = join(repositoryRoot, "testdata", "source-workflow", "source-task-execution");
  const taskSourceRoot = join(projectRoot, "source-task-demo");
  await mkdir(taskSourceRoot, { recursive: true });
  await Promise.all([
    mkdir(join(taskSourceRoot, "modules", "used_old"), { recursive: true }),
    mkdir(join(taskSourceRoot, "modules", "used_new"), { recursive: true }),
    mkdir(join(taskSourceRoot, "inputs"), { recursive: true }),
    writeFile(join(taskSourceRoot, "nextflow.config"), [
      "docker.enabled = true",
      "trace.enabled = true",
      "process {",
      "  withName: USED_OLD {",
      "    executor = 'slurm'",
      "    scratch = true",
      "    stageOutMode = 'rclone'",
      "    shell = ['/bin/false', '-x']",
      "  }",
      "  withName: USED_NEW { executor = 'pbs' }",
      "}",
      "",
    ].join("\n")),
    writeFile(join(taskSourceRoot, "README.md"), "source-owned file\n"),
    writeFile(join(taskSourceRoot, "nextflow_schema.json"), `${JSON.stringify({
      type: "object",
      properties: { input: { type: "string", format: "file-path" } },
    })}\n`),
    writeFile(join(taskSourceRoot, "inputs", "reads.txt"), "portable input binding\n"),
  ]);
  for (const relativePath of [
    "main.nf",
    "modules/used_old/main.nf",
    "modules/used_old/environment.yml",
    "modules/used_new/main.nf",
    "modules/used_new/environment.yml",
  ]) {
    await writeFile(join(taskSourceRoot, relativePath), await readFile(join(taskFixtureRoot, relativePath)));
  }
  const taskImported = await new ProjectGateway(projectRoot, catalog).open({ path: "source-task-demo" });
  assert.equal(taskImported.kind, "nextflow");
  assert.equal(taskImported.graph.nodes[0]?.source_workflow?.capabilities.exact_execution, true);
  const importedTaskNode = taskImported.graph.nodes[0]!;
  const importedTaskWorkflow = importedTaskNode.source_workflow!;
  const taskGraph: SomiteGraph = {
    ...taskImported.graph,
    nodes: [{
      ...importedTaskNode,
      source_workflow: applySourceWorkflowEdits(importedTaskWorkflow, importedTaskWorkflow.workflow_revision, [{
        kind: "set_parameter",
        name: "input",
        binding: { kind: "project_file", path: "source-task-demo/inputs/reads.txt" },
      }]),
    }],
  };

  const taskValidation = await manager.start(taskGraph, "validation", "source-task-preview-smoke");
  const taskValidationStatus = await terminalStatus(manager, taskValidation.run_id);
  assert.equal(taskValidationStatus.phase, "completed", taskValidationStatus.error);
  assert.equal(taskValidationStatus.evidence_receipt?.result, "passed");
  assert.equal(taskValidationStatus.evidence_receipt?.artifact_digests.length, 2);
  const taskConfigProof = JSON.parse(await readFile(join(
    projectRoot,
    ".somite",
    "runs",
    taskValidation.run_id,
    ".somite",
    "run",
    "nextflow-config-proof.json",
  ), "utf8"));
  assert.equal(taskConfigProof.schema_version, 2);
  assert.equal(taskConfigProof.status, "passed");

  const taskRun = await manager.start(taskGraph, "run", "source-task-run-smoke");
  const taskRunStatus = await terminalStatus(manager, taskRun.run_id);
  assert.equal(taskRunStatus.phase, "completed", taskRunStatus.error);
  assert.equal(taskRunStatus.exit_code, 0);
  assert.equal(taskRunStatus.states[taskGraph.nodes[0]!.id], "done");
  const taskPackage = join(projectRoot, ".somite", "runs", taskRun.run_id);
  assert.match(await readFile(join(taskPackage, ".somite", "run", "nextflow.log"), "utf8"), /USED_OLD/);
  assert.match(await readFile(join(taskPackage, ".somite", "run", "nextflow.log"), "utf8"), /USED_NEW/);
  assert.equal(await readFile(join(taskPackage, "README.md"), "utf8"), "source-owned file\n");
  assert.ok((await stat(join(taskPackage, ".somite", "run", "stdout.log"))).isFile());
  assert.match(await readFile(join(taskPackage, "modules", "used_old", "main.nf"), "utf8"), /\.pixi\/envs\/task-[a-f0-9]{64}/);
  assert.match(await readFile(join(taskPackage, "modules", "used_new", "main.nf"), "utf8"), /\.pixi\/envs\/task-[a-f0-9]{64}/);
  const taskWrapperPath = await findNamedFile(join(taskPackage, ".somite", "run", "work"), ".command.run");
  assert.ok(taskWrapperPath);
  const taskWrapper = await readFile(taskWrapperPath, "utf8");
  assert.doesNotMatch(taskWrapper, /nxf_trace_linux/);
  assert.match(taskWrapper, /\.pixi\/envs\/default\/bin\/bash/);
  const taskPlan = JSON.parse(await readFile(join(taskPackage, ".somite", "run", "source-task-plan.json"), "utf8")) as { environments?: unknown[]; rewrites?: unknown[] };
  assert.equal(taskPlan.environments?.length, 2);
  assert.equal(taskPlan.rewrites?.length, 2);

  const compiledTask = await manager.compile(taskGraph, { archiveName: "source-task-demo", platform: pixiPlatform() });
  const compiledTaskRoot = join(projectRoot, compiledTask.output_path);
  const compiledOld = await readFile(join(compiledTaskRoot, "modules", "used_old", "main.nf"), "utf8");
  const compiledNew = await readFile(join(compiledTaskRoot, "modules", "used_new", "main.nf"), "utf8");
  assert.match(compiledOld, /"\$\{projectDir\}\/\.pixi\/envs\/task-[a-f0-9]{64}"/);
  assert.match(compiledNew, /"\$\{projectDir\}\/\.pixi\/envs\/task-[a-f0-9]{64}"/);
  assert.doesNotMatch(compiledOld, new RegExp(cacheRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(JSON.parse(await readFile(join(compiledTaskRoot, ".somite", "run", "params.json"), "utf8")).input, "source-task-demo/inputs/reads.txt");
  assert.ok((await stat(join(compiledTaskRoot, "somite-run"))).mode & 0o100);
  assert.ok((await stat(join(compiledTaskRoot, "pixi.lock"))).isFile());
  const exportedTask = await manager.export(taskGraph, { archiveName: "source-task-demo", platform: pixiPlatform() });
  assert.equal(exportedTask.filename, "source-task-demo.somite-source.zip");
  assert.deepEqual([...exportedTask.bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const exportedRoot = join(projectRoot, "extracted-source-task-demo");
  const exportedArchive = join(projectRoot, exportedTask.filename);
  await writeFile(exportedArchive, exportedTask.bytes);
  await mkdir(exportedRoot);
  await execFileAsync("unzip", ["-q", exportedArchive, "-d", exportedRoot], { timeout: 60_000 });
  const exportedParams = await readFile(join(exportedRoot, ".somite", "run", "params.json"), "utf8");
  assert.equal(JSON.parse(exportedParams).input, "source-task-demo/inputs/reads.txt");
  assert.doesNotMatch(exportedParams, new RegExp(projectRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok((await stat(join(exportedRoot, "somite-run"))).mode & 0o100);
  await execFileAsync("./somite-run", [], {
    cwd: exportedRoot,
    env: process.env,
    timeout: 10 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const exportedWork = join(exportedRoot, ".somite", "run", "work");
  const exportedOld = await findNamedFile(exportedWork, "old.txt");
  const exportedNew = await findNamedFile(exportedWork, "new.txt");
  assert.ok(exportedOld);
  assert.ok(exportedNew);
  assert.match(await readFile(exportedOld, "utf8"), /^samtools 1\.18/m);
  assert.match(await readFile(exportedNew, "utf8"), /^samtools 1\.19\.2/m);
});
