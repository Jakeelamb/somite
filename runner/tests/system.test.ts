import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { environmentBinaryDirectories, executablePath } from "../src/system.ts";

test("Pixi binary search uses native environment layouts", () => {
  const root = join("project", "root");
  assert.deepEqual(environmentBinaryDirectories(root, "linux"), [join(root, ".pixi", "envs", "default", "bin")]);
  assert.deepEqual(environmentBinaryDirectories(root, "darwin"), [join(root, ".pixi", "envs", "default", "bin")]);
  assert.deepEqual(environmentBinaryDirectories(root, "win32"), [
    join(root, ".pixi", "envs", "default"),
    join(root, ".pixi", "envs", "default", "Scripts"),
    join(root, ".pixi", "envs", "default", "Library", "bin"),
  ]);
});

test("project Pixi binaries take precedence over the ambient path", { skip: process.platform === "win32" }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-system-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, ".pixi", "envs", "default", "bin", "example-tool");
  await mkdir(join(binary, ".."), { recursive: true });
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  await chmod(binary, 0o755);

  assert.equal(await executablePath(root, "example-tool"), binary);
});
