import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { OperatorCatalog } from "@somite/workflow/catalog";
import { operatorRevision, parseOperator } from "@somite/workflow/catalogCodec";
import { compileNextflow, type CompileOptions } from "@somite/workflow/nextflow";
import { assemblyResult, sraResults } from "@somite/workflow/sourceSearch";
import { buildPublicSourceGraph } from "../app/publicSourceGraph.ts";
import { classifySource } from "../app/sourceBuilder.ts";

const operatorFiles = [
  "sra.prefetch.json",
  "sra.fasterq_dump.json",
  "sra.fasterq_dump_single.json",
  "ncbi.datasets_assembly.json",
  "ncbi.datasets_extract_assembly.json",
  "ensembl.sequence.json",
] as const;

const compileOptions: CompileOptions = {
  workflowName: "public-source",
  outputDirectory: "results",
  platforms: ["linux-64"],
  nextflowVersion: "26.04.4",
  openjdkVersion: "17.0.17",
};

async function operators() {
  const loaded = await Promise.all(operatorFiles.map(async (file) => {
    const path = new URL(`../../operators/${file}`, import.meta.url);
    const operator = parseOperator(JSON.parse(await readFile(path, "utf8")), path.pathname);
    return { ...operator, revision: operatorRevision(operator) };
  }));
  return { map: new Map(loaded.map((operator) => [operator.id, operator])), catalog: new OperatorCatalog(loaded) };
}

test("direct source actions wait for provider metadata when identity alone is insufficient", () => {
  assert.equal(classifySource("SRR10000001"), null, "an SRA accession does not encode its library layout");
  assert.equal(classifySource("ENST00000357654.9"), null, "a versioned Ensembl ID must be resolved by the provider");
  assert.equal(classifySource("GCA_009914755.4")?.kind, "assembly");
  assert.equal(classifySource("ENST00000357654")?.sequenceType, "cdna");
});

test("the public-data graph seam preserves paired and single SRA layouts", async () => {
  const { map, catalog } = await operators();
  const paired = sraResults({
    runs: '<Run acc="SRR10000001"/>',
    expxml: "<Title>Paired reads</Title><Organism ScientificName=\"Homo sapiens\"/><LIBRARY_STRATEGY>WGS</LIBRARY_STRATEGY><PAIRED/>",
  })[0]!;
  const pairedGraph = buildPublicSourceGraph(paired.request, map, [], { x: 40, y: 80 });
  assert.deepEqual(pairedGraph.nodes.map((node) => node.operator), ["sra.prefetch", "sra.fasterq_dump"]);
  assert.deepEqual(
    pairedGraph.nodes[1]?.ports.filter((port) => port.dir === "out").map((port) => [port.name, port.ty, port.optional ?? false]),
    [["r1", "Fastq", false], ["r2", "Fastq", false]],
  );
  assert.deepEqual(pairedGraph.edges.map((edge) => [edge.from_port, edge.to_port]), [["sra", "sra"]]);
  assert.deepEqual(catalog.verifyGraph({ schema_version: 3, ...pairedGraph }), { ok: true });
  assert.match(compileNextflow({ schema_version: 3, ...pairedGraph }, catalog, compileOptions).mainNf, /\*_2\.fastq/);

  const single = sraResults({
    runs: '<Run acc="SRR10000002"/>',
    expxml: "<Title>Single reads</Title><Organism ScientificName=\"Homo sapiens\"/><LIBRARY_STRATEGY>RNA-Seq</LIBRARY_STRATEGY><SINGLE/>",
  })[0]!;
  const singleGraph = buildPublicSourceGraph(single.request, map, [], { x: 40, y: 80 });
  assert.deepEqual(singleGraph.nodes.map((node) => node.operator), ["sra.prefetch", "sra.fasterq_dump_single"]);
  assert.deepEqual(
    singleGraph.nodes[1]?.ports.filter((port) => port.dir === "out").map((port) => [port.name, port.ty, port.optional ?? false]),
    [["reads", "Fastq", false]],
  );
  assert.deepEqual(catalog.verifyGraph({ schema_version: 3, ...singleGraph }), { ok: true });
  assert.match(compileNextflow({ schema_version: 3, ...singleGraph }, catalog, compileOptions).mainNf, /\*\.fastq/);
});

test("NCBI assembly sources expose typed genome and annotation artifacts", async () => {
  const { map, catalog } = await operators();
  const result = assemblyResult({
    assemblyaccession: "GCF_000001405.40",
    assemblyname: "GRCh38.p14",
    organism: "Homo sapiens",
    assemblystatus: "Chromosome",
  })!;
  const graph = buildPublicSourceGraph(result.request, map, [], { x: 40, y: 80 });
  assert.deepEqual(graph.nodes.map((node) => node.operator), ["ncbi.datasets_assembly", "ncbi.datasets_extract_assembly"]);
  assert.deepEqual(
    graph.nodes[1]?.ports.filter((port) => port.dir === "out").map((port) => [port.name, port.ty, port.optional ?? false]),
    [
      ["genome", "Fasta", false],
      ["gff3", "Gff3", true],
      ["gtf", "Gtf", true],
      ["catalog", "Json", false],
      ["sequence_report", "Text", true],
    ],
  );
  assert.deepEqual(graph.edges.map((edge) => [edge.from_port, edge.to_port]), [["package", "package"]]);
  assert.deepEqual(catalog.verifyGraph({ schema_version: 3, ...graph }), { ok: true });
  const compiled = compileNextflow({ schema_version: 3, ...graph }, catalog, compileOptions);
  assert.match(compiled.mainNf, /\*_genomic\.fna/);
  assert.match(compiled.mainNf, /genomic\.gff/);
  assert.match(compiled.mainNf, /genomic\.gtf/);
});
