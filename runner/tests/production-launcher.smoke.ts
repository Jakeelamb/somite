import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { SOMITE_VERSION } from "@somite/workflow/version";
import { repositoryRoot, startProductionApp } from "./helpers/productionApp.ts";

test("the documented npm launcher serves production and stops its complete process tree", { timeout: 60_000 }, async (context) => {
  assert.notEqual(process.platform, "win32", "the release smoke runs on supported POSIX hosts");
  const buildId = join(repositoryRoot, "web", "dist", "server", "BUILD_ID");
  const before = await stat(buildId).catch(() => undefined);
  assert.ok(before?.isFile(), "run npm run build before the production launcher smoke");
  const beforeIdentity = await readFile(buildId, "utf8");
  const app = await startProductionApp();
  context.after(app.stop);

  try {
    const [runnerResponse, webResponse, sessionResponse] = await Promise.all([
      fetch(`${app.runnerUrl}/api/health`),
      fetch(`${app.webUrl}/`),
      fetch(`${app.runnerUrl}/api/session`),
    ]);
    const runner = await runnerResponse.json() as { ok?: boolean; runtime?: string };
    const session = await sessionResponse.json() as { graph_path?: string };
    assert.deepEqual(runner, { ok: true, runtime: "typescript", version: SOMITE_VERSION });
    assert.equal(session.graph_path, ".somite/web.somite.json");
    await assert.rejects(stat(join(app.projectRoot, "--production")), { code: "ENOENT" });
    const html = await webResponse.text();
    assert.match(html, /Somite/);
    assert.doesNotMatch(app.output(), /vinext build/);
    assert.equal(await readFile(buildId, "utf8"), beforeIdentity);
    assert.ok((await stat(join(app.projectRoot, ".somite"))).isDirectory());
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLauncher output:\n${app.output()}`);
  }

  await app.stop();
  assert.ok(app.child.exitCode !== null || app.child.signalCode !== null, `production launcher did not stop\n${app.output()}`);
  await assert.rejects(fetch(`${app.runnerUrl}/api/health`));
  await assert.rejects(fetch(`${app.webUrl}/`));
});
