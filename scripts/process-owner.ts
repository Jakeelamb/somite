import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const active = new Set<ChildProcess>();
const escalation = new WeakMap<ChildProcess, Promise<void>>();
let interruptedBy: NodeJS.Signals | undefined;

function signalTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.unref();
    } else child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function ownedTreeExists(child: ChildProcess) {
  if (!child.pid) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export function terminateOwnedProcess(child: ChildProcess, graceMs = 5_000) {
  const pending = escalation.get(child);
  if (pending) return pending;
  const completed = (async () => {
    try {
      try { signalTree(child, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      const deadline = Date.now() + Math.max(0, graceMs);
      while (ownedTreeExists(child) && Date.now() < deadline) {
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      }
      if (ownedTreeExists(child)) {
        try { signalTree(child, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        const hardDeadline = Date.now() + 1_000;
        while (ownedTreeExists(child) && Date.now() < hardDeadline) await delay(10);
        if (ownedTreeExists(child)) throw new Error(`owned process group ${child.pid} survived SIGKILL`);
      }
    } finally {
      active.delete(child);
    }
  })();
  escalation.set(child, completed);
  return completed;
}

export function waitForOwnedProcessTermination(child: ChildProcess) {
  const pending = escalation.get(child);
  if (pending) return pending;
  if (ownedTreeExists(child)) return terminateOwnedProcess(child);
  active.delete(child);
  return Promise.resolve();
}

function interrupt(signal: NodeJS.Signals) {
  if (interruptedBy) return;
  interruptedBy = signal;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  for (const child of active) terminateOwnedProcess(child);
}

process.once("SIGINT", () => interrupt("SIGINT"));
process.once("SIGTERM", () => interrupt("SIGTERM"));

export function throwIfProcessInterrupted() {
  if (interruptedBy) throw new Error(`operation interrupted by ${interruptedBy}`);
}

export function spawnOwnedProcess(command: string, args: readonly string[], options: SpawnOptions) {
  throwIfProcessInterrupted();
  const child = spawn(command, [...args], {
    ...options,
    detached: process.platform !== "win32",
    shell: false,
  });
  active.add(child);
  child.once("error", () => {
    if (!child.pid) active.delete(child);
  });
  return child;
}
