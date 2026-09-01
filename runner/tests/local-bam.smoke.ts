import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { operatorPorts, type PinnedOperator } from "@somite/workflow/catalog";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { byteDigest } from "@somite/workflow/contentIdentity";
import type { SomiteGraph, SomiteGraphNode } from "@somite/workflow/model";
import { RunManager, type RunStatus } from "../src/jobs.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const BAM_DIGEST = "blake3:d437257e3a74d0ecee3663900482960e429074c4698ab9fe82785fcc06cd5719";

function node(operator: PinnedOperator, id: string, params: SomiteGraphNode["params"] = {}): SomiteGraphNode {
  return {
    id,
    operator: operator.id,
    operator_revision: operator.revision,
    ports: operatorPorts(operator),
    params,
    layout: { x: 0, y: 0 },
  };
}

async function terminalStatus(manager: RunManager, id: string) {
  const deadline = Date.now() + 15 * 60_000;
  let status: RunStatus;
  do {
    status = await manager.status(id, 1_000);
    if (["completed", "failed", "cancelled"].includes(status.phase)) return status;
  } while (Date.now() < deadline);
  throw new Error(`local BAM smoke ${id} did not become terminal`);
}

function assertCompleted(status: RunStatus) {
  assert.equal(status.phase, "completed", status.error);
  for (const id of ["input", "read-groups", "sort", "index"]) {
    assert.ok(["done", "cached"].includes(status.states[id]!), `${id}: ${status.states[id]}`);
  }
}

test("local BAM runs and validates through GATK preparation with real Pixi and Nextflow", { timeout: 18 * 60_000 }, async (context) => {
  assert.equal(process.platform, "linux", "the local BAM smoke currently targets Linux");
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "somite-local-bam-smoke-")));
  const cacheParent = await realpath(await mkdtemp(join(tmpdir(), "somite-local-bam-cache-")));
  const previousCacheRoot = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.SOMITE_PIXI_CACHE_DIR = join(cacheParent, "pixi");
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const manager = new RunManager(projectRoot, repositoryRoot, catalog);
  context.after(async () => {
    await manager.shutdown();
    if (previousCacheRoot === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCacheRoot;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(cacheParent, { recursive: true, force: true });
  });

  const encoded = (await readFile(join(repositoryRoot, "fixtures", "bam", "v1", "sample.bam.b64"), "utf8")).trim();
  const bam = Buffer.from(encoded, "base64");
  assert.equal(bam.toString("base64"), encoded, "reviewed BAM fixture must use canonical base64");
  assert.equal(byteDigest(bam), BAM_DIGEST);
  await writeFile(join(projectRoot, "sample.bam"), bam);

  const input = node(catalog.get("files.import_bam")!, "input", { path: "sample.bam" });
  const readGroups = node(catalog.get("align.gatk_add_read_groups")!, "read-groups", {
    read_group_id: "sample-1",
    library: "library-1",
    platform: "ILLUMINA",
    platform_unit: "unit-1",
    sample: "sample-1",
  });
  const sort = node(catalog.get("align.samtools_sort_gatk")!, "sort", { threads: 1 });
  const index = node(catalog.get("align.samtools_index")!, "index", { threads: 1 });
  const graph: SomiteGraph = {
    schema_version: 3,
    name: "local-bam-gatk-preparation",
    nodes: [input, readGroups, sort, index],
    edges: [
      { id: "input-read-groups", from_node: "input", from_port: "bam", to_node: "read-groups", to_port: "bam" },
      { id: "read-groups-sort", from_node: "read-groups", from_port: "bam", to_node: "sort", to_port: "bam" },
      { id: "sort-index", from_node: "sort", from_port: "bam", to_node: "index", to_port: "bam" },
    ],
  };

  const run = await terminalStatus(manager, (await manager.start(graph, "run", "local-bam-run")).run_id);
  assertCompleted(run);

  const validation = await terminalStatus(manager, (await manager.start(graph, "validation", "local-bam-validation")).run_id);
  assertCompleted(validation);
  assert.equal(validation.evidence_receipt?.result, "passed");
  assert.equal(validation.evidence_receipt?.scope, "graph_e2e");
  assert.deepEqual(validation.evidence_receipt?.fixture_digests, [BAM_DIGEST]);
  assert.deepEqual(validation.evidence_receipt?.node_results, {
    input: "passed",
    "read-groups": "passed",
    sort: "passed",
    index: "passed",
  });
});
