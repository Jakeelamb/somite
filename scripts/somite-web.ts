import { spawn, type ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../runner/src/server.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsList = process.argv.slice(2);
const production = argumentsList[0] === "--production";
if (production) argumentsList.shift();
const invalidArguments = argumentsList.length > 1 || argumentsList[0]?.startsWith("--");
const graph = argumentsList[0];
const workspaceRoot = resolve(process.env.SOMITE_PROJECT_ROOT ?? projectRoot);
const port = Number(process.env.SOMITE_PORT ?? 7310);
const host = process.env.SOMITE_HOST ?? "127.0.0.1";
const webPort = Number(process.env.PORT ?? 3000);
const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host === "::1" ? "[::1]" : host;
const runnerUrl = `http://${connectHost}:${port}`;
const children = new Set<ChildProcess>();
let stopping = false;
let runningServer: Awaited<ReturnType<typeof startServer>> | undefined;
let shutdown: Promise<void> | undefined;

async function resolveVinextCli() {
  for (const modules of [join(projectRoot, "web", "node_modules"), join(projectRoot, "node_modules")]) {
    const candidate = join(modules, "vinext", "dist", "cli.js");
    if ((await lstat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  throw new Error("Somite's web runtime is missing. Run: npm ci");
}

function launchWeb(vinext: string, args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const child = spawn(process.execPath, [vinext, ...args], {
    cwd: join(projectRoot, "web"),
    env: environment,
    detached: false,
    windowsHide: true,
    stdio: "inherit",
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function terminate(child: ChildProcess, hard = false) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(hard ? "SIGKILL" : "SIGINT");
}

function stop(code: number) {
  if (shutdown) return shutdown;
  stopping = true;
  process.exitCode = code;
  const activeChildren = [...children];
  for (const child of activeChildren) terminate(child);
  shutdown = (async () => {
    await runningServer?.close();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(activeChildren.map((child) => child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise())))),
        new Promise<void>((resolvePromise) => { timeout = setTimeout(resolvePromise, 3_000); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    for (const child of activeChildren) terminate(child, true);
  })();
  return shutdown;
}

process.once("SIGINT", () => { void stop(130); });
process.once("SIGTERM", () => { void stop(143); });
if (process.platform !== "win32") process.once("SIGHUP", () => { void stop(129); });

try {
  if (invalidArguments) throw new Error(`Usage: npm ${production ? "start" : "run dev"} -- [workflow.somite.json]`);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("SOMITE_PORT must be an integer from 1 to 65535");
  if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error("PORT must be an integer from 1 to 65535");
  const modules = await lstat(join(projectRoot, "node_modules")).catch(() => undefined);
  if (!modules?.isDirectory()) throw new Error("Somite dependencies are missing. Run: npm ci");
  if (production) {
    const build = await lstat(join(projectRoot, "web", "dist", "server", "BUILD_ID")).catch(() => undefined);
    if (!build?.isFile()) throw new Error("Somite's production web bundle is missing. Run: npm run build");
  }
  runningServer = await startServer({
    projectRoot: workspaceRoot,
    ...(graph ? { graph } : {}),
    port,
    host,
    allowedOrigin: process.env.SOMITE_ALLOWED_ORIGIN ?? `http://localhost:${webPort}`,
  });
  const vinext = await resolveVinextCli();
  const web = launchWeb(vinext, production
    ? ["start", "--hostname", "127.0.0.1"]
    : ["dev"], {
    ...process.env,
    SOMITE_SERVER_URL: process.env.SOMITE_SERVER_URL ?? runnerUrl,
    NEXT_PUBLIC_SOMITE_SERVER: process.env.NEXT_PUBLIC_SOMITE_SERVER ?? runnerUrl,
  });
  const result = await new Promise<number | null>((resolvePromise) => web.once("close", resolvePromise));
  if (!stopping && result !== 0) process.stderr.write(`Somite web app stopped${result === null ? "" : ` with exit ${result}`}\n`);
  await stop(result ?? 1);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await stop(1);
}
