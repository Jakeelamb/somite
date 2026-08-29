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
  const [page, app, panels, paperIntake, paperIntakeApi, paperReading, catalogExpansion, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/SomiteApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/WorkspacePanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/paperIntake.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/paperIntakeApi.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/paperReading.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/catalogExpansion.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<SomiteApp initialQuery=/);
  assert.match(app, /ReactFlowProvider/);
  assert.match(app, /api\/graph\/validate/);
  assert.match(app, /api\/run/);
  assert.match(app, /createPaperIntakeCoordinator/);
  assert.match(paperIntakeApi, /api\/papers\/uploads/);
  assert.match(paperIntakeApi, /api\/papers\/intakes/);
  assert.match(paperIntakeApi, /api\/papers\/biorxiv\/reconstruct/);
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
  assert.match(paperIntake, /previous\?\.controller\.abort/);
  assert.match(paperIntake, /normalizedPaperReview/);
  assert.match(panels, /The previous result remains below/);
  assert.match(panels, /Try again/);
  assert.match(panels, /paper-job-phase-announcement[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(panels, /paper-job-progress[^>]+role="progressbar"[^>]+aria-live="off"/);
  assert.match(panels, /<p aria-live="off">\{presentation\.detail\}<\/p>/);
  assert.doesNotMatch(panels, /role=\{presentation\.tone === "error" \? "alert" : "status"\}/);
  assert.match(panels, /window\.setInterval\(\(\) => setNowMs\(Date\.now\(\)\), 1_000\)/);
  assert.match(panels, /if \(nowMs - startedAtMs < 1_000\) return null/);
  assert.match(panels, /\{runningActivity && <PaperElapsed/);
  assert.match(panels, /intake\.activity\.status === "failed" && intake\.activity\.retryable/);
  assert.match(panels, /Retrying unchanged will not resolve this issue/);
  assert.match(panels, /paperIntakeIsBusy\(intake\.activity\)/);
  assert.match(panels, /Preprint · not peer reviewed/);
  assert.match(panels, /Use ready workflow on the canvas/);
  assert.match(panels, /Add draft to canvas/);
  assert.match(panels, /Methods not represented in this draft/);
  assert.match(panels, /Methods retained/);
  assert.match(panels, /No workflow identified/);
  assert.doesNotMatch(panels, /review\.outcome\.replaceAll\("_", " "\)/);
  assert.match(panels, /Paper reading/);
  assert.match(panels, /Native PDF text/);
  assert.match(panels, /Scanned PDF OCR/);
  assert.match(panels, /no agent required/);
  assert.match(paperReading, /Somite managed Pixi/);
  assert.match(paperReading, /Restart Somite to recheck/);
  assert.match(css, /\.paper-reading-guidance \{[^}]*font-size: 10px/);
  assert.match(css, /\.paper-reading-tools article p \{[^}]*font-size: 10px/);
  assert.match(css, /\.paper-job > p \{[^}]*font-size: 10px/);
  assert.match(css, /\.paper-job-actions button \{[^}]*font-size: 10px/);
  assert.match(panels, /Browse Nextflow workflows/);
  assert.match(panels, /catalogExpansion\?\.operatorId === operator\.id/);
  assert.match(catalogExpansion, /Building process graph…/);
  assert.match(panels, /role=\{activity\.phase === "failed" \? "alert" : "status"\}/);
  assert.match(panels, /aria-busy=\{activity\?\.phase === "resolving"\}/);
  assert.match(panels, /Try again/);
  assert.match(panels, /Dismiss/);
  assert.match(css, /\.catalog-expansion-feedback/);
  assert.match(app, /setCatalogExpansion\(\{ operatorId: operator\.id, title: operator\.title, phase: "resolving" \}\)/);
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
