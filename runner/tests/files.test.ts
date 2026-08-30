import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { atomicWrite, containedPath, immutableWrite } from "../src/files.ts";

test("contained paths reject traversal and atomic writes reject symlinked parents", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-files-root-"));
  const outside = await mkdtemp(join(tmpdir(), "somite-files-outside-"));
  try {
    assert.throws(() => containedPath(root, "../outside.txt"), /escapes its root/);
    assert.equal(containedPath(root, "nested/value.txt"), join(root, "nested", "value.txt"));

    await mkdir(join(root, "safe"));
    await atomicWrite(join(root, "safe", "value.txt"), "safe\n");
    assert.equal(await readFile(join(root, "safe", "value.txt"), "utf8"), "safe\n");
    await immutableWrite(join(root, "safe", "receipt.json"), "first\n");
    await assert.rejects(immutableWrite(join(root, "safe", "receipt.json"), "second\n"), { code: "EEXIST" });
    assert.equal(await readFile(join(root, "safe", "receipt.json"), "utf8"), "first\n");

    await writeFile(join(outside, "preserve.txt"), "preserve\n");
    await symlink(outside, join(root, "linked"));
    await assert.rejects(atomicWrite(join(root, "linked", "created.txt"), "unsafe\n"), /regular directory|symbolic link|symlink/i);
    await assert.rejects(readFile(join(outside, "created.txt")), /ENOENT/);
    assert.equal(await readFile(join(outside, "preserve.txt"), "utf8"), "preserve\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
