import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  buildSourceManifest,
  indexNextflowSource,
  tokenizeNextflow,
  type FrozenSourceFile,
} from "@somite/workflow/nextflowSource";
import { trackedSourceWorkflowFixture } from "./source-workflow-fixture.ts";

const encoder = new TextEncoder();
const sourceDigest = "blake3:0000000000000000000000000000000000000000000000000000000000000000";

function sourceFile(path: string, source: string): FrozenSourceFile {
  return { path, mode: 0o100644, bytes: encoder.encode(source) };
}

function assertIndexError(files: readonly FrozenSourceFile[], message: string) {
  assert.throws(
    () => indexNextflowSource(files, "main.nf", sourceDigest),
    (error) => error instanceof Error && error.message === message,
  );
}

async function sourceFixture(directory: URL) {
  const files: FrozenSourceFile[] = [];
  const pending: Array<{ directory: URL; prefix: string }> = [{ directory, prefix: "" }];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = (await readdir(current.directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, current.directory);
      if (entry.isDirectory()) pending.push({ directory: url, prefix: path });
      else files.push({ path, mode: 0o100644, bytes: await readFile(url) });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
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

test("Groovy slashy regular expressions cannot swallow later Nextflow scopes", () => {
  const files = [
    sourceFile("main.nf", "include { CALL_WORKFLOW } from './call'\nworkflow { CALL_WORKFLOW() }\n"),
    sourceFile("call.nf", [
      "def cleanup(value) {",
      "  value.replaceAll(/^[\\[\\s'\"]+/, '').replaceAll(/[,'\"}]+$/, '')",
      "}",
      "workflow CALL_WORKFLOW {",
      "  cleanup('value')",
      "}",
      "",
    ].join("\n")),
  ];
  const indexed = indexNextflowSource(files, "main.nf", buildSourceManifest(files).source_digest);

  assert.ok(indexed.scopes.some((scope) => scope.symbol === "CALL_WORKFLOW"));
  assert.equal(indexed.invocations.find((invocation) => invocation.name === "CALL_WORKFLOW")?.callee,
    indexed.scopes.find((scope) => scope.symbol === "CALL_WORKFLOW")?.id);
  assert.deepEqual(indexed.diagnostics, []);
});

test("slashy regular expressions returned from helper functions cannot create fake workflow scopes", () => {
  const files = [sourceFile("main.nf", [
    "def matcher() { return /workflow FAKE { process ALSO_FAKE {} }/ }",
    "workflow REAL {}",
    "",
  ].join("\n"))];
  const indexed = indexNextflowSource(files, "main.nf", buildSourceManifest(files).source_digest);

  assert.deepEqual(indexed.scopes.map((scope) => scope.symbol), ["REAL"]);
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

test("legacy DSL1 process declarations are recovered as entry invocations", async () => {
  const file = {
    path: "main.nf",
    mode: 0o100644,
    bytes: await readFile(new URL("../../testdata/source-workflow/legacy-dsl1.nf", import.meta.url)),
  } as const;
  const manifest = buildSourceManifest([file]);
  const indexed = indexNextflowSource([file], "main.nf", manifest.source_digest);
  const entry = indexed.scopes.find((scope) => scope.kind === "entry_workflow");
  const processes = new Map(indexed.scopes
    .filter((scope) => scope.kind === "process")
    .map((scope) => [scope.title, scope]));

  assert.ok(entry);
  assert.deepEqual([...processes.keys()], ["PREPARE_READS", "REPORT_READS"]);
  assert.deepEqual(indexed.invocations.map((invocation) => ({
    name: invocation.name,
    caller: invocation.caller,
    callee: invocation.callee,
  })), [
    { name: "PREPARE_READS", caller: entry.id, callee: processes.get("PREPARE_READS")?.id },
    { name: "REPORT_READS", caller: entry.id, callee: processes.get("REPORT_READS")?.id },
  ]);
  assert.deepEqual(indexed.diagnostics, []);
});

test("projectDir module imports resolve while imported utility calls stay outside the workflow outline", async () => {
  const files = await sourceFixture(new URL("../../testdata/source-workflow/projectdir-imports/", import.meta.url));
  const manifest = buildSourceManifest(files);
  const indexed = indexNextflowSource(files, "main.nf", manifest.source_digest);

  assert.deepEqual(indexed.invocations.map((invocation) => ({
    name: invocation.name,
    resolved: Boolean(invocation.callee),
  })), [
    { name: "ALIGN", resolved: true },
    { name: "ALIGNER", resolved: true },
  ]);
  assert.deepEqual(indexed.diagnostics, []);
});

test("a DSL2 process definition without a call remains declaration-only", () => {
  const indexed = indexNextflowSource([sourceFile("main.nf", `process PREPARE_READS {
    input:
    path reads
    output:
    path 'prepared.fastq'
    script:
    '''cp $reads prepared.fastq'''
  }`)], "main.nf", sourceDigest);

  assert.deepEqual(indexed.scopes.map(({ title, kind }) => ({ title, kind })), [
    { title: "PREPARE_READS", kind: "process" },
  ]);
  assert.deepEqual(indexed.invocations, []);
});

test("the source-wide token budget cannot be multiplied by file count", () => {
  assertIndexError(
    [sourceFile("a.nf", ";"), sourceFile("b.nf", ";".repeat(1_000_000))],
    "source outline exceeds 1000000 indexed tokens across all Nextflow files; exclude generated .nf files or reduce generated declarations",
  );
});

test("scope and include-binding budgets are shared by every Nextflow file", () => {
  const scopes = Array.from({ length: 25_000 }, (_, index) => `process P${index} {}`).join("\n");
  assertIndexError(
    [sourceFile("a.nf", "process FIRST {}"), sourceFile("b.nf", scopes)],
    "source outline exceeds 25000 indexed scopes across all Nextflow files; exclude generated .nf files or reduce generated declarations",
  );

  const bindings = Array.from({ length: 50_000 }, (_, index) => `P${index};`).join(" ");
  assertIndexError(
    [
      sourceFile("a.nf", "include { FIRST } from 'plugin/example'"),
      sourceFile("b.nf", `include { ${bindings} } from 'plugin/example'`),
    ],
    "source outline exceeds 50000 indexed include bindings across all Nextflow files; exclude generated .nf files or reduce generated declarations",
  );
});

test("the source-wide diagnostic cap fails with deterministic recovery guidance", () => {
  const names = Array.from({ length: 25_000 }, (_, index) => `M${index}`);
  const unresolved = `include { ${names.join("; ")} } from './missing'\nworkflow MANY { ${names.map((name) => `${name}()`).join("; ")} }`;
  assertIndexError(
    [
      sourceFile("a.nf", "include { FIRST } from './missing'\nworkflow ONE { FIRST() }"),
      sourceFile("b.nf", unresolved),
    ],
    "source outline exceeds 25000 indexed diagnostics across all Nextflow files; exclude generated .nf files or reduce generated declarations",
  );
});

test("derived projection bytes are budgeted once across the complete source", () => {
  const declarations = (prefix: string) => Array.from({ length: 8_000 }, (_, index) => {
    const symbol = `${prefix}${String(index).padStart(5, "0")}${"x".repeat(1_018)}`;
    return `process ${symbol} {}`;
  }).join("\n");
  const first = sourceFile("a.nf", declarations("P"));
  const second = sourceFile("b.nf", declarations("Q"));

  assert.equal(indexNextflowSource([first], "main.nf", sourceDigest).scopes.length, 8_000);
  assertIndexError(
    [first, second],
    "source outline exceeds the 33554432-byte derived projection budget while indexing scopes across all Nextflow files; exclude generated .nf files or reduce generated declarations",
  );
});
