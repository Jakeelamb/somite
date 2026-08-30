import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSourceManifest,
  indexNextflowSource,
  tokenizeNextflow,
} from "@somite/workflow/nextflowSource";
import { trackedSourceWorkflowFixture } from "./source-workflow-fixture.ts";

test("Nextflow tokenizer ignores comments and triple-quoted scripts", () => {
  const tokens = tokenizeNextflow(new TextEncoder().encode(`workflow TOP {
    // process COMMENTED {}
    call('value')
    /* workflow BLOCKED {} */
    """process SCRIPT {}"""
  }`));
  assert.equal(tokens.filter((token) => token.kind === "left_brace").length, 1);
  assert.equal(tokens.filter((token) => token.kind === "string").length, 1);
});

test("the tracked source fixture has a stable portable identity", async () => {
  const { manifest, files } = await trackedSourceWorkflowFixture();
  assert.deepEqual(buildSourceManifest(files), manifest);
  assert.equal(manifest.source_digest, "blake3:a0ba64ca1eb87ef7b49909ac6f97c361e9cdd2a7b7c34e1957e6e0dec5dc414c");
});

test("the tracked source fixture produces a resolved nested outline", async () => {
  const { manifest, files, workflow } = await trackedSourceWorkflowFixture();
  const indexed = indexNextflowSource(files, "main.nf", manifest.source_digest);
  assert.deepEqual(indexed.scopes, workflow.scopes);
  assert.deepEqual(indexed.invocations, workflow.invocations);
  assert.deepEqual(indexed.scopes.map(({ title, kind }) => ({ title, kind })), [
    { title: "NFCORE_PANGENOME", kind: "workflow" },
    { title: "Entry workflow", kind: "entry_workflow" },
    { title: "ODGI_STATS", kind: "process" },
    { title: "WFMASH_MAP_ALIGN", kind: "process" },
    { title: "ODGI_QC", kind: "workflow" },
    { title: "PANGENOME", kind: "workflow" },
  ]);
  assert.deepEqual(indexed.invocations.map(({ name, callee }) => ({ name, resolved: Boolean(callee) })), [
    { name: "PANGENOME", resolved: true },
    { name: "NFCORE_PANGENOME", resolved: true },
    { name: "ODGI_STATS", resolved: true },
    { name: "WFMASH_MAP_ALIGN", resolved: true },
    { name: "ODGI_QC", resolved: true },
  ]);
  assert.deepEqual(indexed.diagnostics, []);
});
