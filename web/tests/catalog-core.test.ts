import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OperatorCatalog, operatorPorts, renderArgv, renderPixiManifest, type PinnedOperator } from "@somite/workflow/catalog";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { catalogRevision, operatorRevision, parseOperator } from "@somite/workflow/catalogCodec";
import type { SomiteGraph, SomiteGraphNode } from "@somite/workflow/model";

const operatorsDirectory = new URL("../../operators/", import.meta.url);
const oraclePath = new URL("../../testdata/operator-revisions.json", import.meta.url);

type RevisionOracle = {
  catalog_revision: string;
  operator_revisions: Record<string, string>;
};

async function reviewedCatalog() {
  return loadOperatorCatalog(fileURLToPath(operatorsDirectory));
}

function node(operator: PinnedOperator, id = "node1"): SomiteGraphNode {
  return {
    id,
    operator: operator.id,
    operator_revision: operator.revision,
    ports: operatorPorts(operator),
    params: {},
    layout: { x: 0, y: 0 },
  };
}

function graph(nodes: SomiteGraphNode[], edges: SomiteGraph["edges"] = []): SomiteGraph {
  return { schema_version: 3, nodes, edges };
}

test("catalog loading reproduces every reviewed operator and revision", async () => {
  const loaded = await reviewedCatalog();
  const oracle = JSON.parse(await readFile(oraclePath, "utf8")) as RevisionOracle;
  assert.equal(loaded.operators.length, 48);
  assert.deepEqual(
    Object.fromEntries(loaded.operators.map((operator) => [operator.id, operator.revision])),
    oracle.operator_revisions,
  );
  assert.equal(loaded.revision, oracle.catalog_revision);
  assert.equal(catalogRevision(loaded.operators), oracle.catalog_revision);
});

test("operator identity excludes presentation but covers execution", async () => {
  const { catalog, revision } = await reviewedCatalog();
  const fastqc = catalog.get("qc.fastqc")!;
  const renamed = {
    ...fastqc,
    title: "A clearer FastQC label",
    palette: ["Different", "Grouping"],
    cost: "low" as const,
    paper: { aliases: ["Fast QC"], operation_class: "quality_control", assays: ["qc"] },
    params: Object.fromEntries(Object.entries(fastqc.params).map(([name, spec]) => [name, { ...spec, label: "Friendlier label" }])),
  };
  assert.equal(operatorRevision(renamed), fastqc.revision);
  assert.notEqual(catalogRevision([...catalog.values()].map((operator) => operator.id === fastqc.id ? renamed : operator)), revision);
  assert.notEqual(operatorRevision({ ...fastqc, argv: [...(fastqc.argv ?? []), "--quiet"] }), fastqc.revision);
});

test("catalog codec rejects unknown contract fields before they become revisions", () => {
  assert.throws(
    () => parseOperator({ id: "bad", title: "Bad", kind: "external", typo: true }),
    /unknown field typo/,
  );
});

test("catalog verification catches stale pins, wrong ports, and invalid source shape", async () => {
  const { catalog } = await reviewedCatalog();
  const fastqc = catalog.get("qc.fastqc")!;
  assert.deepEqual(catalog.verifyGraph(graph([node(fastqc)])), { ok: true });

  const stale = node(fastqc);
  stale.operator_revision = "blake3:stale";
  assert.deepEqual(catalog.verifyGraph(graph([stale])), {
    ok: false,
    issue: {
      code: "revision_mismatch",
      message: `node node1 pins operator qc.fastqc revision blake3:stale, expected ${fastqc.revision}`,
    },
  });

  const wrongPorts = node(fastqc);
  wrongPorts.ports = [];
  assert.equal(catalog.verifyGraph(graph([wrongPorts])).ok, false);

  const source = catalog.get("workflow.source")!;
  const sourceNode = node(source, "source1");
  sourceNode.source_workflow = {
    schema_version: 1,
    workflow_revision: `blake3:${"a".repeat(64)}`,
    source: {
      provider: "nf_core",
      repository: "nf-core/rnaseq",
      requested_revision: "3.26.0",
      resolved_revision: "a".repeat(40),
      source_digest: `blake3:${"b".repeat(64)}`,
      entrypoint: "main.nf",
      file_count: 1,
      source_bytes: 1,
    },
    capabilities: {
      exact_execution: true,
      parameter_edits: true,
      hierarchy_indexed: true,
      structural_edits: false,
      channel_contracts: false,
      source_edits: false,
    },
  };
  const invalidShape = catalog.verifyGraph(graph([sourceNode, node(fastqc, "fastqc1")]));
  assert.deepEqual(invalidShape, {
    ok: false,
    issue: {
      code: "source_workflow_graph_shape",
      message: "source-backed workflows currently require one source node and no edges",
    },
  });
});

test("imported workflow references retain their reviewed structural ports", async () => {
  const { catalog } = await reviewedCatalog();
  const reference = catalog.get("workflow.reference")!;
  const imported = node(reference, "fastqc");
  imported.params = {
    engine: "nextflow",
    workflow: "nf-core/rnaseq",
    revision: "3.26.0",
    component: "NFCORE_RNASEQ:RNASEQ:FASTQC",
  };
  imported.ports = [
    { name: "r1", dir: "in", ty: "Fastq", union: ["FastqGz"] },
    { name: "r2", dir: "in", ty: "Fastq", union: ["FastqGz"], optional: true },
    { name: "out", dir: "out", ty: "Directory", optional: true },
  ];
  assert.deepEqual(catalog.verifyGraph(graph([imported])), { ok: true });
});

test("command and Pixi rendering preserve the current execution contract", async () => {
  const { catalog } = await reviewedCatalog();
  const fastp = catalog.get("qc.fastp")!;
  assert.deepEqual(renderArgv(fastp, {
    params: { threads: 4 },
    inputs: { r1: "/reads/sample_R1.fastq.gz", r2: "/reads/sample_R2.fastq.gz" },
    work: "/w",
    workOut: "/w/out",
    workTmp: "/w/tmp",
  }), [
    "fastp",
    "-i",
    "/reads/sample_R1.fastq.gz",
    "-o",
    "/w/out/clean_R1.fastq.gz",
    "-I",
    "/reads/sample_R2.fastq.gz",
    "-O",
    "/w/out/clean_R2.fastq.gz",
    "-w",
    "4",
  ]);

  assert.equal(renderPixiManifest("RNA workflow", "linux-64", [fastp, fastp]), [
    "[workspace]",
    "name = \"RNA-workflow\"",
    "channels = [\"conda-forge\", \"bioconda\"]",
    "platforms = [\"linux-64\"]",
    "",
    "[dependencies]",
    "\"fastp\" = { version = \"*\", channel = \"bioconda\" }",
    "",
  ].join("\n"));
});

test("catalog lookup rejects duplicate operator ids", async () => {
  const { catalog } = await reviewedCatalog();
  const fastqc = catalog.get("qc.fastqc")!;
  assert.throws(() => new OperatorCatalog([fastqc, fastqc]), /duplicate operator id qc\.fastqc/);
});
