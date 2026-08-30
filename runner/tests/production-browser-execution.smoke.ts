import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";
import { repositoryRoot, startProductionApp } from "./helpers/productionApp.ts";
import { systemBrowserExecutable } from "./helpers/systemBrowser.ts";

test("production browser crosses real validation, run, evidence, and export HTTP boundaries", { timeout: 20 * 60_000 }, async () => {
  assert.notEqual(process.platform, "win32", "the real browser execution smoke requires a supported POSIX host");
  const projectRoot = await mkdtemp(join(tmpdir(), "somite-browser-execution-smoke-"));
  let app: Awaited<ReturnType<typeof startProductionApp>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(join(projectRoot, "testdata"));
    await copyFile(join(repositoryRoot, "testdata", "fastq_to_fastqc.somite.json"), join(projectRoot, "workflow.somite.json"));
    await copyFile(join(repositoryRoot, "testdata", "tiny_R1.fastq"), join(projectRoot, "testdata", "tiny_R1.fastq"));
    app = await startProductionApp({ projectRoot, graph: "workflow.somite.json" });
    browser = await chromium.launch({ executablePath: await systemBrowserExecutable(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const emptyCatalog = JSON.stringify({ entries: [], cached: true });
    const catalogHeaders = {
      "access-control-allow-origin": app.webUrl,
      "content-type": "application/json",
    };
    await page.route(`${app.runnerUrl}/api/catalog/nfcore`, (route) => route.fulfill({ status: 200, headers: catalogHeaders, body: emptyCatalog }));
    await page.route(`${app.runnerUrl}/api/catalog/snakemake`, (route) => route.fulfill({ status: 200, headers: catalogHeaders, body: emptyCatalog }));

    await page.goto(app.webUrl);
    await page.locator(".react-flow__node").nth(1).waitFor();
    const validate = page.getByRole("button", { name: "Validate", exact: true });
    assert.equal(await validate.isEnabled(), true);
    await validate.click();
    await page.locator(".status-copy").getByText(/Validated with 1 fixture/).waitFor({ timeout: 15 * 60_000 });

    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.locator(".status-copy").getByText(/Run complete/).waitFor({ timeout: 15 * 60_000 });

    await page.getByRole("button", { name: "Export", exact: true }).click();
    const exportPanel = page.locator("section[aria-label='Environment and Export']");
    await exportPanel.getByText("Workflow setup is complete").waitFor();
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await exportPanel.getByRole("button", { name: /^Download / }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    assert.ok(downloadPath);
    const archive = await readFile(downloadPath);
    assert.ok(archive.byteLength > 1_000);
    assert.deepEqual([...archive.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

    const runRoot = join(projectRoot, ".somite", "runs");
    const runIds = (await readdir(runRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    assert.equal(runIds.length, 2);
    const markers = await Promise.all(runIds.map(async (runId) => JSON.parse(await readFile(join(runRoot, runId, "run-status.json"), "utf8")) as Record<string, unknown>));
    assert.ok(markers.every((marker) => marker.phase === "completed"));
    assert.equal(markers.filter((marker) => typeof marker.evidence_receipt_digest === "string").length, 1);
    assert.ok((await stat(join(projectRoot, ".somite", "evidence", "index.json"))).isFile());
    assert.deepEqual(pageErrors, [], `browser page errors:\n${pageErrors.join("\n")}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await app?.stop();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
