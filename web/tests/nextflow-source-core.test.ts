import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildSourceManifest,
  indexNextflowSource,
  tokenizeNextflow,
  type FrozenSourceFile,
  type SourceManifest,
} from "@somite/workflow/nextflowSource";
import type { SourceWorkflowInstance } from "@somite/workflow/model";

const objectRoot = new URL("../../.somite/source-workflows/objects/4b8e157a3fbd3009095b60e4d857fba2af999ffe29c21bd01bd8304aaa427442/", import.meta.url);
const instancePath = new URL("../../.somite/source-workflows/instances/779d9b35a620a72180c6bd4d545bb753fb343a9396c9771818d6cc21aa5481fe.json", import.meta.url);

async function pangenomeSource() {
  const manifest = JSON.parse(await readFile(new URL("source-manifest.json", objectRoot), "utf8")) as SourceManifest;
  const files = await Promise.all(manifest.files.map(async (entry): Promise<FrozenSourceFile> => ({
    path: entry.path,
    mode: entry.mode,
    bytes: await readFile(new URL(`source/${entry.path}`, objectRoot)),
  })));
  return { manifest, files };
}

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

test("TypeScript reproduces the exact stored pangenome source identity", async () => {
  const { manifest, files } = await pangenomeSource();
  assert.deepEqual(buildSourceManifest(files), manifest);
});

test("pangenome import reproduces the accepted nested source projection", async () => {
  const { manifest, files } = await pangenomeSource();
  const record = JSON.parse(await readFile(instancePath, "utf8")) as { workflow: SourceWorkflowInstance };
  const indexed = indexNextflowSource(files, "main.nf", manifest.source_digest);
  assert.deepEqual(indexed.scopes, record.workflow.scopes);
  assert.deepEqual(indexed.invocations, record.workflow.invocations);
  const outlineDiagnostics = (record.workflow.diagnostics ?? []).filter((diagnostic) =>
    diagnostic.code === "source_only_invocation" || diagnostic.code === "non_utf8_nextflow_source" || diagnostic.code === "source_outline_empty");
  assert.deepEqual(indexed.diagnostics, outlineDiagnostics);
});
