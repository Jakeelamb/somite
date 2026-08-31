import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { OfficialDocumentation, type DocumentationProvider, type DocumentationSource } from "@somite/mcp-runtime/docs";
import { WorkspaceBoundary } from "@somite/mcp-runtime";

import { createNextflowServer, NEXTFLOW_DOCUMENTATION_SOURCE } from "../mcp/nextflow/src/server.ts";
import { createPixiServer, PIXI_DOCUMENTATION_SOURCE } from "../mcp/pixi/src/server.ts";

type DocumentationServer = ReturnType<typeof createPixiServer>;

const githubToken = process.env.SOMITE_MCP_CANARY_GITHUB_TOKEN;

/** Authenticate only GitHub API metadata; never forward the workflow token to page or tool hosts. */
const canaryFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
  if (!githubToken || url.origin !== "https://api.github.com") return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${githubToken}`);
  return fetch(input, { ...init, headers, redirect: "error" });
}) as typeof fetch;

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  return result;
}

async function verifyLiveDocumentation(options: {
  name: string;
  source: DocumentationSource;
  catalogUri: string;
  searchTool: string;
  readTool: string;
  stablePath: string;
  searchQuery: string;
  expectedText: RegExp;
  minimumPages: number;
  binary: string;
  createServer: (boundary: WorkspaceBoundary, binary: string, docs: DocumentationProvider) => DocumentationServer;
  verifyExternalTools: (client: Client, root: string) => Promise<void>;
}) {
  const root = await mkdtemp(join(tmpdir(), `somite-${options.name.toLowerCase()}-docs-root-`));
  const cache = await mkdtemp(join(tmpdir(), `somite-${options.name.toLowerCase()}-docs-cache-`));
  const docs = new OfficialDocumentation(options.source, cache, canaryFetch);
  const boundary = await WorkspaceBoundary.create(root);
  const server = options.createServer(boundary, options.binary, docs);
  const client = new Client({ name: `somite-${options.name.toLowerCase()}-docs-canary`, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const resource = await client.readResource({ uri: options.catalogUri });
    const content = resource.contents[0];
    assert.ok(content && "text" in content, `${options.name} catalog did not return text`);
    const catalog = JSON.parse(content.text) as { repository?: string; revision?: string; directory?: string; pages?: string[] };
    assert.equal(catalog.repository, options.source.repository);
    assert.equal(catalog.revision, options.source.branch);
    assert.equal(catalog.directory, options.source.directory);
    assert.ok((catalog.pages?.length ?? 0) >= options.minimumPages, `${options.name} catalog is unexpectedly small`);
    assert.ok(catalog.pages?.includes(options.stablePath), `${options.name} catalog is missing ${options.stablePath}`);

    const search = await client.callTool({
      name: options.searchTool,
      arguments: { query: options.searchQuery, limit: 20 },
    });
    assert.notEqual(search.isError, true, `${options.name} documentation search failed`);
    const matches = (search.structuredContent as { matches?: Array<{ path?: string }> } | undefined)?.matches;
    assert.ok(matches?.some((match) => match.path === options.stablePath), `${options.name} search did not find ${options.stablePath}`);

    const read = await client.callTool({ name: options.readTool, arguments: { path: options.stablePath } });
    assert.notEqual(read.isError, true, `${options.name} documentation read failed`);
    const page = read.structuredContent as { source_revision?: string; text?: string } | undefined;
    assert.equal(page?.source_revision, options.source.branch);
    assert.match(page?.text ?? "", options.expectedText);
    await options.verifyExternalTools(client, root);
    console.log(`${options.name} live MCP upstream passed: ${catalog.pages!.length} documentation pages at ${options.source.branch}`);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(cache, { recursive: true, force: true }),
    ]);
  }
}

await verifyLiveDocumentation({
  name: "Pixi",
  source: PIXI_DOCUMENTATION_SOURCE,
  catalogUri: "pixi://docs/catalog",
  searchTool: "pixi_docs_search",
  readTool: "pixi_docs_read",
  stablePath: "global_tools/introduction.md",
  searchQuery: "global tools globally installed",
  expectedText: /users can manage globally installed tools/,
  minimumPages: 100,
  binary: "pixi",
  createServer: createPixiServer,
  verifyExternalTools: async (client, root) => {
    const runtime = await call(client, "pixi_runtime_info", {});
    assert.match(JSON.stringify(runtime.structuredContent), /"compatible":true/);
    const packageSearch = await call(client, "pixi_package_search", {
      spec: "samtools", channels: ["bioconda"], platform: "linux-64", limit: 3,
    });
    const packages = packageSearch.structuredContent as { total_records?: number; matches?: Array<{ name?: string }> };
    assert.ok((packages.total_records ?? 0) >= 3);
    assert.equal(packages.matches?.length, 3);
    assert.ok(packages.matches?.every((match) => match.name === "samtools"));

    await call(client, "pixi_workspace", { action: "init", path: ".", channels: ["conda-forge"] });
    await call(client, "pixi_dependency", { action: "add", packages: ["coreutils"], source: "conda" });
    await call(client, "pixi_task", { action: "add", name: "proof", command: "printf 'pixi-mcp-live-ok\\n'" });
    await call(client, "pixi_lock", { action: "resolve" });
    await call(client, "pixi_environment", { action: "install", frozen: true });
    const ran = await call(client, "pixi_task", { action: "run", name: "proof" });
    assert.match(JSON.stringify(ran.structuredContent), /pixi-mcp-live-ok/);
    await call(client, "pixi_workspace", { action: "export_conda", path: "environment.yml", pinned: true });
    assert.ok((await stat(join(root, "pixi.lock"))).isFile());
    assert.match(await readFile(join(root, "environment.yml"), "utf8"), /coreutils/);
  },
});

await verifyLiveDocumentation({
  name: "Nextflow",
  source: NEXTFLOW_DOCUMENTATION_SOURCE,
  catalogUri: "nextflow://docs/catalog",
  searchTool: "nextflow_docs_search",
  readTool: "nextflow_docs_read",
  stablePath: "process.md",
  searchQuery: "process specialized function executing scripts",
  expectedText: /specialized function for executing scripts/,
  minimumPages: 100,
  binary: "nextflow",
  createServer: createNextflowServer,
  verifyExternalTools: async (client) => {
    const runtime = await call(client, "nextflow_runtime_info", {});
    assert.match(JSON.stringify(runtime.structuredContent), /26\.04\.6/);
    const moduleSearch = await call(client, "nextflow_module", { action: "search", query: "fastqc", limit: 5 });
    assert.match(JSON.stringify(moduleSearch.structuredContent), /nf-core\/fastqc/);
  },
});
