import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { chromium, type Browser, type Locator, type Page, type Route } from "playwright-core";
import { operatorPorts } from "@somite/workflow/catalog";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import type { SomiteGraph } from "@somite/workflow/model";
import { InputOrigins } from "../src/inputOrigins.ts";
import { NfcoreGateway } from "../src/nfcoreGateway.ts";
import { nfcoreCatalogFixture, nfcoreGroupableSourceArchive } from "./helpers/nfcoreFixture.ts";
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

function watchPage(page: Page, allowedConsoleErrors: readonly RegExp[] = []) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() !== "error") return;
    const location = entry.location();
    const source = location.url ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})` : "";
    const message = `console: ${entry.text()}${source}`;
    if (!allowedConsoleErrors.some((pattern) => pattern.test(message))) errors.push(message);
  });
  return () => assert.deepEqual(errors, [], `browser page errors:\n${errors.join("\n")}`);
}

async function sourceEntityIds(canvas: Locator) {
  const entities = canvas.locator("[data-source-entity-id]");
  const ids = await Promise.all(Array.from({ length: await entities.count() }, (_, index) => entities.nth(index).getAttribute("data-source-entity-id")));
  assert.ok(ids.every((id): id is string => Boolean(id)), "every visible source entity has a stable identity");
  return ids.sort();
}

function sourceEntity(canvas: Locator, id: string) {
  return canvas.locator(`[data-source-entity-id=${JSON.stringify(id)}]`);
}

async function roundedSize(locator: Locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "source entity must have a visible bounding box");
  return { width: Math.round(box.width), height: Math.round(box.height) };
}

async function emptyCatalogs(page: Page, app: ProductionApp) {
  await page.route(`${app.runnerUrl}/api/catalog/nfcore`, (route) => fulfillJson(route, app, { entries: [], cached: true }));
  await page.route(`${app.runnerUrl}/api/catalog/snakemake`, (route) => fulfillJson(route, app, { entries: [], cached: true }));
}

async function openLibrary(page: Page) {
  const launcher = page.getByRole("button", { name: "Add to Canvas" });
  if (await launcher.getAttribute("aria-expanded") !== "true") await launcher.click();
  const library = page.locator("section[aria-label='Operator Library']");
  await library.waitFor();
  return library;
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
  const toolchainRoot = await mkdtemp(join(tmpdir(), "somite-browser-agent-toolchain-"));
  const toolchainBin = join(toolchainRoot, "bin");
  await mkdir(toolchainBin);
  const pixi = join(toolchainBin, "pixi");
  const nextflow = join(toolchainBin, "nextflow");
  await Promise.all([
    writeFile(pixi, "#!/bin/sh\n[ \"$#\" -eq 1 ] && [ \"$1\" = \"--version\" ] || exit 64\nprintf '%s\\n' 'pixi 0.77.1'\n"),
    writeFile(nextflow, "#!/bin/sh\n[ \"$#\" -eq 1 ] && [ \"$1\" = \"-version\" ] || exit 64\nprintf '%s\\n' 'nextflow version 26.04.6'\n"),
  ]);
  await Promise.all([chmod(pixi, 0o755), chmod(nextflow, 0o755)]);
  const app = await startProductionApp({
    environment: { PATH: `${toolchainBin}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ""}` },
  }).catch(async (cause) => {
    await rm(toolchainRoot, { recursive: true, force: true });
    throw cause;
  });
  context.after(async () => {
    await app.stop();
    await rm(toolchainRoot, { recursive: true, force: true });
  });
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
          read_layout: "paired",
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
  await message.fill("[test:cross-server-agent-ladder]");
  await agent.getByRole("button", { name: "Send to Agent" }).click();
  const ladderMessage = feed.getByText(/cross-server-ladder:/);
  await ladderMessage.waitFor({ timeout: 30_000 });
  const ladderText = await ladderMessage.textContent();
  assert.match(ladderText ?? "", /"pixi":\{"observed_version":"[^"]+","compatible":true\}/);
  assert.match(ladderText ?? "", /"nextflow":\{"observed_version":"[^"]+","compatible":true\}/);
  assert.match(ladderText ?? "", /"readiness":"empty","validation_decision":"blocked_by_readiness"/);
  await activity.locator("li", { hasText: "mcp.Pixi.pixi_runtime_info" }).waitFor();
  await activity.locator("li", { hasText: "mcp.Nextflow.nextflow_runtime_info" }).waitFor();
  await activity.locator("li", { hasText: "mcp.Somite.somite.readiness.get" }).waitFor();
  await agent.getByRole("button", { name: "Disconnect Somite Test Agent" }).click();
  await agent.getByText("Choose an assistant", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close Agent" }).click();

  const library = await openLibrary(page);
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

test("production canvas imports a dropped Nextflow directory through the runner", { timeout: 90_000 }, async (context) => {
  const app = await startProductionApp();
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await emptyCatalogs(page, app);
  await page.goto(app.webUrl);
  const canvas = page.locator("#workflow-canvas");
  await canvas.waitFor();

  await canvas.evaluate((element) => {
    const fileEntry = (name: string, contents: string) => ({
      isFile: true,
      isDirectory: false,
      name,
      file(success: (file: File) => void) { success(new File([contents], name, { type: "text/plain" })); },
    });
    const directoryEntry = (name: string, entries: unknown[]) => ({
      isFile: false,
      isDirectory: true,
      name,
      createReader() {
        let complete = false;
        return { readEntries(success: (batch: unknown[]) => void) { success(complete ? [] : (complete = true, entries)); } };
      },
    });
    const root = directoryEntry("dropped-demo", [
      fileEntry("main.nf", [
        "nextflow.enable.dsl=2",
        "include { PREPARE } from './modules/prepare'",
        "workflow { PREPARE() }",
        "",
      ].join("\n")),
      directoryEntry("modules", [fileEntry("prepare.nf", "process PREPARE { script: \"\"\"touch ready\"\"\" }\n")]),
    ]);
    const event = new DragEvent("drop", { bubbles: true, cancelable: true, clientX: 720, clientY: 500 });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        getData: () => "",
        items: [{ kind: "file", webkitGetAsEntry: () => root }],
        files: [],
      },
    });
    element.dispatchEvent(event);
  });

  await canvas.locator(".source-workflow-node").waitFor({ timeout: 30_000 });
  await page.locator(".status-copy").getByText(/Opened dropped-demo · frozen Nextflow source/).waitFor();
  assert.equal(await canvas.locator(".source-graph-preview").count(), 1);
  assert.equal(await canvas.locator(".react-flow__node").count(), 1);
  assertNoPageErrors();
});

test("production Nextflow workflow uses one continuous semantic-zoom canvas", { timeout: 120_000 }, async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "somite-browser-semantic-zoom-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const gateway = new NfcoreGateway(projectRoot, catalog, async (input) => String(input).includes("pipelines.json")
    ? new Response(nfcoreCatalogFixture, { headers: { "content-type": "application/json" } })
    : new Response(nfcoreGroupableSourceArchive(), { headers: { "content-type": "application/gzip" } }));
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
  const library = await openLibrary(page);
  await page.getByRole("button", { name: /Browse Nextflow workflows/ }).click();
  await page.locator("button.operator-add", { hasText: "nf-core/demo" }).click();

  const canvas = page.locator("#workflow-canvas");
  const flowHost = canvas.locator(":scope > .react-flow");
  const sourceNode = canvas.locator(".source-workflow-node");
  await sourceNode.waitFor();
  assert.equal(await canvas.locator(".react-flow").count(), 1);
  assert.equal(await canvas.locator(".source-graph-preview").count(), 1, "the container shows its live child graph before entry");
  await flowHost.evaluate((element) => element.setAttribute("data-persistent-flow", "semantic-host"));
  await page.locator("[aria-label='Canvas Tools']").waitFor();
  await page.getByRole("complementary", { name: "Workspace Tools" }).waitFor();
  await page.getByRole("button", { name: "Open Agent" }).waitFor();
  assertNoPageErrors();

  await sourceNode.hover();
  for (let attempt = 0; attempt < 12 && await canvas.getAttribute("data-semantic-depth") !== "1"; attempt += 1) {
    await page.mouse.wheel(0, -620);
    await page.waitForTimeout(80);
  }
  await canvas.locator("[data-source-entity-kind='invocation']").first().waitFor();
  assert.equal(await canvas.getAttribute("data-semantic-depth"), "1");
  assert.equal(await canvas.locator(".react-flow").count(), 1);
  assert.equal(await flowHost.getAttribute("data-persistent-flow"), "semantic-host", "semantic entry preserves the exact React Flow host element");
  assert.equal(await page.locator("section[aria-label='Nested source canvas']").count(), 0);
  assert.equal(await page.getByRole("navigation", { name: "Nested canvas breadcrumbs" }).count(), 0);
  assert.equal(await canvas.locator("[data-source-entity-kind='invocation']").count(), 4);
  await page.locator("[aria-label='Canvas Tools']").waitFor();
  await page.getByRole("complementary", { name: "Workspace Tools" }).waitFor();
  await page.getByRole("button", { name: "Open Agent" }).waitFor();
  assertNoPageErrors();

  const invocations = canvas.locator("[data-source-entity-kind='invocation']");
  await invocations.nth(0).click();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(100);
  assert.equal(await invocations.count(), 4, "immutable source calls cannot disappear through React Flow deletion");
  await canvas.locator(".react-flow__pane").click({ position: { x: 700, y: 700 }, force: true });
  const sourceRelations = canvas.locator("[data-testid^='source-relation-']");
  const sourceRelationCount = await sourceRelations.count();
  assert.ok(sourceRelationCount > 0);
  await sourceRelations.first().click({ force: true });
  await canvas.getByRole("toolbar", { name: "Source frame selection actions" }).waitFor();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(100);
  assert.equal(await sourceRelations.count(), sourceRelationCount, "immutable source relationships cannot disappear through React Flow deletion");
  await invocations.nth(0).click();
  await invocations.nth(1).click({ modifiers: ["Control"] });
  await invocations.nth(2).click({ modifiers: ["Control"] });
  await canvas.getByRole("button", { name: "Nest selection", exact: true }).click();
  const hull = canvas.locator(".source-group-hull").first();
  await hull.waitFor();
  const groupId = await hull.getAttribute("data-source-group-id");
  assert.ok(groupId);
  await page.getByRole("button", { name: "Fit Workflow" }).click();
  await page.waitForTimeout(350);
  await hull.locator("header").hover();
  for (let attempt = 0; attempt < 12 && await canvas.getAttribute("data-semantic-depth") !== "2"; attempt += 1) {
    await page.mouse.wheel(0, -620);
    await page.waitForTimeout(80);
  }
  assert.equal(await canvas.getAttribute("data-semantic-depth"), "2", "soft group hulls are recursively zoomable containers");
  assert.equal(await canvas.locator("[data-source-entity-kind='invocation']").count(), 3);
  assert.equal(await flowHost.getAttribute("data-persistent-flow"), "semantic-host");

  const sourceProjectionScreenBounds = async () => {
    const projectedNodes = canvas.locator([
      ".react-flow__node-sourceEntity",
      ".react-flow__node-sourceGroupHull",
      ".react-flow__node-sourceGroupPortal",
      ".react-flow__node-sourceBoundaryPortal",
    ].join(", "));
    const boxes = await Promise.all((await projectedNodes.all()).map((node) => node.boundingBox()));
    const present = boxes.filter((box): box is NonNullable<typeof box> => box !== null);
    assert.ok(present.length > 0);
    const left = Math.min(...present.map((box) => box.x));
    const top = Math.min(...present.map((box) => box.y));
    const right = Math.max(...present.map((box) => box.x + box.width));
    const bottom = Math.max(...present.map((box) => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  const assertNestedScreenFit = (portal: Awaited<ReturnType<typeof sourceProjectionScreenBounds>>, child: Awaited<ReturnType<typeof sourceProjectionScreenBounds>>, label: string) => {
    const portalCenter = { x: portal.x + portal.width / 2, y: portal.y + portal.height / 2 };
    const childCenter = { x: child.x + child.width / 2, y: child.y + child.height / 2 };
    assert.ok(Math.abs(portalCenter.x - childCenter.x) <= 3, `${label}: horizontal centers drifted; portal=${JSON.stringify(portal)} child=${JSON.stringify(child)}`);
    assert.ok(Math.abs(portalCenter.y - childCenter.y) <= 3, `${label}: vertical centers drifted; portal=${JSON.stringify(portal)} child=${JSON.stringify(child)}`);
    assert.ok(child.width <= portal.width + 3 && child.height <= portal.height + 3, `${label}: child no longer fits its portal`);
    assert.ok(Math.min(Math.abs(portal.width - child.width), Math.abs(portal.height - child.height)) <= 3, `${label}: neither fitted dimension stayed continuous`);
  };
  const zoomOutOneLevel = async (depth: string) => {
    const box = await canvas.boundingBox();
    assert.ok(box);
    let projectionBeforeExit = await sourceProjectionScreenBounds();
    await page.mouse.move(box.x + box.width * .72, box.y + box.height * .42);
    for (let attempt = 0; attempt < 16 && await canvas.getAttribute("data-semantic-depth") !== depth; attempt += 1) {
      projectionBeforeExit = await sourceProjectionScreenBounds();
      await page.mouse.wheel(0, 620);
      await page.waitForTimeout(80);
    }
    assert.equal(await canvas.getAttribute("data-semantic-depth"), depth);
    return projectionBeforeExit;
  };

  const movedInvocationId = await invocations.first().getAttribute("data-source-entity-id");
  assert.ok(movedInvocationId);
  await invocations.first().click();
  await canvas.getByRole("button", { name: "Move out one level" }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-source-entity-kind='invocation']").length === 2);
  const updatedChildBounds = await zoomOutOneLevel("1");
  const updatedHullBounds = await hull.boundingBox();
  assert.ok(updatedHullBounds);
  assertNestedScreenFit(updatedHullBounds, updatedChildBounds, "semantic exit uses the latest child and portal geometry");
  assert.equal(await canvas.locator("[data-source-entity-kind='invocation']").count(), 4);
  await sourceEntity(canvas, movedInvocationId).click();
  const moveBack = canvas.getByRole("button", { name: "Move back" });
  await moveBack.click();
  await moveBack.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelectorAll("[data-source-entity-kind='invocation']").length === 4);
  await page.getByRole("button", { name: "Fit Workflow" }).click();
  await page.waitForTimeout(350);
  await hull.getByRole("button", { name: /^Collapse / }).click();
  const macro = canvas.locator(`[data-testid=${JSON.stringify(`source-group-portal-${groupId}`)}]`);
  await macro.waitFor();
  assert.equal(await macro.locator(".source-graph-preview").count(), 1, "collapsed containers retain a live child preview");
  await macro.hover();
  for (let attempt = 0; attempt < 12 && await canvas.getAttribute("data-semantic-depth") !== "2"; attempt += 1) {
    await page.mouse.wheel(0, -620);
    await page.waitForTimeout(80);
  }
  assert.equal(await canvas.getAttribute("data-semantic-depth"), "2", "collapsed Macros use the same recursive semantic entry");
  assert.equal(await canvas.locator("[data-source-entity-kind='invocation']").count(), 3);
  await zoomOutOneLevel("1");
  await zoomOutOneLevel("0");
  await sourceNode.waitFor();
  assert.equal(await flowHost.getAttribute("data-persistent-flow"), "semantic-host");
  assert.equal(await canvas.locator(".source-graph-preview").count(), 1);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
  await page.reload();
  await sourceNode.waitFor();
  await sourceNode.hover();
  for (let attempt = 0; attempt < 12 && await canvas.getAttribute("data-semantic-depth") !== "1"; attempt += 1) {
    await page.mouse.wheel(0, -620);
    await page.waitForTimeout(80);
  }
  await macro.waitFor();
  assert.equal(await macro.locator(".source-graph-preview").count(), 1, "saved collapsed containers and previews survive reload");
  await macro.getByRole("button", { name: /Expand .* inline/ }).click();
  await page.getByRole("button", { name: "Fit Workflow" }).click();
  await page.waitForTimeout(350);
  await hull.getByRole("button", { name: /^Ungroup / }).click();
  await hull.waitFor({ state: "detached" });
  const dissolvedChildBounds = await zoomOutOneLevel("0");
  const sourcePortalBounds = await sourceNode.boundingBox();
  assert.ok(sourcePortalBounds);
  assertNestedScreenFit(sourcePortalBounds, dissolvedChildBounds, "dissolving inside an active frame updates the root inverse camera");
  await sourceNode.hover();
  for (let attempt = 0; attempt < 12 && await canvas.getAttribute("data-semantic-depth") !== "1"; attempt += 1) {
    await page.mouse.wheel(0, -620);
    await page.waitForTimeout(80);
  }
  assert.equal(await canvas.getAttribute("data-semantic-depth"), "1", "dissolving a group cannot leave semantic zoom stuck");
  const firstSourceCallId = await canvas.locator(".source-outline-node").first().getAttribute("data-source-entity-id");
  assert.ok(firstSourceCallId);
  const firstSourceCall = sourceEntity(canvas, firstSourceCallId);
  await firstSourceCall.getByRole("button", { name: "Replace tool" }).click();
  const replacementPicker = page.getByRole("complementary", { name: "Replace source invocation" });
  await replacementPicker.getByRole("searchbox", { name: "Search replacement tools" }).fill("files.import");
  await replacementPicker.getByRole("button", { name: /^Import file files\.import / }).click();
  await firstSourceCall.getByRole("button", { name: "Make editable" }).click();
  await page.getByText("Native variant", { exact: true }).waitFor();
  await canvas.locator(".react-flow__node").first().waitFor();
  assert.equal(await canvas.locator(".react-flow__node").count(), 1);

  await page.getByRole("button", { name: "Review source calls" }).click();
  await canvas.locator(".source-outline-promoted", { hasText: "Editable on canvas" }).waitFor();
  const secondSourceCallId = await canvas.locator(".source-outline-node").filter({ hasNotText: "Editable on canvas" }).first().getAttribute("data-source-entity-id");
  assert.ok(secondSourceCallId);
  const secondSourceCall = sourceEntity(canvas, secondSourceCallId);
  await secondSourceCall.getByRole("button", { name: "Replace tool" }).click();
  await replacementPicker.getByRole("searchbox", { name: "Search replacement tools" }).fill("qc.fastqc");
  await replacementPicker.getByRole("button", { name: /^FastQC qc\.fastqc / }).click();
  await secondSourceCall.getByRole("button", { name: "Make editable" }).click();
  await page.getByText("2 promoted calls", { exact: true }).waitFor();
  await canvas.locator(".react-flow__node").nth(1).waitFor();
  assert.equal(await canvas.locator(".react-flow__node").count(), 2, "a native variant can progressively promote multiple source calls");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
  await page.reload();
  await page.getByText("2 promoted calls", { exact: true }).waitFor();
  await canvas.locator(".react-flow__node").nth(1).waitFor();
  assert.equal(await canvas.locator(".react-flow__node").count(), 2, "progressive promotion and provenance survive reload");
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
  const assertNoPageErrors = watchPage(page, [/Failed to load resource:.*422.*\/api\/projects\/open/]);
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

test("public-source validation explains exactly what representative data did not exercise", { timeout: 90_000 }, async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "somite-browser-public-validation-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const download = catalog.get("ensembl.fasta")!;
  const decompress = catalog.get("archive.gunzip_fasta")!;
  const index = catalog.get("align.star_index")!;
  const graph: SomiteGraph = {
    schema_version: 3,
    name: "Representative public reference",
    nodes: [
      { id: "download", operator: download.id, operator_revision: download.revision, ports: operatorPorts(download), params: { url: "https://example.invalid/reference.fa.gz" }, layout: { x: 0, y: 0 } },
      { id: "decompress", operator: decompress.id, operator_revision: decompress.revision, ports: operatorPorts(decompress), params: {}, layout: { x: 240, y: 0 } },
      { id: "index", operator: index.id, operator_revision: index.revision, ports: operatorPorts(index), params: { threads: 1 }, layout: { x: 480, y: 0 } },
    ],
    edges: [
      { id: "download-decompress", from_node: "download", from_port: "fasta", to_node: "decompress", to_port: "compressed" },
      { id: "decompress-index", from_node: "decompress", from_port: "fasta", to_node: "index", to_port: "ref" },
    ],
  };
  await writeFile(join(projectRoot, "workflow.somite.json"), `${JSON.stringify(graph, null, 2)}\n`);
  const app = await startProductionApp({ projectRoot, graph: "workflow.somite.json" });
  context.after(app.stop);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  context.after(() => page.close());
  const assertNoPageErrors = watchPage(page);
  await emptyCatalogs(page, app);
  let submitted: unknown;
  await page.route(`${app.runnerUrl}/api/validations`, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillJson(route, app, {}, 204);
    submitted = route.request().postDataJSON();
    return fulfillJson(route, app, { run_id: "public-validation", phase: "preparing", replayed: false }, 202);
  });
  await page.route(`${app.runnerUrl}/api/runs/public-validation*`, (route) => fulfillJson(route, app, {
    run_id: "public-validation",
    phase: "completed",
    states: { download: "skipped", decompress: "skipped", index: "done", "decompress-fixture": "done" },
    progress: { completed: 4, total: 4, unit: "nodes", message: "Completed" },
    exit_code: 0,
    evidence_receipt: {
      receipt_digest: "blake3:public-browser-receipt",
      recorded_at_unix_ms: 1,
      subject_digest: "blake3:public-browser-subject",
      kind: "configuration_validation",
      scope: "graph_e2e_public_retrieval_not_exercised_fixture_parameters_adjusted",
      configuration_digest: "blake3:public-browser-configuration",
      fixture_digests: ["blake3:public-browser-reference"],
      verifier: "somite-browser-test",
      result: "passed",
      node_results: { download: "inconclusive", decompress: "inconclusive", index: "passed" },
      edge_results: { "download-decompress": "inconclusive", "decompress-index": "inconclusive" },
      artifact_digests: [],
      log_digests: [],
    },
  }));

  await page.goto(app.webUrl);
  await page.locator(".react-flow__node").nth(2).waitFor();
  const validate = page.getByRole("button", { name: "Validate", exact: true });
  assert.match(await validate.getAttribute("title") ?? "", /public retrieval is not exercised/);
  await validate.click();
  await page.locator(".status-copy").getByText(/Representative check passed · 1 workflow node passed · 2 public retrieval steps not exercised · tiny-data parameters disclosed/).waitFor();
  const submittedGraph = (submitted as { graph?: typeof graph })?.graph;
  assert.deepEqual(submittedGraph?.nodes.map((node) => node.operator), ["ensembl.fasta", "archive.gunzip_fasta", "align.star_index"]);
  assert.equal(submittedGraph?.nodes.find((node) => node.id === "index")?.params?.genome_sa_index_nbases, undefined,
    "fixture-only STAR sizing belongs to runner binding, not the saved canvas submission");
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
  const browserWarnings: string[] = [];
  page.on("console", (entry) => {
    if (entry.type() === "warning") browserWarnings.push(entry.text());
  });
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
  await page.getByRole("button", { name: "Fit Workflow" }).click();
  await page.waitForTimeout(350);

  const outputHandle = importNode.locator(".react-flow__handle.source[data-handleid='file']");
  const inputHandle = fastqcNode.locator(".react-flow__handle.target[data-handleid='fastq']");
  const outputBox = await outputHandle.boundingBox();
  const inputBox = await inputHandle.boundingBox();
  assert.ok(outputBox, "files.import.file output handle should be visible");
  assert.ok(inputBox, "qc.fastqc.fastq input handle should be visible");
  await page.mouse.move(outputBox.x + outputBox.width / 2, outputBox.y + outputBox.height / 2);
  await page.waitForTimeout(75);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.move(
    (outputBox.x + inputBox.x) / 2,
    (outputBox.y + inputBox.y) / 2,
    { steps: 8 },
  );
  await page.waitForTimeout(50);
  await page.mouse.move(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2, { steps: 16 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  try {
    await page.locator(".react-flow__edge").waitFor({ state: "attached", timeout: 10_000 });
  } catch (error) {
    const response = await fetch(`${app.runnerUrl}/api/session`);
    const current = await response.json() as { graph?: { edges?: unknown[] } };
    const currentStatus = await page.locator(".status-copy").textContent();
    throw new Error(`connection gesture did not converge; status=${currentStatus}; server_edges=${current.graph?.edges?.length ?? "unknown"}`, { cause: error });
  }
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
  await page.locator(".react-flow__edge").waitFor({ state: "attached" });
  assert.equal(await page.locator(".react-flow__edge").count(), 1, "undoing an annotation color must preserve workflow edges");
  await redo.click();
  assert.equal(await note.getAttribute("data-color"), "violet");
  await page.locator(".react-flow__edge").waitFor({ state: "attached" });
  assert.equal(await page.locator(".react-flow__edge").count(), 1, "redoing an annotation color must preserve workflow edges");

  let explicitSaveStarted = false;
  let lateAutosaveRequests = 0;
  page.on("request", (request) => {
    if (explicitSaveStarted && request.method() === "PUT" && new URL(request.url()).pathname === "/api/graph/autosave") {
      lateAutosaveRequests += 1;
    }
  });
  await page.route(`${app.runnerUrl}/api/graph`, async (route) => {
    if (route.request().method() === "PUT") await new Promise((resolvePromise) => setTimeout(resolvePromise, 900));
    await route.continue();
  });
  await noteText.fill("Review FastQC evidence pending");
  await noteText.fill("Review FastQC evidence");
  explicitSaveStarted = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
  await page.waitForTimeout(900);
  explicitSaveStarted = false;
  assert.equal(lateAutosaveRequests, 0, "an older autosave must not run after an explicit canonical save begins");
  const persisted = JSON.parse(await readFile(join(projectRoot, ".somite", "web.somite.json"), "utf8")) as { edges?: unknown[] };
  assert.equal(persisted.edges?.length, 1, "the canonical saved graph must retain the workflow edge");
  for (let reloadAttempt = 1; reloadAttempt <= 5; reloadAttempt += 1) {
    await page.reload();
    await page.locator(".react-flow__node").nth(1).waitFor();
    try {
      await page.locator(".react-flow__edge").waitFor({ state: "attached", timeout: 5_000 });
    } catch (error) {
      const response = await fetch(`${app.runnerUrl}/api/session`);
      const current = await response.json() as { graph?: { edges?: unknown[] } };
      const autosaved = JSON.parse(await readFile(join(projectRoot, ".somite", "autosave.somite.json"), "utf8")) as { edges?: unknown[] };
      const canonical = JSON.parse(await readFile(join(projectRoot, ".somite", "web.somite.json"), "utf8")) as { edges?: unknown[] };
      const geometry = await page.locator(".react-flow__node").evaluateAll((elements) => elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { id: element.getAttribute("data-id"), x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, handles: element.querySelectorAll(".react-flow__handle").length };
      }));
      const transform = await page.locator(".react-flow__viewport").getAttribute("style");
      throw new Error(`saved connection did not restore on reload ${reloadAttempt}; session_edges=${current.graph?.edges?.length ?? "unknown"}; autosave_edges=${autosaved.edges?.length ?? "unknown"}; canonical_edges=${canonical.edges?.length ?? "unknown"}; geometry=${JSON.stringify(geometry)}; viewport=${transform}; warnings=${JSON.stringify(browserWarnings.slice(-8))}`, { cause: error });
    }
  }
  assert.equal(await page.locator(".react-flow__node").count(), 2);
  assert.equal(await page.locator(".react-flow__edge").count(), 1);
  assert.equal(await page.getByRole("textbox", { name: "Sticky note note-1" }).inputValue(), "Review FastQC evidence");
  assert.equal(await page.locator(".canvas-annotation.sticky").getAttribute("data-color"), "violet");
  await page.locator(".react-flow__node", { has: page.locator(".node-operator", { hasText: "files.import" }) }).click();
  assert.equal(await page.locator("section[aria-label='Node Parameters']").getByRole("textbox", { name: "Path" }).inputValue(), "testdata/tiny_R1.fastq");
  await readiness.filter({ hasText: "Ready" }).waitFor();
  assertNoPageErrors();
});
