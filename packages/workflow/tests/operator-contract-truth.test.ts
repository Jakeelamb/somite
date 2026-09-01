import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assessWorkflow } from "../assessment.ts";
import { loadOperatorCatalog } from "../catalog.node.ts";
import { OperatorCatalog, operatorPorts, type PinnedOperator } from "../catalog.ts";
import type { SomiteGraph, SomiteGraphNode } from "../model.ts";
import { compileNextflow, operatorImportPaths, type CompileOptions } from "../nextflow.ts";

const operatorsDirectory = fileURLToPath(new URL("../../../operators/", import.meta.url));
const options: CompileOptions = {
  workflowName: "operator-contract-truth",
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

function edge(
  id: string,
  fromNode: string,
  fromPort: string,
  toNode: string,
  toPort: string,
): SomiteGraph["edges"][number] {
  return { id, from_node: fromNode, from_port: fromPort, to_node: toNode, to_port: toPort };
}

function inputReferences(operator: PinnedOperator, input: string) {
  return (operator.argv ?? []).flatMap((token) => {
    const references = [...token.matchAll(/\{input\.([^}]+)\}/g)]
      .filter((match) => match[1] === input);
    return references.map(() => ({ token, condition: /^(\?!|\?)([^:]+):/.exec(token)?.[2] }));
  });
}

test("reviewed external operators have closed input and output contracts", async () => {
  const { operators } = await loadOperatorCatalog(operatorsDirectory);
  const issues: string[] = [];

  for (const operator of operators.filter((candidate) => candidate.kind === "external")) {
    for (const input of operator.ports.in) {
      const references = inputReferences(operator, input.name);
      if (references.length === 0 && !input.implicit_sidecar) issues.push(`${operator.id}.${input.name}: declared input is never consumed`);
      if (input.optional && references.some((reference) => reference.condition !== input.name)) {
        issues.push(`${operator.id}.${input.name}: optional input is referenced outside its own conditional argv token`);
      }
    }

    const outputNames = new Set(operator.ports.out.map((output) => output.name));
    for (const output of operator.ports.out) {
      const spec = operator.outputs?.[output.name];
      if (!spec) {
        issues.push(`${operator.id}.${output.name}: output port has no collection rule`);
        continue;
      }
      if (spec.type !== output.type) issues.push(`${operator.id}.${output.name}: output type ${output.type} != collection type ${spec.type}`);
      if (Boolean(spec.optional) !== Boolean(output.optional)) {
        issues.push(`${operator.id}.${output.name}: output optionality differs between port and collection rule`);
      }
    }
    for (const output of Object.keys(operator.outputs ?? {})) {
      if (!outputNames.has(output)) issues.push(`${operator.id}.${output}: collection rule has no output port`);
    }
  }

  assert.deepEqual(issues, []);
});

test("the reviewed catalog loader rejects cross-field execution drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "somite-operator-contract-"));
  try {
    await writeFile(join(directory, "bad.json"), JSON.stringify({
      id: "test.bad",
      title: "Bad optional input",
      palette: [],
      kind: "external",
      cost: "low",
      bin: "bad",
      params: {},
      ports: {
        in: [{ name: "reads", type: "Fastq", optional: true }],
        out: [{ name: "report", type: "Table" }],
      },
      argv: ["bad", "{input.reads}"],
      outputs: { report: { glob: "{work}/out/report.tsv", type: "Table", optional: true } },
    }));

    await assert.rejects(
      loadOperatorCatalog(directory),
      /test\.bad\.reads: optional input is referenced outside its own conditional argv token/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a ready workflow with an omitted optional read compiles", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const reads = node(catalog.get("files.import")!, "reads", { path: "reads.fastq.gz" });
  const reference = node(catalog.get("files.import_fasta")!, "reference", { path: "reference.fa" });
  const index = node(catalog.get("align.bwa_index")!, "index");
  const bwa = node(catalog.get("align.bwa")!, "bwa");
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [reads, reference, index, bwa],
    edges: [
      edge("reads-to-bwa", "reads", "file", "bwa", "r1"),
      edge("reference-to-index", "reference", "assembly", "index", "ref"),
      edge("index-to-bwa", "index", "index", "bwa", "index"),
    ],
  };

  assert.equal(assessWorkflow(graph, catalog).state, "ready");
  assert.doesNotThrow(() => compileNextflow(graph, catalog, options));
});

test("a required minimap2 reference is reported before compilation", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const reads = node(catalog.get("files.import")!, "reads", { path: "reads.fastq.gz" });
  const minimap = node(catalog.get("align.minimap2")!, "minimap");
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [reads, minimap],
    edges: [edge("reads-to-minimap", "reads", "file", "minimap", "reads")],
  };

  const assessment = assessWorkflow(graph, catalog);
  assert.equal(assessment.state, "building");
  assert.ok(assessment.items.some((item) => item.id === "input:minimap:ref"));
});

test("unsupported in-process transforms remain explicit blockers", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const reads = node(catalog.get("files.import")!, "reads", { path: "reads.fastq.gz" });
  const sheet = node(catalog.get("sheet.rnaseq")!, "sheet");
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [reads, sheet],
    edges: [edge("reads-to-sheet", "reads", "file", "sheet", "r1")],
  };

  const assessment = assessWorkflow(graph, catalog);
  assert.equal(assessment.state, "needs_action");
  assert.ok(assessment.items.some((item) => item.id === "resolution:sheet:adapter"));
  assert.equal(assessment.nodes.find((candidate) => candidate.node_id === "sheet")?.requires_action, true);
});

test("SAM-producing aligners expose SAM rather than BAM", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  for (const id of ["align.hisat2", "align.minimap2"]) {
    const operator = catalog.get(id)!;
    assert.deepEqual(operator.ports.out.map(({ name, type }) => ({ name, type })), [{ name: "sam", type: "Sam" }], id);
    assert.equal(operator.outputs?.sam?.type, "Sam", id);
    assert.match(operator.outputs?.sam?.glob ?? "", /\.sam$/, id);
  }
});

test("the compiler rejects output optionality drift even outside the reviewed loader", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const reads = node(catalog.get("files.import")!, "reads", { path: "reads.fastq.gz" });
  const reference = node(catalog.get("files.import_fasta")!, "reference", { path: "reference.fa" });
  const index = node(catalog.get("align.bwa_index")!, "index");
  const bwa = catalog.get("align.bwa")!;
  const drifted: PinnedOperator = {
    ...bwa,
    revision: "test-output-optionality-drift",
    outputs: { ...bwa.outputs, sam: { ...bwa.outputs!.sam!, optional: true } },
  };
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [reads, reference, index, node(drifted, "bwa")],
    edges: [
      edge("reads-to-bwa", "reads", "file", "bwa", "r1"),
      edge("reference-to-index", "reference", "assembly", "index", "ref"),
      edge("index-to-bwa", "index", "index", "bwa", "index"),
    ],
  };
  const driftedCatalog = new OperatorCatalog([...catalog.values()].map((operator) => operator.id === drifted.id ? drifted : operator));

  assert.throws(
    () => compileNextflow(graph, driftedCatalog, options),
    /output sam: optionality differs between port and collection rule/,
  );
});

test("required directory outputs must contain an artifact", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const reference = node(catalog.get("files.import_fasta")!, "reference", { path: "reference.fa" });
  const build = node(catalog.get("align.bowtie2_build")!, "build");
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [reference, build],
    edges: [edge("reference-to-build", "reference", "assembly", "build", "ref")],
  };

  assert.equal(assessWorkflow(graph, catalog).state, "ready");
  assert.match(
    compileNextflow(graph, catalog, options).mainNf,
    /find "\$somite_artifact" -mindepth 1 -print -quit/,
  );
});

test("reviewed SRA source contracts are ready-to-compile", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const prefetch = node(catalog.get("sra.prefetch")!, "prefetch", { accession: "SRR000001" });
  const single = node(catalog.get("sra.fasterq_dump_single")!, "single");
  const source: SomiteGraph = { schema_version: 3, nodes: [prefetch], edges: [] };
  const conversion: SomiteGraph = {
    schema_version: 3,
    nodes: [prefetch, single],
    edges: [edge("prefetch-to-single", "prefetch", "sra", "single", "sra")],
  };

  for (const graph of [source, conversion]) {
    assert.equal(assessWorkflow(graph, catalog).state, "ready");
    assert.doesNotThrow(() => compileNextflow(graph, catalog, options));
  }
});

test("typed local GTF and GFF3 sources lower as exact file imports", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  for (const [id, port, type] of [
    ["files.import_gtf", "gtf", "Gtf"],
    ["files.import_gff3", "gff3", "Gff3"],
  ] as const) {
    const operator = catalog.get(id)!;
    assert.deepEqual(operator.ports.out.map((output) => [output.name, output.type]), [[port, type]]);
    assert.deepEqual(operatorImportPaths(operator), [{ port, parameter: "path", kind: "file" }]);
    const graph: SomiteGraph = { schema_version: 3, nodes: [node(operator, id, { path: `inputs/${port}` })], edges: [] };
    assert.equal(assessWorkflow(graph, catalog).state, "ready");
    assert.doesNotThrow(() => compileNextflow(graph, catalog, options));
  }
});

test("typed local BAM is an exact file import accepted by BAM consumers", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const input = catalog.get("files.import_bam")!;
  assert.deepEqual(input.ports.out.map((output) => [output.name, output.type]), [["bam", "Bam"]]);
  assert.deepEqual(operatorImportPaths(input), [{ port: "bam", parameter: "path", kind: "file" }]);

  const readGroups = catalog.get("align.gatk_add_read_groups")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      node(input, "input", { path: "inputs/sample.bam" }),
      node(readGroups, "read-groups", {
        read_group_id: "sample-1",
        library: "library-1",
        platform: "ILLUMINA",
        platform_unit: "unit-1",
        sample: "sample-1",
      }),
    ],
    edges: [edge("input-to-read-groups", "input", "bam", "read-groups", "bam")],
  };
  assert.equal(assessWorkflow(graph, catalog).state, "ready");
  assert.doesNotThrow(() => compileNextflow(graph, catalog, options));
});
