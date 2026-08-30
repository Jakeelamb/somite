import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunStorage } from "../src/runStorage.ts";

async function terminalRun(root: string, id: string, phase: "completed" | "failed" | "cancelled" = "completed") {
  const directory = join(root, ".somite", "runs", id);
  await mkdir(join(directory, "work"), { recursive: true });
  await mkdir(join(directory, ".pixi"), { recursive: true });
  await mkdir(join(directory, "results"), { recursive: true });
  await writeFile(join(directory, "work", "temporary.bin"), Buffer.alloc(128, 1));
  await writeFile(join(directory, ".pixi", "environment.bin"), Buffer.alloc(256, 2));
  await writeFile(join(directory, "results", "scientific.txt"), "retain me\n");
  await writeFile(join(directory, "run.stdout.log"), "retain log\n");
  await writeFile(join(directory, "pixi.lock"), "retain lock\n");
  await writeFile(join(directory, "run-status.json"), `${JSON.stringify({
    schema_version: 1,
    run_id: id,
    phase,
    finished_at_unix_ms: 1,
  })}\n`);
  return directory;
}

test("run storage profiles reclaimable bytes without treating scientific records as disposable", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-run-storage-"));
  try {
    const complete = await terminalRun(root, "run-complete");
    const active = await terminalRun(root, "run-active");
    await mkdir(join(root, ".somite", "pixi", "environments", "linux-64", "cache"), { recursive: true });
    await writeFile(join(root, ".somite", "pixi", "environments", "linux-64", "cache", "tool.bin"), Buffer.alloc(512, 3));
    await mkdir(join(root, ".somite", "tools", "paper"), { recursive: true });
    await writeFile(join(root, ".somite", "tools", "paper", "ocr.bin"), Buffer.alloc(128, 4));
    const storage = new RunStorage(root);

    const profile = await storage.profile(new Set(["run-active"]));
    assert.equal(profile.runs.count, 2);
    assert.equal(profile.runs.terminal_count, 2);
    assert.equal(profile.runs.reclaimable_bytes, 384);
    assert.deepEqual(profile.runs.reclaimable_run_ids, ["run-complete"]);
    assert.equal(profile.shared_environments.bytes, 640);
    assert.ok(profile.retained_scientific_state.bytes >= Buffer.byteLength("retain me\nretain log\nretain lock\n"));

    await assert.rejects(storage.dehydrateRuns(["run-active"], new Set(["run-active"])), /still active/);
    const reclaimed = await storage.dehydrateRuns(["run-complete"]);
    assert.equal(reclaimed.reclaimed_bytes, 384);
    await assert.rejects(readFile(join(complete, "work", "temporary.bin")), /ENOENT/);
    await assert.rejects(readFile(join(complete, ".pixi", "environment.bin")), /ENOENT/);
    assert.equal(await readFile(join(complete, "results", "scientific.txt"), "utf8"), "retain me\n");
    assert.equal(await readFile(join(complete, "run.stdout.log"), "utf8"), "retain log\n");
    assert.equal(await readFile(join(complete, "pixi.lock"), "utf8"), "retain lock\n");
    assert.match(await readFile(join(complete, "run-status.json"), "utf8"), /completed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run storage refuses cleanup without a valid terminal marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-run-storage-invalid-"));
  try {
    const directory = join(root, ".somite", "runs", "run-unknown");
    await mkdir(join(directory, "work"), { recursive: true });
    await writeFile(join(directory, "work", "preserve.bin"), Buffer.alloc(16));
    const storage = new RunStorage(root);
    const profile = await storage.profile();
    assert.equal(profile.runs.uncertified_count, 1);
    assert.ok(profile.runs.uncertified_bytes >= 16);
    await assert.rejects(storage.dehydrateRuns(["run-unknown"]), /no valid terminal status/);
    assert.equal((await readFile(join(directory, "work", "preserve.bin"))).byteLength, 16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run storage refuses symlinked reclaimable paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-run-storage-symlink-"));
  try {
    const directory = await terminalRun(root, "run-symlink");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "preserve.bin"), Buffer.alloc(32));
    await rm(join(directory, "work"), { recursive: true });
    await symlink(outside, join(directory, "work"), "dir");
    const storage = new RunStorage(root);

    await assert.rejects(storage.dehydrateRuns(["run-symlink"]), /not a regular directory/);
    assert.equal((await readFile(join(outside, "preserve.bin"))).byteLength, 32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run cleanup preflights every target before deleting any work", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-run-storage-preflight-"));
  try {
    const valid = await terminalRun(root, "run-valid");
    const invalid = await terminalRun(root, "run-invalid");
    await writeFile(join(invalid, "run-status.json"), "{broken\n");
    const storage = new RunStorage(root);

    await assert.rejects(storage.dehydrateRuns(["run-valid", "run-invalid"]), /invalid terminal status/);
    assert.equal((await readFile(join(valid, "work", "temporary.bin"))).byteLength, 128);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
