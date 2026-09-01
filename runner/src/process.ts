import { spawn, type ChildProcess } from "node:child_process";

export type CapturedCommand = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

export type ProcessCompletion = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

export type ChildProcessOwner = {
  child?: ChildProcess;
};

const MAX_CAPTURE_BYTES = 512 * 1024;
const terminationTimers = new WeakMap<ChildProcess, ReturnType<typeof setTimeout>>();

/** Copy an inherited process environment while removing one owned namespace. */
export function withoutEnvironmentPrefix(
  environment: Readonly<NodeJS.ProcessEnv>,
  prefix: string,
): NodeJS.ProcessEnv {
  if (!prefix || /[^A-Za-z0-9_]/.test(prefix)) throw new Error("environment prefix must be a non-empty identifier");
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith(prefix)));
}

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

export async function runAbortableProcess(
  signal: AbortSignal,
  spawnProcess: () => ChildProcess,
  owner: ChildProcessOwner,
): Promise<ProcessCompletion> {
  if (signal.aborted) throw new Error("operation cancelled");
  const child = spawnProcess();
  owner.child = child;
  const completed = new Promise<ProcessCompletion>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, closeSignal) => resolvePromise({ code, signal: closeSignal }));
  });
  const cancel = () => terminateProcessTree(child);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return await completed;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (owner.child === child) owner.child = undefined;
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
  const lines = [result.stderr, result.stdout]
    .flatMap((stream) => stream.replaceAll("\r", "").split("\n"))
    .map((line) => line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?").trim())
    .filter(Boolean)
    .slice(-8);
  if (!lines.length) return `${command} exited with ${result.code ?? result.signal ?? "unknown status"}`;
  const detail = lines.join(" | ");
  return detail.length > 4_096 ? detail.slice(detail.length - 4_096) : detail;
}
