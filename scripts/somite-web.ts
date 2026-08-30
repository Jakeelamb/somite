import { spawn, type ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../runner/src/server.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const graph = process.argv[2];
const port = Number(process.env.SOMITE_PORT ?? 7310);
const host = process.env.SOMITE_HOST ?? "127.0.0.1";
const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host === "::1" ? "[::1]" : host;
const runnerUrl = `http://${connectHost}:${port}`;
const children = new Set<ChildProcess>();
let stopping = false;
let runningServer: Awaited<ReturnType<typeof startServer>> | undefined;
let shutdown: Promise<void> | undefined;

function launch(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const child = spawn(npm, args, {
    cwd: projectRoot,
    env: environment,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "inherit",
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function terminate(child: ChildProcess, hard = false) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, hard ? "SIGKILL" : "SIGINT"); } catch { child.kill(hard ? "SIGKILL" : "SIGINT"); }
}

function stop(code: number) {
  if (shutdown) return shutdown;
  stopping = true;
  process.exitCode = code;
  const activeChildren = [...children];
  for (const child of activeChildren) terminate(child);
  shutdown = (async () => {
    await runningServer?.close();
    await Promise.race([
      Promise.all(activeChildren.map((child) => child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise())))),
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 3_000)),
    ]);
    for (const child of activeChildren) terminate(child, true);
  })();
  return shutdown;
}

process.once("SIGINT", () => { void stop(130); });
process.once("SIGTERM", () => { void stop(143); });
if (process.platform !== "win32") process.once("SIGHUP", () => { void stop(129); });

try {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("SOMITE_PORT must be an integer from 1 to 65535");
  const modules = await lstat(join(projectRoot, "node_modules")).catch(() => undefined);
  if (!modules?.isDirectory()) throw new Error("Somite dependencies are missing. Run: npm ci");
  runningServer = await startServer({ projectRoot, ...(graph ? { graph } : {}), port, host });
  const web = launch(["run", "dev", "--workspace=somite-web"], {
    ...process.env,
    NEXT_PUBLIC_SOMITE_SERVER: process.env.NEXT_PUBLIC_SOMITE_SERVER ?? runnerUrl,
  });
  const result = await new Promise<number | null>((resolvePromise) => web.once("close", resolvePromise));
  if (!stopping && result !== 0) process.stderr.write(`Somite web app stopped${result === null ? "" : ` with exit ${result}`}\n`);
  await stop(result ?? 1);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await stop(1);
}
