import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { nfcoreCatalogResponse, parseNfcoreCatalog, searchNfcoreCatalog } from "@somite/workflow/nfcore";

test("nf-core catalog keeps only exact released pipelines and pins display operators", () => {
  const pipelines = parseNfcoreCatalog({ remote_workflows: [
    { name: "rnaseq", description: "RNA sequencing", topics: ["rna"], releases: [
      { tag_name: "dev", tag_sha: "f".repeat(40) },
      { tag_name: "3.26.0", tag_sha: "a".repeat(40) },
    ] },
    { name: "archived", archived: true, releases: [{ tag_name: "1.0.0", tag_sha: "b".repeat(40) }] },
    { name: "unresolved", releases: [{ tag_name: "1.0.0" }] },
  ] });
  assert.deepEqual(pipelines, [{
    name: "rnaseq",
    description: "RNA sequencing",
    topics: ["rna"],
    revision: "3.26.0",
    resolvedRevision: "a".repeat(40),
  }]);
  const entry = nfcoreCatalogResponse(pipelines, false).entries[0]!;
  assert.equal(entry.operator.id, "nf.rnaseq");
  assert.equal(entry.operator.params.revision.default, "3.26.0");
  assert.match(entry.operator.revision, /^blake3:[0-9a-f]{64}$/);
});

test("nf-core search requires every term and exposes exact release pairs", () => {
  const pipelines = parseNfcoreCatalog({ remote_workflows: [
    { name: "rnaseq", description: "RNA sequencing", topics: ["transcriptomics"], releases: [{ tag_name: "3.26.0", tag_sha: "a".repeat(40) }] },
    { name: "scrnaseq", description: "Single cell RNA", topics: ["single-cell"], releases: [{ tag_name: "2.7.1", tag_sha: "b".repeat(40) }] },
  ] });
  const response = searchNfcoreCatalog(pipelines, "single RNA");
  assert.equal(response.total_matches, 1);
  assert.deepEqual(response.entries.map(({ repository, revision }) => ({ repository, revision })), [
    { repository: "nf-core/scrnaseq", revision: "2.7.1" },
  ]);
});

test("the checked-in live nf-core cache remains parseable", async () => {
  const raw = await readFile(new URL("../../.somite/catalog/nfcore-pipelines.json", import.meta.url), "utf8");
  const pipelines = parseNfcoreCatalog(raw);
  assert.ok(pipelines.length > 50);
  assert.ok(pipelines.every((pipeline) => /^[0-9a-f]{40}$/.test(pipeline.resolvedRevision)));
});
