import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { operatorPorts, type PinnedOperator } from "@somite/workflow/catalog";
import type { SomiteGraph, SomiteGraphNode } from "@somite/workflow/model";
import { RunManager, type RunStatus } from "../src/jobs.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

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

function edge(
  id: string,
  fromNode: string,
  fromPort: string,
  toNode: string,
  toPort: string,
): SomiteGraph["edges"][number] {
  return { id, from_node: fromNode, from_port: fromPort, to_node: toNode, to_port: toPort };
}

async function terminalStatus(manager: RunManager, id: string) {
  const deadline = Date.now() + 10 * 60_000;
  let status: RunStatus;
  do {
    status = await manager.status(id, 1_000);
    if (["completed", "failed", "cancelled"].includes(status.phase)) return status;
  } while (Date.now() < deadline);
  throw new Error(`compressed reads smoke ${id} did not become terminal`);
}

function deterministicDna(length: number) {
  let state = 0x9e3779b9;
  let sequence = "";
  for (let index = 0; index < length; index += 1) {
    state = Math.imul(state ^ (state >>> 16), 0x21f0aaad);
    state = Math.imul(state ^ (state >>> 15), 0x735a2d97);
    sequence += "ACGT"[(state ^ (state >>> 15)) >>> 30];
  }
  return sequence;
}

test("compressed FASTA and FASTQ are visibly decompressed before STAR through real Pixi and Nextflow", { timeout: 12 * 60_000 }, async (context) => {
  assert.equal(process.platform, "linux", "the compressed reads smoke currently targets Linux");
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "somite-compressed-reads-smoke-")));
  const cacheParent = await realpath(await mkdtemp(join(tmpdir(), "somite-compressed-reads-cache-")));
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

  const sequence = deterministicDna(4_096);
  const read = sequence.slice(1_024, 1_124);
  const fastq = `@read-1\n${read}\n+\n${"I".repeat(read.length)}\n`;
  await Promise.all([
    writeFile(join(projectRoot, "reference.fa.gz"), gzipSync(`>reference\n${sequence}\n`)),
    writeFile(join(projectRoot, "reads.fastq.gz"), gzipSync(fastq)),
  ]);

  const reference = node(catalog.get("files.import_fasta_gz")!, "compressed-reference", { path: "reference.fa.gz" });
  const decompressReference = node(catalog.get("archive.gunzip_fasta")!, "decompress-reference");
  const index = node(catalog.get("align.star_index")!, "star-index", { threads: 1, genome_sa_index_nbases: 1 });
  const compressed = node(catalog.get("files.import_fastq_gz")!, "compressed-reads", { path: "reads.fastq.gz" });
  const decompress = node(catalog.get("archive.gunzip_fastq")!, "decompress-reads");
  const star = node(catalog.get("align.star")!, "star", { threads: 1 });
  const graph: SomiteGraph = {
    schema_version: 3,
    name: "compressed-reads-star-smoke",
    nodes: [reference, decompressReference, index, compressed, decompress, star],
    edges: [
      edge("reference-decompress", "compressed-reference", "assembly", "decompress-reference", "compressed"),
      edge("reference-index", "decompress-reference", "fasta", "star-index", "ref"),
      edge("index-star", "star-index", "index", "star", "genome"),
      edge("compressed-decompress", "compressed-reads", "reads", "decompress-reads", "compressed"),
      edge("decompress-star", "decompress-reads", "fastq", "star", "r1"),
    ],
  };

  const started = await manager.start(graph, "run", "compressed-reads-star-smoke");
  const status = await terminalStatus(manager, started.run_id);
  if (status.phase !== "completed") {
    const runRoot = join(projectRoot, ".somite", "runs", started.run_id);
    const stderr = await readFile(join(runRoot, "run.stderr.log"), "utf8").catch(() => "");
    const nextflow = await readFile(join(runRoot, ".nextflow.log"), "utf8").catch(() => "");
    assert.fail(`${status.error ?? `run ended ${status.phase}`}\n${stderr}\n${nextflow}`);
  }
  assert.equal(status.exit_code, 0);
  for (const id of ["decompress-reference", "star-index", "decompress-reads", "star"]) {
    assert.ok(["done", "cached"].includes(status.states[id]!), `${id}: ${status.states[id]}`);
  }

  const validationStarted = await manager.start(graph, "validation", "compressed-reads-star-validation-smoke");
  const validation = await terminalStatus(manager, validationStarted.run_id);
  if (validation.phase !== "completed") {
    const runRoot = join(projectRoot, ".somite", "runs", validationStarted.run_id);
    const stderr = await readFile(join(runRoot, "run.stderr.log"), "utf8").catch(() => "");
    const nextflow = await readFile(join(runRoot, ".nextflow.log"), "utf8").catch(() => "");
    assert.fail(`${validation.error ?? `validation ended ${validation.phase}`}\n${stderr}\n${nextflow}`);
  }
  assert.equal(validation.evidence_receipt?.result, "passed");
  assert.equal(validation.evidence_receipt?.scope, "graph_e2e");
  assert.equal(validation.evidence_receipt?.fixture_digests.length, 2);
  for (const id of ["compressed-reference", "decompress-reference", "compressed-reads", "star-index", "decompress-reads", "star"]) {
    assert.equal(validation.evidence_receipt?.node_results[id], "passed", `${id} validation result`);
  }
});
