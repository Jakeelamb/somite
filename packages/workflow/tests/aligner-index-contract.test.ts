import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assessWorkflow } from "../assessment.ts";
import { loadOperatorCatalog } from "../catalog.node.ts";
import { operatorPorts, type PinnedOperator } from "../catalog.ts";
import type { SomiteGraph, SomiteGraphNode } from "../model.ts";
import { compileNextflow, type CompileOptions } from "../nextflow.ts";
import { validateGraph } from "../workflow.ts";

const operatorsDirectory = fileURLToPath(new URL("../../../operators/", import.meta.url));
const options: CompileOptions = {
  workflowName: "aligner-index-contract",
  outputDirectory: "results",
  platforms: ["linux-64"],
  nextflowVersion: "26.04.6",
  openjdkVersion: "25.0.2",
};

type IndexedTool = Readonly<{
  tool: string;
  builder: string;
  builderInput: string;
  indexInput: string;
  profile: string;
}>;

const indexedTools: readonly IndexedTool[] = [
  { tool: "align.bowtie2", builder: "align.bowtie2_build", builderInput: "ref", indexInput: "index", profile: "bowtie2-index" },
  { tool: "align.bwa", builder: "align.bwa_index", builderInput: "ref", indexInput: "index", profile: "bwa-index" },
  { tool: "align.hisat2", builder: "align.hisat2_index", builderInput: "ref", indexInput: "index", profile: "hisat2-index" },
  { tool: "align.star", builder: "align.star_index", builderInput: "ref", indexInput: "genome", profile: "star-index" },
  { tool: "quant.salmon", builder: "quant.salmon_index", builderInput: "transcripts", indexInput: "index", profile: "salmon-index" },
];

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

test("indexed tools cannot claim a raw FASTA is an executable index", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const reference = node(catalog.get("files.import_fasta")!, "reference", { path: "reference.fa" });
  const bwa = node(catalog.get("align.bwa")!, "bwa");
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [reference, bwa],
    edges: [edge("reference-to-bwa", "reference", "assembly", "bwa", "index")],
  };

  assert.deepEqual(validateGraph(graph), {
    ok: false,
    issue: {
      code: "type",
      message: "type mismatch reference.assembly:Fasta → bwa.index:Directory",
    },
  });
});

test("every indexed Linux core tool has a profiled FASTA builder and compiles through it", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const readsOperator = catalog.get("files.import")!;
  const referenceOperator = catalog.get("files.import_fasta")!;

  for (const spec of indexedTools) {
    const toolOperator = catalog.get(spec.tool);
    const builderOperator = catalog.get(spec.builder);
    assert.ok(toolOperator, `${spec.tool} is in the catalog`);
    assert.ok(builderOperator, `${spec.builder} is in the catalog`);

    const indexInput = toolOperator.ports.in.find((port) => port.name === spec.indexInput);
    const indexOutput = builderOperator.ports.out.find((port) => port.name === "index");
    assert.equal(indexInput?.type, "Directory", `${spec.tool} consumes a directory index`);
    assert.equal(indexInput?.resource?.profile, spec.profile, `${spec.tool} requires the engine-specific index profile`);
    assert.equal(indexOutput?.type, "Directory", `${spec.builder} produces a directory index`);
    assert.equal(indexOutput?.resource_profile, spec.profile, `${spec.builder} provides the engine-specific index profile`);

    const reads = node(readsOperator, `${spec.tool}-reads`, { path: "reads.fastq" });
    const reference = node(referenceOperator, `${spec.tool}-reference`, { path: "reference.fa" });
    const builder = node(builderOperator, `${spec.tool}-builder`);
    const tool = node(toolOperator, `${spec.tool}-tool`);
    const graph: SomiteGraph = {
      schema_version: 3,
      nodes: [reads, reference, builder, tool],
      edges: [
        edge(`${spec.tool}-reference-builder`, reference.id, "assembly", builder.id, spec.builderInput),
        edge(`${spec.tool}-builder-tool`, builder.id, "index", tool.id, spec.indexInput),
        edge(`${spec.tool}-reads-tool`, reads.id, "file", tool.id, "r1"),
      ],
    };

    assert.deepEqual(validateGraph(graph), { ok: true }, spec.tool);
    assert.deepEqual(catalog.verifyGraph(graph), { ok: true }, spec.tool);
    assert.equal(assessWorkflow(graph, catalog).state, "ready", spec.tool);
    const compiled = compileNextflow(graph, catalog, options);
    const packageName = builderOperator.pixi![0]!.split("::").at(-1)!;
    assert.match(compiled.pixiToml, new RegExp(`"${packageName}"`), spec.builder);
    assert.match(compiled.mainNf, /path input_\d+, name: '[^']+_index'/, spec.tool);
  }
});

test("an index directory from one engine cannot be wired into another", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const reference = node(catalog.get("files.import_fasta")!, "reference", { path: "reference.fa" });
  const bwaBuilder = node(catalog.get("align.bwa_index")!, "bwa-builder");
  const hisat = node(catalog.get("align.hisat2")!, "hisat");
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [reference, bwaBuilder, hisat],
    edges: [
      edge("reference-to-bwa-builder", "reference", "assembly", "bwa-builder", "ref"),
      edge("bwa-index-to-hisat", "bwa-builder", "index", "hisat", "index"),
    ],
  };

  assert.deepEqual(validateGraph(graph), { ok: true }, "both artifacts are physically directories");
  assert.deepEqual(catalog.verifyGraph(graph), {
    ok: false,
    issue: {
      code: "resource_profile_mismatch",
      message: "edge bwa-index-to-hisat requires resource profile hisat2-index at hisat.index, but bwa-builder.index provides resource profile bwa-index",
    },
  });
});

test("fetched genome and transcript FASTA artifacts compile into the appropriate indexes", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const assemblyDownload = node(catalog.get("ncbi.datasets_assembly")!, "assembly-download", { accession: "GCF_000001405.40" });
  const assemblyExtract = node(catalog.get("ncbi.datasets_extract_assembly")!, "assembly-extract");
  const bwa = node(catalog.get("align.bwa_index")!, "bwa-index");
  const hisat = node(catalog.get("align.hisat2_index")!, "hisat-index");
  const star = node(catalog.get("align.star_index")!, "star-index");
  const genomeGraph: SomiteGraph = {
    schema_version: 3,
    nodes: [assemblyDownload, assemblyExtract, bwa, hisat, star],
    edges: [
      edge("download-to-extract", "assembly-download", "package", "assembly-extract", "package"),
      edge("genome-to-bwa", "assembly-extract", "genome", "bwa-index", "ref"),
      edge("genome-to-hisat", "assembly-extract", "genome", "hisat-index", "ref"),
      edge("genome-to-star", "assembly-extract", "genome", "star-index", "ref"),
    ],
  };
  assert.deepEqual(catalog.verifyGraph(genomeGraph), { ok: true });
  assert.equal(assessWorkflow(genomeGraph, catalog).state, "ready");
  assert.doesNotThrow(() => compileNextflow(genomeGraph, catalog, options));

  const transcript = node(catalog.get("ensembl.sequence")!, "transcript", {
    accession: "ENST00000331789",
    sequence_type: "cdna",
  });
  const salmon = node(catalog.get("quant.salmon_index")!, "salmon-index");
  const transcriptGraph: SomiteGraph = {
    schema_version: 3,
    nodes: [transcript, salmon],
    edges: [edge("transcript-to-salmon", "transcript", "fasta", "salmon-index", "transcripts")],
  };
  assert.deepEqual(catalog.verifyGraph(transcriptGraph), { ok: true });
  assert.equal(assessWorkflow(transcriptGraph, catalog).state, "ready");
  assert.doesNotThrow(() => compileNextflow(transcriptGraph, catalog, options));
});

test("compressed public FASTA is normalized by one reviewed step before index building", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const publicFasta = node(catalog.get("ensembl.fasta")!, "public-fasta", {
    url: "https://example.test/reference.fa.gz",
  });
  const decompress = node(catalog.get("archive.gunzip_fasta")!, "decompress");
  const builders = [
    node(catalog.get("align.bwa_index")!, "bwa-index"),
    node(catalog.get("align.hisat2_index")!, "hisat-index"),
    node(catalog.get("align.star_index")!, "star-index"),
  ];
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [publicFasta, decompress, ...builders],
    edges: [
      edge("public-to-decompress", "public-fasta", "fasta", "decompress", "compressed"),
      ...builders.map((builder) => edge(`decompress-to-${builder.id}`, "decompress", "fasta", builder.id, "ref")),
    ],
  };

  assert.deepEqual(validateGraph(graph), { ok: true });
  assert.deepEqual(catalog.verifyGraph(graph), { ok: true });
  assert.equal(assessWorkflow(graph, catalog).state, "ready");
  const compiled = compileNextflow(graph, catalog, options);
  assert.match(compiled.pixiToml, /"gzip"/);
  assert.match(compiled.mainNf, /gzip/);
});

test("compressed local FASTQ remains typed and reaches STAR only through visible decompression", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const compressedImport = catalog.get("files.import_fastq_gz")!;
  const pairedCompressedImport = catalog.get("files.import_paired_gz")!;
  const decompressOperator = catalog.get("archive.gunzip_fastq")!;
  const starOperator = catalog.get("align.star")!;

  assert.deepEqual(compressedImport.ports.out.map((port) => [port.name, port.type]), [["reads", "FastqGz"]]);
  assert.deepEqual(pairedCompressedImport.ports.out.map((port) => [port.name, port.type]), [
    ["r1", "FastqGz"],
    ["r2", "FastqGz"],
  ]);
  assert.deepEqual(decompressOperator.ports.in.map((port) => [port.name, port.type]), [["compressed", "FastqGz"]]);
  assert.deepEqual(decompressOperator.ports.out.map((port) => [port.name, port.type]), [["fastq", "Fastq"]]);
  assert.equal(starOperator.ports.in.find((port) => port.name === "r1")?.union?.includes("FastqGz"), false);
  assert.equal(starOperator.ports.in.find((port) => port.name === "r2")?.union?.includes("FastqGz"), false);

  const compressed = node(compressedImport, "compressed", { path: "reads.fastq.gz" });
  const decompress = node(decompressOperator, "decompress");
  const index = node(catalog.get("align.star_index")!, "index", { threads: 1, genome_sa_index_nbases: 1 });
  const reference = node(catalog.get("files.import_fasta")!, "reference", { path: "reference.fa" });
  const star = node(starOperator, "star", { threads: 1 });
  const directGraph: SomiteGraph = {
    schema_version: 3,
    nodes: [compressed, reference, index, star],
    edges: [
      edge("reference-index", "reference", "assembly", "index", "ref"),
      edge("index-star", "index", "index", "star", "genome"),
      edge("compressed-star", "compressed", "reads", "star", "r1"),
    ],
  };
  assert.deepEqual(validateGraph(directGraph), {
    ok: false,
    issue: {
      code: "type",
      message: "type mismatch compressed.reads:FastqGz → star.r1:Fastq",
    },
  });

  const decompressedGraph: SomiteGraph = {
    schema_version: 3,
    nodes: [compressed, decompress, reference, index, star],
    edges: [
      edge("compressed-decompress", "compressed", "reads", "decompress", "compressed"),
      edge("decompress-star", "decompress", "fastq", "star", "r1"),
      edge("reference-index", "reference", "assembly", "index", "ref"),
      edge("index-star", "index", "index", "star", "genome"),
    ],
  };
  assert.deepEqual(validateGraph(decompressedGraph), { ok: true });
  assert.deepEqual(catalog.verifyGraph(decompressedGraph), { ok: true });
  assert.equal(assessWorkflow(decompressedGraph, catalog).state, "ready");
  const compiled = compileNextflow(decompressedGraph, catalog, options);
  assert.match(compiled.mainNf, /gzip/);
  assert.doesNotMatch(compiled.mainNf, /--readFilesCommand/);
});
