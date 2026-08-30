import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

export async function reserveLocalPort() {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a local port");
  await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return address.port;
}

async function eventuallyFetch(url: string, deadline: number) {
  let detail = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      detail = `${response.status} ${response.statusText}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${url} did not become ready: ${detail}`);
}

function closeResult(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function stopProcessTree(child: ChildProcess, closed: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid!, "SIGINT"); } catch { child.kill("SIGINT"); }
  }
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    closed,
    new Promise<void>((resolvePromise) => {
      timeout = setTimeout(resolvePromise, 10_000);
      timeout.unref();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

export type ProductionApp = {
  child: ChildProcess;
  projectRoot: string;
  runnerUrl: string;
  webUrl: string;
  output: () => string;
  stop: () => Promise<void>;
};

export async function startProductionApp(options: {
  graph?: string;
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<ProductionApp> {
  if (process.platform === "win32") throw new Error("the production application helper requires a supported POSIX host");
  const ownsProjectRoot = !options.projectRoot;
  const projectRoot = options.projectRoot ?? await mkdtemp(join(tmpdir(), "somite-production-test-"));
  const [webPort, runnerPort] = await Promise.all([reserveLocalPort(), reserveLocalPort()]);
  if (webPort === runnerPort) throw new Error("web and runner ports must differ");
  const webUrl = `http://localhost:${webPort}`;
  const runnerUrl = `http://127.0.0.1:${runnerPort}`;
  let output = "";
  const child = spawn("npm", ["start", ...(options.graph ? ["--", options.graph] : [])], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...options.environment,
      PORT: String(webPort),
      SOMITE_PORT: String(runnerPort),
      SOMITE_HOST: "127.0.0.1",
      SOMITE_PROJECT_ROOT: projectRoot,
      SOMITE_ALLOWED_ORIGIN: webUrl,
      SOMITE_SERVER_URL: runnerUrl,
      NEXT_PUBLIC_SOMITE_SERVER: runnerUrl,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = closeResult(child);
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-32_768);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const stop = async () => {
    await stopProcessTree(child, closed).catch(() => undefined);
    if (ownsProjectRoot) await rm(projectRoot, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    await Promise.race([
      Promise.all([
        eventuallyFetch(`${runnerUrl}/api/health`, deadline),
        eventuallyFetch(`${webUrl}/`, deadline),
      ]),
      closed.then(({ code, signal }) => Promise.reject(new Error(`production launcher exited during startup (${code ?? signal ?? "unknown status"})`))),
    ]);
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLauncher output:\n${output}`);
  }

  return { child, projectRoot, runnerUrl, webUrl, output: () => output, stop };
}
