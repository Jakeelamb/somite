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
  const originalFetch = globalThis.fetch;
  let request = 0;
  globalThis.fetch = (async () => {
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
    const docs = new OfficialDocumentation(source, cache);
    await assert.rejects(docs.read("guide.md"), /documentation page exceeds the response limit/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cache, { recursive: true, force: true });
  }
});
