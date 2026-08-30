import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { parseSnakemakeCatalog, SnakemakeGateway } from "../src/snakemakeGateway.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("Snakemake catalog keeps released standardized workflows and pins their identity", async () => {
  const raw = [
    { full_name: "owner/low", description: "low", standardized: true, latest_release: "v1", stargazers_count: 3, topics: ["rna"], rulegraph: null },
    { full_name: "owner/high", description: "high", standardized: true, latest_release: "v2", stargazers_count: 30, topics: [], rulegraph: "digraph { 0[label=\"prepare\"]; }" },
    { full_name: "owner/no-release", standardized: true, latest_release: null, stargazers_count: 99 },
    { full_name: "owner/custom", standardized: false, latest_release: "v1", stargazers_count: 100 },
  ];
  assert.deepEqual(parseSnakemakeCatalog(raw).map((workflow) => workflow.fullName), ["owner/high", "owner/low"]);

  const root = await mkdtemp(join(tmpdir(), "somite-snakemake-catalog-ts-"));
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const gateway = new SnakemakeGateway(root, catalog, async () => Response.json(raw));
    const response = await gateway.catalogResponse();
    assert.equal(response.cached, false);
    assert.equal(response.entries[0]?.operator.id, "smk.catalog.owner-high");
    assert.equal(response.entries[0]?.operator.params.revision?.default, "v2");
    assert.equal(response.entries[0]?.expandable, true);

    const expanded = await gateway.expand("owner/high", "v2");
    assert.equal(expanded.graph.nodes[0]?.params?.component, "prepare");
    assert.equal(expanded.graph.nodes[0]?.operator, "workflow.reference");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Snakemake catalog falls back to its validated project cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-snakemake-cache-ts-"));
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const first = new SnakemakeGateway(root, catalog, async () => Response.json([{
      full_name: "owner/workflow",
      description: "cached",
      standardized: true,
      latest_release: "1.0.0",
      stargazers_count: 1,
      topics: ["testing"],
      rulegraph: "digraph { 0[label=\"all\"]; }",
    }]));
    await first.catalogResponse();
    const offline = new SnakemakeGateway(root, catalog, async () => { throw new Error("offline"); });
    const response = await offline.catalogResponse();
    assert.equal(response.cached, true);
    assert.equal(response.entries[0]?.operator.title, "owner/workflow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local Snakemake import asks the declared Pixi environment only for a rule graph", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-snakemake-local-ts-"));
  try {
    const project = join(root, "project");
    const bin = join(project, ".pixi", "envs", "default", "bin");
    await mkdir(join(project, "workflow"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(project, "workflow", "Snakefile"), "rule all:\n    input: 'done'\n");
    await writeFile(join(project, "pixi.lock"), "test\n");
    const pixi = join(bin, "pixi");
    await writeFile(pixi, "#!/bin/sh\nprintf '%s\\n' 'digraph snakemake_dag {' '0[label = \"prepare\"];' '1[label = \"all\"];' '0 -> 1' '}'\n");
    await chmod(pixi, 0o755);
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const gateway = new SnakemakeGateway(root, catalog, async () => { throw new Error("unused"); });
    const imported = await gateway.importLocal(project, ["all", "all"]);
    assert.equal(imported.workflow, project);
    assert.equal(imported.revision, "local-worktree");
    assert.deepEqual(imported.graph.nodes.map((node) => node.id), ["prepare", "all"]);
    assert.equal(imported.graph.edges[0]?.from_node, "prepare");
    assert.equal(imported.graph.edges[0]?.to_node, "all");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local Snakemake import rejects option-shaped targets before launching", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-snakemake-target-ts-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(project, "Snakefile"), "rule all:\n    input: 'done'\n");
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const gateway = new SnakemakeGateway(root, catalog, async () => { throw new Error("unused"); });
    await assert.rejects(gateway.importLocal(project, ["--delete-all-output"]), /invalid Snakemake target/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
