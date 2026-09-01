import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assessWorkflow } from "../assessment.ts";
import { loadOperatorCatalog } from "../catalog.node.ts";
import { operatorPorts, renderArgv, type OperatorCatalog, type PinnedOperator } from "../catalog.ts";
import type { SomiteGraph, SomiteGraphNode } from "../model.ts";
import { compileNextflow, PINNED_NEXTFLOW_VERSION, PINNED_OPENJDK_VERSION } from "../nextflow.ts";
import { reconstructPaper } from "../paper.ts";

const operatorsDirectory = fileURLToPath(new URL("../../../operators/", import.meta.url));
const compileOptions = {
  workflowName: "common-paper-adapters",
  outputDirectory: "results",
  platforms: ["linux-64"],
  nextflowVersion: PINNED_NEXTFLOW_VERSION,
  openjdkVersion: PINNED_OPENJDK_VERSION,
};

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

function edge(id: string, fromNode: string, fromPort: string, toNode: string, toPort: string): SomiteGraph["edges"][number] {
  return { id, from_node: fromNode, from_port: fromPort, to_node: toNode, to_port: toPort };
}

function catalogOperator(catalog: OperatorCatalog, id: string) {
  const operator = catalog.get(id);
  assert.ok(operator, `missing ${id}`);
  return operator;
}

test("common paper tools pin reviewed Pixi versions and exact argv", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const multiqc = catalogOperator(catalog, "qc.multiqc");
  const picard = catalogOperator(catalog, "align.picard_mark_duplicates");
  const kallistoIndex = catalogOperator(catalog, "quant.kallisto_index");
  const kallisto = catalogOperator(catalog, "quant.kallisto");
  const kallistoSingle = catalogOperator(catalog, "quant.kallisto_single");

  assert.deepEqual(multiqc.pixi, ["bioconda::multiqc=1.35"]);
  assert.deepEqual(picard.pixi, ["bioconda::picard=3.5.0"]);
  assert.deepEqual(kallisto.pixi, ["bioconda::kallisto=0.52.0"]);
  assert.equal(multiqc.outputs?.data?.glob, "{work}/out/multiqc_report_data");

  assert.deepEqual(renderArgv(multiqc, {
    params: {}, inputs: { reports: "/analysis" }, work: "/w", workOut: "/w/out", workTmp: "/w/tmp",
  }), [
    "multiqc", "/analysis", "--outdir", "/w/out", "--filename", "multiqc_report.html", "--force", "--data-dir",
  ]);
  assert.deepEqual(renderArgv(picard, {
    params: {}, inputs: { bam: "/reads/aligned.bam" }, work: "/w", workOut: "/w/out", workTmp: "/w/tmp",
  }), [
    "picard", "MarkDuplicates", "--INPUT", "/reads/aligned.bam", "--OUTPUT", "/w/out/marked-duplicates.bam",
    "--METRICS_FILE", "/w/out/duplication-metrics.txt",
  ]);
  assert.deepEqual(renderArgv(kallistoIndex, {
    params: { threads: 4 }, inputs: { transcripts: "/ref/transcripts.fa.gz" }, work: "/w", workOut: "/w/out", workTmp: "/w/tmp",
  }), ["kallisto", "index", "--index", "/w/out/transcripts.idx", "--threads", "4", "/ref/transcripts.fa.gz"]);
  assert.deepEqual(renderArgv(kallisto, {
    params: { threads: 8 }, inputs: { r1: "/reads/R1.fastq.gz", r2: "/reads/R2.fastq.gz", index: "/idx" }, work: "/w", workOut: "/w/out", workTmp: "/w/tmp",
  }), [
    "kallisto", "quant", "--index", "/idx/transcripts.idx", "--output-dir", "/w/out", "--threads", "8",
    "/reads/R1.fastq.gz", "/reads/R2.fastq.gz",
  ]);
  assert.deepEqual(renderArgv(kallistoSingle, {
    params: { threads: 2, fragment_length: 190, fragment_sd: 20 }, inputs: { reads: "/reads/sample.fastq.gz", index: "/idx" }, work: "/w", workOut: "/w/out", workTmp: "/w/tmp",
  }), [
    "kallisto", "quant", "--index", "/idx/transcripts.idx", "--output-dir", "/w/out", "--threads", "2",
    "--single", "--fragment-length", "190", "--sd", "20", "/reads/sample.fastq.gz",
  ]);
});

test("MultiQC and Kallisto indices require their reviewed directory profiles", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const generic = node(catalogOperator(catalog, "files.import_directory"), "generic", { path: "reports" });
  const reports = node(catalogOperator(catalog, "files.import_multiqc_reports"), "reports", { path: "reports" });
  const multiqc = node(catalogOperator(catalog, "qc.multiqc"), "multiqc");
  const invalid: SomiteGraph = {
    schema_version: 3,
    nodes: [generic, multiqc],
    edges: [edge("generic-to-multiqc", "generic", "directory", "multiqc", "reports")],
  };
  assert.deepEqual(catalog.verifyGraph(invalid), {
    ok: false,
    issue: {
      code: "resource_profile_mismatch",
      message: "edge generic-to-multiqc requires resource profile multiqc-scan-directory at multiqc.reports, but generic.directory provides no resource profile",
    },
  });

  const valid: SomiteGraph = {
    schema_version: 3,
    nodes: [reports, multiqc],
    edges: [edge("reports-to-multiqc", "reports", "reports", "multiqc", "reports")],
  };
  assert.equal(assessWorkflow(valid, catalog).state, "ready");
  assert.match(compileNextflow(valid, catalog, compileOptions).mainNf, /multiqc_report\.html/);

  const importedBam = node(catalogOperator(catalog, "files.import_bam"), "bam", { path: "aligned.bam" });
  const picard = node(catalogOperator(catalog, "align.picard_mark_duplicates"), "picard");
  const unsortedPicard: SomiteGraph = {
    schema_version: 3,
    nodes: [importedBam, picard],
    edges: [edge("bam-to-picard", "bam", "bam", "picard", "bam")],
  };
  assert.equal(catalog.verifyGraph(unsortedPicard).ok, false, "a generic BAM must not claim coordinate-sort provenance");
  const sort = node(catalogOperator(catalog, "align.samtools_sort"), "sort", { threads: 2 });
  const sortedPicard: SomiteGraph = {
    schema_version: 3,
    nodes: [importedBam, sort, picard],
    edges: [
      edge("bam-to-sort", "bam", "bam", "sort", "bam"),
      edge("sort-to-picard", "sort", "bam", "picard", "bam"),
    ],
  };
  assert.equal(assessWorkflow(sortedPicard, catalog).state, "ready");
  assert.match(compileNextflow(sortedPicard, catalog, compileOptions).mainNf, /duplication-metrics\.txt/);

  const reads = node(catalogOperator(catalog, "files.import_paired"), "reads", { r1: "R1.fastq.gz", r2: "R2.fastq.gz" });
  const transcripts = node(catalogOperator(catalog, "files.import_fasta"), "transcripts", { path: "transcripts.fa" });
  const index = node(catalogOperator(catalog, "quant.kallisto_index"), "index", { threads: 4 });
  const quant = node(catalogOperator(catalog, "quant.kallisto"), "quant", { threads: 4 });
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [reads, transcripts, index, quant],
    edges: [
      edge("transcripts-to-index", "transcripts", "assembly", "index", "transcripts"),
      edge("index-to-quant", "index", "index", "quant", "index"),
      edge("r1-to-quant", "reads", "r1", "quant", "r1"),
      edge("r2-to-quant", "reads", "r2", "quant", "r2"),
    ],
  };
  assert.equal(assessWorkflow(graph, catalog).state, "ready");
  const compiled = compileNextflow(graph, catalog, compileOptions);
  assert.match(compiled.mainNf, /transcripts\.idx/);
  assert.match(compiled.pixiToml, /"kallisto" = \{ version = "=0\.52\.0", channel = "bioconda" \}/);
});

test("paper reconstruction maps only explicit Picard deduplication and preserves Kallisto layout", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end RNA-seq reads were trimmed with fastp before FastQC generated per-sample reports.",
    "MultiQC aggregated the analysis reports, STAR aligned the reads, and duplicate alignments were marked with Picard MarkDuplicates.",
    "Kallisto quantified transcript abundance from the paired reads.",
  ].join("\n"), "jats");
  assert.deepEqual(
    review.mentions.filter((mention) => ["multiqc", "picardmarkduplicates", "kallisto"].includes(mention.normalized_name))
      .map((mention) => mention.operator_id),
    ["qc.multiqc", "align.picard_mark_duplicates", "quant.kallisto"],
  );
  const candidate = review.candidates.find((item) => item.assay === "rna_seq");
  assert.ok(candidate);
  const ids = new Set(candidate.graph.nodes.map((candidateNode) => candidateNode.operator));
  for (const id of ["qc.multiqc", "align.picard_mark_duplicates", "quant.kallisto_index", "quant.kallisto"]) assert.ok(ids.has(id), id);
  const index = candidate.graph.nodes.find((candidateNode) => candidateNode.operator === "quant.kallisto_index")!;
  const quant = candidate.graph.nodes.find((candidateNode) => candidateNode.operator === "quant.kallisto")!;
  assert.ok(candidate.graph.edges.some((candidateEdge) => candidateEdge.from_node === index.id && candidateEdge.to_node === quant.id && candidateEdge.to_port === "index"));

  const single = reconstructPaper(catalog, "Methods\nSingle-end RNA-seq reads were quantified with Kallisto.", "jats");
  assert.equal(single.mentions.find((mention) => mention.normalized_name === "kallisto")?.operator_id, "quant.kallisto_single");
  assert.ok(single.candidates[0]?.graph.nodes.some((candidateNode) => candidateNode.operator === "quant.kallisto_single"));

  const otherPicard = reconstructPaper(catalog, "Methods\nRNA-seq alignments were summarized with Picard CollectInsertSizeMetrics.", "jats");
  assert.ok(otherPicard.mentions.some((mention) => mention.normalized_name === "picard" && mention.support === "unsupported"));
  assert.equal(otherPicard.candidates.some((item) => item.graph.nodes.some((candidateNode) => candidateNode.operator === "align.picard_mark_duplicates")), false);
});
