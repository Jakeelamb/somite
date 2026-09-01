import assert from "node:assert/strict";
import test from "node:test";

import { runAbortableProcess, type ChildProcessOwner } from "../src/process.ts";

test("abort-aware process execution does not spawn when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const owner: ChildProcessOwner = {};
  let spawned = false;

  await assert.rejects(
    runAbortableProcess(controller.signal, () => {
      spawned = true;
      throw new Error("spawn must not be called");
    }, owner),
    /operation cancelled/,
  );

  assert.equal(spawned, false);
  assert.equal(owner.child, undefined);
});
