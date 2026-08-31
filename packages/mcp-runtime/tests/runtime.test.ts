import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VersionedCommandRunner, WorkspaceBoundary, runCommand, safeChildEnvironment, toolResult } from "../index.ts";

test("workspace paths cannot escape the configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-mcp-runtime-"));
  try {
    const boundary = await WorkspaceBoundary.create(root);
    assert.equal(boundary.path("workflow/main.nf"), join(root, "workflow/main.nf"));
    assert.throws(() => boundary.path("../secret"), /leaves/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace paths reject boundary-crossing symbolic links", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-mcp-runtime-links-"));
  const outside = await mkdtemp(join(tmpdir(), "somite-mcp-runtime-outside-"));
  try {
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const boundary = await WorkspaceBoundary.create(root);
    assert.throws(() => boundary.path("linked/secret.txt"), /symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("child environments omit ambient credentials", () => {
  const environment = safeChildEnvironment({ PATH: "/bin", API_TOKEN: "secret", HOME: "/tmp/home" });
  assert.deepEqual(environment, { PATH: "/bin", HOME: "/tmp/home" });
});

test("commands use argument arrays and return bounded evidence", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], process.cwd());
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "ok");
  assert.equal(result.command[0], "node");
});

test("command cancellation kills an owned process tree and settles", { skip: process.platform === "win32", timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-command-tree-"));
  const pidFile = join(root, "descendant.pid");
  const controller = new AbortController();
  try {
    const script = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const running = runCommand(process.execPath, ["-e", script], root, { signal: controller.signal, timeoutMs: 7_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.signal, "SIGKILL");
    const descendant = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(descendant, 0), (cause: unknown) => (cause as NodeJS.ErrnoException).code === "ESRCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON command output is surfaced once as native structured data", () => {
  const result = toolResult({
    command: ["tool", "inspect"], cwd: "/tmp", exit_code: 0, signal: null,
    stdout: "{\"packages\":[{\"name\":\"samtools\"}]}", stderr: "", stdout_truncated: false, stderr_truncated: false,
    duration_ms: 1, ok: true,
  });
  assert.equal(result.structuredContent.stdout, "");
  assert.ok("data" in result.structuredContent);
  assert.deepEqual(result.structuredContent.data, { packages: [{ name: "samtools" }] });
  assert.match(result.content[0]!.text, /structured JSON/);
});

test("versioned command execution fails closed before an incompatible command runs", async () => {
  const compatible = new VersionedCommandRunner({
    binary: process.execPath,
    cwd: process.cwd(),
    supportedVersion: process.versions.node,
    versionArgs: ["--version"],
  });
  assert.equal((await compatible.compatibility()).compatible, true);
  assert.equal((await compatible.run(["-e", "process.stdout.write('ok')"])).stdout, "ok");

  const incompatible = new VersionedCommandRunner({
    binary: process.execPath,
    cwd: process.cwd(),
    supportedVersion: "0.0.0",
    versionArgs: ["--version"],
  });
  const rejected = await incompatible.run(["-e", "process.exit(99)"]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.exit_code, null);
  assert.match(rejected.stderr, /proven against 0\.0\.0/);
});
