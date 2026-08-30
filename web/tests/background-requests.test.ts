import assert from "node:assert/strict";
import test from "node:test";
import {
  validationEvidenceRequestPath,
  workflowCatalogRequestPaths,
} from "../app/backgroundRequests.ts";
import type { SomiteGraph, SomiteGraphNode } from "../app/types.ts";

const inputNode: SomiteGraphNode = {
  id: "reads",
  operator: "files.import_paired",
  operator_revision: "test-revision",
  ports: [
    { name: "r1", dir: "out", ty: "Fastq" },
    { name: "r2", dir: "out", ty: "Fastq" },
  ],
  params: { r1: "reads_R1.fastq", r2: "reads_R2.fastq" },
  layout: { x: 0, y: 0 },
};

const nativeGraph: SomiteGraph = {
  schema_version: 3,
  nodes: [inputNode],
  edges: [],
};

test("workflow catalogs wait for a visible Library and a ready project session", () => {
  assert.deepEqual(workflowCatalogRequestPaths({ sessionReady: false, libraryVisible: true, loadState: "idle" }), []);
  assert.deepEqual(workflowCatalogRequestPaths({ sessionReady: true, libraryVisible: false, loadState: "idle" }), []);
  assert.deepEqual(workflowCatalogRequestPaths({ sessionReady: true, libraryVisible: true, loadState: "idle" }), [
    "/api/catalog/nfcore",
    "/api/catalog/snakemake",
  ]);
});

test("workflow catalogs start once and wait for an explicit retry after failure", () => {
  assert.deepEqual(workflowCatalogRequestPaths({ sessionReady: true, libraryVisible: true, loadState: "loading" }), []);
  assert.deepEqual(workflowCatalogRequestPaths({ sessionReady: true, libraryVisible: true, loadState: "loaded" }), []);
  assert.deepEqual(workflowCatalogRequestPaths({ sessionReady: true, libraryVisible: true, loadState: "failed" }), []);
});

test("validation evidence runs only for graphs that support representative inputs", () => {
  assert.equal(validationEvidenceRequestPath({ sessionReady: true, activeIntent: false, workflowReady: true, graph: nativeGraph }), "/api/validations/status");
  assert.equal(validationEvidenceRequestPath({ sessionReady: false, activeIntent: false, workflowReady: true, graph: nativeGraph }), null);
  assert.equal(validationEvidenceRequestPath({ sessionReady: true, activeIntent: true, workflowReady: true, graph: nativeGraph }), null);
  assert.equal(validationEvidenceRequestPath({ sessionReady: true, activeIntent: false, workflowReady: false, graph: nativeGraph }), null);
  assert.equal(validationEvidenceRequestPath({ sessionReady: true, activeIntent: false, workflowReady: true, graph: { ...nativeGraph, nodes: [] } }), null);
});

test("source-backed and unsupported-source workflows never request representative validation evidence", () => {
  const sourceBacked: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      ...inputNode,
      id: "pangenome",
      operator: "workflow.source",
      source_workflow: {} as NonNullable<SomiteGraphNode["source_workflow"]>,
    }],
    edges: [],
  };
  const remoteReads: SomiteGraph = {
    schema_version: 3,
    nodes: [{ ...inputNode, operator: "ncbi.sra_fastq", id: "sra" }],
    edges: [],
  };

  assert.equal(validationEvidenceRequestPath({ sessionReady: true, activeIntent: false, workflowReady: true, graph: sourceBacked }), null);
  assert.equal(validationEvidenceRequestPath({ sessionReady: true, activeIntent: false, workflowReady: true, graph: remoteReads }), null);
});
