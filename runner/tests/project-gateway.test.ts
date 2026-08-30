import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import type { OperatorCatalog } from "@somite/workflow/catalog";
import { parseGraph } from "@somite/workflow/graphCodec";
import { validateSourceWorkflow } from "@somite/workflow/workflow";
import { ProjectGateway, ProjectGatewayError } from "../src/projectGateway.ts";
import { readSourceObject } from "../src/sourceWorkflowStore.ts";
import { verifyGraphSourceWorkflowTrust } from "../src/sourceWorkflowTrust.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const execFile = promisify(execFileCallback);

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  return { root, catalog, gateway: new ProjectGateway(root, catalog) };
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeNextflowProject(root: string, name = "pipeline") {
  const project = join(root, name);
  await mkdir(join(project, "modules"), { recursive: true });
  await writeFile(join(project, "main.nf"), [
    "include { PREPARE } from './modules/prepare'",
    "workflow { PREPARE() }",
    "",
  ].join("\n"));
  await writeFile(join(project, "modules", "prepare.nf"), [
    "process PREPARE {",
    "  output:",
    "  path 'ready.txt'",
    "  script:",
    "  \"\"\"touch ready.txt\"\"\"",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(project, "nextflow_schema.json"), JSON.stringify({
    type: "object",
    properties: { reads: { type: "string", format: "file-path", title: "Reads" } },
  }));
  await writeFile(join(project, ".nextflow.log"), "runtime noise that is not source\n");
  await writeFile(join(project, ".env"), "SOMITE_TEST_SECRET=never-copy-this\n");
  await mkdir(join(project, ".pixi", "envs", "default"), { recursive: true });
  await writeFile(join(project, ".pixi", "envs", "default", "installed-package"), "environment state\n");
  await mkdir(join(project, "modules", "nested"), { recursive: true });
  await writeFile(join(project, "modules", "nested", ".git"), "gitdir: ../../../.git/modules/nested\n");
  await writeFile(join(project, "modules", "nested", "tool.nf"), "process NESTED { script: \"\"\"true\"\"\" }\n");
  await mkdir(join(project, "templates"), { recursive: true });
  await writeFile(join(project, "templates", "report.nfinc"), "workflow report template\n");
  await mkdir(join(project, "assets"), { recursive: true });
  await writeFile(join(project, "assets", "layout.json"), "{\"label\":\"required workflow asset\"}\n");
  await mkdir(join(project, "config"), { recursive: true });
  await writeFile(join(project, "config", "credentials.yaml"), "api_token: actual-private-token-value\n");
  await writeFile(join(project, "notes.docx"), "unrelated document\n");
  await mkdir(join(project, "results"), { recursive: true });
  await writeFile(join(project, "results", "raw.fastq"), "@read\nACGT\n+\n!!!!\n");
  await mkdir(join(project, "work", "task"), { recursive: true });
  await writeFile(join(project, "work", "task", "output.txt"), "runtime output\n");
  return project;
}

function sourceWorkflow(response: Awaited<ReturnType<ProjectGateway["open"]>>) {
  if (response.kind !== "nextflow") throw new Error("expected a Nextflow response");
  const workflow = response.graph.nodes[0]?.source_workflow;
  if (!workflow) throw new Error("Nextflow response has no source workflow");
  return workflow;
}

test("ProjectGateway opens current and legacy Somite graphs through catalog and source trust", async () => {
  const { root, catalog, gateway } = await fixture("somite-project-graph-");
  try {
    await writeJson(join(root, "graphs", "legacy.somite.json"), {
      schema_version: 1,
      name: "Legacy graph",
      nodes: [{ id: "reads", operator: "files.import", params: { path: "reads.fastq" }, layout: { x: 1, y: 2 } }],
      edges: [],
    });
    const opened = await gateway.open({ path: "graphs" });
    assert.equal(opened.kind, "somite");
    if (opened.kind !== "somite") throw new Error("expected a Somite graph");
    assert.equal(opened.project_path, "graphs");
    assert.equal(opened.entrypoint, "legacy.somite.json");
    assert.equal(opened.input_base, join(root, "graphs"));
    assert.equal(opened.graph.schema_version, 3);
    assert.equal(opened.graph.nodes[0]?.operator_revision, catalog.get("files.import")?.revision);
    assert.deepEqual(opened.graph.nodes[0]?.ports, [{ name: "file", dir: "out", ty: "Fastq" }]);

    await writeJson(join(root, "graphs", "bad.somite.json"), {
      schema_version: 3,
      nodes: [{ id: "bad", operator: "missing.operator", operator_revision: "bad", ports: [], params: {}, layout: { x: 0, y: 0 } }],
      edges: [],
    });
    await assert.rejects(
      gateway.open({ path: "graphs/bad.somite.json" }),
      (error: unknown) => error instanceof ProjectGatewayError && error.code === "project_graph_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectGateway carries verified frozen source when opening another Somite project", async () => {
  const { root, catalog, gateway } = await fixture("somite-project-graph-source-");
  const external = await mkdtemp(join(tmpdir(), "somite-project-graph-external-"));
  try {
    await writeNextflowProject(external, ".");
    const externalGateway = new ProjectGateway(external, catalog);
    const frozen = await externalGateway.open({ path: "." });
    if (frozen.kind !== "nextflow") throw new Error("expected a Nextflow source graph");
    const graphPath = join(external, "shared.somite.json");
    await writeJson(graphPath, frozen.graph);

    const opened = await gateway.open({ path: graphPath });
    assert.equal(opened.kind, "somite");
    if (opened.kind !== "somite") throw new Error("expected a Somite graph");
    assert.equal(opened.input_base, external);
    assert.deepEqual(opened.graph, parseGraph(frozen.graph));
    await verifyGraphSourceWorkflowTrust(root, catalog, opened.graph);
    const stored = await readSourceObject(root, frozen.source_digest);
    assert.equal(stored.manifest.source_digest, frozen.source_digest);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("ProjectGateway freezes local Nextflow source with deterministic portable identity and exact reuse", async () => {
  const { root, catalog, gateway } = await fixture("somite-project-nextflow-");
  try {
    const project = await writeNextflowProject(root);
    const concurrent = await Promise.all([
      gateway.open({ path: "pipeline" }),
      gateway.open({ path: "pipeline/main.nf" }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.kind), ["nextflow", "nextflow"]);
    assert.deepEqual(concurrent.map((response) => response.kind === "nextflow" && response.cached).sort(), [false, true]);
    const first = concurrent.find((response) => response.kind === "nextflow" && !response.cached)!;
    assert.equal(first.kind, "nextflow");
    if (first.kind !== "nextflow") throw new Error("expected Nextflow import");
    assert.equal(first.project_path, "pipeline");
    assert.equal(first.entrypoint, "main.nf");
    assert.equal(first.cached, false);
    assert.match(first.source_digest, /^blake3:[0-9a-f]{64}$/);
    const workflow = sourceWorkflow(first);
    assert.equal(workflow.source.provider, "local");
    assert.equal(workflow.source.repository, "local:pipeline");
    assert.equal(workflow.source.requested_revision, "working-tree");
    assert.equal(workflow.source.resolved_revision, first.source_digest.slice("blake3:".length));
    assert.equal(workflow.workflow_revision, first.workflow_revision);
    const falselyPinned = structuredClone(workflow);
    falselyPinned.source.resolved_revision = "a".repeat(64);
    assert.match(validateSourceWorkflow(falselyPinned) ?? "", /exact frozen source BLAKE3 identity/);
    assert.equal(JSON.stringify(first.graph).includes(root), false, "portable graph must not contain an absolute machine path");
    await verifyGraphSourceWorkflowTrust(root, catalog, first.graph);

    const stored = await readSourceObject(root, first.source_digest);
    assert.deepEqual(stored.manifest.files.map((file) => file.path), ["assets/layout.json", "main.nf", "modules/nested/tool.nf", "modules/prepare.nf", "nextflow_schema.json", "templates/report.nfinc"]);
    assert.equal(stored.manifest.files.some((file) => file.path.includes("/.git/") || file.path.startsWith("results/")
      || file.path.startsWith("work/") || file.path.startsWith(".pixi/") || file.path === ".env" || file.path === ".nextflow.log"), false);
    assert.ok(first.exclusions.count >= 6);
    assert.ok(first.exclusions.examples.some((entry) => entry.path === ".env" && entry.reason === "sensitive"));
    assert.ok(first.exclusions.examples.some((entry) => entry.path === "config/credentials.yaml" && entry.reason === "sensitive"));
    assert.ok(first.exclusions.examples.some((entry) => entry.path === "notes.docx" && entry.reason === "not_workflow_source"));
    assert.ok(first.exclusions.examples.some((entry) => entry.path === "modules/nested/.git" && entry.reason === "runtime_state"));

    await writeFile(join(project, ".env"), "SOMITE_TEST_SECRET=changed-but-still-never-copied\n");
    await writeFile(join(project, "results", "raw.fastq"), "@changed\nTGCA\n+\n!!!!\n");
    const second = await gateway.open({ path: join(project, "main.nf") });
    assert.equal(second.kind, "nextflow");
    if (second.kind !== "nextflow") throw new Error("expected Nextflow import");
    assert.equal(second.cached, true);
    assert.equal(second.source_digest, first.source_digest);
    assert.equal(second.workflow_revision, first.workflow_revision);
    assert.deepEqual(second.graph, first.graph);

    await writeFile(join(project, "modules", "prepare.nf"), "process PREPARE { script: \"\"\"touch changed\"\"\" }\n");
    const changed = await gateway.open({ path: "pipeline/main.nf" });
    assert.equal(changed.kind, "nextflow");
    if (changed.kind !== "nextflow") throw new Error("expected Nextflow import");
    assert.equal(changed.cached, false);
    assert.notEqual(changed.source_digest, first.source_digest);
    assert.notEqual(changed.workflow_revision, first.workflow_revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectGateway can freeze the project root without ingesting its own Somite state", async () => {
  const { root, gateway } = await fixture("somite-project-nextflow-root-");
  try {
    await writeNextflowProject(root, ".");
    const first = await gateway.open({ path: "." });
    const second = await gateway.open({ path: "main.nf" });
    assert.equal(first.kind, "nextflow");
    assert.equal(second.kind, "nextflow");
    if (first.kind !== "nextflow" || second.kind !== "nextflow") throw new Error("expected Nextflow import");
    assert.equal(first.project_path, ".");
    assert.equal(sourceWorkflow(first).source.repository, "local:.");
    assert.equal(second.cached, true);
    assert.equal(second.source_digest, first.source_digest, ".somite source objects must not recursively change the local snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectGateway refuses ambiguous, unsupported, escaping, and symlinked project paths", async () => {
  const { root, gateway } = await fixture("somite-project-security-");
  const outside = await mkdtemp(join(tmpdir(), "somite-project-outside-"));
  try {
    const ambiguous = await writeNextflowProject(root, "ambiguous");
    await writeFile(join(ambiguous, "Snakefile"), "rule all:\n    input: 'done'\n");
    await assert.rejects(
      gateway.open({ path: "ambiguous" }),
      (error: unknown) => error instanceof ProjectGatewayError && error.code === "project_ambiguous" && /main\.nf, Snakefile/.test(error.message),
    );
    const explicit = await gateway.open({ path: "ambiguous/main.nf" });
    assert.equal(explicit.kind, "nextflow", "an explicit entrypoint resolves directory ambiguity without guessing");

    await mkdir(join(root, "two-graphs"));
    await writeJson(join(root, "two-graphs", "one.somite.json"), { schema_version: 3, nodes: [], edges: [] });
    await writeJson(join(root, "two-graphs", "two.somite.json"), { schema_version: 3, nodes: [], edges: [] });
    await assert.rejects(gateway.open({ path: "two-graphs" }), /ambiguous/);

    await mkdir(join(root, "unsupported"));
    await writeFile(join(root, "unsupported", "workflow.nf"), "workflow {}\n");
    await assert.rejects(
      gateway.open({ path: "unsupported" }),
      (error: unknown) => error instanceof ProjectGatewayError && error.code === "project_unsupported",
    );
    await writeFile(join(outside, "main.nf"), "workflow {}\n");
    const external = await gateway.open({ path: join(outside, "main.nf") });
    assert.equal(external.kind, "nextflow");
    assert.equal(external.project_path, `external/${basename(outside)}`);
    assert.equal(JSON.stringify(external.graph).includes(outside), false);
    if (process.platform !== "win32") {
      await symlink("ambiguous", join(root, "linked-project"));
      await assert.rejects(gateway.open({ path: "linked-project" }), /symbolic link/);
      await symlink("main.nf", join(ambiguous, "linked.nf"));
      await assert.rejects(
        gateway.open({ path: "ambiguous/main.nf" }),
        (error: unknown) => error instanceof ProjectGatewayError && error.code === "project_source_invalid" && /symbolic link linked\.nf/.test(error.message),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ProjectGateway delegates existing Snakemake projects and keeps absolute paths out of the graph", { skip: process.platform === "win32" }, async () => {
  const { root, gateway } = await fixture("somite-project-snakemake-");
  try {
    const project = join(root, "snake");
    const bin = join(project, ".pixi", "envs", "default", "bin");
    await mkdir(join(project, "workflow"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(project, "workflow", "Snakefile"), "rule all:\n    input: 'done'\n");
    await writeFile(join(project, "pixi.lock"), "fixture\n");
    const pixi = join(bin, "pixi");
    await writeFile(pixi, "#!/bin/sh\nprintf '%s\\n' 'digraph snakemake_dag {' '0[label = \"prepare\"];' '1[label = \"all\"];' '0 -> 1' '}'\n");
    await chmod(pixi, 0o755);

    const opened = await gateway.open({ path: "snake", snakemake_targets: ["all"] });
    assert.equal(opened.kind, "snakemake");
    if (opened.kind !== "snakemake") throw new Error("expected Snakemake import");
    assert.equal(opened.project_path, "snake");
    assert.equal(opened.entrypoint, "workflow/Snakefile");
    assert.equal(opened.revision, "local-worktree");
    assert.deepEqual(opened.graph.nodes.map((node) => node.id), ["prepare", "all"]);
    assert.equal(opened.graph.nodes[0]?.params?.workflow, "snake");
    assert.equal(JSON.stringify(opened.graph).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectGateway marks a modified explicit .smk entrypoint as dirty Git provenance", { skip: process.platform === "win32" }, async () => {
  const { root, gateway } = await fixture("somite-project-snakemake-git-");
  try {
    const project = join(root, "snake");
    const bin = join(project, ".pixi", "envs", "default", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(project, "analysis.smk"), "rule all:\n    input: 'done'\n");
    await writeFile(join(project, "pixi.lock"), "fixture\n");
    const pixi = join(bin, "pixi");
    await writeFile(pixi, "#!/bin/sh\nprintf '%s\\n' 'digraph snakemake_dag {' '0[label = \"all\"];' '}'\n");
    await chmod(pixi, 0o755);
    await execFile("git", ["init", "--quiet"], { cwd: project });
    await execFile("git", ["config", "user.email", "somite-test@example.invalid"], { cwd: project });
    await execFile("git", ["config", "user.name", "Somite Test"], { cwd: project });
    await execFile("git", ["add", "."], { cwd: project });
    await execFile("git", ["commit", "--quiet", "-m", "fixture"], { cwd: project });
    await writeFile(join(project, "analysis.smk"), "rule all:\n    input: 'changed'\n");

    const opened = await gateway.open({ path: "snake/analysis.smk" });
    assert.equal(opened.kind, "snakemake");
    if (opened.kind !== "snakemake") throw new Error("expected Snakemake import");
    assert.match(opened.revision, /^git:[0-9a-f]{12}\+worktree$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectGateway detects a corrupted existing local source object instead of reusing it", async () => {
  const { root, gateway } = await fixture("somite-project-corrupt-");
  try {
    await writeNextflowProject(root);
    const first = await gateway.open({ path: "pipeline" });
    if (first.kind !== "nextflow") throw new Error("expected Nextflow import");
    const storedMain = join(
      root,
      ".somite",
      "source-workflows",
      "objects",
      first.source_digest.slice("blake3:".length),
      "source",
      "main.nf",
    );
    await writeFile(storedMain, "workflow { forged() }\n");
    await assert.rejects(
      gateway.open({ path: "pipeline" }),
      (error: unknown) => error instanceof ProjectGatewayError
        && error.code === "project_source_invalid"
        && /source file main\.nf does not match its manifest|exact content verification/.test(error.message),
    );
    assert.notEqual((await readFile(storedMain, "utf8")).trim(), "", "gateway must not overwrite the corrupted immutable object");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
