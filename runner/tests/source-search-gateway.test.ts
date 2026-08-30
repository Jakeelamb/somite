import assert from "node:assert/strict";
import test from "node:test";

import { SourceSearchGateway } from "../src/sourceSearchGateway.ts";

test("source search gateway coalesces equivalent live requests", async () => {
  let requests = 0;
  const gateway = new SourceSearchGateway({
    fetcher: async () => {
      requests += 1;
      return Response.json({
        id: "ENSG00000012048",
        object_type: "Gene",
        display_name: "BRCA1",
      });
    },
  });
  const [first, second] = await Promise.all([
    gateway.search("ensembl", " human   BRCA1 "),
    gateway.search("ensembl", "human BRCA1"),
  ]);
  assert.deepEqual(first, second);
  assert.equal(requests, 1);
});

test("source search gateway rejects unbounded and failed requests without caching them", async () => {
  const gateway = new SourceSearchGateway();
  assert.throws(() => gateway.search("ncbi", "x"), /at least two/);
  assert.throws(() => gateway.search("ncbi", "x".repeat(201)), /200/);

  let attempts = 0;
  const retrying = new SourceSearchGateway({ fetcher: async () => {
    attempts += 1;
    return new Response("unavailable", { status: 503 });
  } });
  await assert.rejects(retrying.search("ncbi", "SRR12345678"), /503/);
  await assert.rejects(retrying.search("ncbi", "SRR12345678"), /503/);
  assert.equal(attempts, 2);
});
