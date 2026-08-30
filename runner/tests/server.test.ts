import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { byteDigest } from "@somite/workflow/contentIdentity";
import { operatorPorts, type Operator } from "@somite/workflow/catalog";
import { InputOrigins } from "../src/inputOrigins.ts";
import { startServer } from "../src/server.ts";
import { MAX_WORKFLOW_REQUEST_BYTES } from "../src/workflowLimits.ts";

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

async function postWithAnnouncedLength(port: number, path: string, length: number) {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "content-length": String(length),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("error", rejectPromise);
    request.end();
  });
}

function largeValidGraph() {
  const note = "x".repeat(5_000);
  return {
    schema_version: 3,
    name: "Large visual workflow",
    nodes: [],
    edges: [],
    annotations: Array.from({ length: 3_300 }, (_, index) => ({
      id: `note-${index}`,
      kind: "sticky",
      text: note,
      color: "yellow",
      layout: { x: index % 50, y: Math.floor(index / 50) },
      width: 180,
      height: 100,
    })),
  };
}

test("the TypeScript runner serves the browser session, streaming uploads, and generic local-project import", { skip: process.platform === "win32" }, async () => {
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

    const originlessMutation = await fetch(`${base}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, snakemake_targets: ["all"] }),
    });
    assert.equal(originlessMutation.status, 403);

    const otherLoopbackOrigin = await fetch(`${base}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3999" },
      body: JSON.stringify({ path: root, snakemake_targets: ["all"] }),
    });
    assert.equal(otherLoopbackOrigin.status, 403);

    assert.equal(await statusWithHost(port, "attacker.example:7310"), 403);

    const imported = await fetch(`${base}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ path: root, snakemake_targets: ["all"] }),
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

test("workflow document routes retain the 64 MiB compatibility envelope without widening Agent bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-large-graph-"));
  const port = await unusedPort();
  const graphPath = join(root, "large.somite.json");
  const paddedDocument = `${" ".repeat(16 * 1024 * 1024)}${JSON.stringify({ schema_version: 3, name: "Large document", nodes: [], edges: [] })}`;
  await writeFile(graphPath, paddedDocument);
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    running = await startServer({ projectRoot: root, graph: "large.somite.json", port });
    const session = await fetch(`${running.url}/api/session`).then((response) => response.json()) as { graph: { name?: string }; state_revision: string };
    assert.equal(session.graph.name, "Large document");

    const body = JSON.stringify({ base_state_revision: session.state_revision, graph: largeValidGraph() });
    assert.ok(Buffer.byteLength(body) > 16 * 1024 * 1024);
    assert.ok(Buffer.byteLength(body) < 64 * 1024 * 1024);
    const saved = await fetch(`${running.url}/api/graph/autosave`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body,
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const activeSession = await fetch(`${running.url}/api/session`).then((response) => response.json()) as { recovered_autosave: boolean };
    assert.equal(activeSession.recovered_autosave, false, "writing an autosave is not the same as recovering one at startup");

    const agent = await fetch(`${running.url}/api/agent/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body,
    });
    assert.equal(agent.status, 413, await agent.clone().text());
    const config = await fetch(`${running.url}/api/agent/config`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body,
    });
    assert.equal(config.status, 413, await config.clone().text());
    assert.equal(await postWithAnnouncedLength(port, "/api/graph/validate", MAX_WORKFLOW_REQUEST_BYTES + 1), 413);

    const autosave = join(root, "large.somite.autosave.somite.json");
    assert.ok((await stat(autosave)).size > 16 * 1024 * 1024);
    await running.close();
    running = undefined;
    running = await startServer({ projectRoot: root, graph: "large.somite.json", port });
    const recovered = await fetch(`${running.url}/api/session`).then((response) => response.json()) as {
      recovered_autosave: boolean;
      graph: { annotations?: unknown[] };
    };
    assert.equal(recovered.recovered_autosave, true);
    assert.equal(recovered.graph.annotations?.length, 3_300);
  } finally {
    await running?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("opening an external Somite document preserves it exactly and carries its relative-input origin through autosave and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-open-document-"));
  const external = await mkdtemp(join(tmpdir(), "somite-runner-external-document-"));
  const mutationHeaders = { "content-type": "application/json", origin: "http://localhost:3000" };
  let running = await startServer({ projectRoot: root, port: await unusedPort() });
  try {
    const firstSession = await fetch(`${running.url}/api/session`).then((response) => response.json()) as {
      operators: Array<{ id: string; revision?: string }>;
      state_revision: string;
      input_origin_id: string;
    };
    const revision = firstSession.operators.find((operator) => operator.id === "files.import")?.revision;
    assert.ok(revision);
    await mkdir(join(external, "data"));
    await writeFile(join(external, "data", "reads.fastq"), "@external\nACGT\n+\n!!!!\n");
    const sourceNode = {
      id: "source-original",
      operator: "files.import",
      operator_revision: revision,
      ports: [{ name: "file", dir: "out", ty: "Fastq" }],
      params: { path: "data/reads.fastq" },
      layout: { x: -300, y: 20 },
    };
    const graph = {
      schema_version: 3,
      name: "External exact document",
      nodes: [{ ...sourceNode, id: "reads", layout: { x: 120, y: 240 } }],
      edges: [],
      annotations: [{ id: "note", kind: "sticky", text: "Keep this", color: "teal", layout: { x: 20, y: 40 }, width: 220, height: 140 }],
    };
    const graphPath = join(external, "external.somite.json");
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);

    const openedResponse = await fetch(`${running.url}/api/projects/open`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ path: graphPath, snakemake_targets: [] }),
    });
    assert.equal(openedResponse.status, 200, await openedResponse.clone().text());
    const openedText = await openedResponse.text();
    assert.equal(openedText.includes(external), false, "the browser response must not expose the machine-local input base");
    const opened = JSON.parse(openedText) as { kind: string; graph: unknown; input_origin_id: string };
    assert.equal(opened.kind, "somite");
    assert.deepEqual(opened.graph, graph);
    assert.match(opened.input_origin_id, /^[A-Za-z0-9_-]{24}$/);

    const autosave = await fetch(`${running.url}/api/graph/autosave`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        base_state_revision: firstSession.state_revision,
        graph: opened.graph,
        input_origin_id: opened.input_origin_id,
      }),
    });
    assert.equal(autosave.status, 200, await autosave.clone().text());
    const externalRevision = (await autosave.json() as { state_revision: string }).state_revision;
    assert.notEqual(externalRevision, firstSession.state_revision);
    assert.deepEqual(JSON.parse(await readFile(join(root, ".somite", "autosave.somite.json"), "utf8")), graph);
    assert.deepEqual(JSON.parse(await readFile(graphPath, "utf8")), graph, "opening and autosaving must not rewrite the source graph");

    const projectOrigin = await fetch(`${running.url}/api/graph/autosave`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        base_state_revision: externalRevision,
        graph,
        input_origin_id: firstSession.input_origin_id,
      }),
    });
    assert.equal(projectOrigin.status, 200, await projectOrigin.clone().text());
    const projectRevision = (await projectOrigin.json() as { state_revision: string }).state_revision;
    assert.notEqual(projectRevision, externalRevision, "origin-only changes must change concurrency identity");
    const staleOriginSwitch = await fetch(`${running.url}/api/graph/autosave`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        base_state_revision: externalRevision,
        graph,
        input_origin_id: opened.input_origin_id,
      }),
    });
    assert.equal(staleOriginSwitch.status, 409, await staleOriginSwitch.clone().text());
    const restoreExternal = await fetch(`${running.url}/api/graph/autosave`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        base_state_revision: projectRevision,
        graph,
        input_origin_id: opened.input_origin_id,
      }),
    });
    assert.equal(restoreExternal.status, 200, await restoreExternal.clone().text());

    const run = await fetch(`${running.url}/api/runs`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ graph, input_origin_id: opened.input_origin_id }),
    });
    assert.equal(run.status, 202, await run.clone().text());
    await running.close();

    running = await startServer({ projectRoot: root, port: await unusedPort() });
    const restoredSession = await fetch(`${running.url}/api/session`).then((response) => response.json()) as {
      graph: unknown;
      input_origin_id: string;
      input_origin_warning: string | null;
    };
    assert.deepEqual(restoredSession.graph, graph);
    assert.equal(restoredSession.input_origin_warning, null);
    const restoredRun = await fetch(`${running.url}/api/runs`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ graph, input_origin_id: restoredSession.input_origin_id }),
    });
    assert.equal(restoredRun.status, 202, await restoredRun.clone().text());
  } finally {
    await running.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("unsupported representative validation returns a typed capability before writing fixture state", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-validation-capability-"));
  const running = await startServer({ projectRoot: root, port: await unusedPort() });
  const mutationHeaders = { "content-type": "application/json", origin: "http://localhost:3000" };
  try {
    const session = await fetch(`${running.url}/api/session`).then((response) => response.json()) as {
      operators: Operator[];
    };
    const input = session.operators.find((operator) => operator.id === "files.import_fasta");
    assert.ok(input?.revision);
    await writeFile(join(root, "reference.fasta"), ">reference\nACGT\n");
    const graph = {
      schema_version: 3,
      name: "FASTA-rooted workflow",
      nodes: [{
        id: "reference",
        operator: input.id,
        operator_revision: input.revision,
        ports: operatorPorts(input),
        params: { path: "reference.fasta" },
        layout: { x: 0, y: 0 },
      }],
      edges: [],
    };
    for (const path of ["/api/validations", "/api/validations/status"]) {
      const response = await fetch(`${running.url}${path}`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(graph),
      });
      assert.equal(response.status, 422, `${path}: ${await response.clone().text()}`);
      const body = await response.json() as { code: string; capability: { supported: boolean; unsupported_roots: string[] }; error: string };
      assert.equal(body.code, "representative_fixture_unsupported");
      assert.deepEqual(body.capability, {
        supported: false,
        code: "representative_fixture_unsupported",
        reason: body.error,
        unsupported_roots: ["files.import_fasta"],
      });
    }
    await assert.rejects(access(join(root, ".somite", "fixtures")), { code: "ENOENT" });
    await assert.rejects(access(join(root, ".somite", "runs")), { code: "ENOENT" });
  } finally {
    await running.close();
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

test("project startup falls back to the saved graph when autosave recovery is corrupt or untrusted", async (context) => {
  const cases = [
    {
      name: "corrupt JSON",
      autosave: "{not valid json\n",
      warning: /autosave.*valid JSON.*saved workflow/i,
    },
    {
      name: "untrusted graph",
      autosave: `${JSON.stringify({
        schema_version: 3,
        name: "Untrusted autosave",
        nodes: [{
          id: "forged",
          operator: "untrusted.operator",
          operator_revision: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
          ports: [],
          layout: { x: 0, y: 0 },
        }],
        edges: [],
      }, null, 2)}\n`,
      warning: /autosave.*unknown operator.*saved workflow/i,
    },
  ];

  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "somite-runner-autosave-fallback-"));
      const graphPath = join(root, "saved.somite.json");
      const autosavePath = join(root, "saved.somite.autosave.somite.json");
      const saved = { schema_version: 3, name: "Saved workflow", nodes: [], edges: [] };
      await writeFile(graphPath, `${JSON.stringify(saved, null, 2)}\n`);
      await writeFile(autosavePath, fixture.autosave);
      const running = await startServer({ projectRoot: root, graph: "saved.somite.json", port: await unusedPort() });
      try {
        const response = await fetch(`${running.url}/api/session`);
        assert.equal(response.status, 200, await response.clone().text());
        const session = await response.json() as {
          graph: { name?: string };
          recovered_autosave: boolean;
          autosave_recovery_warning: string | null;
        };
        assert.equal(session.graph.name, "Saved workflow");
        assert.equal(session.recovered_autosave, false);
        assert.match(session.autosave_recovery_warning ?? "", fixture.warning);
        assert.equal(await readFile(autosavePath, "utf8"), fixture.autosave, "the rejected autosave remains available for diagnosis");
      } finally {
        await running.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("project startup still recovers a valid autosave without a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-autosave-valid-"));
  const saved = { schema_version: 3, name: "Saved workflow", nodes: [], edges: [] };
  const autosaved = { schema_version: 3, name: "Recovered autosave", nodes: [], edges: [] };
  await writeFile(join(root, "saved.somite.json"), `${JSON.stringify(saved, null, 2)}\n`);
  await writeFile(join(root, "saved.somite.autosave.somite.json"), `${JSON.stringify(autosaved, null, 2)}\n`);
  const running = await startServer({ projectRoot: root, graph: "saved.somite.json", port: await unusedPort() });
  try {
    const session = await fetch(`${running.url}/api/session`).then((response) => response.json()) as {
      graph: { name?: string };
      recovered_autosave: boolean;
      autosave_recovery_warning: string | null;
    };
    assert.equal(session.graph.name, "Recovered autosave");
    assert.equal(session.recovered_autosave, true);
    assert.equal(session.autosave_recovery_warning, null);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("recovered graphs fail closed until their local input location is explicitly rebound", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-origin-recovery-"));
  const external = await mkdtemp(join(tmpdir(), "somite-runner-origin-recovery-external-"));
  const graphPath = join(root, "saved.somite.json");
  const autosavePath = join(root, "saved.somite.autosave.somite.json");
  const saved = { schema_version: 3 as const, name: "Saved workflow", nodes: [], edges: [] };
  const recovered = { schema_version: 3 as const, name: "Recovered workflow", nodes: [], edges: [] };
  const mutationHeaders = { "content-type": "application/json", origin: "http://localhost:3000" };
  const agentCapability = "a".repeat(64);
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await mkdir(join(root, ".somite"));
    await writeFile(graphPath, `${JSON.stringify(saved, null, 2)}\n`);
    await writeFile(autosavePath, `${JSON.stringify(recovered, null, 2)}\n`);
    const origins = await InputOrigins.open(root, graphPath, root, saved);
    const externalId = await origins.registerOpenedGraph(external);
    await origins.record(externalId, saved);
    const externalGraphPath = join(external, "original.somite.json");
    await writeFile(externalGraphPath, `${JSON.stringify(recovered, null, 2)}\n`);

    running = await startServer({ projectRoot: root, graph: "saved.somite.json", port: await unusedPort(), agentCapability });
    const session = await fetch(`${running.url}/api/session`).then((response) => response.json()) as {
      graph: unknown;
      state_revision: string;
      input_origin_id: string;
      input_origin_warning: string | null;
    };
    assert.match(session.input_origin_warning ?? "", /does not match the recovered canvas/);

    const graphRequest = { graph: session.graph, input_origin_id: session.input_origin_id };
    const blocked = [
      fetch(`${running.url}/api/graph/autosave`, { method: "PUT", headers: mutationHeaders, body: JSON.stringify({ ...graphRequest, base_state_revision: session.state_revision }) }),
      fetch(`${running.url}/api/export`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(graphRequest) }),
      fetch(`${running.url}/api/runs`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(graphRequest) }),
      fetch(`${running.url}/api/validations`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(graphRequest) }),
      fetch(`${running.url}/api/agent/compile`, { method: "POST", headers: { ...mutationHeaders, "x-somite-mcp-capability": agentCapability }, body: "{}" }),
    ];
    for (const response of await Promise.all(blocked)) {
      assert.equal(response.status, 409, await response.clone().text());
      assert.equal((await response.json() as { code?: string }).code, "input_origin_recovery_required");
    }

    const openedResponse = await fetch(`${running.url}/api/projects/open`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ path: externalGraphPath, snakemake_targets: [] }),
    });
    assert.equal(openedResponse.status, 200, await openedResponse.clone().text());
    const opened = await openedResponse.json() as { input_origin_id: string };
    const reboundResponse = await fetch(`${running.url}/api/input-origin/recover`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ base_state_revision: session.state_revision, input_origin_id: opened.input_origin_id }),
    });
    assert.equal(reboundResponse.status, 200, await reboundResponse.clone().text());
    const rebound = await reboundResponse.json() as { state_revision: string; input_origin_id: string; input_origin_warning: null };
    assert.equal(rebound.input_origin_id, opened.input_origin_id);
    assert.equal(rebound.input_origin_warning, null);
    assert.notEqual(rebound.state_revision, session.state_revision);

    const savedAfterRecovery = await fetch(`${running.url}/api/graph/autosave`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({ graph: session.graph, base_state_revision: rebound.state_revision, input_origin_id: rebound.input_origin_id }),
    });
    assert.equal(savedAfterRecovery.status, 200, await savedAfterRecovery.clone().text());
    const recoveredSession = await fetch(`${running.url}/api/session`).then((response) => response.json()) as { input_origin_warning: string | null };
    assert.equal(recoveredSession.input_origin_warning, null);
  } finally {
    await running?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("paper resource resolution rejects accession-kind mismatches before network lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-paper-resource-"));
  const running = await startServer({ projectRoot: root, port: await unusedPort() });
  try {
    const response = await fetch(`${running.url}/api/paper/resources/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ resources: [{
        accession: "SRR123456",
        kind: "assembly",
        role: "reads",
        context: "cited sequencing reads",
      }] }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /kind must be sra_run for SRR123456/);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("paper OCR setup installs a verified managed toolchain and refreshes machine readiness", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-runner-paper-tools-"));
  const bin = join(root, ".pixi", "envs", "default", "bin");
  await mkdir(bin, { recursive: true });
  const pixi = join(bin, "pixi");
  await writeFile(pixi, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const manifest = args[args.indexOf("--manifest-path") + 1];
const directory = path.dirname(manifest);
fs.writeFileSync(path.join(directory, "pixi.lock"), "version = 1\\n");
const bin = path.join(directory, ".pixi", "envs", "default", "bin");
fs.mkdirSync(bin, { recursive: true });
const bodies = {
  pdfinfo: 'process.stderr.write("pdfinfo version 25.01.0\\\\n");',
  pdftoppm: 'process.stderr.write("pdftoppm version 25.01.0\\\\n");',
  tesseract: 'if (process.argv.includes("--version")) process.stdout.write("tesseract 5.5.0\\\\n"); else process.stdout.write("List of available languages (1):\\\\neng\\\\n");',
};
for (const [name, body] of Object.entries(bodies)) {
  const target = path.join(bin, name);
  fs.writeFileSync(target, "#!${process.execPath}\\n" + body + "\\n", { mode: 0o700 });
  fs.chmodSync(target, 0o700);
}
`, { mode: 0o700 });
  await chmod(pixi, 0o700);
  const running = await startServer({ projectRoot: root, port: await unusedPort() });
  try {
    const setup = await fetch(`${running.url}/api/paper-tools/ocr/install`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: "{}",
    });
    assert.equal(setup.status, 200, await setup.clone().text());
    const installed = await setup.json() as { receipt_id: string; preflight: { scanned_pdf_ocr: boolean; missing: string[]; tools: Array<{ name: string; source?: string }> } };
    assert.match(installed.receipt_id, /^[a-f0-9]{64}$/);
    assert.equal(installed.preflight.scanned_pdf_ocr, true);
    assert.deepEqual(installed.preflight.missing, []);
    assert.ok(installed.preflight.tools.filter((tool) => tool.name !== "PDF.js").every((tool) => tool.source === "managed_pixi"));

    const system = await fetch(`${running.url}/api/system`).then((response) => response.json()) as {
      paper_extraction: { native_pdf_text: boolean; scanned_pdf_ocr: boolean; missing: string[] };
    };
    assert.equal(system.paper_extraction.native_pdf_text, true);
    assert.equal(system.paper_extraction.scanned_pdf_ocr, true);
    assert.deepEqual(system.paper_extraction.missing, []);
    const storage = await fetch(`${running.url}/api/storage`).then((response) => response.json()) as { shared_environments: { bytes: number } };
    assert.ok(storage.shared_environments.bytes > 0, "managed paper tools must be included in local storage accounting");
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
