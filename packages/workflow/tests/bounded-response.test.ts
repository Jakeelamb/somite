import assert from "node:assert/strict";
import test from "node:test";

import { ResponseHeaderError, ResponseSizeError, boundedResponseBytes } from "../boundedResponse.ts";

test("bounded response reading accepts an exact unadvertised body", async () => {
  const bytes = await boundedResponseBytes(new Response(new Uint8Array([1, 2, 3, 4])), 4);
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
});

test("bounded response reading cancels an advertised oversized body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { "content-length": "9" } });
  await assert.rejects(
    boundedResponseBytes(response, 8),
    (error: unknown) => error instanceof ResponseSizeError && error.maximumBytes === 8,
  );
  assert.equal(cancelled, true);
});

test("bounded response reading types and cancels an invalid byte count", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { "content-length": "unknown" } });
  await assert.rejects(boundedResponseBytes(response, 8), ResponseHeaderError);
  assert.equal(cancelled, true);
});

test("bounded response reading cancels a chunked body as soon as it crosses the limit", async () => {
  let cancelled = false;
  let pull = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pull += 1;
      controller.enqueue(new Uint8Array(4));
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(
    boundedResponseBytes(response, 8),
    (error: unknown) => error instanceof ResponseSizeError,
  );
  assert.equal(cancelled, true);
  assert.ok(pull <= 4, `oversized stream pulled ${pull} chunks`);
});
