import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assessWorkflow } from "../assessment.ts";
import { loadOperatorCatalog } from "../catalog.node.ts";
import { operatorPorts, type PinnedOperator } from "../catalog.ts";
import type { SomiteGraph, SomiteGraphNode } from "../model.ts";
import { compileNextflow, type CompileOptions } from "../nextflow.ts";
import { reconstructPaper } from "../paper.ts";
import { validateGraph } from "../workflow.ts";

const operatorsDirectory = fileURLToPath(new URL("../../../operators/", import.meta.url));
const options: CompileOptions = {
  workflowName: "gatk-haplotypecaller-contract",
  outputDirectory: "results",
  platforms: ["linux-64"],
  nextflowVersion: "26.04.6",
  openjdkVersion: "25.0.2",
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

test("HaplotypeCaller exposes every runtime prerequisite as a typed visible artifact", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const haplotypeCaller = catalog.get("var.haplotypecaller")!;

  assert.deepEqual(
    haplotypeCaller.ports.in.map(({ name, type, stage_as, implicit_sidecar, resource }) => ({
      name,
      type,
      stage_as,
      implicit_sidecar: implicit_sidecar ?? false,
      profile: resource?.profile,
    })),
    [
      { name: "bam", type: "GatkReadyBam", stage_as: "sample.bam", implicit_sidecar: false, profile: undefined },
      { name: "bai", type: "Bai", stage_as: "sample.bam.bai", implicit_sidecar: true, profile: undefined },
      { name: "ref", type: "Fasta", stage_as: "reference.fa", implicit_sidecar: false, profile: undefined },
      { name: "fai", type: "Fai", stage_as: "reference.fa.fai", implicit_sidecar: true, profile: undefined },
      { name: "dict", type: "Dict", stage_as: "reference.dict", implicit_sidecar: true, profile: undefined },
    ],
  );

  assert.deepEqual(catalog.get("ref.samtools_faidx")?.argv, [
    "samtools", "faidx", "--fai-idx", "{work}/out/reference.fa.fai", "{input.ref}",
  ]);
  assert.equal(catalog.get("ref.samtools_faidx")?.ports.out[0]?.type, "Fai");
  assert.equal(catalog.get("ref.gatk_sequence_dictionary")?.ports.out[0]?.type, "Dict");
  assert.equal(catalog.get("align.gatk_add_read_groups")?.ports.out[0]?.type, "ReadGroupedBam");
  assert.equal(catalog.get("align.samtools_sort_gatk")?.ports.out[0]?.type, "GatkReadyBam");
  assert.equal(catalog.get("align.samtools_index")?.ports.out[0]?.type, "Bai");
});

test("the complete BWA to HaplotypeCaller path is ready and stages inferred sidecars by matching basename", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const reads = node(catalog.get("files.import")!, "reads", { path: "reads.fastq" });
  const reference = node(catalog.get("files.import_fasta")!, "reference", { path: "reference.fa" });
  const bwaIndex = node(catalog.get("align.bwa_index")!, "bwa-index");
  const bwa = node(catalog.get("align.bwa")!, "bwa", { threads: 1 });
  const view = node(catalog.get("align.samtools_view")!, "view", { exclude_flags: 0 });
  const readGroups = node(catalog.get("align.gatk_add_read_groups")!, "read-groups", {
    read_group_id: "sample-1",
    library: "library-1",
    platform: "ILLUMINA",
    platform_unit: "unit-1",
    sample: "sample-1",
  });
  const sort = node(catalog.get("align.samtools_sort_gatk")!, "sort", { threads: 1 });
  const bamIndex = node(catalog.get("align.samtools_index")!, "bam-index", { threads: 1 });
  const fastaIndex = node(catalog.get("ref.samtools_faidx")!, "fasta-index");
  const dictionary = node(catalog.get("ref.gatk_sequence_dictionary")!, "dictionary");
  const caller = node(catalog.get("var.haplotypecaller")!, "caller");
  const graph: SomiteGraph = {
    schema_version: 3,
    name: "complete-gatk-haplotypecaller",
    nodes: [reads, reference, bwaIndex, bwa, view, readGroups, sort, bamIndex, fastaIndex, dictionary, caller],
    edges: [
      edge("reference-bwa-index", "reference", "assembly", "bwa-index", "ref"),
      edge("bwa-index-bwa", "bwa-index", "index", "bwa", "index"),
      edge("reads-bwa", "reads", "file", "bwa", "r1"),
      edge("bwa-view", "bwa", "sam", "view", "sam"),
      edge("view-read-groups", "view", "bam", "read-groups", "bam"),
      edge("read-groups-sort", "read-groups", "bam", "sort", "bam"),
      edge("sort-bam-index", "sort", "bam", "bam-index", "bam"),
      edge("sort-caller", "sort", "bam", "caller", "bam"),
      edge("bam-index-caller", "bam-index", "bai", "caller", "bai"),
      edge("reference-fasta-index", "reference", "assembly", "fasta-index", "ref"),
      edge("fasta-index-caller", "fasta-index", "fai", "caller", "fai"),
      edge("reference-dictionary", "reference", "assembly", "dictionary", "ref"),
      edge("dictionary-caller", "dictionary", "dict", "caller", "dict"),
      edge("reference-caller", "reference", "assembly", "caller", "ref"),
    ],
  };

  assert.equal(assessWorkflow(graph, catalog).state, "ready");
  const compiled = compileNextflow(graph, catalog, options);
  for (const basename of ["sample.bam", "sample.bam.bai", "reference.fa", "reference.fa.fai", "reference.dict"]) {
    assert.match(compiled.mainNf, new RegExp(`name: '${basename.replaceAll(".", "\\.")}'`));
  }
});

test("a generic BAM cannot masquerade as coordinate-sorted read-grouped HaplotypeCaller input", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const genericSort = node(catalog.get("align.samtools_sort")!, "generic-sort");
  const caller = node(catalog.get("var.haplotypecaller")!, "caller");
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [genericSort, caller],
    edges: [edge("generic-bam-caller", "generic-sort", "bam", "caller", "bam")],
  };

  const validation = validateGraph(graph);
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.match(validation.issue.message, /Bam.*GatkReadyBam/);
});

test("paper reconstruction inserts the complete typed HaplotypeCaller preparation chain", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end reads were aligned to the GRCh38 reference with BWA-MEM.",
    "SAMtools view converted the alignments to BAM.",
    "Variants were called from the resulting BAM using GATK HaplotypeCaller.",
  ].join("\n"), "text");
  const graph = review.candidates.find((candidate) => candidate.assay === "variants")?.graph;
  const assessment = review.candidates.find((candidate) => candidate.assay === "variants")?.assessment;
  assert.ok(graph);
  assert.ok(assessment?.items.some((item) => item.id === "parameter:align-gatk-add-read-groups:sample"));

  const required = [
    "align.gatk_add_read_groups",
    "align.samtools_sort_gatk",
    "align.samtools_index",
    "ref.samtools_faidx",
    "ref.gatk_sequence_dictionary",
    "var.haplotypecaller",
  ];
  for (const operator of required) assert.ok(graph.nodes.some((entry) => entry.operator === operator), operator);
  const caller = graph.nodes.find((entry) => entry.operator === "var.haplotypecaller")!;
  assert.deepEqual(
    graph.edges.filter((entry) => entry.to_node === caller.id).map((entry) => entry.to_port).sort(),
    ["bai", "bam", "dict", "fai", "ref"],
  );
});
