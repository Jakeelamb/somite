import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { NfcoreGateway } from "../src/nfcoreGateway.ts";
import { nfcoreCatalogFixture, nfcoreSourceArchive } from "./helpers/nfcoreFixture.ts";
import { repositoryRoot, startProductionApp, type ProductionApp } from "./helpers/productionApp.ts";
import { systemBrowserExecutable } from "./helpers/systemBrowser.ts";

function cors(app: ProductionApp) {
  return {
    "access-control-allow-origin": app.webUrl,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  };
}

async function fulfillJson(route: Route, app: ProductionApp, value: unknown, status = 200) {
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: cors(app), body: "" });
    return;
  }
  await route.fulfill({ status, contentType: "application/json", headers: cors(app), body: JSON.stringify(value) });
}

function watchPage(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return () => assert.deepEqual(errors, [], `browser page errors:\n${errors.join("\n")}`);
}

async function emptyCatalogs(page: Page, app: ProductionApp) {
  await page.route(`${app.runnerUrl}/api/catalog/nfcore`, (route) => fulfillJson(route, app, { entries: [], cached: true }));
  await page.route(`${app.runnerUrl}/api/catalog/snakemake`, (route) => fulfillJson(route, app, { entries: [], cached: true }));
}

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch({ executablePath: await systemBrowserExecutable(), headless: true });
});

test.after(async () => {
  await browser.close();
});

test("production workbench persists its name, restores Agent controls, and adds searched public reads", { timeout: 60_000 }, async (context) => {
  const app = await startProductionApp();
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await emptyCatalogs(page, app);
  await page.route(`${app.runnerUrl}/api/agent/discover`, (route) => fulfillJson(route, app, {
    registry_url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
    registry_status: "unavailable",
    agents: [],
  }));
  await page.route(`${app.runnerUrl}/api/sources/search?*`, async (route) => {
    const provider = new URL(route.request().url()).searchParams.get("provider");
    await fulfillJson(route, app, provider === "ncbi" ? {
      query: "SRR123456",
      provider: "ncbi",
      results: [{
        key: "ncbi-srr123456",
        title: "Axolotl demonstration reads",
        accession: "SRR123456",
        description: "Paired public reads",
        provider: "NCBI SRA",
        data_kind: "reads",
        tags: ["paired", "public"],
        request: {
          kind: "sra",
          value: "SRR123456",
          provider: "NCBI SRA",
          result: "SRA download → separate R1 / R2 FASTQ streams",
          action: "Add Reads",
        },
      }],
    } : { query: "SRR123456", provider: "ensembl", results: [] });
  });

  await page.goto(app.webUrl);
  const workflowName = page.getByRole("textbox", { name: "Workflow name" });
  await workflowName.waitFor();
  await workflowName.fill("Axolotl read QC");
  await workflowName.press("Enter");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
  await page.reload();
  await assert.doesNotReject(async () => assert.equal(await workflowName.inputValue(), "Axolotl read QC"));

  await page.getByRole("button", { name: "Open Agent" }).click();
  const agent = page.locator("section[aria-label='Agent']");
  await agent.waitFor();
  await page.getByRole("button", { name: "Collapse Agent" }).click();
  await assert.doesNotReject(async () => assert.match(await agent.getAttribute("class") ?? "", /collapsed/));
  await page.getByRole("button", { name: "Expand Agent" }).click();
  await page.getByRole("button", { name: "Close Agent" }).click();
  await page.getByRole("button", { name: "Open Agent" }).waitFor();
  await page.getByRole("button", { name: "Open Agent" }).click();
  await agent.waitFor();
  await agent.getByRole("button", { name: /More agents/ }).click();
  await agent.getByText("Connection details", { exact: true }).click();
  const fakeAgent = join(repositoryRoot, "runner", "tests", "fixtures", "fake-acp-agent.ts");
  await agent.getByLabel("Custom command").fill(`${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fakeAgent)}`);
  await agent.getByRole("button", { name: "Connect", exact: true }).click();
  const message = agent.getByRole("textbox", { name: "Message Agent" });
  await message.click({ trial: true, timeout: 30_000 });
  assert.equal(await message.isEnabled(), true);
  await page.getByRole("button", { name: "Agent settings" }).click();
  await agent.getByLabel("Model").selectOption("deep");
  await message.fill("Explain this workflow");
  await agent.getByRole("button", { name: "Send to Agent" }).click();
  const feed = agent.getByRole("log");
  await feed.getByText(/client-version:0\.1\.0/).waitFor({ timeout: 30_000 });
  await feed.getByText(/approved:allow-session/).waitFor({ timeout: 30_000 });
  await agent.getByRole("button", { name: "Disconnect Somite Test Agent" }).click();
  await agent.getByText("Choose an assistant", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close Agent" }).click();

  const library = page.locator("section[aria-label='Operator Library']");
  if (!await library.isVisible()) await page.getByRole("button", { name: "Add to Canvas" }).click();
  await page.getByRole("textbox", { name: "Search everything" }).fill("SRR123456");
  await page.getByRole("option", { name: /Axolotl demonstration reads/ }).click();
  await page.locator(".react-flow__node").nth(1).waitFor();
  assert.equal(await page.locator(".react-flow__node").count(), 2);
  await page.locator(".node-operator", { hasText: "sra.prefetch" }).waitFor();
  await page.locator(".node-operator", { hasText: "sra.fasterq_dump" }).waitFor();
  await page.getByLabel("Import local files").setInputFiles(join(repositoryRoot, "testdata", "tiny_R1.fastq"));
  await page.locator(".react-flow__node").nth(2).waitFor();
  assert.equal(await page.locator(".react-flow__node").count(), 3);
  await page.locator(".node-operator", { hasText: "files.import" }).waitFor();
  assertNoPageErrors();
});

test("production Nextflow catalog selection resolves into visible editable nodes", { timeout: 60_000 }, async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "somite-browser-nextflow-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const gateway = new NfcoreGateway(projectRoot, catalog, async (input) => String(input).includes("pipelines.json")
    ? new Response(nfcoreCatalogFixture, { headers: { "content-type": "application/json" } })
    : new Response(nfcoreSourceArchive(), { headers: { "content-type": "application/gzip" } }));
  const discovery = await gateway.catalog();
  const imported = await gateway.import("nf-core/demo", "1.0.0");
  const app = await startProductionApp({ projectRoot });
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await page.route(`${app.runnerUrl}/api/catalog/nfcore`, (route) => fulfillJson(route, app, discovery));
  await page.route(`${app.runnerUrl}/api/catalog/nfcore/expand`, (route) => fulfillJson(route, app, imported));
  await page.route(`${app.runnerUrl}/api/catalog/snakemake`, (route) => fulfillJson(route, app, { entries: [], cached: true }));

  await page.goto(app.webUrl);
  await page.getByRole("textbox", { name: "Workflow name" }).waitFor();
  await page.getByRole("button", { name: /Browse Nextflow workflows/ }).click();
  await page.locator("button.operator-add", { hasText: "nf-core/demo" }).click();
  const sourceNode = page.locator(".source-workflow-node");
  await sourceNode.waitFor();
  assert.equal(await page.locator(".react-flow__node").count(), 1);
  await sourceNode.dblclick();
  const nested = page.locator("section[aria-label='Nested source canvas']");
  await nested.waitFor();
  const nestedText = await nested.textContent();
  assert.match(nestedText ?? "", /FASTQC/i);
  assert.match(nestedText ?? "", /Source invocations · not data wires/);
  assertNoPageErrors();
});

test("a real paper drop reports progress, installs its draft, and offers the typed Kraken database input", { timeout: 60_000 }, async (context) => {
  const app = await startProductionApp();
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await emptyCatalogs(page, app);
  await page.goto(app.webUrl);
  await page.getByRole("textbox", { name: "Workflow name" }).waitFor();
  await page.getByRole("button", { name: "Rebuild from a Paper" }).click();
  const panel = page.locator("section[aria-label='Paper Reconstruction']");
  await panel.waitFor();
  const methods = await readFile(join(repositoryRoot, "testdata", "papers", "kraken2_methods.txt"), "utf8");
  await panel.evaluate((element, contents) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([contents], "kraken2_methods.txt", { type: "text/plain" }));
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, methods);
  await panel.getByRole("button", { name: "Add draft to canvas" }).waitFor({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Add draft to canvas" }).click();
  await page.getByRole("button", { name: "Close Paper Reconstruction" }).click();
  await page.locator(".node-operator", { hasText: "class.kraken2" }).waitFor();

  await page.locator("footer .readiness-status").click();
  const readiness = page.locator("section[aria-label='Workflow Readiness']");
  await readiness.waitFor();
  let chooseExisting = readiness.getByRole("button", { name: "Choose existing" });
  if (!await chooseExisting.isVisible()) {
    const steps = readiness.getByRole("button", { name: /Go to readiness step/ });
    for (let index = 0; index < await steps.count(); index += 1) {
      await steps.nth(index).click();
      if (await chooseExisting.isVisible()) break;
    }
  }
  await chooseExisting.click();
  await page.locator(".node-operator", { hasText: "files.import_kraken2_database" }).waitFor();
  assertNoPageErrors();
});

test("production controls complete validation, run, and bundle download journeys", { timeout: 90_000 }, async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "somite-browser-workflow-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "testdata"));
  await copyFile(join(repositoryRoot, "testdata", "fastq_to_fastqc.somite.json"), join(projectRoot, "workflow.somite.json"));
  await copyFile(join(repositoryRoot, "testdata", "tiny_R1.fastq"), join(projectRoot, "testdata", "tiny_R1.fastq"));
  const app = await startProductionApp({ projectRoot, graph: "workflow.somite.json" });
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await emptyCatalogs(page, app);
  await page.route(`${app.runnerUrl}/api/validations`, (route) => fulfillJson(route, app, { run_id: "browser-validation" }, 202));
  await page.route(`${app.runnerUrl}/api/runs`, (route) => fulfillJson(route, app, { run_id: "browser-run" }, 202));
  await page.route(`${app.runnerUrl}/api/runs/*`, (route) => {
    const id = route.request().url().endsWith("browser-validation") ? "browser-validation" : "browser-run";
    return fulfillJson(route, app, {
      run_id: id,
      phase: "completed",
      states: { import1: "done", fastqc1: "done" },
      exit_code: 0,
      ...(id === "browser-validation" ? { evidence_receipt: { result: "passed", scope: "representative", fixture_digests: ["blake3:browser"] } } : {}),
    });
  });
  let exportRequests = 0;
  await page.route(`${app.runnerUrl}/api/export`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors(app), body: "" });
      return;
    }
    exportRequests += 1;
    await route.fulfill({ status: 200, headers: { ...cors(app), "content-type": "application/zip" }, body: Buffer.from("PK\u0003\u0004somite-browser-bundle") });
  });

  await page.goto(app.webUrl);
  await page.locator(".react-flow__node").nth(1).waitFor();
  const validate = page.getByRole("button", { name: "Validate", exact: true });
  assert.equal(await validate.isEnabled(), true);
  await validate.click();
  await page.locator(".status-copy").getByText(/Validated with 1 fixture/).waitFor();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator(".status-copy").getByText(/Run complete · 2 done/).waitFor();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const exportPanel = page.locator("section[aria-label='Environment and Export']");
  await exportPanel.getByText("Workflow setup is complete").waitFor();
  const downloadPromise = page.waitForEvent("download", { timeout: 5_000 }).catch(() => null);
  await exportPanel.getByRole("button", { name: /^Download / }).click();
  await page.waitForTimeout(1_000);
  const exportStatus = await page.locator(".status-copy").textContent();
  assert.match(exportStatus ?? "", /^Exported /, `export requests: ${exportRequests}`);
  const download = await downloadPromise;
  assert.ok(download, `browser did not begin the exported download; status=${exportStatus}; requests=${exportRequests}`);
  const downloadPath = await download.path();
  assert.ok(downloadPath);
  assert.ok((await stat(downloadPath)).size > 4);
  await page.locator(".status-copy").getByText(/Exported .*\.somite-run\.zip/).waitFor();
  assertNoPageErrors();
});
