import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { byteDigest } from "@somite/workflow/contentIdentity";
import {
  bindRepresentativeFastq,
  representativeValidationCapability,
  RepresentativeValidationError,
} from "@somite/workflow/fixtures";
import type { SomiteGraph, SomiteGraphNode } from "@somite/workflow/model";

async function fixtureGraph() {
  const { catalog } = await loadOperatorCatalog(fileURLToPath(new URL("../../operators/", import.meta.url)));
  const input = catalog.get("files.import_paired")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      id: "reads",
      operator: input.id,
      operator_revision: input.revision,
      ports: [
        { name: "r1", dir: "out", ty: "Fastq" },
        { name: "r2", dir: "out", ty: "Fastq" },
      ],
      params: { r1: "real_R1.fastq", r2: "real_R2.fastq" },
      layout: { x: 0, y: 0 },
    }],
    edges: [],
  };
  const readOne = await readFile(new URL("../../fixtures/fastq/v1/reads_R1.fastq", import.meta.url));
  const readTwo = await readFile(new URL("../../fixtures/fastq/v1/reads_R2.fastq", import.meta.url));
  return {
    graph,
    fixtures: {
      readOne: { path: "/store/one.fastq", digest: byteDigest(readOne) },
      readTwo: { path: "/store/two.fastq", digest: byteDigest(readTwo) },
    },
  };
}

test("representative FASTQ identity is path-independent", async () => {
  const { graph, fixtures } = await fixtureGraph();
  const first = bindRepresentativeFastq(graph, fixtures);
  const second = bindRepresentativeFastq({
    ...graph,
    nodes: [{ ...graph.nodes[0], params: { r1: "other_R1.fastq", r2: "other_R2.fastq" } }],
  }, {
    readOne: { ...fixtures.readOne, path: "/elsewhere/one.fastq" },
    readTwo: { ...fixtures.readTwo, path: "/elsewhere/two.fastq" },
  });
  assert.equal(first.configuration_digest, second.configuration_digest);
  assert.deepEqual(first.fixture_digests, second.fixture_digests);
  assert.equal(first.graph.nodes[0].params?.r1, "/store/one.fastq");
  assert.equal(graph.nodes[0].params?.r1, "real_R1.fastq");
});

test("representative validation rejects unsupported root sources", async () => {
  const { graph, fixtures } = await fixtureGraph();
  const unsupported: SomiteGraphNode = { ...graph.nodes[0], operator: "sra.prefetch" };
  const capability = representativeValidationCapability({ ...graph, nodes: [unsupported] });
  assert.deepEqual(capability, {
    supported: false,
    code: "representative_fixture_unsupported",
    reason: "Representative validation currently supports workflows rooted in local single or paired FASTQ inputs. This workflow starts with sra.prefetch; Run can still use its real inputs, but Validate is unavailable until a reviewed fixture adapter exists.",
    unsupported_roots: ["sra.prefetch"],
  });
  assert.throws(
    () => bindRepresentativeFastq({ ...graph, nodes: [unsupported] }, fixtures),
    (error) => error instanceof RepresentativeValidationError
      && error.code === "representative_fixture_unsupported"
      && error.capability.reason === capability.reason
      && error.capability.unsupported_roots.join(",") === "sra.prefetch",
  );
});

test("a locked source workflow exposes static Nextflow preview validation", async () => {
  const { graph } = await fixtureGraph();
  const source: SomiteGraphNode = {
    ...graph.nodes[0],
    operator: "workflow.source",
    ports: [],
    params: {},
    source_workflow: {
      schema_version: 1,
      workflow_revision: `blake3:${"a".repeat(64)}`,
      source: {
        provider: "local",
        repository: "local:demo",
        requested_revision: "working-tree",
        resolved_revision: "b".repeat(64),
        source_digest: `blake3:${"b".repeat(64)}`,
        entrypoint: "main.nf",
        file_count: 3,
        source_bytes: 300,
      },
      capabilities: {
        exact_execution: true,
        parameter_edits: true,
        hierarchy_indexed: true,
        structural_edits: false,
        channel_contracts: false,
        source_edits: false,
      },
    },
  };
  assert.deepEqual(representativeValidationCapability({ ...graph, nodes: [source] }), {
    supported: true,
    kind: "source_preview",
    fixture_pack: "somite.source.preview.v1",
  });
});
