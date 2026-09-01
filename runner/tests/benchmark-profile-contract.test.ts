import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { benchmarkProfileContractFiles } from "../../scripts/benchmark-profile-contract.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("profile identity binds workflow product sources and operator contracts", async () => {
  const sourceFiles = await benchmarkProfileContractFiles(repositoryRoot, "source.index_8k");
  const paperFiles = await benchmarkProfileContractFiles(repositoryRoot, "paper.gold_text");

  for (const files of [sourceFiles, paperFiles]) {
    assert.ok(files.includes("packages/workflow/sourceWorkflow.ts"));
    assert.ok(files.includes("packages/workflow/paper.ts"));
    assert.ok(files.includes("packages/workflow/catalog.ts"));
    assert.ok(files.includes("operators/align.star.json"));
    assert.ok(files.includes("operators/workflow.reference.json"));
    assert.equal(files.some((path) => path.startsWith("packages/workflow/tests/")), false);
    assert.deepEqual(files, [...new Set(files)].sort(), "profile contract files must be unique and deterministic");
  }
  assert.ok(paperFiles.includes("testdata/papers/gold.tsv"));
  assert.ok(paperFiles.includes("testdata/papers/aphis_assembly_methods.txt"));
  assert.equal(sourceFiles.some((path) => path.startsWith("testdata/papers/")), false);
});
