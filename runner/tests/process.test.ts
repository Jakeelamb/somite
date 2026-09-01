import assert from "node:assert/strict";
import test from "node:test";

import {
  commandFailure,
  runAbortableProcess,
  withoutEnvironmentPrefix,
  type ChildProcessOwner,
} from "../src/process.ts";

test("command failures retain a bounded diagnostic tail instead of only the final summary", () => {
  assert.equal(commandFailure("pixi lock", {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "solver conflict detail\n  incompatible package\nother error\n",
  }), "solver conflict detail | incompatible package | other error");
});

test("owned environment namespaces are removed without mutating unrelated values", () => {
  const source = { PATH: "/bin", NXF_CONFIG: "/tmp/ambient", NXF_OPTS: "-Dunsafe=true" };
  assert.deepEqual(withoutEnvironmentPrefix(source, "NXF_"), { PATH: "/bin" });
  assert.deepEqual(source, { PATH: "/bin", NXF_CONFIG: "/tmp/ambient", NXF_OPTS: "-Dunsafe=true" });
  assert.throws(() => withoutEnvironmentPrefix(source, ""), /non-empty identifier/);
});

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
