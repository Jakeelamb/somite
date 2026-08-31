import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceBoundary } from "@somite/mcp-runtime";
import { analysisCommand, historyCommand, maintenanceCommand, moduleCommand, pluginCommand, projectCommand, runCommand, storageCommand } from "../src/commands.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nextflow-mcp-"));
  return { root, boundary: await WorkspaceBoundary.create(root) };
}

test("remote projects reject embedded credentials", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.throws(() => projectCommand(boundary, { action: "pull", source: "remote", project: "https://token@github.com/acme/demo" }), /credential-free/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("asset commands require remote project identities", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.throws(
      () => projectCommand(boundary, { action: "clone", source: "local", project: ".", destination: "copy" }),
      /clone requires a remote project identity/,
    );
    assert.throws(
      () => projectCommand(boundary, { action: "view", source: "local", project: "." }),
      /view requires a remote project identity/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project information is machine-readable and rejects unsupported revisions", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.deepEqual(projectCommand(boundary, { action: "info", source: "remote", project: "nf-core/rnaseq" }), ["info", "-o", "json", "nf-core/rnaseq"]);
    assert.throws(
      () => projectCommand(boundary, { action: "info", source: "remote", project: "nf-core/rnaseq", revision: "3.21.0" }),
      /revision is not supported by nextflow info/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lint uses JSON diagnostics and a contained project root", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.deepEqual(analysisCommand(boundary, { action: "lint", source: "local", project: "." }), ["lint", "-o", "json", "-project-dir", root, root]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preview constructs a DAG without process execution", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.deepEqual(analysisCommand(boundary, { action: "preview_dag", source: "local", project: ".", dag_file: "proof/dag.html" }), [
      "run", root, "-ansi-log", "false", "-preview", "-with-dag", join(root, "proof/dag.html"),
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real validation can capture bounded evidence paths", async () => {
  const { boundary, root } = await fixture();
  try {
    const args = runCommand(boundary, { mode: "fixture", source: "local", project: ".", profiles: ["test", "docker"], parameters: { input: "reads.csv", save_trimmed: true }, trace_file: "proof/trace.tsv" });
    assert.deepEqual(args, ["run", root, "-ansi-log", "false", "-profile", "test,docker", "-with-trace", join(root, "proof/trace.tsv"), "--input", "reads.csv", "--save_trimmed", "true"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fixture execution cannot silently degrade into an unbound full run", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.throws(
      () => runCommand(boundary, { mode: "fixture", source: "local", project: "." }),
      /fixture run requires explicit fixture parameters/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("history uses commands supported by the pinned Nextflow runtime", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.deepEqual(historyCommand(boundary, { action: "runs" }), ["log", "-q"]);
    assert.deepEqual(historyCommand(boundary, { action: "tasks", run: "last", fields: ["name", "status", "exit"] }), [
      "log", "last", "-f", "name,status,exit",
    ]);
    assert.throws(
      () => historyCommand(boundary, { action: "lineage_diff", lineage_ids: ["lid://one"] }),
      /exactly 2 lineage IDs/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("module discovery uses registry JSON", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.deepEqual(moduleCommand(boundary, { action: "search", query: "fastqc", limit: 12 }), ["module", "search", "-o", "json", "-limit", "12", "fastqc"]);
    assert.throws(() => moduleCommand(boundary, { action: "search" }), /query is required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local module specifications require their registry namespace", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.throws(
      () => moduleCommand(boundary, { action: "spec", path: "module" }),
      /namespace is required/,
    );
    assert.deepEqual(moduleCommand(boundary, { action: "spec", path: "module", namespace: "nf-core" }), [
      "module", "spec", "-dry-run", "-namespace", "nf-core", join(root, "module"),
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plugin installation handles one exact plugin per command", () => {
  assert.deepEqual(pluginCommand({ action: "install", plugin: "nf-amazon@3.4.1" }), [
    "plugin", "install", "nf-amazon@3.4.1",
  ]);
});

test("filesystem local paths cannot escape and URIs cannot contain credentials", async () => {
  const { boundary, root } = await fixture();
  try {
    assert.throws(() => storageCommand(boundary, { action: "cat", source: "../secret" }), /leaves/);
    assert.throws(() => storageCommand(boundary, { action: "cat", source: "s3://token:secret@bucket/data" }), /credentials/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup is a dry run unless clean is explicit", () => {
  assert.deepEqual(maintenanceCommand({ action: "clean_preview", run: "last" }), ["clean", "last", "-n"]);
  assert.deepEqual(maintenanceCommand({ action: "clean", run: "last", keep_logs: true }), ["clean", "last", "-keep-logs", "-f"]);
});
