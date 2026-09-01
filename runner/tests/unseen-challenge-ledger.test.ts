import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SourceWorkflowInstance } from "@somite/workflow/model";
import { createWorkflowChallengeReport, decodeChallengeLedger } from "../src/unseenChallenge.ts";
import { persistChallengeReport } from "../src/unseenChallengeLedger.ts";

const digest = (character: string) => `blake3:${character.repeat(64)}`;
const ledgerModule = new URL("../src/unseenChallengeLedger.ts", import.meta.url).href;

function report(name: string, character: string, retrievedAt: string) {
  const sourceWorkflow: SourceWorkflowInstance = {
    schema_version: 1,
    workflow_revision: digest("a"),
    source: {
      provider: "nf_core",
      repository: `https://github.com/nf-core/${name}`,
      requested_revision: "1.0.0",
      resolved_revision: character.repeat(40),
      source_digest: digest(character),
      entrypoint: "main.nf",
      file_count: 1,
      source_bytes: 100,
    },
    scopes: [
      { id: "root", title: "Root", kind: "entry_workflow", span: { path: "main.nf", start_line: 1, end_line: 3 } },
      { id: "task", title: "Task", kind: "process", span: { path: "main.nf", start_line: 4, end_line: 6 } },
    ],
    invocations: [{
      id: "call-task",
      caller: "root",
      name: "TASK",
      callee: "task",
      span: { path: "main.nf", start_line: 2, end_line: 2 },
    }],
    capabilities: {
      exact_execution: false,
      parameter_edits: true,
      hierarchy_indexed: true,
      structural_edits: false,
      channel_contracts: false,
      source_edits: false,
    },
  };
  return createWorkflowChallengeReport({ source_workflow: sourceWorkflow, retrieved_at: retrievedAt });
}

function childWriter(ledgerPath: string, challengeReport: ReturnType<typeof report>) {
  const program = `
    const { persistChallengeReport } = await import(${JSON.stringify(ledgerModule)});
    const report = JSON.parse(Buffer.from(process.argv.at(-1), "base64").toString("utf8"));
    process.stdout.write("ready\\n");
    await new Promise((resolvePromise) => process.stdin.once("data", resolvePromise));
    await persistChallengeReport(${JSON.stringify(ledgerPath)}, report);
  `;
  const encoded = Buffer.from(JSON.stringify(challengeReport)).toString("base64");
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    program,
    encoded,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const output = child.stdout;
  const errorOutput = child.stderr;
  assert.ok(output && errorOutput && child.stdin);
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    output.once("data", (chunk: Buffer) => {
      assert.equal(chunk.toString("utf8"), "ready\n");
      resolvePromise();
    });
  });
  let stderr = "";
  errorOutput.setEncoding("utf8");
  errorOutput.on("data", (chunk: string) => { stderr += chunk; });
  const complete = new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`challenge writer exited ${code ?? signal}: ${stderr}`));
    });
  });
  return {
    ready,
    release() { child.stdin!.end("go\n"); },
    complete,
  };
}

test("concurrent challenge writers preserve every unique ledger entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "somite-challenge-ledger-"));
  const ledgerPath = join(directory, "ledger.json");
  try {
    const original = report("original", "b", "2026-08-31T23:59:58.000Z");
    await persistChallengeReport(ledgerPath, original);

    const concurrent = [
      report("paper-side", "c", "2026-08-31T23:59:59.000Z"),
      report("workflow-side", "d", "2026-09-01T00:00:00.000Z"),
      ...["e", "f", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].map((character, index) => {
        return report(`parallel-${index}`, character, `2026-09-01T00:00:${String(index + 1).padStart(2, "0")}.000Z`);
      }),
    ];
    await Promise.all(concurrent.map((entry) => persistChallengeReport(ledgerPath, entry)));

    const ledger = decodeChallengeLedger(await readFile(ledgerPath, "utf8"));
    assert.equal(ledger.entries.length, concurrent.length + 1);
    assert.equal(ledger.entries[0]?.source_key, original.source_key, "the existing ledger prefix must retain its order");
    assert.deepEqual(
      new Set(ledger.entries.slice(1).map((entry) => entry.source_key)),
      new Set(concurrent.map((entry) => entry.source_key)),
    );
    assert.equal(new Set(ledger.entries.map((entry) => entry.content_digest)).size, concurrent.length + 1);
    assert.deepEqual(await readdir(directory), ["ledger.json"], "the transaction must not add persistent lock state");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate challenge processes merge reports released from one barrier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "somite-challenge-ledger-processes-"));
  const ledgerPath = join(directory, "ledger.json");
  try {
    const original = report("original-process", "a", "2026-08-31T23:59:58.000Z");
    await persistChallengeReport(ledgerPath, original);
    const concurrent = ["1", "2", "3", "4", "5", "6", "7", "8"].map((character, index) =>
      report(`process-${index}`, character, `2026-09-01T00:01:${String(index).padStart(2, "0")}.000Z`));
    const children = concurrent.map((entry) => childWriter(ledgerPath, entry));
    await Promise.all(children.map((child) => child.ready));
    for (const child of children) child.release();
    await Promise.all(children.map((child) => child.complete));

    const ledger = decodeChallengeLedger(await readFile(ledgerPath, "utf8"));
    assert.equal(ledger.entries.length, concurrent.length + 1);
    assert.equal(ledger.entries[0]?.source_key, original.source_key);
    assert.deepEqual(
      new Set(ledger.entries.slice(1).map((entry) => entry.source_key)),
      new Set(concurrent.map((entry) => entry.source_key)),
    );
    assert.deepEqual(await readdir(directory), ["ledger.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid runtime report cannot mutate the persisted ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "somite-challenge-ledger-invalid-"));
  const ledgerPath = join(directory, "ledger.json");
  try {
    await persistChallengeReport(ledgerPath, report("valid", "a", "2026-09-01T00:02:00.000Z"));
    const before = await readFile(ledgerPath, "utf8");
    const invalid = { ...report("invalid", "b", "2026-09-01T00:02:01.000Z"), content_digest: "not-a-digest" };

    await assert.rejects(() => persistChallengeReport(ledgerPath, invalid), /must be a BLAKE3 digest/);

    assert.equal(await readFile(ledgerPath, "utf8"), before);
    assert.deepEqual(await readdir(directory), ["ledger.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
