import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assessWorkflow } from "../assessment.ts";
import { loadOperatorCatalog } from "../catalog.node.ts";
import { operatorPorts, type PinnedOperator } from "../catalog.ts";
import type { SomiteEdge, SomiteGraph, SomiteGraphNode } from "../model.ts";
import {
  compileNextflow,
  NextflowCompileError,
  operatorImportPaths,
  PINNED_NEXTFLOW_VERSION,
  PINNED_OPENJDK_VERSION,
} from "../nextflow.ts";
import { validateGraph } from "../workflow.ts";

const operatorsDirectory = fileURLToPath(new URL("../../../operators/", import.meta.url));

function node(operator: PinnedOperator, id: string, params: Record<string, string> = {}): SomiteGraphNode {
  return {
    id,
    operator: operator.id,
    operator_revision: operator.revision,
    ports: operatorPorts(operator),
    ...(Object.keys(params).length ? { params } : {}),
    layout: { x: 0, y: 0 },
  };
}

function edge(id: string, fromNode: string, fromPort: string, toNode: string, toPort: string): SomiteEdge {
  return { id, from_node: fromNode, from_port: fromPort, to_node: toNode, to_port: toPort };
}

function krakenGraph(
  operators: {
    reads: PinnedOperator;
    database: PinnedOperator;
    kraken: PinnedOperator;
  },
): SomiteGraph {
  return {
    schema_version: 3,
    nodes: [
      node(operators.reads, "reads", { r1: "reads_R1.fastq", r2: "reads_R2.fastq" }),
      node(operators.database, "database", { path: "resources/kraken2" }),
      node(operators.kraken, "kraken"),
    ],
    edges: [
      edge("read-one-to-kraken", "reads", "r1", "kraken", "r1"),
      edge("read-two-to-kraken", "reads", "r2", "kraken", "r2"),
      edge(
        "database-to-kraken",
        "database",
        operators.database.id === "files.import_directory" ? "directory" : "database",
        "kraken",
        "db",
      ),
    ],
  };
}

test("a generic Directory cannot satisfy a typed Kraken2 database input", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const graph = krakenGraph({
    reads: catalog.get("files.import_paired")!,
    database: catalog.get("files.import_directory")!,
    kraken: catalog.get("class.kraken2")!,
  });

  assert.deepEqual(validateGraph(graph), { ok: true }, "the physical Directory type remains valid");
  assert.deepEqual(catalog.verifyGraph(graph), {
    ok: false,
    issue: {
      code: "resource_profile_mismatch",
      message: "edge database-to-kraken requires resource profile kraken2-database at kraken.db, but database.directory provides no resource profile",
    },
  });
  assert.throws(
    () => assessWorkflow(graph, catalog),
    /catalog: edge database-to-kraken requires resource profile kraken2-database/,
  );
  assert.throws(
    () => compileNextflow(graph, catalog, {
      workflowName: "invalid-kraken",
      outputDirectory: "results",
      platforms: ["linux-64"],
      nextflowVersion: PINNED_NEXTFLOW_VERSION,
      openjdkVersion: PINNED_OPENJDK_VERSION,
    }),
    (error) => error instanceof NextflowCompileError
      && error.code === "invalid_graph"
      && error.message.includes("requires resource profile kraken2-database"),
  );
});

test("the reviewed existing-database import provides the profile and lowers as a local directory", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const database = catalog.get("files.import_kraken2_database")!;
  const graph = krakenGraph({
    reads: catalog.get("files.import_paired")!,
    database,
    kraken: catalog.get("class.kraken2")!,
  });

  assert.deepEqual(operatorImportPaths(database), [{
    port: "database",
    parameter: "path",
    kind: "directory",
  }]);
  assert.deepEqual(catalog.verifyGraph(graph), { ok: true });
  const assessment = assessWorkflow(graph, catalog);
  assert.equal(assessment.state, "ready");
  assert.equal(assessment.items.length, 0);

  const portable = structuredClone(graph);
  portable.nodes.find((candidate) => candidate.id === "database")!.params!.path = "somite-resource:kraken2-standard-8-20260626";
  const missingManaged = assessWorkflow(portable, catalog);
  assert.equal(missingManaged.state, "needs_action");
  assert.equal(missingManaged.items[0]?.kind, "managed_resource");
  assert.equal(missingManaged.items[0]?.field, "path");
  const managedResource = {
    reference: "somite-resource:kraken2-standard-8-20260626",
    provider_id: "kraken2-standard-8-20260626",
    profile: "kraken2-database",
    resolution: "standard-8",
    title: "Kraken2 Standard-8",
    available: true,
    detail: "Download and verify Standard-8.",
    download_bytes: 5_500_000_000,
    stored_bytes: 7_500_000_000,
    scientific_effect: "Reduced reference coverage and memory use.",
    source_url: "https://benlangmead.github.io/aws-indexes/k2",
  } as const;
  assert.equal(assessWorkflow(portable, catalog, { managed_resources: [managedResource] }).state, "ready");

  const compiled = compileNextflow(graph, catalog, {
    workflowName: "reviewed-kraken",
    outputDirectory: "results",
    platforms: ["linux-64"],
    nextflowVersion: PINNED_NEXTFLOW_VERSION,
    openjdkVersion: PINNED_OPENJDK_VERSION,
  });
  const inputs = Object.values((JSON.parse(compiled.paramsJson) as { inputs: Record<string, string> }).inputs);
  assert.deepEqual(inputs.sort(), ["reads_R1.fastq", "reads_R2.fastq", "resources/kraken2"]);
  assert.match(compiled.mainNf, /channel\.fromPath\(params\.inputs\./);
  assert.match(compiled.mainNf, /kraken2/);
  assert.match(compiled.pixiToml, /bioconda/);
  assert.match(compiled.pixiToml, /kraken2/);
});
