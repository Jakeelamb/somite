import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseGraph } from "@somite/workflow/graphCodec";
import type { SomiteGraph } from "@somite/workflow/model";

test("runtime Graph codec admits every shared valid graph without weakening it", async () => {
  const cases = JSON.parse(await readFile(new URL("../../testdata/assessment-parity-graphs.json", import.meta.url), "utf8")) as Array<{ name: string; graph: SomiteGraph }>;
  for (const fixture of cases) assert.deepEqual(parseGraph(fixture.graph, fixture.name), fixture.graph);
});

test("runtime Graph codec rejects unknown fields and unstable values", () => {
  assert.throws(
    () => parseGraph({ schema_version: 3, nodes: [], edges: [], typo: true }),
    /unknown field typo/,
  );
  assert.throws(
    () => parseGraph({
      schema_version: 3,
      nodes: [{
        id: "node",
        operator: "tool",
        operator_revision: "revision",
        ports: [],
        params: { unsafe: Number.MAX_SAFE_INTEGER + 1 },
        layout: { x: 0, y: 0 },
      }],
      edges: [],
    }),
    /browser-stable parameter value/,
  );
});
