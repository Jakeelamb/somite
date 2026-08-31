import assert from "node:assert/strict";
import test from "node:test";

import { safeProjectUploadPath } from "../src/projectUploadStore.ts";

test("browser project paths retain a safe directory root", () => {
  assert.deepEqual(safeProjectUploadPath("demo/modules/prepare.nf"), ["demo", "modules", "prepare.nf"]);
  for (const path of ["main.nf", "../main.nf", "demo/../main.nf", "demo\\main.nf", "/demo/main.nf", "demo//main.nf"]) {
    assert.throws(() => safeProjectUploadPath(path), /project upload/);
  }
});
