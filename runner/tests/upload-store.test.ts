import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { safeUploadFilename, UploadError, UploadStore } from "../src/uploadStore.ts";

async function listen(store: UploadStore) {
  const server = createServer(async (request, response) => {
    try {
      const result = await store.receive(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof UploadError ? error.status : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function close(server: Server) {
  return new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
}

async function upload(url: string, filename: string, contents: string) {
  const form = new FormData();
  form.set("file", new Blob([contents], { type: "application/octet-stream" }), filename);
  const response = await fetch(url, { method: "POST", body: form });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("upload filenames are portable project basenames", () => {
  assert.equal(safeUploadFilename("../../reads.fastq.gz"), "reads.fastq.gz");
  assert.equal(safeUploadFilename("C:\\fakepath\\reads.fastq"), "reads.fastq");
  assert.throws(() => safeUploadFilename(".."), /invalid/);
  assert.throws(() => safeUploadFilename("bad\u0000name"), /invalid/);
});

test("scientific uploads stream into the project and same-name files never clobber", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-upload-ts-"));
  const endpoint = await listen(new UploadStore(root, { maxFileBytes: 1024, maxProjectBytes: 4096 }));
  try {
    const [first, second] = await Promise.all([
      upload(endpoint.url, "reads.fastq", "first\n"),
      upload(endpoint.url, "reads.fastq", "second\n"),
    ]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(first.body.path, second.body.path);
    const paths = [first.body.path, second.body.path].map(String);
    const contents = await Promise.all(paths.map((path) => readFile(join(root, path), "utf8")));
    assert.deepEqual(contents.sort(), ["first\n", "second\n"]);
  } finally {
    await close(endpoint.server);
    await rm(root, { recursive: true, force: true });
  }
});

test("scientific uploads enforce file and project byte budgets without partial files", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-upload-budget-ts-"));
  const endpoint = await listen(new UploadStore(root, { maxFileBytes: 8, maxProjectBytes: 12 }));
  try {
    const oversized = await upload(endpoint.url, "oversized.fastq", "123456789");
    assert.equal(oversized.status, 413, JSON.stringify(oversized.body));
    const accepted = await upload(endpoint.url, "accepted.fastq", "12345678");
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const budget = await upload(endpoint.url, "budget.fastq", "12345");
    assert.equal(budget.status, 413, JSON.stringify(budget.body));
    assert.deepEqual(await readdir(join(root, ".somite", "uploads")), ["accepted.fastq"]);
  } finally {
    await close(endpoint.server);
    await rm(root, { recursive: true, force: true });
  }
});

test("scientific uploads reject a symlinked project store", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-upload-link-ts-"));
  const outside = await mkdtemp(join(tmpdir(), "somite-upload-outside-ts-"));
  await mkdir(join(root, ".somite"));
  await symlink(outside, join(root, ".somite", "uploads"));
  const endpoint = await listen(new UploadStore(root, { maxFileBytes: 1024, maxProjectBytes: 4096 }));
  try {
    const response = await upload(endpoint.url, "reads.fastq", "outside\n");
    assert.equal(response.status, 422);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await close(endpoint.server);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
