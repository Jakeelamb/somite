import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { operatorPorts } from "@somite/workflow/catalog";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { byteDigest } from "@somite/workflow/contentIdentity";
import {
  bindRepresentativeInputs,
  bindRepresentativeFastq,
  REPRESENTATIVE_SOURCE_PACK,
  representativeValidationCapability,
  RepresentativeValidationError,
} from "@somite/workflow/fixtures";
import type { SomiteGraph, SomiteGraphNode } from "@somite/workflow/model";

async function fixtureGraph() {
  const { catalog } = await loadOperatorCatalog(fileURLToPath(new URL("../../operators/", import.meta.url)));
  const input = catalog.get("files.import_paired")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      id: "reads",
      operator: input.id,
      operator_revision: input.revision,
      ports: [
        { name: "r1", dir: "out", ty: "Fastq" },
        { name: "r2", dir: "out", ty: "Fastq" },
      ],
      params: { r1: "real_R1.fastq", r2: "real_R2.fastq" },
      layout: { x: 0, y: 0 },
    }],
    edges: [],
  };
  const readOne = await readFile(new URL("../../fixtures/fastq/v1/reads_R1.fastq", import.meta.url));
  const readTwo = await readFile(new URL("../../fixtures/fastq/v1/reads_R2.fastq", import.meta.url));
  return {
    catalog,
    graph,
    fixtures: {
      readOne: { path: "/store/one.fastq", digest: byteDigest(readOne) },
      readTwo: { path: "/store/two.fastq", digest: byteDigest(readTwo) },
    },
  };
}

test("paired SRA validation uses local reads and declares retrieval nodes untested", async () => {
  const { catalog, fixtures } = await fixtureGraph();
  const prefetch = catalog.get("sra.prefetch")!;
  const fasterq = catalog.get("sra.fasterq_dump")!;
  const fastp = catalog.get("qc.fastp")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      id: "fetch",
      operator: prefetch.id,
      operator_revision: prefetch.revision,
      ports: operatorPorts(prefetch),
      params: { accession: "SRR000001", max_size: "20G" },
      layout: { x: 0, y: 0 },
    }, {
      id: "convert",
      operator: fasterq.id,
      operator_revision: fasterq.revision,
      ports: operatorPorts(fasterq),
      params: { threads: 1 },
      layout: { x: 240, y: 0 },
    }, {
      id: "trim",
      operator: fastp.id,
      operator_revision: fastp.revision,
      ports: operatorPorts(fastp),
      params: { threads: 1 },
      layout: { x: 480, y: 0 },
    }],
    edges: [
      { id: "fetch-convert", from_node: "fetch", from_port: "sra", to_node: "convert", to_port: "sra" },
      { id: "r1-trim", from_node: "convert", from_port: "r1", to_node: "trim", to_port: "r1" },
      { id: "r2-trim", from_node: "convert", from_port: "r2", to_node: "trim", to_port: "r2" },
    ],
  };

  assert.deepEqual(representativeValidationCapability(graph), {
    supported: true,
    fixture_pack: REPRESENTATIVE_SOURCE_PACK,
    unexercised_nodes: ["convert", "fetch"],
  });
  const binding = bindRepresentativeInputs(graph, catalog, fixtures);
  assert.equal(binding.fixture_pack, REPRESENTATIVE_SOURCE_PACK);
  assert.deepEqual(binding.unexercised_nodes, ["convert", "fetch"]);
  assert.equal(binding.graph.nodes.some((node) => node.operator.startsWith("sra.")), false);
  const localReads = binding.graph.nodes.find((node) => node.operator === "files.import_paired");
  assert.deepEqual(localReads?.params, { r1: "/store/one.fastq", r2: "/store/two.fastq" });
  assert.deepEqual(binding.graph.edges.filter((edge) => edge.to_node === "trim").map((edge) => edge.from_node), [localReads?.id, localReads?.id]);
  assert.equal(graph.nodes[0]?.operator, "sra.prefetch", "fixture binding must not mutate the saved canvas");
});

test("single-end SRA validation preserves the downstream typed connection", async () => {
  const { catalog, fixtures } = await fixtureGraph();
  const prefetch = catalog.get("sra.prefetch")!;
  const fasterq = catalog.get("sra.fasterq_dump_single")!;
  const fastqc = catalog.get("qc.fastqc")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "fetch", operator: prefetch.id, operator_revision: prefetch.revision, ports: operatorPorts(prefetch), params: { accession: "SRR000001" }, layout: { x: 0, y: 0 } },
      { id: "convert", operator: fasterq.id, operator_revision: fasterq.revision, ports: operatorPorts(fasterq), params: { threads: 1 }, layout: { x: 240, y: 0 } },
      { id: "qc", operator: fastqc.id, operator_revision: fastqc.revision, ports: operatorPorts(fastqc), params: { threads: 1 }, layout: { x: 480, y: 0 } },
    ],
    edges: [
      { id: "fetch-convert", from_node: "fetch", from_port: "sra", to_node: "convert", to_port: "sra" },
      { id: "reads-qc", from_node: "convert", from_port: "reads", to_node: "qc", to_port: "fastq" },
    ],
  };

  const binding = bindRepresentativeInputs(graph, catalog, fixtures);
  const localRead = binding.graph.nodes.find((node) => node.operator === "files.import");
  assert.equal(localRead?.params?.path, "/store/one.fastq");
  assert.deepEqual(binding.graph.edges.find((edge) => edge.id === "reads-qc"), {
    id: "reads-qc",
    from_node: localRead?.id,
    from_port: "file",
    to_node: "qc",
    to_port: "fastq",
  });
});

test("representative fixtures bind local reads, reference, and annotation together", async () => {
  const { catalog, fixtures } = await fixtureGraph();
  const reference = catalog.get("files.import_fasta")!;
  const annotation = catalog.get("files.import_gtf")!;
  const reads = catalog.get("files.import_paired")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "reads", operator: reads.id, operator_revision: reads.revision, ports: operatorPorts(reads), params: { r1: "sample_R1.fastq", r2: "sample_R2.fastq" }, layout: { x: 0, y: 0 } },
      { id: "reference", operator: reference.id, operator_revision: reference.revision, ports: operatorPorts(reference), params: { path: "species.fa" }, layout: { x: 0, y: 120 } },
      { id: "annotation", operator: annotation.id, operator_revision: annotation.revision, ports: operatorPorts(annotation), params: { path: "species.gtf" }, layout: { x: 0, y: 240 } },
    ],
    edges: [],
  };
  const typedFixtures = {
    ...fixtures,
    reference: { path: "/store/reference.fa", digest: `blake3:${"a".repeat(64)}` },
    gtf: { path: "/store/annotation.gtf", digest: `blake3:${"b".repeat(64)}` },
  };

  assert.deepEqual(representativeValidationCapability(graph), {
    supported: true,
    fixture_pack: REPRESENTATIVE_SOURCE_PACK,
    unexercised_nodes: [],
  });
  const binding = bindRepresentativeInputs(graph, catalog, typedFixtures);
  assert.equal(binding.graph.nodes.find((node) => node.id === "reference")?.params?.path, "/store/reference.fa");
  assert.equal(binding.graph.nodes.find((node) => node.id === "annotation")?.params?.path, "/store/annotation.gtf");
  assert.equal(binding.fixture_digests.length, 4);
});

test("local compressed roots bind compressed bytes and keep explicit decompression executable", async () => {
  const { catalog, fixtures } = await fixtureGraph();
  const compressedReads = catalog.get("files.import_paired_gz")!;
  const decompressReads = catalog.get("archive.gunzip_fastq")!;
  const compressedReference = catalog.get("files.import_fasta_gz")!;
  const decompressReference = catalog.get("archive.gunzip_fasta")!;
  const readOneBytes = gzipSync(await readFile(new URL("../../fixtures/fastq/v1/reads_R1.fastq", import.meta.url)), { level: 9 });
  const readTwoBytes = gzipSync(await readFile(new URL("../../fixtures/fastq/v1/reads_R2.fastq", import.meta.url)), { level: 9 });
  const referenceBytes = gzipSync(await readFile(new URL("../../fixtures/reference/v1/reference.fa", import.meta.url)), { level: 9 });
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "reads", operator: compressedReads.id, operator_revision: compressedReads.revision, ports: operatorPorts(compressedReads), params: { r1: "sample_R1.fastq.gz", r2: "sample_R2.fastq.gz" }, layout: { x: 0, y: 0 } },
      { id: "unzip-r1", operator: decompressReads.id, operator_revision: decompressReads.revision, ports: operatorPorts(decompressReads), params: {}, layout: { x: 240, y: 0 } },
      { id: "reference", operator: compressedReference.id, operator_revision: compressedReference.revision, ports: operatorPorts(compressedReference), params: { path: "species.fa.gz" }, layout: { x: 0, y: 160 } },
      { id: "unzip-reference", operator: decompressReference.id, operator_revision: decompressReference.revision, ports: operatorPorts(decompressReference), params: {}, layout: { x: 240, y: 160 } },
    ],
    edges: [
      { id: "reads-unzip", from_node: "reads", from_port: "r1", to_node: "unzip-r1", to_port: "compressed" },
      { id: "reference-unzip", from_node: "reference", from_port: "assembly", to_node: "unzip-reference", to_port: "compressed" },
    ],
  };
  const compressedFixtures = {
    ...fixtures,
    readOneGz: { path: "/store/one.fastq.gz", digest: byteDigest(readOneBytes) },
    readTwoGz: { path: "/store/two.fastq.gz", digest: byteDigest(readTwoBytes) },
    referenceGz: { path: "/store/reference.fa.gz", digest: byteDigest(referenceBytes) },
  };

  assert.deepEqual(representativeValidationCapability(graph), {
    supported: true,
    fixture_pack: REPRESENTATIVE_SOURCE_PACK,
    unexercised_nodes: [],
  });
  const binding = bindRepresentativeInputs(graph, catalog, compressedFixtures);
  assert.deepEqual(binding.graph.nodes.find((node) => node.id === "reads")?.params, {
    r1: "/store/one.fastq.gz",
    r2: "/store/two.fastq.gz",
  });
  assert.equal(binding.graph.nodes.find((node) => node.id === "reference")?.params?.path, "/store/reference.fa.gz");
  assert.ok(binding.graph.nodes.some((node) => node.id === "unzip-r1"));
  assert.ok(binding.graph.nodes.some((node) => node.id === "unzip-reference"));
  assert.deepEqual(binding.unexercised_nodes, []);
  assert.deepEqual(binding.fixture_digests, [byteDigest(readOneBytes), byteDigest(readTwoBytes), byteDigest(referenceBytes)].sort());
});

test("compressed local validation fails closed when compressed fixture bytes are unavailable", async () => {
  const { catalog, fixtures } = await fixtureGraph();
  const compressed = catalog.get("files.import_fastq_gz")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      id: "reads",
      operator: compressed.id,
      operator_revision: compressed.revision,
      ports: operatorPorts(compressed),
      params: { path: "sample.fastq.gz" },
      layout: { x: 0, y: 0 },
    }],
    edges: [],
  };

  assert.throws(
    () => bindRepresentativeInputs(graph, catalog, fixtures),
    /representative single_fastq_gz fixture is unavailable/,
  );
});

test("NCBI assembly validation bypasses download and extraction with typed fixtures", async () => {
  const { catalog, fixtures } = await fixtureGraph();
  const download = catalog.get("ncbi.datasets_assembly")!;
  const extract = catalog.get("ncbi.datasets_extract_assembly")!;
  const index = catalog.get("align.bwa_index")!;
  const counts = catalog.get("quant.featurecounts")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "download", operator: download.id, operator_revision: download.revision, ports: operatorPorts(download), params: { accession: "GCF_000001405.40" }, layout: { x: 0, y: 0 } },
      { id: "extract", operator: extract.id, operator_revision: extract.revision, ports: operatorPorts(extract), params: {}, layout: { x: 240, y: 0 } },
      { id: "index", operator: index.id, operator_revision: index.revision, ports: operatorPorts(index), params: {}, layout: { x: 480, y: 0 } },
      { id: "counts", operator: counts.id, operator_revision: counts.revision, ports: operatorPorts(counts), params: { threads: 1 }, layout: { x: 480, y: 160 } },
    ],
    edges: [
      { id: "package", from_node: "download", from_port: "package", to_node: "extract", to_port: "package" },
      { id: "genome", from_node: "extract", from_port: "genome", to_node: "index", to_port: "ref" },
      { id: "annotation", from_node: "extract", from_port: "gtf", to_node: "counts", to_port: "gtf" },
    ],
  };
  const typedFixtures = {
    ...fixtures,
    reference: { path: "/store/reference.fa", digest: `blake3:${"a".repeat(64)}` },
    gtf: { path: "/store/annotation.gtf", digest: `blake3:${"b".repeat(64)}` },
  };

  assert.deepEqual(representativeValidationCapability(graph), {
    supported: true,
    fixture_pack: REPRESENTATIVE_SOURCE_PACK,
    unexercised_nodes: ["download", "extract"],
  });
  const binding = bindRepresentativeInputs(graph, catalog, typedFixtures);
  assert.equal(binding.graph.nodes.some((node) => node.operator.startsWith("ncbi.datasets")), false);
  const reference = binding.graph.nodes.find((node) => node.operator === "files.import_fasta");
  const annotation = binding.graph.nodes.find((node) => node.operator === "files.import_gtf");
  assert.equal(binding.graph.edges.find((edge) => edge.id === "genome")?.from_node, reference?.id);
  assert.equal(binding.graph.edges.find((edge) => edge.id === "genome")?.from_port, "assembly");
  assert.equal(binding.graph.edges.find((edge) => edge.id === "annotation")?.from_node, annotation?.id);
});

test("Ensembl reference and annotation roots bind typed local fixtures without HTTP", async () => {
  const { catalog, fixtures } = await fixtureGraph();
  const sequence = catalog.get("ensembl.sequence")!;
  const annotation = catalog.get("ensembl.gtf")!;
  const index = catalog.get("align.bwa_index")!;
  const counts = catalog.get("quant.featurecounts")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "sequence", operator: sequence.id, operator_revision: sequence.revision, ports: operatorPorts(sequence), params: { accession: "ENSG00000139618", sequence_type: "genomic" }, layout: { x: 0, y: 0 } },
      { id: "annotation", operator: annotation.id, operator_revision: annotation.revision, ports: operatorPorts(annotation), params: { url: "https://example.invalid/species.gtf.gz" }, layout: { x: 0, y: 160 } },
      { id: "index", operator: index.id, operator_revision: index.revision, ports: operatorPorts(index), params: {}, layout: { x: 320, y: 0 } },
      { id: "counts", operator: counts.id, operator_revision: counts.revision, ports: operatorPorts(counts), params: { threads: 1 }, layout: { x: 320, y: 160 } },
    ],
    edges: [
      { id: "sequence-index", from_node: "sequence", from_port: "fasta", to_node: "index", to_port: "ref" },
      { id: "annotation-counts", from_node: "annotation", from_port: "gtf", to_node: "counts", to_port: "gtf" },
    ],
  };
  const typedFixtures = {
    ...fixtures,
    reference: { path: "/store/reference.fa", digest: `blake3:${"a".repeat(64)}` },
    gtf: { path: "/store/annotation.gtf", digest: `blake3:${"b".repeat(64)}` },
  };

  assert.deepEqual(representativeValidationCapability(graph), {
    supported: true,
    fixture_pack: REPRESENTATIVE_SOURCE_PACK,
    unexercised_nodes: ["annotation", "sequence"],
  });
  const binding = bindRepresentativeInputs(graph, catalog, typedFixtures);
  assert.equal(binding.graph.nodes.some((node) => node.operator.startsWith("ensembl.")), false);
  assert.equal(binding.graph.edges.find((edge) => edge.id === "sequence-index")?.from_port, "assembly");
  assert.equal(binding.graph.edges.find((edge) => edge.id === "annotation-counts")?.from_port, "gtf");
});

test("compressed Ensembl FASTA and decompression are bypassed as one reviewed source shape", async () => {
  const { catalog, fixtures } = await fixtureGraph();
  const download = catalog.get("ensembl.fasta")!;
  const decompress = catalog.get("archive.gunzip_fasta")!;
  const index = catalog.get("align.star_index")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "download", operator: download.id, operator_revision: download.revision, ports: operatorPorts(download), params: { url: "https://example.invalid/reference.fa.gz" }, layout: { x: 0, y: 0 } },
      { id: "decompress", operator: decompress.id, operator_revision: decompress.revision, ports: operatorPorts(decompress), params: {}, layout: { x: 240, y: 0 } },
      { id: "index", operator: index.id, operator_revision: index.revision, ports: operatorPorts(index), params: { threads: 1 }, layout: { x: 480, y: 0 } },
    ],
    edges: [
      { id: "download-decompress", from_node: "download", from_port: "fasta", to_node: "decompress", to_port: "compressed" },
      { id: "decompress-index", from_node: "decompress", from_port: "fasta", to_node: "index", to_port: "ref" },
    ],
  };
  const typedFixtures = {
    ...fixtures,
    reference: { path: "/store/reference.fa", digest: `blake3:${"a".repeat(64)}` },
  };

  assert.deepEqual(representativeValidationCapability(graph), {
    supported: true,
    fixture_pack: REPRESENTATIVE_SOURCE_PACK,
    unexercised_nodes: ["decompress", "download"],
    parameter_overrides: { "index.genome_sa_index_nbases": 1 },
  });
  const binding = bindRepresentativeInputs(graph, catalog, typedFixtures);
  assert.equal(binding.graph.nodes.some((node) => node.id === "download" || node.id === "decompress"), false);
  assert.equal(binding.graph.nodes.find((node) => node.id === "index")?.params?.genome_sa_index_nbases, 1);
  assert.deepEqual(binding.parameter_overrides, { "index.genome_sa_index_nbases": 1 });
});

test("protein sequence retrieval fails closed without a typed protein fixture", async () => {
  const { catalog } = await fixtureGraph();
  const sequence = catalog.get("ensembl.sequence")!;
  const index = catalog.get("align.bwa_index")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "protein", operator: sequence.id, operator_revision: sequence.revision, ports: operatorPorts(sequence), params: { accession: "ENSP00000439902", sequence_type: "protein" }, layout: { x: 0, y: 0 } },
      { id: "index", operator: index.id, operator_revision: index.revision, ports: operatorPorts(index), params: {}, layout: { x: 240, y: 0 } },
    ],
    edges: [{ id: "protein-index", from_node: "protein", from_port: "fasta", to_node: "index", to_port: "ref" }],
  };

  const capability = representativeValidationCapability(graph);
  assert.equal(capability.supported, false);
  if (capability.supported) return;
  assert.deepEqual(capability.unsupported_roots, ["ensembl.sequence"]);
  assert.match(capability.reason, /reviewed fixture adapter/);
});

test("representative FASTQ identity is path-independent", async () => {
  const { graph, fixtures } = await fixtureGraph();
  const first = bindRepresentativeFastq(graph, fixtures);
  const second = bindRepresentativeFastq({
    ...graph,
    nodes: [{ ...graph.nodes[0], params: { r1: "other_R1.fastq", r2: "other_R2.fastq" } }],
  }, {
    readOne: { ...fixtures.readOne, path: "/elsewhere/one.fastq" },
    readTwo: { ...fixtures.readTwo, path: "/elsewhere/two.fastq" },
  });
  assert.equal(first.configuration_digest, second.configuration_digest);
  assert.deepEqual(first.fixture_digests, second.fixture_digests);
  assert.equal(first.graph.nodes[0].params?.r1, "/store/one.fastq");
  assert.equal(graph.nodes[0].params?.r1, "real_R1.fastq");
});

test("representative validation rejects unsupported root sources", async () => {
  const { graph, fixtures } = await fixtureGraph();
  const unsupported: SomiteGraphNode = { ...graph.nodes[0], operator: "sra.prefetch" };
  const capability = representativeValidationCapability({ ...graph, nodes: [unsupported] });
  assert.deepEqual(capability, {
    supported: false,
    code: "representative_fixture_unsupported",
    reason: "Representative validation supports reviewed local FASTQ, compressed FASTQ, FASTA, compressed FASTA, BAM, GTF, and GFF3 fixtures plus exact SRA, NCBI assembly, and Ensembl source shapes. This workflow starts with sra.prefetch; Run can still use its real inputs, but Validate is unavailable until a reviewed fixture adapter exists.",
    unsupported_roots: ["sra.prefetch"],
  });
  assert.throws(
    () => bindRepresentativeFastq({ ...graph, nodes: [unsupported] }, fixtures),
    (error) => error instanceof RepresentativeValidationError
      && error.code === "representative_fixture_unsupported"
      && error.capability.reason === capability.reason
      && error.capability.unsupported_roots.join(",") === "sra.prefetch",
  );
});

test("a locked source workflow exposes static Nextflow preview validation", async () => {
  const { graph } = await fixtureGraph();
  const source: SomiteGraphNode = {
    ...graph.nodes[0],
    operator: "workflow.source",
    ports: [],
    params: {},
    source_workflow: {
      schema_version: 1,
      workflow_revision: `blake3:${"a".repeat(64)}`,
      source: {
        provider: "local",
        repository: "local:demo",
        requested_revision: "working-tree",
        resolved_revision: "b".repeat(64),
        source_digest: `blake3:${"b".repeat(64)}`,
        entrypoint: "main.nf",
        file_count: 3,
        source_bytes: 300,
      },
      capabilities: {
        exact_execution: true,
        parameter_edits: true,
        hierarchy_indexed: true,
        structural_edits: false,
        channel_contracts: false,
        source_edits: false,
      },
    },
  };
  assert.deepEqual(representativeValidationCapability({ ...graph, nodes: [source] }), {
    supported: true,
    kind: "source_preview",
    fixture_pack: "somite.source.preview.v1",
  });
});
