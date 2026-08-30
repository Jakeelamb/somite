import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SomiteGraph } from "@somite/workflow/model";
import { InputOriginError, InputOrigins } from "../src/inputOrigins.ts";

const graph = (name: string): SomiteGraph => ({ schema_version: 3, name, nodes: [], edges: [] });

async function persistedOrigin(root: string) {
  const directory = join(root, ".somite", "input-origins");
  const entries = await readdir(directory);
  assert.equal(entries.length, 1);
  return readFile(join(directory, entries[0]!), "utf8");
}

test("InputOrigins keeps external directories opaque and restores the exact autosaved association", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-input-origin-root-"));
  const external = await mkdtemp(join(tmpdir(), "somite-input-origin-external-"));
  try {
    await mkdir(join(root, ".somite"));
    const openedGraph = graph("Opened external graph");
    const workspaceGraph = join(root, "workflow.somite.json");
    const origins = await InputOrigins.open(root, workspaceGraph, root, graph("Initial graph"));
    assert.deepEqual(origins.location(), { graphBase: root, relativeInputOrder: "project_first" });

    const externalId = await origins.registerOpenedGraph(external);
    assert.match(externalId, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(externalId.includes(external), false);
    assert.deepEqual(origins.location(externalId), { graphBase: external, relativeInputOrder: "graph_first" });
    await origins.record(externalId, openedGraph);

    const persisted = await persistedOrigin(root);
    assert.match(persisted, /"relative_input_order": "graph_first"/);
    assert.equal((JSON.parse(persisted) as { workspace_graph_base: string }).workspace_graph_base, root);
    const restored = await InputOrigins.open(root, workspaceGraph, root, openedGraph);
    assert.equal(restored.warning, null);
    assert.deepEqual(restored.location(), { graphBase: external, relativeInputOrder: "graph_first" });

    const stale = await InputOrigins.open(root, workspaceGraph, root, graph("Different graph"));
    assert.match(stale.warning ?? "", /does not match the recovered canvas/);
    assert.deepEqual(stale.location(), { graphBase: root, relativeInputOrder: "project_first" });
    assert.throws(
      () => stale.executionLocation(),
      (error: unknown) => error instanceof InputOriginError && error.code === "input_origin_recovery_required",
    );
    await assert.rejects(
      stale.record(stale.currentId, graph("Different graph")),
      (error: unknown) => error instanceof InputOriginError && error.code === "input_origin_recovery_required",
    );
    const recoveredId = await stale.registerOpenedGraph(external);
    await stale.recover(recoveredId, graph("Different graph"));
    assert.equal(stale.warning, null);
    assert.deepEqual(stale.executionLocation(), { graphBase: external, relativeInputOrder: "graph_first" });
    assert.throws(
      () => origins.location("AAAAAAAAAAAAAAAAAAAAAAAA"),
      (error: unknown) => error instanceof InputOriginError && error.code === "input_origin_unknown",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("InputOrigins refuses symlinked locations and reports unavailable persisted input bases", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-input-origin-security-"));
  const external = await mkdtemp(join(tmpdir(), "somite-input-origin-gone-"));
  try {
    await mkdir(join(root, ".somite"));
    await symlink(external, join(root, "linked"));
    const workspaceGraph = join(root, "workflow.somite.json");
    const origins = await InputOrigins.open(root, workspaceGraph, root, graph("Initial"));
    await assert.rejects(
      origins.registerOpenedGraph(join(root, "linked")),
      (error: unknown) => error instanceof InputOriginError && error.code === "input_origin_invalid",
    );
    const id = await origins.registerOpenedGraph(external);
    const imported = graph("Imported");
    await origins.record(id, imported);
    await rm(external, { recursive: true, force: true });

    const restored = await InputOrigins.open(root, workspaceGraph, root, imported);
    assert.match(restored.warning ?? "", /could not be restored/);
    assert.deepEqual(restored.location(), { graphBase: root, relativeInputOrder: "project_first" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("InputOrigins never reuses an equal graph revision for a different workspace graph base", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-input-origin-scope-"));
  const external = await mkdtemp(join(tmpdir(), "somite-input-origin-scoped-external-"));
  try {
    const firstBase = join(root, "first");
    const secondBase = join(root, "second");
    await Promise.all([mkdir(join(root, ".somite")), mkdir(firstBase), mkdir(secondBase)]);
    const sharedGraph = graph("Same graph bytes");
    const origins = await InputOrigins.open(root, join(firstBase, "workflow.somite.json"), firstBase, sharedGraph);
    const externalId = await origins.registerOpenedGraph(external);
    await origins.record(externalId, sharedGraph);

    const reopenedElsewhere = await InputOrigins.open(root, join(secondBase, "workflow.somite.json"), secondBase, sharedGraph);
    assert.equal(reopenedElsewhere.warning, null);
    assert.deepEqual(reopenedElsewhere.location(), { graphBase: secondBase, relativeInputOrder: "project_first" });
    await reopenedElsewhere.record(reopenedElsewhere.currentId, sharedGraph);
    assert.equal((await readdir(join(root, ".somite", "input-origins"))).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("InputOrigins refuses a persisted canonical base retargeted through a new ancestor symlink", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-input-origin-retarget-"));
  const replacement = await mkdtemp(join(tmpdir(), "somite-input-origin-replacement-"));
  try {
    await mkdir(join(root, ".somite"));
    const originalParent = join(root, "original-parent");
    const movedParent = join(root, "moved-parent");
    const graphBase = join(originalParent, "graph");
    await mkdir(graphBase, { recursive: true });
    const workspaceGraph = join(root, "workflow.somite.json");
    const imported = graph("Imported through canonical base");
    const origins = await InputOrigins.open(root, workspaceGraph, root, graph("Initial"));
    const id = await origins.registerOpenedGraph(graphBase);
    await origins.record(id, imported);

    await rename(originalParent, movedParent);
    await symlink(replacement, originalParent);
    await mkdir(join(replacement, "graph"));
    const restored = await InputOrigins.open(root, workspaceGraph, root, imported);
    assert.match(restored.warning ?? "", /could not be restored/);
    assert.deepEqual(restored.location(), { graphBase: root, relativeInputOrder: "project_first" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(replacement, { recursive: true, force: true });
  }
});
