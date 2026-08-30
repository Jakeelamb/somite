import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { NdjsonFrameSizeError, boundedNdjsonStream } from "../src/boundedNdjson.ts";

async function transformed(chunks: readonly string[], maximumFrameBytes: number) {
  const output: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(boundedNdjsonStream(maximumFrameBytes))) {
    output.push(Buffer.from(chunk));
  }
  return Buffer.concat(output).toString("utf8");
}

test("bounded NDJSON forwards complete split frames and a bounded final frame", async () => {
  const input = ["{\"first\":", "1}\n{\"second\":2}\n{\"final\":", "3}"];
  assert.equal(await transformed(input, 32), input.join(""));
});

test("bounded NDJSON accepts an exact-cap frame split across chunks", async () => {
  assert.equal(await transformed(["12", "34\n"], 4), "1234\n");
});

test("bounded NDJSON resets its budget after every complete sub-cap frame", async () => {
  const lines = Array.from({ length: 1_000 }, (_, index) => `${String(index).padStart(4, "0")}\n`);
  assert.equal(await transformed(lines, 4), lines.join(""));
});

test("bounded NDJSON rejects a newline-free partial frame before retaining more bytes", async () => {
  await assert.rejects(
    transformed(["1234", "5"], 4),
    (error: unknown) => error instanceof NdjsonFrameSizeError
      && error.code === "acp_frame_too_large"
      && error.actual_bytes === 5
      && error.maximum_bytes === 4,
  );
});

test("bounded NDJSON rejects one terminated frame beyond the same byte limit", async () => {
  await assert.rejects(
    transformed(["12345\n"], 4),
    (error: unknown) => error instanceof NdjsonFrameSizeError
      && error.actual_bytes === 5
      && error.maximum_bytes === 4,
  );
});
