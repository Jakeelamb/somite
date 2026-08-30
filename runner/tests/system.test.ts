import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { environmentBinaryDirectories, executablePath, pixiPlatform } from "../src/system.ts";

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

test("workflow execution supports Unix Pixi targets and directs Windows users to WSL", () => {
  assert.equal(pixiPlatform("linux", "x64"), "linux-64");
  assert.equal(pixiPlatform("linux", "arm64"), "linux-aarch64");
  assert.equal(pixiPlatform("darwin", "x64"), "osx-64");
  assert.equal(pixiPlatform("darwin", "arm64"), "osx-arm64");
  assert.throws(() => pixiPlatform("win32", "x64"), /WSL2/);
  assert.throws(() => pixiPlatform("freebsd", "x64"), /unsupported on freebsd\/x64/);
  assert.throws(() => pixiPlatform("linux", "riscv64"), /unsupported on linux\/riscv64/);
  assert.throws(() => pixiPlatform("darwin", "ppc64"), /unsupported on darwin\/ppc64/);
});
