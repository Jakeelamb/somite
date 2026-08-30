import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { byteDigest } from "@somite/workflow/contentIdentity";
import { startServer } from "../src/server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function unusedPort() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("could not reserve test port");
  await new Promise<void>((resolvePromise, rejectPromise) => reservation.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return address.port;
}

async function statusWithHost(port: number, host: string) {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/api/session", headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("error", rejectPromise);
    request.end();
  });
}

test("the TypeScript runner serves the browser session, streaming uploads, and local Snakemake import", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-"));
  const port = await unusedPort();
  const bin = join(root, ".pixi", "envs", "default", "bin");
  await mkdir(join(root, "workflow"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, "workflow", "Snakefile"), "rule all:\n    input: 'done'\n");
  await writeFile(join(root, "pixi.lock"), "test\n");
  const pixi = join(bin, "pixi");
  await writeFile(pixi, "#!/bin/sh\nprintf '%s\\n' 'digraph snakemake_dag {' '0[label = \"prepare\"];' '1[label = \"all\"];' '0 -> 1' '}'\n");
  await chmod(pixi, 0o755);
  const child = spawn(process.execPath, ["--experimental-strip-types", join(repositoryRoot, "runner", "src", "server.ts")], {
    cwd: repositoryRoot,
    env: { ...process.env, SOMITE_PROJECT_ROOT: root, SOMITE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk: Buffer) => { diagnostics += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString("utf8"); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) break;
      healthy = await fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false);
      if (healthy) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.equal(healthy, true, diagnostics);
    const session = await fetch(`${base}/api/session`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal((session.graph as Record<string, unknown>).schema_version, 3);

    const form = new FormData();
    form.set("file", new Blob(["@read\nACGT\n+\n!!!!\n"]), "reads.fastq");
    const uploadedResponse = await fetch(`${base}/api/files`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: form });
    assert.equal(uploadedResponse.status, 200, await uploadedResponse.clone().text().then((value) => value || diagnostics));
    const uploaded = await uploadedResponse.json() as { path: string };
    const storedPath = uploaded.path;
    assert.equal(await readFile(join(root, storedPath), "utf8"), "@read\nACGT\n+\n!!!!\n");

    const hostile = new FormData();
    hostile.set("file", new Blob(["hostile\n"]), "hostile.fastq");
    assert.equal((await fetch(`${base}/api/files`, { method: "POST", headers: { origin: "https://attacker.example" }, body: hostile })).status, 403);

    const originlessMutation = await fetch(`${base}/api/workflows/snakemake/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, targets: ["all"] }),
    });
    assert.equal(originlessMutation.status, 403);

    const otherLoopbackOrigin = await fetch(`${base}/api/workflows/snakemake/import`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3999" },
      body: JSON.stringify({ path: root, targets: ["all"] }),
    });
    assert.equal(otherLoopbackOrigin.status, 403);

    assert.equal(await statusWithHost(port, "attacker.example:7310"), 403);

    const imported = await fetch(`${base}/api/workflows/snakemake/import`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ path: root, targets: ["all"] }),
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    const graph = (await imported.json() as { graph: { nodes: unknown[]; edges: unknown[] } }).graph;
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
  } finally {
    child.kill("SIGTERM");
    await once(child, "close").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("paper upload streams past the global JSON body limit into content-addressed storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-paper-stream-"));
  const running = await startServer({ projectRoot: root, port: await unusedPort() });
  try {
    const bytes = new Uint8Array(17 * 1024 * 1024 + 137);
    bytes.fill("A".charCodeAt(0));
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: "text/plain" }), "large-methods.txt");
    const response = await fetch(`${running.url}/api/papers/uploads`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
      body: form,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const artifact = await response.json() as { digest: string; path: string; size_bytes: number; media_kind: string; reused: boolean };
    assert.equal(artifact.size_bytes, bytes.byteLength);
    assert.equal(artifact.size_bytes > 16 * 1024 * 1024, true);
    assert.equal(artifact.digest, byteDigest(bytes));
    assert.equal(artifact.media_kind, "text");
    assert.equal(artifact.reused, false);
    assert.equal((await stat(join(root, artifact.path))).size, bytes.byteLength);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime cleanup is explicit and preserves scientific run records", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-storage-"));
  const run = join(root, ".somite", "runs", "run-finished");
  await mkdir(join(run, "work"), { recursive: true });
  await mkdir(join(run, "results"), { recursive: true });
  await writeFile(join(run, "work", "recreatable.bin"), Buffer.alloc(1024));
  await writeFile(join(run, "results", "scientific.txt"), "retain me\n");
  await writeFile(join(run, "run-status.json"), `${JSON.stringify({
    schema_version: 1,
    run_id: "run-finished",
    phase: "completed",
    finished_at_unix_ms: 1,
  })}\n`);
  const running = await startServer({ projectRoot: root, port: await unusedPort() });
  try {
    const profileResponse = await fetch(`${running.url}/api/storage`);
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.json() as { runs: { reclaimable_bytes: number; reclaimable_run_ids: string[] } };
    assert.equal(profile.runs.reclaimable_bytes, 1024);
    assert.deepEqual(profile.runs.reclaimable_run_ids, ["run-finished"]);

    const cleanupBody = JSON.stringify({ run_ids: profile.runs.reclaimable_run_ids });
    assert.equal((await fetch(`${running.url}/api/storage/dehydrate-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: cleanupBody,
    })).status, 403);
    const cleanupResponse = await fetch(`${running.url}/api/storage/dehydrate-runs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: cleanupBody,
    });
    assert.equal(cleanupResponse.status, 200, await cleanupResponse.clone().text());
    assert.equal((await cleanupResponse.json() as { reclaimed_bytes: number }).reclaimed_bytes, 1024);
    await assert.rejects(readFile(join(run, "work", "recreatable.bin")), /ENOENT/);
    assert.equal(await readFile(join(run, "results", "scientific.txt"), "utf8"), "retain me\n");

    const refreshed = await fetch(`${running.url}/api/storage`).then((response) => response.json()) as { runs: { reclaimable_bytes: number; reclaimable_run_ids: string[] } };
    assert.equal(refreshed.runs.reclaimable_bytes, 0);
    assert.deepEqual(refreshed.runs.reclaimable_run_ids, []);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("project startup rejects graph paths and state directories outside the canonical project", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-path-"));
  const outside = await mkdtemp(join(tmpdir(), "somite-runner-outside-"));
  try {
    const outsideGraph = join(outside, "outside.somite.json");
    const outsideAttempt = await startServer({ projectRoot: root, graph: outsideGraph, port: await unusedPort() })
      .then(async (running) => {
        await running.close();
        return null;
      })
      .catch((error: unknown) => error);
    assert.match(outsideAttempt instanceof Error ? outsideAttempt.message : "", /inside|within|escapes|project root/i);
    await assert.rejects(readFile(outsideGraph), /ENOENT/);

    await rm(join(root, ".somite"), { recursive: true, force: true });
    await import("node:fs/promises").then(({ symlink }) => symlink(outside, join(root, ".somite")));
    const symlinkAttempt = await startServer({ projectRoot: root, port: await unusedPort() })
      .then(async (running) => {
        await running.close();
        return null;
      })
      .catch((error: unknown) => error);
    assert.match(symlinkAttempt instanceof Error ? symlinkAttempt.message : "", /regular directory|symbolic link|symlink/i);
    await assert.rejects(readFile(join(outside, "web.somite.json")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
