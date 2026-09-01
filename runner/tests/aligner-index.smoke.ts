import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  const deadline = Date.now() + 20 * 60_000;
  let status: RunStatus;
  do {
    status = await manager.status(id, 1_000);
    if (["completed", "failed", "cancelled"].includes(status.phase)) return status;
  } while (Date.now() < deadline);
  throw new Error(`aligner/index smoke ${id} did not become terminal`);
}

function deterministicDna(length: number) {
  let state = 0x6d2b79f5;
  let sequence = "";
  for (let index = 0; index < length; index += 1) {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    sequence += "ACGT"[(state ^ (state >>> 14)) >>> 30];
  }
  return sequence;
}

test("core aligners, indexes, and GATK HaplotypeCaller run through real Pixi and Nextflow", { timeout: 25 * 60_000 }, async (context) => {
  assert.equal(process.platform, "linux", "the core aligner/index smoke currently targets Linux");
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "somite-aligner-index-smoke-")));
  const cacheParent = await realpath(await mkdtemp(join(tmpdir(), "somite-aligner-index-cache-")));
  const previousCacheRoot = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.SOMITE_PIXI_CACHE_DIR = join(cacheParent, "pixi");
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const manager = new RunManager(projectRoot, repositoryRoot, catalog);
  const sequence = deterministicDna(4_096);
  const compressedReference = gzipSync(`>reference\n${sequence}\n`);
  const referenceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/gzip", "content-length": compressedReference.byteLength });
    response.end(compressedReference);
  });
  await new Promise<void>((resolve, reject) => referenceServer.listen(0, "127.0.0.1", resolve).once("error", reject));
  const referenceAddress = referenceServer.address() as AddressInfo;
  context.after(async () => {
    await manager.shutdown();
    await new Promise<void>((resolve, reject) => referenceServer.close((error) => error ? reject(error) : resolve()));
    if (previousCacheRoot === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCacheRoot;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(cacheParent, { recursive: true, force: true });
  });

  const read = sequence.slice(1_024, 1_124);
  await Promise.all([
    writeFile(join(projectRoot, "transcripts.fa"), `>transcript-1\n${sequence}\n`),
    writeFile(join(projectRoot, "reads.fastq"), `@read-1\n${read}\n+\n${"I".repeat(read.length)}\n`),
  ]);

  const reference = node(catalog.get("ensembl.fasta")!, "public-reference", {
    url: `http://127.0.0.1:${referenceAddress.port}/reference.fa.gz`,
  });
  const decompress = node(catalog.get("archive.gunzip_fasta")!, "decompress-reference");
  const transcripts = node(catalog.get("files.import_fasta")!, "transcripts", { path: "transcripts.fa" });
  const reads = node(catalog.get("files.import")!, "reads", { path: "reads.fastq" });
  const bowtieIndex = node(catalog.get("align.bowtie2_build")!, "bowtie-index", { threads: 1 });
  const bowtie = node(catalog.get("align.bowtie2")!, "bowtie", { threads: 1 });
  const bwaIndex = node(catalog.get("align.bwa_index")!, "bwa-index");
  const bwa = node(catalog.get("align.bwa")!, "bwa", { threads: 1 });
  const view = node(catalog.get("align.samtools_view")!, "gatk-view", { exclude_flags: 0 });
  const readGroups = node(catalog.get("align.gatk_add_read_groups")!, "gatk-read-groups", {
    read_group_id: "sample-1",
    library: "library-1",
    platform: "ILLUMINA",
    platform_unit: "unit-1",
    sample: "sample-1",
  });
  const gatkSort = node(catalog.get("align.samtools_sort_gatk")!, "gatk-sort", { threads: 1 });
  const bamIndex = node(catalog.get("align.samtools_index")!, "gatk-bam-index", { threads: 1 });
  const fastaIndex = node(catalog.get("ref.samtools_faidx")!, "gatk-fasta-index");
  const dictionary = node(catalog.get("ref.gatk_sequence_dictionary")!, "gatk-dictionary");
  const haplotypeCaller = node(catalog.get("var.haplotypecaller")!, "gatk-haplotypecaller");
  const hisatIndex = node(catalog.get("align.hisat2_index")!, "hisat-index", { threads: 1 });
  const hisat = node(catalog.get("align.hisat2")!, "hisat", { threads: 1 });
  const starIndex = node(catalog.get("align.star_index")!, "star-index", { threads: 1, genome_sa_index_nbases: 1 });
  const star = node(catalog.get("align.star")!, "star", { threads: 1 });
  const salmonIndex = node(catalog.get("quant.salmon_index")!, "salmon-index", { kmer: 15 });
  const salmon = node(catalog.get("quant.salmon")!, "salmon");
  const graph: SomiteGraph = {
    schema_version: 3,
    name: "real-aligner-index-smoke",
    nodes: [
      reference, decompress, transcripts, reads,
      bowtieIndex, bowtie,
      bwaIndex, bwa, view, readGroups, gatkSort, bamIndex, fastaIndex, dictionary, haplotypeCaller,
      hisatIndex, hisat, starIndex, star, salmonIndex, salmon,
    ],
    edges: [
      edge("public-reference-decompress", "public-reference", "fasta", "decompress-reference", "compressed"),
      edge("ref-bowtie-index", "decompress-reference", "fasta", "bowtie-index", "ref"),
      edge("bowtie-index-bowtie", "bowtie-index", "index", "bowtie", "index"),
      edge("reads-bowtie", "reads", "file", "bowtie", "r1"),
      edge("ref-bwa-index", "decompress-reference", "fasta", "bwa-index", "ref"),
      edge("bwa-index-bwa", "bwa-index", "index", "bwa", "index"),
      edge("reads-bwa", "reads", "file", "bwa", "r1"),
      edge("bwa-gatk-view", "bwa", "sam", "gatk-view", "sam"),
      edge("gatk-view-read-groups", "gatk-view", "bam", "gatk-read-groups", "bam"),
      edge("gatk-read-groups-sort", "gatk-read-groups", "bam", "gatk-sort", "bam"),
      edge("gatk-sort-bam-index", "gatk-sort", "bam", "gatk-bam-index", "bam"),
      edge("gatk-sort-haplotypecaller", "gatk-sort", "bam", "gatk-haplotypecaller", "bam"),
      edge("gatk-bam-index-haplotypecaller", "gatk-bam-index", "bai", "gatk-haplotypecaller", "bai"),
      edge("ref-gatk-fasta-index", "decompress-reference", "fasta", "gatk-fasta-index", "ref"),
      edge("gatk-fasta-index-haplotypecaller", "gatk-fasta-index", "fai", "gatk-haplotypecaller", "fai"),
      edge("ref-gatk-dictionary", "decompress-reference", "fasta", "gatk-dictionary", "ref"),
      edge("gatk-dictionary-haplotypecaller", "gatk-dictionary", "dict", "gatk-haplotypecaller", "dict"),
      edge("ref-gatk-haplotypecaller", "decompress-reference", "fasta", "gatk-haplotypecaller", "ref"),
      edge("ref-hisat-index", "decompress-reference", "fasta", "hisat-index", "ref"),
      edge("hisat-index-hisat", "hisat-index", "index", "hisat", "index"),
      edge("reads-hisat", "reads", "file", "hisat", "r1"),
      edge("ref-star-index", "decompress-reference", "fasta", "star-index", "ref"),
      edge("star-index-star", "star-index", "index", "star", "genome"),
      edge("reads-star", "reads", "file", "star", "r1"),
      edge("transcripts-salmon-index", "transcripts", "assembly", "salmon-index", "transcripts"),
      edge("salmon-index-salmon", "salmon-index", "index", "salmon", "index"),
      edge("reads-salmon", "reads", "file", "salmon", "r1"),
    ],
  };

  const started = await manager.start(graph, "run", "real-aligner-index-smoke");
  const status = await terminalStatus(manager, started.run_id);
  if (status.phase !== "completed") {
    const runRoot = join(projectRoot, ".somite", "runs", started.run_id);
    const stderr = await readFile(join(runRoot, "run.stderr.log"), "utf8").catch(() => "");
    const nextflow = await readFile(join(runRoot, ".nextflow.log"), "utf8").catch(() => "");
    assert.fail(`${status.error ?? `run ended ${status.phase}`}\n${stderr}\n${nextflow}`);
  }
  assert.equal(status.exit_code, 0);
  for (const id of [
    "bowtie-index", "bowtie", "bwa-index", "bwa",
    "gatk-view", "gatk-read-groups", "gatk-sort", "gatk-bam-index", "gatk-fasta-index", "gatk-dictionary", "gatk-haplotypecaller",
    "hisat-index", "hisat", "star-index", "star", "salmon-index", "salmon",
  ]) {
    assert.ok(["done", "cached"].includes(status.states[id]!), `${id}: ${status.states[id]}`);
  }
  const resultsRoot = join(projectRoot, ".somite", "runs", started.run_id, "results");
  const callerDirectory = (await readdir(resultsRoot, { withFileTypes: true }))
    .find((entry) => entry.isDirectory() && entry.name.startsWith("SOMITE_GATK_HAPLOTYPECALLER_"));
  assert.ok(callerDirectory, "HaplotypeCaller did not publish a result directory");
  const callerRoot = join(resultsRoot, callerDirectory.name);
  const callsPath = (await readdir(callerRoot, { recursive: true }))
    .find((entry) => entry.endsWith("calls.vcf"));
  assert.ok(callsPath, "HaplotypeCaller did not publish calls.vcf");
  const vcf = await readFile(join(callerRoot, callsPath), "utf8");
  assert.match(vcf, /^##fileformat=VCFv4\./);
  assert.match(vcf, /^#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tsample-1$/m);

  const validationReference = node(catalog.get("ensembl.fasta")!, "validation-reference", {
    url: `http://127.0.0.1:${referenceAddress.port}/reference.fa.gz`,
  });
  const validationDecompress = node(catalog.get("archive.gunzip_fasta")!, "validation-decompress");
  const validationIndex = node(catalog.get("align.star_index")!, "validation-star-index", { threads: 1 });
  const validationGraph: SomiteGraph = {
    schema_version: 3,
    name: "public-reference-representative-validation",
    nodes: [validationReference, validationDecompress, validationIndex],
    edges: [
      edge("validation-reference-decompress", validationReference.id, "fasta", validationDecompress.id, "compressed"),
      edge("validation-decompress-index", validationDecompress.id, "fasta", validationIndex.id, "ref"),
    ],
  };
  const validationStarted = await manager.start(validationGraph, "validation", "public-reference-star-validation");
  const validationStatus = await terminalStatus(manager, validationStarted.run_id);
  if (validationStatus.phase !== "completed") {
    const runRoot = join(projectRoot, ".somite", "runs", validationStarted.run_id);
    const stderr = await readFile(join(runRoot, "run.stderr.log"), "utf8").catch(() => "");
    const nextflow = await readFile(join(runRoot, ".nextflow.log"), "utf8").catch(() => "");
    assert.fail(`${validationStatus.error ?? `validation ended ${validationStatus.phase}`}\n${stderr}\n${nextflow}`);
  }
  assert.equal(validationStatus.evidence_receipt?.scope, "graph_e2e_public_retrieval_not_exercised_fixture_parameters_adjusted");
  assert.equal(validationStatus.evidence_receipt?.result, "passed");
  assert.deepEqual(validationStatus.evidence_receipt?.node_results, {
    "validation-decompress": "inconclusive",
    "validation-reference": "inconclusive",
    "validation-star-index": "passed",
  });
  const boundGraph = JSON.parse(await readFile(join(projectRoot, ".somite", "runs", validationStarted.run_id, "workflow.somite.json"), "utf8")) as SomiteGraph;
  assert.equal(boundGraph.nodes.find((entry) => entry.id === "validation-star-index")?.params?.genome_sa_index_nbases, 1);
});
