import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceBoundary } from "@somite/mcp-runtime";
import { compactSearchResult, dependencyCommand, globalCommand, lockCommand, searchCommand, taskCommand, workspaceCommand } from "../src/commands.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pixi-mcp-"));
  return { root, boundary: await WorkspaceBoundary.create(root) };
}

test("package search is structured and bounded", () => {
  assert.deepEqual(searchCommand({ spec: "samtools >=1.20", channels: ["bioconda", "conda-forge"], platform: "linux-64", limit: 10 }), [
    "search", "--json", "--channel", "bioconda", "--channel", "conda-forge", "--platform", "linux-64", "samtools >=1.20",
  ]);
  const compact = compactSearchResult(JSON.stringify({
    "linux-64": [
      { name: "samtools", version: "1.24", build: "h1_1", build_number: 1, subdir: "linux-64", channel: "https://conda.anaconda.org/bioconda/", url: "https://example/samtools-1.24.conda", license: "MIT", size: 5, timestamp: 3, depends: ["htslib"] },
      { name: "samtools", version: "1.24", build: "h1_0", build_number: 0, subdir: "linux-64", channel: "https://conda.anaconda.org/bioconda/", url: "https://example/samtools-1.24-0.conda", license: "MIT", size: 4, timestamp: 2, depends: ["htslib"] },
      { name: "samtools", version: "1.23", build: "h0_0", build_number: 0, subdir: "linux-64", channel: "https://conda.anaconda.org/bioconda/", url: "https://example/samtools-1.23.conda", license: "MIT", size: 3, timestamp: 1, depends: ["htslib"] },
    ],
  }), 2);
  assert.equal(compact.total_records, 3);
  assert.deepEqual(compact.matches, [
    { name: "samtools", version: "1.24", build: "h1_1", build_number: 1, subdir: "linux-64", channel: "https://conda.anaconda.org/bioconda/", url: "https://example/samtools-1.24.conda", license: "MIT", size: 5, timestamp: 3, depends: ["htslib"] },
    { name: "samtools", version: "1.24", build: "h1_0", build_number: 0, subdir: "linux-64", channel: "https://conda.anaconda.org/bioconda/", url: "https://example/samtools-1.24-0.conda", license: "MIT", size: 4, timestamp: 2, depends: ["htslib"] },
  ]);
});

test("dependency edits use explicit manifest and never a shell", async () => {
  const { root, boundary } = await fixture();
  try {
    assert.deepEqual(dependencyCommand(boundary, { action: "add", packages: ["nextflow==26.04.6"], source: "conda", manifest_path: ".", dry_run: false }), [
      "add", "--manifest-path", root, "--no-install", "nextflow==26.04.6",
    ]);
    assert.deepEqual(dependencyCommand(boundary, { action: "add", packages: ["nextflow==26.04.6"], source: "conda", manifest_path: ".", install: true }), [
      "add", "--manifest-path", root, "nextflow==26.04.6",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dependency flags stay within the Pixi subcommands that support them", async () => {
  const { root, boundary } = await fixture();
  try {
    assert.throws(
      () => dependencyCommand(boundary, { action: "update", packages: ["samtools"], feature: "bio" }),
      /feature is not supported by pixi update/,
    );
    assert.throws(
      () => dependencyCommand(boundary, { action: "upgrade", packages: ["samtools"], platform: "linux-64" }),
      /platform is not supported by pixi upgrade/,
    );
    assert.throws(
      () => dependencyCommand(boundary, { action: "add", packages: ["samtools"], source: "conda", editable: true }),
      /editable and index apply only to PyPI dependencies/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("locks distinguish check, preview, and write", async () => {
  const { root, boundary } = await fixture();
  try {
    assert.deepEqual(lockCommand(boundary, { action: "check" }), ["lock", "--manifest-path", root, "--check"]);
    assert.deepEqual(lockCommand(boundary, { action: "preview" }), ["lock", "--manifest-path", root, "--dry-run", "--json"]);
    assert.deepEqual(lockCommand(boundary, { action: "resolve" }), ["lock", "--manifest-path", root, "--json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task execution is frozen, clean, and restricted to a declared task", async () => {
  const { root, boundary } = await fixture();
  try {
    assert.deepEqual(taskCommand(boundary, { action: "run", name: "test", arguments: ["--quick"] }), [
      "run", "--frozen", "--clean-env", "--manifest-path", root, "test", "--quick",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task and workspace selectors are not silently discarded", async () => {
  const { root, boundary } = await fixture();
  try {
    assert.deepEqual(taskCommand(boundary, { action: "remove", name: "qc", environment: "bio" }), [
      "task", "remove", "--manifest-path", root, "--environment", "bio", "qc",
    ]);
    assert.deepEqual(workspaceCommand(boundary, {
      action: "platform_add",
      values: ["linux-64"],
      environment: "bio",
      feature: "alignment",
    }), [
      "workspace", "platform", "add", "--manifest-path", root,
      "--environment", "bio", "--feature", "alignment", "--no-install", "linux-64",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace imports cannot escape the configured root", async () => {
  const { root, boundary } = await fixture();
  try {
    assert.throws(() => workspaceCommand(boundary, { action: "import", path: "../environment.yml", format: "conda-env" }), /leaves/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace exports use the current locked export contract", async () => {
  const { root, boundary } = await fixture();
  try {
    assert.deepEqual(workspaceCommand(boundary, {
      action: "export_conda",
      path: "environment.yml",
      pinned: true,
    }), [
      "workspace", "export", "conda-environment", "--manifest-path", root,
      "--from-lock-file", join(root, "environment.yml"),
    ]);
    assert.throws(
      () => workspaceCommand(boundary, { action: "export_explicit", pinned: true }),
      /output directory is required/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("global dependency edits require an explicit environment", () => {
  assert.throws(
    () => globalCommand({ action: "add", packages: ["samtools"] }),
    /environment is required/,
  );
  assert.throws(
    () => globalCommand({ action: "remove", packages: ["samtools"] }),
    /environment is required/,
  );
  assert.deepEqual(globalCommand({ action: "update", environment: "bio-tools" }), [
    "global", "update", "bio-tools",
  ]);
});
