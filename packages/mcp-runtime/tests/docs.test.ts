import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OfficialDocumentation } from "../docs.ts";

const source = {
  name: "Fixture",
  repository: "somite/fixture",
  branch: "v1",
  directory: "docs",
  website: "https://example.test/docs/",
};

test("documentation pages enforce byte limits while streaming", async () => {
  const cache = await mkdtemp(join(tmpdir(), "somite-docs-limit-"));
  let request = 0;
  const fetcher = (async () => {
    request += 1;
    if (request === 1) {
      return new Response(JSON.stringify({ tree: [{ path: "docs/guide.md", type: "blob" }] }), { status: 200 });
    }
    const chunk = new Uint8Array(300 * 1024).fill(65);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const docs = new OfficialDocumentation(source, cache, fetcher);
    await assert.rejects(docs.read("guide.md"), /documentation page exceeds the response limit/);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("catalog, search, and read replay completely from the versioned cache", async () => {
  const cache = await mkdtemp(join(tmpdir(), "somite-docs-offline-"));
  const pages = new Map([
    ["guide.md", "# Frozen execution\nUse the exact lock file for deterministic environments.\n"],
    ["reference/tasks.md", "# Tasks\nRun declared tasks without an interactive shell.\n"],
  ]);
  let requests = 0;
  const fetcher = (async (input: string | URL | Request) => {
    requests += 1;
    const url = String(input);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ tree: [...pages.keys()].map((path) => ({ path: `docs/${path}`, type: "blob" })) }), { status: 200 });
    }
    const path = [...pages.keys()].find((candidate) => url.endsWith(`/docs/${candidate}`));
    return path ? new Response(pages.get(path), { status: 200 }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  try {
    const online = new OfficialDocumentation(source, cache, fetcher);
    assert.deepEqual(await online.catalog(), [...pages.keys()].sort());
    assert.match(JSON.stringify(await online.search("exact lock deterministic", 5)), /guide\.md/);
    assert.equal((await online.read("reference/tasks.md")).text, pages.get("reference/tasks.md"));
    assert.equal(requests, 3, "one catalog and two pages should populate the complete cache");

    const offline = new OfficialDocumentation(source, cache, (async () => {
      throw new Error("offline replay attempted a network request");
    }) as typeof fetch);
    assert.deepEqual(await offline.catalog(), [...pages.keys()].sort());
    assert.match(JSON.stringify(await offline.search("declared tasks", 5)), /reference\/tasks\.md/);
    assert.equal((await offline.read("guide.md")).text, pages.get("guide.md"));
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
