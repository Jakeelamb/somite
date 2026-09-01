import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { operatorPorts } from "../catalog.ts";
import { loadOperatorCatalog } from "../catalog.node.ts";
import {
  bindRepresentativeInputs,
  REPRESENTATIVE_SOURCE_PACK,
  representativeValidationCapability,
} from "../fixtures.ts";
import type { SomiteGraph } from "../model.ts";

const operatorsDirectory = fileURLToPath(new URL("../../../operators/", import.meta.url));
const BAM_DIGEST = "blake3:d437257e3a74d0ecee3663900482960e429074c4698ab9fe82785fcc06cd5719";

test("representative validation binds an exact typed local BAM fixture", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const input = catalog.get("files.import_bam")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      id: "input",
      operator: input.id,
      operator_revision: input.revision,
      ports: operatorPorts(input),
      params: { path: "real/sample.bam" },
      layout: { x: 0, y: 0 },
    }],
    edges: [],
  };

  assert.deepEqual(representativeValidationCapability(graph), {
    supported: true,
    fixture_pack: REPRESENTATIVE_SOURCE_PACK,
    unexercised_nodes: [],
  });
  const binding = bindRepresentativeInputs(graph, catalog, {
    readOne: { path: "/fixtures/read-one.fastq", digest: `blake3:${"1".repeat(64)}` },
    readTwo: { path: "/fixtures/read-two.fastq", digest: `blake3:${"2".repeat(64)}` },
    bam: { path: "/fixtures/sample.bam", digest: BAM_DIGEST },
  });
  assert.deepEqual(binding.bindings, { "input.path": BAM_DIGEST });
  assert.deepEqual(binding.fixture_digests, [BAM_DIGEST]);
  assert.equal(binding.graph.nodes[0]?.params?.path, "/fixtures/sample.bam");
  assert.equal(graph.nodes[0]?.params?.path, "real/sample.bam", "fixture binding must leave the saved canvas untouched");
});

test("local BAM validation fails closed when its reviewed fixture is unavailable", async () => {
  const { catalog } = await loadOperatorCatalog(operatorsDirectory);
  const input = catalog.get("files.import_bam")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      id: "input",
      operator: input.id,
      operator_revision: input.revision,
      ports: operatorPorts(input),
      params: { path: "real/sample.bam" },
      layout: { x: 0, y: 0 },
    }],
    edges: [],
  };

  assert.throws(() => bindRepresentativeInputs(graph, catalog, {
    readOne: { path: "/fixtures/read-one.fastq", digest: `blake3:${"1".repeat(64)}` },
    readTwo: { path: "/fixtures/read-two.fastq", digest: `blake3:${"2".repeat(64)}` },
  }), /representative bam fixture is unavailable/);
});
