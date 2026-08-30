import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { InputOrigins } from "../src/inputOrigins.ts";
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

async function inputOriginRecoveryFixture(prefix: string) {
  const projectRoot = await mkdtemp(join(tmpdir(), `somite-browser-${prefix}-`));
  const externalRoot = await mkdtemp(join(tmpdir(), `somite-browser-${prefix}-external-`));
  const graphPath = join(projectRoot, "saved.somite.json");
  const autosavePath = join(projectRoot, "saved.somite.autosave.somite.json");
  const originalPath = join(externalRoot, "original.somite.json");
  const saved = { schema_version: 3 as const, name: "Saved workflow", nodes: [], edges: [] };
  const recovered = { schema_version: 3 as const, name: "Recovered canvas", nodes: [], edges: [] };
  await writeFile(graphPath, `${JSON.stringify(saved, null, 2)}\n`);
  await writeFile(autosavePath, `${JSON.stringify(recovered, null, 2)}\n`);
  await writeFile(originalPath, `${JSON.stringify({ ...saved, name: "Original file contents" }, null, 2)}\n`);
  const origins = await InputOrigins.open(projectRoot, graphPath, projectRoot, saved);
  const externalId = await origins.registerOpenedGraph(externalRoot);
  await origins.record(externalId, saved);
  return { projectRoot, externalRoot, graphPath, originalPath };
}

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch({ executablePath: await systemBrowserExecutable(), headless: true });
});

test.after(async () => {
  await browser.close();
});

test("production workbench persists its name, applies one undoable Agent MCP edit, and adds searched public reads", { timeout: 90_000 }, async (context) => {
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
  await message.fill("[test:mcp-canvas-transaction]");
  await agent.getByRole("button", { name: "Send to Agent" }).click();
  const agentFastqc = page.locator(".react-flow__node", { has: page.locator(".node-operator", { hasText: "qc.fastqc" }) });
  await agentFastqc.waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".react-flow__node").count(), 1);
  await page.locator(".status-copy").getByText(/Agent applied .+Add a reviewed FastQC step.+Undo available/).waitFor();
  assert.equal(await feed.locator(".agent-event.transaction").count(), 1);
  await feed.locator(".agent-event.transaction").getByText("Saved as one undoable canvas change.", { exact: true }).waitFor();
  const activity = feed.locator("details.agent-activity");
  await activity.locator("summary").click();
  await activity.locator("li", { hasText: "mcp.Somite.somite.workflow.get" }).last().waitFor();
  await activity.locator("li", { hasText: "mcp.Somite.somite.graph.apply_transaction" }).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await agentFastqc.waitFor({ state: "detached" });
  assert.equal(await page.locator(".react-flow__node").count(), 0);
  await page.locator(".status-copy").getByText("Undid edit", { exact: true }).waitFor();
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
  const library = page.locator("section[aria-label='Operator Library']");
  if (!await library.isVisible()) await page.getByRole("button", { name: "Add to Canvas" }).click();
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

test("production project controls render a local Snakemake graph and explain a failed environment", { timeout: 60_000, skip: process.platform === "win32" }, async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "somite-browser-snakemake-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const broken = join(projectRoot, "broken");
  const working = join(projectRoot, "working");
  for (const project of [broken, working]) {
    const bin = join(project, ".pixi", "envs", "default", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(project, "Snakefile"), "rule all:\n    input: 'prepared.txt'\n");
    await writeFile(join(project, "pixi.lock"), "browser fixture\n");
  }
  const brokenPixi = join(broken, ".pixi", "envs", "default", "bin", "pixi");
  await writeFile(brokenPixi, "#!/bin/sh\nprintf '%s\\n' 'fixture environment is incomplete; run pixi install' >&2\nexit 17\n");
  await chmod(brokenPixi, 0o755);
  const workingPixi = join(working, ".pixi", "envs", "default", "bin", "pixi");
  await writeFile(workingPixi, [
    "#!/bin/sh",
    "test \"$1\" = run && test \"$2\" = snakemake && test \"$3\" = --snakefile || exit 64",
    "printf '%s\\n' 'digraph snakemake_dag {' '0[label = \"prepare\"];' '1[label = \"all\"];' '0 -> 1' '}'",
    "",
  ].join("\n"));
  await chmod(workingPixi, 0o755);

  const app = await startProductionApp({ projectRoot });
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await emptyCatalogs(page, app);

  await page.goto(app.webUrl);
  await page.getByRole("textbox", { name: "Workflow name" }).waitFor();
  await page.getByRole("button", { name: "Project", exact: true }).click();
  const panel = page.locator("section[aria-label='Project']");
  const path = panel.getByLabel("Local project folder or workflow file");
  await path.fill("broken");
  await panel.getByRole("button", { name: "Open project" }).click();
  await panel.getByRole("alert").getByText(/Snakemake project could not be visualized:.*run pixi install/).waitFor();
  assert.equal(await page.locator(".react-flow__node").count(), 0);

  await path.fill("working");
  await panel.getByRole("button", { name: "Open project" }).click();
  await page.locator(".react-flow__node").nth(1).waitFor();
  await page.locator(".react-flow__edge").waitFor({ state: "attached" });
  assert.equal(await page.locator(".react-flow__node").count(), 2);
  assert.equal(await page.locator(".react-flow__edge").count(), 1);
  await page.locator(".react-flow__node", { hasText: "prepare" }).waitFor();
  await page.locator(".react-flow__node", { hasText: "all" }).waitFor();
  assert.equal(await page.locator(".node-collapsed-body").count(), 2);
  await page.locator(".status-copy").getByText(/Opened working · Snakemake rules/).waitFor();
  assertNoPageErrors();
});

test("production recovery keeps the recovered canvas while rebinding its input location", { timeout: 90_000 }, async (context) => {
  const { projectRoot, externalRoot, graphPath, originalPath } = await inputOriginRecoveryFixture("origin-recovery");
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  context.after(() => rm(externalRoot, { recursive: true, force: true }));

  const app = await startProductionApp({ projectRoot, graph: "saved.somite.json" });
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await emptyCatalogs(page, app);
  let runRequests = 0;
  await page.route(`${app.runnerUrl}/api/runs`, async (route) => {
    runRequests += 1;
    await fulfillJson(route, app, { run_id: "unexpected-recovery-run" }, 202);
  });

  await page.goto(app.webUrl);
  const workflowName = page.getByRole("textbox", { name: "Workflow name" });
  await workflowName.waitFor();
  assert.equal(await workflowName.inputValue(), "Recovered canvas");
  const recovery = page.getByRole("alert").filter({ hasText: "Confirm where this workflow's files live" });
  await recovery.waitFor();
  for (const buttonName of ["Paused", "Export", "Validate", "Run"]) {
    assert.equal(await page.getByRole("button", { name: buttonName, exact: true }).isDisabled(), true, `${buttonName} should be blocked during recovery`);
  }
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await page.keyboard.press("F5");
  assert.equal(runRequests, 0);
  assert.equal(JSON.parse(await readFile(graphPath, "utf8")).name, "Saved workflow");

  await page.getByRole("button", { name: "Open Agent" }).click();
  const agent = page.locator("section[aria-label='Agent']");
  await agent.getByText("Canvas actions are paused", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close Agent" }).click();

  await recovery.getByRole("button", { name: "Choose original workflow" }).click();
  const project = page.locator("section[aria-label='Project']");
  await project.getByLabel("Original Somite workflow file").fill(originalPath);
  await project.getByRole("button", { name: "Use workflow location" }).click();
  await recovery.waitFor({ state: "detached" });
  assert.equal(await workflowName.inputValue(), "Recovered canvas", "rebinding must not replace the recovered canvas");
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
  assert.equal(JSON.parse(await readFile(graphPath, "utf8")).name, "Recovered canvas");
  assertNoPageErrors();
});

test("production recovery can explicitly adopt the current project folder", { timeout: 60_000 }, async (context) => {
  const { projectRoot, externalRoot, graphPath } = await inputOriginRecoveryFixture("origin-current-project");
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  context.after(() => rm(externalRoot, { recursive: true, force: true }));
  const app = await startProductionApp({ projectRoot, graph: "saved.somite.json" });
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await emptyCatalogs(page, app);

  await page.goto(app.webUrl);
  const workflowName = page.getByRole("textbox", { name: "Workflow name" });
  await workflowName.waitFor();
  assert.equal(await workflowName.inputValue(), "Recovered canvas");
  const recovery = page.getByRole("alert").filter({ hasText: "Confirm where this workflow's files live" });
  await recovery.getByRole("button", { name: "Use this project folder" }).click();
  await recovery.waitFor({ state: "detached" });
  assert.equal(await workflowName.inputValue(), "Recovered canvas");
  const save = page.getByRole("button", { name: "Save", exact: true });
  assert.equal(await save.isEnabled(), true);
  await save.click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
  assert.equal(JSON.parse(await readFile(graphPath, "utf8")).name, "Recovered canvas");
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
  await page.route(`${app.runnerUrl}/api/validations`, (route) => fulfillJson(route, app, { run_id: "browser-validation", phase: "preparing", replayed: false }, 202));
  await page.route(`${app.runnerUrl}/api/runs`, (route) => fulfillJson(route, app, { run_id: "browser-run", phase: "preparing", replayed: false }, 202));
  await page.route(`${app.runnerUrl}/api/runs/*`, (route) => {
    const id = route.request().url().endsWith("browser-validation") ? "browser-validation" : "browser-run";
    return fulfillJson(route, app, {
      run_id: id,
      phase: "completed",
      states: { import1: "done", fastqc1: "done" },
      progress: { completed: 2, total: 2, unit: "nodes", message: "Completed" },
      exit_code: 0,
      ...(id === "browser-validation" ? { evidence_receipt: {
        receipt_digest: "blake3:browser-receipt",
        recorded_at_unix_ms: 1,
        subject_digest: "blake3:browser-subject",
        kind: "representative_validation",
        scope: "representative",
        configuration_digest: "blake3:browser-configuration",
        fixture_digests: ["blake3:browser-fixture"],
        verifier: "somite-browser-test",
        result: "passed",
        node_results: { import1: "passed", fastqc1: "passed" },
        edge_results: { e1: "passed" },
        artifact_digests: [],
        log_digests: [],
      } } : {}),
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

test("production flagship canvas builds, annotates, saves, and restores a ready native workflow", { timeout: 90_000 }, async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "somite-browser-flagship-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "testdata"));
  await copyFile(join(repositoryRoot, "testdata", "tiny_R1.fastq"), join(projectRoot, "testdata", "tiny_R1.fastq"));
  const app = await startProductionApp({ projectRoot });
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await emptyCatalogs(page, app);

  await page.goto(app.webUrl);
  await page.getByRole("textbox", { name: "Workflow name" }).waitFor();
  const readiness = page.locator("footer .readiness-status");
  await readiness.filter({ hasText: "Start building" }).waitFor();

  const library = page.locator("section[aria-label='Operator Library']");
  await library.getByRole("button", { name: "Close Library" }).click();
  const pane = page.locator(".react-flow__pane");
  await page.getByLabel("Import local files").setInputFiles(join(repositoryRoot, "testdata", "tiny_R1.fastq"));
  const importNode = page.locator(".react-flow__node", { has: page.locator(".node-operator", { hasText: "files.import" }) });
  await importNode.waitFor();
  const inspector = page.locator("section[aria-label='Node Parameters']");
  const path = inspector.getByRole("textbox", { name: "Path" });
  await path.fill("");
  await inspector.getByRole("button", { name: "Close Parameters" }).click();
  await readiness.filter({ hasText: "Needs 1 item" }).waitFor();

  await pane.dblclick({ position: { x: 900, y: 360 } });
  const search = library.getByRole("textbox", { name: "Search everything" });
  await search.fill("FastQC");
  await library.locator("button.operator-add", { hasText: "FastQC" }).click();
  await library.getByRole("button", { name: "Close Library" }).click();

  const fastqcNode = page.locator(".react-flow__node", { has: page.locator(".node-operator", { hasText: "qc.fastqc" }) });
  await fastqcNode.waitFor();
  assert.equal(await page.locator(".react-flow__node").count(), 2);
  await readiness.filter({ hasText: "Needs 2 items" }).waitFor();

  await importNode.click();
  await path.fill("testdata/tiny_R1.fastq");
  assert.equal(await path.inputValue(), "testdata/tiny_R1.fastq");
  await inspector.getByRole("button", { name: "Close Parameters" }).click();
  await readiness.filter({ hasText: "Needs 1 item" }).waitFor();

  const outputHandle = importNode.locator(".react-flow__handle.source[data-handleid='file']");
  const inputHandle = fastqcNode.locator(".react-flow__handle.target[data-handleid='fastq']");
  const outputBox = await outputHandle.boundingBox();
  const inputBox = await inputHandle.boundingBox();
  assert.ok(outputBox, "files.import.file output handle should be visible");
  assert.ok(inputBox, "qc.fastqc.fastq input handle should be visible");
  await page.mouse.move(outputBox.x + outputBox.width / 2, outputBox.y + outputBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.locator(".react-flow__edge").waitFor({ state: "attached" });
  assert.equal(await page.locator(".react-flow__edge").count(), 1);
  await page.locator(".status-copy").getByText("Connected file to fastq", { exact: true }).waitFor();
  await readiness.filter({ hasText: "Ready" }).waitFor();

  await page.getByRole("button", { name: "Sticky Note Tool" }).click();
  await pane.click({ position: { x: 690, y: 650 } });
  const note = page.locator(".canvas-annotation.sticky");
  const noteText = page.getByRole("textbox", { name: "Sticky note note-1" });
  await noteText.fill("Review FastQC evidence");
  await page.getByRole("button", { name: "Use Analysis color" }).click();
  assert.equal(await note.getAttribute("data-color"), "violet");
  await readiness.filter({ hasText: "Ready" }).waitFor();

  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  await undo.click();
  assert.equal(await note.getAttribute("data-color"), "yellow");
  await redo.click();
  assert.equal(await note.getAttribute("data-color"), "violet");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
  await page.reload();
  await page.locator(".react-flow__node").nth(1).waitFor();
  assert.equal(await page.locator(".react-flow__node").count(), 2);
  assert.equal(await page.locator(".react-flow__edge").count(), 1);
  assert.equal(await page.getByRole("textbox", { name: "Sticky note note-1" }).inputValue(), "Review FastQC evidence");
  assert.equal(await page.locator(".canvas-annotation.sticky").getAttribute("data-color"), "violet");
  await page.locator(".react-flow__node", { has: page.locator(".node-operator", { hasText: "files.import" }) }).click();
  assert.equal(await page.locator("section[aria-label='Node Parameters']").getByRole("textbox", { name: "Path" }).inputValue(), "testdata/tiny_R1.fastq");
  await readiness.filter({ hasText: "Ready" }).waitFor();
  assertNoPageErrors();
});
