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

test("server-renders the Somite web shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Somite — Visual Bioinformatics<\/title>/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Starter Project/i);
});

test("starter preview is removed and the real canvas is wired", async () => {
  const [page, app, panels, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/SomiteApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/WorkspacePanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<SomiteApp initialQuery=/);
  assert.match(app, /ReactFlowProvider/);
  assert.match(app, /api\/graph\/validate/);
  assert.match(app, /api\/run/);
  assert.match(app, /api\/paper/);
  assert.match(app, /api\/papers\/biorxiv\/reconstruct/);
  assert.match(app, /panActivationKeyCode="Space"/);
  assert.match(app, /pairedCompanion/);
  assert.match(app, /onConnectEnd=/);
  assert.match(app, /ContinuationContext/);
  assert.match(app, /focusPaperEvidence/);
  assert.match(app, /api\/agent\/events/);
  assert.match(app, /api\/readiness/);
  assert.match(app, /api\/agent\/discover/);
  assert.match(app, /api\/agent\/config/);
  assert.match(app, /api\/workflows\/snakemake\/import/);
  assert.match(app, /unseenAgentTransactions/);
  assert.match(panels, /Compatible Tools/);
  assert.match(panels, /Choose your Agent/);
  assert.match(panels, /More agents/);
  assert.match(panels, /Open a local project/);
  assert.match(panels, /Search tools, data, workflows/);
  assert.match(panels, /Search bioRxiv/);
  assert.match(panels, /onDrop=\{handlePaperDrop\}/);
  assert.match(panels, /Drop one PDF or text file/);
  assert.match(panels, /Preprint · not peer reviewed/);
  assert.match(panels, /Use ready workflow on the canvas/);
  assert.match(panels, /Add draft to canvas/);
  assert.match(panels, /Browse Nextflow workflows/);
  assert.match(panels, /Search by organism, name, or accession/);
  assert.match(panels, /filter\(\(operator\) => !isSource\(operator\)\)/);
  assert.doesNotMatch(panels, /Library Modes|Quick Add|Workflow Engines|Open a local Snakemake project/);
  assert.match(app, /className="canvas-toolbar"/);
  assert.match(app, /agent-edge-launcher/);
  assert.match(app, /CanvasAnnotations/);
  assert.match(app, /Sticky Note Tool/);
  assert.match(app, /Pen Tool/);
  assert.doesNotMatch(app, /Open Workflow Agent|title="Workflow Agent"/);
  assert.match(app, /aria-label="Workflow name"/);
  assert.match(app, /ReadinessPanel/);
  assert.match(panels, /deterministic checks/);
  assert.match(panels, /Ask Agent/);
  assert.match(app, /maxLength=\{100\}/);
  assert.match(app, /Renamed workflow to/);
  assert.match(panels, /Show on canvas/);
  assert.match(app, /beforeunload/);
  assert.match(app, /aria-live="polite"/);
  assert.match(css, /\.app-shell/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(packageJson, /"@xyflow\/react"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
