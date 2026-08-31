import assert from "node:assert/strict";
import test from "node:test";

import { spawnOwnedProcess, terminateOwnedProcess, waitForOwnedProcessTermination } from "../../scripts/process-owner.ts";

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("owned process escalation kills descendants after the group leader exits", { skip: process.platform === "win32", timeout: 5_000 }, async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\\\n'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    descendant.stdout.once("data", () => process.stdout.write(String(descendant.pid) + "\\n"));
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const leader = spawnOwnedProcess(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>((resolveClose) => leader.once("close", () => resolveClose()));
  const descendantPid = await new Promise<number>((resolvePid, reject) => {
    let stdout = "";
    leader.once("error", reject);
    leader.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split("\n")[0];
      if (/^[0-9]+$/.test(line)) resolvePid(Number(line));
    });
  });
  assert.equal(processExists(descendantPid), true);
  const terminated = terminateOwnedProcess(leader, 100);
  await closed;
  await terminated;
  const deadline = Date.now() + 2_000;
  while (processExists(descendantPid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(processExists(descendantPid), false, "hard escalation left the descendant process alive");
});

test("owned process finalization reaps descendants after a successful leader exit", { skip: process.platform === "win32", timeout: 5_000 }, async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    descendant.unref();
    process.stdout.write(String(descendant.pid) + "\\n");
  `;
  const leader = spawnOwnedProcess(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>((resolveClose) => leader.once("close", () => resolveClose()));
  const descendantPid = await new Promise<number>((resolvePid, reject) => {
    let stdout = "";
    leader.once("error", reject);
    leader.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split("\n")[0];
      if (/^[0-9]+$/.test(line)) resolvePid(Number(line));
    });
  });
  await closed;
  assert.equal(processExists(descendantPid), true);
  await waitForOwnedProcessTermination(leader);
  assert.equal(processExists(descendantPid), false, "successful leader exit left its descendant alive");
});
