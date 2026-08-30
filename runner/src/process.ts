import { spawn, type ChildProcess } from "node:child_process";

export type CapturedCommand = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

const MAX_CAPTURE_BYTES = 512 * 1024;
const terminationTimers = new WeakMap<ChildProcess, ReturnType<typeof setTimeout>>();

function boundedAppend(current: string, chunk: Buffer, maximumBytes: number) {
  const next = current + chunk.toString("utf8");
  return next.length <= maximumBytes ? next : next.slice(next.length - maximumBytes);
}

export function terminateProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    if (terminationTimers.has(child)) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    const timer = setTimeout(() => {
      terminationTimers.delete(child);
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 3_000);
    terminationTimers.set(child, timer);
    child.once("close", () => {
      const pending = terminationTimers.get(child);
      if (pending) clearTimeout(pending);
      terminationTimers.delete(child);
    });
    timer.unref();
  }
}

export async function runCaptured(
  command: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  maximumBytes = MAX_CAPTURE_BYTES,
): Promise<CapturedCommand> {
  if (signal?.aborted) throw new Error("operation cancelled");
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk, maximumBytes); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk, maximumBytes); });
  const cancel = () => terminateProcessTree(child);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const completed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code, closeSignal) => resolvePromise({ code, signal: closeSignal }));
    });
    if (signal?.aborted) throw new Error("operation cancelled");
    return { ...completed, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function commandFailure(command: string, result: CapturedCommand) {
  const detail = result.stderr.split("\n").reverse().find((line) => line.trim())
    ?? result.stdout.split("\n").reverse().find((line) => line.trim())
    ?? `${command} exited with ${result.code ?? result.signal ?? "unknown status"}`;
  return detail.trim();
}
