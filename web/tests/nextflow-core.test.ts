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
