import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SOMITE_VERSION } from "@somite/workflow/version";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function reservePort() {
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

async function stopLauncher(child: ChildProcess, closed: Promise<unknown>) {
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

test("the documented npm launcher serves production and stops its complete process tree", { timeout: 60_000 }, async (context) => {
  assert.notEqual(process.platform, "win32", "the release smoke runs on supported POSIX hosts");
  const buildId = join(repositoryRoot, "web", "dist", "server", "BUILD_ID");
  const before = await stat(buildId).catch(() => undefined);
  assert.ok(before?.isFile(), "run npm run build before the production launcher smoke");
  const beforeIdentity = await readFile(buildId, "utf8");
  const projectRoot = await mkdtemp(join(tmpdir(), "somite-production-smoke-"));
  const [webPort, runnerPort] = await Promise.all([reservePort(), reservePort()]);
  assert.notEqual(webPort, runnerPort);

  let output = "";
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["start"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PORT: String(webPort),
      SOMITE_PORT: String(runnerPort),
      SOMITE_HOST: "127.0.0.1",
      SOMITE_PROJECT_ROOT: projectRoot,
      SOMITE_ALLOWED_ORIGIN: `http://localhost:${webPort}`,
      NEXT_PUBLIC_SOMITE_SERVER: `http://127.0.0.1:${runnerPort}`,
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

  context.after(async () => {
    await stopLauncher(child, closed).catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  });

  try {
    const deadline = Date.now() + 30_000;
    const [runnerResponse, webResponse] = await Promise.race([
      Promise.all([
        eventuallyFetch(`http://127.0.0.1:${runnerPort}/api/health`, deadline),
        eventuallyFetch(`http://127.0.0.1:${webPort}/`, deadline),
      ]),
      closed.then(({ code, signal }) => Promise.reject(new Error(`production launcher exited during startup (${code ?? signal ?? "unknown status"})`))),
    ]);
    const runner = await runnerResponse.json() as { ok?: boolean; runtime?: string };
    assert.deepEqual(runner, { ok: true, runtime: "typescript", version: SOMITE_VERSION });
    const html = await webResponse.text();
    assert.match(html, /Somite/);
    assert.doesNotMatch(output, /vinext build/);
    assert.equal(await readFile(buildId, "utf8"), beforeIdentity);
    assert.ok((await stat(join(projectRoot, ".somite"))).isDirectory());
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLauncher output:\n${output}`);
  }

  await stopLauncher(child, closed);
  assert.ok(child.exitCode !== null || child.signalCode !== null, `production launcher did not stop\n${output}`);
  await assert.rejects(fetch(`http://127.0.0.1:${runnerPort}/api/health`));
  await assert.rejects(fetch(`http://127.0.0.1:${webPort}/`));
});
