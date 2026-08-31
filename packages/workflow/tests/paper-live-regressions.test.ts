import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "../catalog.node.ts";
import { reconstructPaper } from "../paper.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("retains explicit ARTIC and Freyja method evidence from an unseen paper", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Samples were sequenced using the ARTIC v5.3.2 workflow.",
    "Variant calling and lineage assignment were performed using Freyja.",
  ].join("\n"), "jats");

  assert.equal(review.outcome, "recognized_unsupported");
  assert.deepEqual(
    review.mentions.map((mention) => mention.normalized_name),
    ["artic", "freyja"],
  );
  assert.ok(review.mentions.every((mention) => mention.support === "unsupported"));
  assert.equal(review.candidates.length, 0, "unsupported methods must not become invented executable nodes");
});
