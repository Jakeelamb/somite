import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { OperatorCatalog, operatorPorts, type PinnedOperator } from "@somite/workflow/catalog";
import { operatorRevision, parseOperator } from "@somite/workflow/catalogCodec";
import { byteDigest } from "@somite/workflow/contentIdentity";
import type { SomiteGraph, SomiteGraphNode } from "@somite/workflow/model";
import {
  compileNextflow,
  NextflowCompileError,
  type CompileOptions,
  type CompiledWorkflow,
} from "@somite/workflow/nextflow";

const fixtureRoot = new URL("../../testdata/compiler/", import.meta.url);
const goldenPath = new URL("../../testdata/paired-main.nf", import.meta.url);
const oraclePath = new URL("../../testdata/nextflow-compiler-oracle.json", import.meta.url);
const encoder = new TextEncoder();

const options: CompileOptions = {
  workflowName: "somite-spike",
  outputDirectory: "results",
  platforms: ["linux-64"],
  nextflowVersion: "26.04.4",
  openjdkVersion: "17.0.17",
};

async function pairedFixture() {
  const operatorNames = ["files.import_paired.json", "qc.fastp.json", "qc.fastqc_paired.json"];
  const operators = await Promise.all(operatorNames.map(async (name) => {
    const raw = JSON.parse(await readFile(new URL(`operators/${name}`, fixtureRoot), "utf8"));
    const operator = parseOperator(raw, name);
    return { ...operator, revision: operatorRevision(operator) };
  }));
  const catalog = new OperatorCatalog(operators);
  const raw = JSON.parse(await readFile(new URL("fastp-fastqc.somite.json", fixtureRoot), "utf8")) as SomiteGraph;
  const graph: SomiteGraph = {
    ...raw,
    schema_version: 3,
    nodes: raw.nodes.map((node) => {
      const operator = catalog.get(node.operator)!;
      return { ...node, operator_revision: operator.revision, ports: operatorPorts(operator) };
    }),
  };
  return { graph, catalog };
}

function repeatedFastpGraph(graph: SomiteGraph, processCount: number) {
  const reads = graph.nodes.find((node) => node.id === "reads");
  const fastp = graph.nodes.find((node) => node.id === "fastp");
  assert.ok(reads);
  assert.ok(fastp);

  const nodes: SomiteGraphNode[] = [reads];
  const rawEdges: SomiteGraph["edges"] = [];
  for (let index = 0; index < processCount; index += 1) {
    const id = `fastp_${String(index).padStart(3, "0")}`;
    const previous = index === 0 ? reads.id : `fastp_${String(index - 1).padStart(3, "0")}`;
    nodes.push({ ...fastp, id, layout: { x: 320 * (index + 1), y: 0 } });
    for (const port of ["r1", "r2"] as const) {
      rawEdges.push({
        id: `edge_${String(index).padStart(3, "0")}_${port}`,
        from_node: previous,
        from_port: port,
        to_node: id,
        to_port: port,
      });
    }
  }

  let edgeElementReads = 0;
  const edges = new Proxy(rawEdges, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/.test(property)) edgeElementReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    graph: { ...graph, nodes, edges },
    edgeElementReads: () => edgeElementReads,
  };
}

function artifactOracle(compiled: CompiledWorkflow) {
  const artifacts = {
    main_nf: compiled.mainNf,
    nextflow_config: compiled.nextflowConfig,
    node_map_json: compiled.nodeMapJson,
    params_json: compiled.paramsJson,
    pixi_toml: compiled.pixiToml,
  };
  return {
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, {
      digest: byteDigest(encoder.encode(value)),
      bytes: encoder.encode(value).byteLength,
    }])),
  };
}

test("the compiler reproduces every byte of the reviewed Nextflow artifacts", async () => {
  const { graph, catalog } = await pairedFixture();
  const compiled = compileNextflow(graph, catalog, options);
  const oracle = JSON.parse(await readFile(oraclePath, "utf8"));
  assert.deepEqual(artifactOracle(compiled), oracle);
  assert.equal(compiled.mainNf, await readFile(goldenPath, "utf8"));
});

test("output validation stays on Bash 3.2 and preserves required and optional outputs", async () => {
  const { graph, catalog } = await pairedFixture();
  const fastqc = catalog.get("qc.fastqc_paired")!;
  const optionalFastqc: PinnedOperator = {
    ...fastqc,
    revision: "test-optional-fastqc",
    ports: {
      ...fastqc.ports,
      out: fastqc.ports.out.map((port) => port.name === "report_r2" ? { ...port, optional: true } : port),
    },
    outputs: {
      ...fastqc.outputs,
      report_r2: { ...fastqc.outputs!.report_r2!, optional: true },
    },
  };
  const changedCatalog = new OperatorCatalog([...catalog.values()].map((operator) => operator.id === fastqc.id ? optionalFastqc : operator));
  const changedGraph: SomiteGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => node.operator === fastqc.id ? {
      ...node,
      operator_revision: optionalFastqc.revision,
      ports: operatorPorts(optionalFastqc),
    } : node),
  };
  const compiled = compileNextflow(changedGraph, changedCatalog, options);

  assert.doesNotMatch(compiled.mainNf, /\b(?:mapfile|readarray)\b/, "generated tasks must run on macOS Bash 3.2");
  assert.match(compiled.mainNf, /while IFS= read -r somite_artifact; do/);
  assert.match(compiled.mainNf, /required output report_r1 was not created/);
  assert.doesNotMatch(compiled.mainNf, /required output report_r2 was not created/);
});

test("compiler edge indexing scales linearly with repeated external processes", async () => {
  const fixture = await pairedFixture();
  const smaller = repeatedFastpGraph(fixture.graph, 12);
  compileNextflow(smaller.graph, fixture.catalog, options);
  const larger = repeatedFastpGraph(fixture.graph, 24);
  compileNextflow(larger.graph, fixture.catalog, options);

  assert.ok(
    larger.edgeElementReads() <= smaller.edgeElementReads() * 2 + 8,
    `doubling a linear graph must not more than double edge traversal work: ${smaller.edgeElementReads()} -> ${larger.edgeElementReads()}`,
  );
});

test("compiler keeps hostile path and parameter values out of generated shell code", async () => {
  const { graph, catalog } = await pairedFixture();
  const hostile = "reads/'\" $(touch SHOULD_NOT_EXIST)\nR1.fastq";
  const fastp = catalog.get("qc.fastp")!;
  const changedFastp: PinnedOperator = {
    ...fastp,
    params: { ...fastp.params, threads: { ...fastp.params.threads, type: "string" } },
    revision: "test-hostile-contract",
  };
  const changedCatalog = new OperatorCatalog([...catalog.values()].map((operator) => operator.id === fastp.id ? changedFastp : operator));
  const changedGraph: SomiteGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === "reads"
      ? { ...node, params: { ...node.params, r1: hostile } }
      : node.id === "fastp"
        ? { ...node, operator_revision: changedFastp.revision, params: { ...node.params, threads: "1; touch SHOULD_NOT_EXIST" } }
        : node),
  };
  const compiled = compileNextflow(changedGraph, changedCatalog, { ...options, outputDirectory: "results/'\" $(touch ALSO_NOT)" });
  assert.match(compiled.paramsJson, /SHOULD_NOT_EXIST/);
  assert.match(compiled.paramsJson, /\\nR1\.fastq/);
  assert.doesNotMatch(compiled.mainNf, /SHOULD_NOT_EXIST|ALSO_NOT/);
  assert.match(compiled.mainNf, /"\$\{SOMITE_PARAM_/);
  assert.match(compiled.mainNf, /"\$\{argv\[@\]\}"/);
});

test("compiler rejects structural nodes, nested engines, invalid parameters, and missing inputs", async () => {
  const { graph, catalog } = await pairedFixture();
  const fastp = catalog.get("qc.fastp")!;

  const reference: PinnedOperator = { ...fastp, id: "reference", kind: "reference", revision: "reference-revision" };
  const referenceGraph = replaceNodeOperator(graph, "fastp", reference);
  assertCompileCode(referenceGraph, new OperatorCatalog([...catalog.values(), reference]), "reference_node");

  const nested: PinnedOperator = {
    ...fastp,
    id: "nested.nextflow",
    bin: "env",
    argv: ["env", "/usr/bin/nextflow"],
    revision: "nested-revision",
  };
  assertCompileCode(replaceNodeOperator(graph, "fastp", nested), new OperatorCatalog([...catalog.values(), nested]), "nested_engine");

  const invalidParameter = {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === "fastp" ? { ...node, params: { threads: "four" } } : node),
  };
  assertCompileCode(invalidParameter, catalog, "invalid_parameter");

  const missingInput = { ...graph, edges: graph.edges.filter((edge) => edge.to_port !== "r2" || edge.to_node !== "fastp") };
  assertCompileCode(missingInput, catalog, "missing_input");
});

function replaceNodeOperator(graph: SomiteGraph, nodeId: string, operator: PinnedOperator): SomiteGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node): SomiteGraphNode => node.id === nodeId ? {
      ...node,
      operator: operator.id,
      operator_revision: operator.revision,
      ports: operatorPorts(operator),
    } : node),
  };
}

function assertCompileCode(graph: SomiteGraph, catalog: OperatorCatalog, code: NextflowCompileError["code"]) {
  assert.throws(
    () => compileNextflow(graph, catalog, options),
    (error) => error instanceof NextflowCompileError && error.code === code,
  );
}
