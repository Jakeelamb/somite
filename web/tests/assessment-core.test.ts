import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assessWorkflow, type ReadinessState } from "@somite/workflow/assessment";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { jsonDigest } from "@somite/workflow/contentIdentity";
import type { SomiteGraph } from "@somite/workflow/model";

type GraphCase = { name: string; graph: SomiteGraph };
type OracleCase = {
  name: string;
  graph_revision: string;
  state: ReadinessState;
  required_count: number;
  item_ids: string[];
  assessment_digest: string;
};

test("readiness remains byte-for-byte compatible with the accepted parity oracle", async () => {
  const graphs = JSON.parse(await readFile(new URL("../../testdata/assessment-parity-graphs.json", import.meta.url), "utf8")) as GraphCase[];
  const oracle = JSON.parse(await readFile(new URL("../../testdata/assessment-parity-oracle.json", import.meta.url), "utf8")) as OracleCase[];
  const { catalog } = await loadOperatorCatalog(fileURLToPath(new URL("../../operators/", import.meta.url)));
  assert.equal(graphs.length, oracle.length);
  for (const [index, fixture] of graphs.entries()) {
    const expected = oracle[index];
    assert.equal(fixture.name, expected.name);
    const assessment = assessWorkflow(fixture.graph, catalog);
    assert.equal(assessment.graph_revision, expected.graph_revision, fixture.name);
    assert.equal(assessment.state, expected.state, fixture.name);
    assert.equal(assessment.required_count, expected.required_count, fixture.name);
    assert.deepEqual(assessment.items.map((item) => item.id), expected.item_ids, fixture.name);
    assert.equal(jsonDigest(assessment), expected.assessment_digest, fixture.name);
  }
});

test("assessment refuses invalid graph and catalog contracts", async () => {
  const { catalog } = await loadOperatorCatalog(fileURLToPath(new URL("../../operators/", import.meta.url)));
  assert.throws(
    () => assessWorkflow({ schema_version: 3, nodes: [{ id: "bad", operator: "qc.fastqc", operator_revision: "stale", ports: [], layout: { x: 0, y: 0 } }], edges: [] }, catalog),
    /catalog: node bad pins operator qc\.fastqc revision stale/,
  );
});
