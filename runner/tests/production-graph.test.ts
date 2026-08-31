import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { operatorPorts } from "@somite/workflow/catalog";
import type { SomiteGraph } from "@somite/workflow/model";
import { materializeProductionGraph, ProductionInputError } from "../src/productionGraph.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "somite-production-inputs-"));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const operator = catalog.get("files.import");
  if (!operator) throw new Error("files.import operator is missing");
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      id: "reads",
      operator: operator.id,
      operator_revision: operator.revision,
      ports: [{ name: "file", dir: "out", ty: "Fastq" }],
      params: { path: "data/reads.fastq" },
      layout: { x: 0, y: 0 },
    }],
    edges: [],
  };
  return { root, catalog, graph };
}

test("production inputs resolve project then graph-relative files without mutating the canvas", async () => {
  const { root, catalog, graph } = await fixture();
  try {
    const graphBase = join(root, "graphs");
    await mkdir(join(root, "data"), { recursive: true });
    await mkdir(join(graphBase, "data"), { recursive: true });
    await writeFile(join(root, "data", "reads.fastq"), "project\n");
    await writeFile(join(graphBase, "data", "reads.fastq"), "graph\n");

    const projectFirst = await materializeProductionGraph(graph, catalog, root, graphBase);
    assert.equal(projectFirst.nodes[0]?.params?.path, join(root, "data", "reads.fastq"));
    assert.equal(graph.nodes[0]?.params?.path, "data/reads.fastq", "production materialization must not rewrite the saved canvas");

    await rm(join(root, "data"), { recursive: true });
    const graphFallback = await materializeProductionGraph(graph, catalog, root, graphBase);
    assert.equal(graphFallback.nodes[0]?.params?.path, join(graphBase, "data", "reads.fastq"));

    await mkdir(join(root, "data"));
    await writeFile(join(root, "data", "reads.fastq"), "project collision\n");
    const openedDocument = await materializeProductionGraph(graph, catalog, root, {
      graphBase,
      relativeInputOrder: "graph_first",
    });
    assert.equal(openedDocument.nodes[0]?.params?.path, join(graphBase, "data", "reads.fastq"));
    assert.equal(graph.nodes[0]?.params?.path, "data/reads.fastq", "origin-aware materialization must still leave the canvas untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production inputs preserve remote identities and validate local type and containment", async () => {
  const { root, catalog, graph } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "somite-production-outside-"));
  try {
    graph.nodes[0]!.params!.path = "https://example.invalid/reads.fastq.gz";
    assert.equal((await materializeProductionGraph(graph, catalog, root)).nodes[0]?.params?.path, "https://example.invalid/reads.fastq.gz");

    graph.nodes[0]!.params!.path = "SRR123456";
    await assert.rejects(
      materializeProductionGraph(graph, catalog, root),
      (error: unknown) => error instanceof ProductionInputError && error.code === "input_path_missing",
      "bare accessions must use an online-source node rather than masquerading as a local file",
    );

    graph.nodes[0]!.params!.path = "missing.fastq";
    await assert.rejects(
      materializeProductionGraph(graph, catalog, root),
      (error: unknown) => error instanceof ProductionInputError && error.code === "input_path_missing",
    );
    graph.nodes[0]!.params!.path = "../outside.fastq";
    await assert.rejects(
      materializeProductionGraph(graph, catalog, root),
      (error: unknown) => error instanceof ProductionInputError && error.code === "input_path_unsafe",
    );
    await mkdir(join(root, "directory.fastq"));
    graph.nodes[0]!.params!.path = "directory.fastq";
    await assert.rejects(
      materializeProductionGraph(graph, catalog, root),
      (error: unknown) => error instanceof ProductionInputError && error.code === "input_path_type",
    );
    if (process.platform !== "win32") {
      await writeFile(join(outside, "reads.fastq"), "outside\n");
      await symlink(join(outside, "reads.fastq"), join(root, "linked.fastq"));
      graph.nodes[0]!.params!.path = "linked.fastq";
      await assert.rejects(
        materializeProductionGraph(graph, catalog, root),
        (error: unknown) => error instanceof ProductionInputError && error.code === "input_path_unsafe",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("managed resource references stay portable and resolve through the attached verified store", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-production-managed-"));
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const operator = catalog.get("files.import_kraken2_database")!;
    const database = join(root, "managed", "kraken");
    await mkdir(database, { recursive: true });
    const reference = "somite-resource:kraken2-standard-8-20260626";
    const graph: SomiteGraph = {
      schema_version: 3,
      nodes: [{
        id: "database",
        operator: operator.id,
        operator_revision: operator.revision,
        ports: operatorPorts(operator),
        params: { path: reference },
        layout: { x: 0, y: 0 },
      }],
      edges: [],
    };
    await assert.rejects(materializeProductionGraph(graph, catalog, root), /no managed resource store is attached/);
    const materialized = await materializeProductionGraph(graph, catalog, root, root, async (requested) => {
      assert.equal(requested, reference);
      return database;
    });
    assert.equal(materialized.nodes[0]?.params?.path, database);
    assert.equal(graph.nodes[0]?.params?.path, reference, "materialization must retain the portable provider identity on the canvas");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
