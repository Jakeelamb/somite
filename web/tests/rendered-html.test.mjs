import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Axial web shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Axial — Visual Bioinformatics<\/title>/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Starter Project/i);
});

test("starter preview is removed and the real canvas is wired", async () => {
  const [page, app, panels, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AxialApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/WorkspacePanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<AxialApp initialQuery=/);
  assert.match(app, /ReactFlowProvider/);
  assert.match(app, /api\/graph\/validate/);
  assert.match(app, /api\/run/);
  assert.match(app, /api\/paper/);
  assert.match(app, /panActivationKeyCode="Space"/);
  assert.match(app, /pairedCompanion/);
  assert.match(app, /onConnectEnd=/);
  assert.match(app, /ContinuationContext/);
  assert.match(app, /focusPaperEvidence/);
  assert.match(panels, /Compatible Tools/);
  assert.match(panels, /Show .* on canvas/);
  assert.match(app, /beforeunload/);
  assert.match(app, /aria-live="polite"/);
  assert.match(css, /\.app-shell/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(packageJson, /"@xyflow\/react"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
