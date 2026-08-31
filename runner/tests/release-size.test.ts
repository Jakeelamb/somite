import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("release size checking distinguishes a pristine archive from an installed tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-release-size-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts", "check-release-size.ts"), join(root, "scripts", "check-release-size.ts"));
  await writeFile(join(root, "README.md"), "Somite\n");

  const pristine = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "check-release-size.ts"), "--source-only"], { cwd: root, encoding: "utf8" });
  assert.equal(pristine.status, 0, pristine.stderr);

  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules", "leak.bin"), Buffer.alloc(2 * 1024 * 1024));
  const strict = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "check-release-size.ts"), "--source-only"], { cwd: root, encoding: "utf8" });
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /generated install or runtime state.+node_modules/s);

  await mkdir(join(root, "web", "dist", "client"), { recursive: true });
  await writeFile(join(root, "web", "dist", "client", "app.js"), "export {};\n");
  const installed = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "check-release-size.ts")], { cwd: root, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
});

test("release size checking profiles the working tree during an unstaged deletion", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-release-size-git-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts", "check-release-size.ts"), join(root, "scripts", "check-release-size.ts"));
  await writeFile(join(root, "deleted.txt"), "deleted\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["add", "scripts/check-release-size.ts", "deleted.txt"], { cwd: root }).status, 0);
  await unlink(join(root, "deleted.txt"));
  await writeFile(join(root, "new.txt"), "new\n");

  const result = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "check-release-size.ts"), "--source-only"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 source files/);
});
