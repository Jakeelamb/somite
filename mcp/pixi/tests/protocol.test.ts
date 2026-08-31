import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { OfficialDocumentation } from "@somite/mcp-runtime/docs";
import { WorkspaceBoundary } from "@somite/mcp-runtime";

import { createPixiServer, PIXI_DOCUMENTATION_SOURCE, SUPPORTED_PIXI_VERSION } from "../src/server.ts";

test("Pixi server negotiates MCP v2 and advertises its complete typed surface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pixi-mcp-protocol-"));
  const client = new Client({ name: "pixi-mcp-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--experimental-strip-types", new URL("../src/server.ts", import.meta.url).pathname,
      "--workspace-root", root, "--binary", join(root, "missing-pixi"),
    ],
    cwd: root,
    stderr: "pipe",
  });
  context.after(async () => {
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "pixi_dependency", "pixi_docs_read", "pixi_docs_search", "pixi_environment", "pixi_global",
    "pixi_inspect", "pixi_lock", "pixi_package_search", "pixi_runtime_info", "pixi_task", "pixi_workspace",
  ]);
  assert.ok(tools.tools.every((tool) => tool.inputSchema && tool.outputSchema && tool.annotations));
  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), ["pixi://docs/catalog", "pixi://policy/execution"]);
  const result = await client.callTool({ name: "pixi_runtime_info", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(typeof result.structuredContent, "object");
  assert.equal((result.structuredContent as { ok?: unknown }).ok, false);
});

test("Pixi documentation resource and tools use the injected official-source provider", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pixi-mcp-docs-root-"));
  const cache = await mkdtemp(join(tmpdir(), "pixi-mcp-docs-cache-"));
  const pages = new Map([
    ["reference/cli/pixi_add.md", "# pixi add\nAdd dependencies to a workspace manifest.\n"],
    ["workspace/export/conda-environment.md", "# Conda export\nExport an exact locked environment.\n"],
  ]);
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ tree: [...pages.keys()].map((path) => ({ path: `docs/${path}`, type: "blob" })) }), { status: 200 });
    }
    const path = [...pages.keys()].find((candidate) => url.endsWith(`/docs/${candidate}`));
    return path ? new Response(pages.get(path), { status: 200 }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  const docs = new OfficialDocumentation(PIXI_DOCUMENTATION_SOURCE, cache, fetcher);
  const boundary = await WorkspaceBoundary.create(root);
  const server = createPixiServer(boundary, join(root, "missing-pixi"), docs);
  const client = new Client({ name: "pixi-mcp-docs-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(cache, { recursive: true, force: true }),
    ]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const resource = await client.readResource({ uri: "pixi://docs/catalog" });
  const content = resource.contents[0];
  assert.ok(content && "text" in content);
  assert.deepEqual(JSON.parse(content.text), {
    repository: "prefix-dev/pixi",
    revision: `v${SUPPORTED_PIXI_VERSION}`,
    directory: "docs",
    pages: [...pages.keys()].sort(),
  });

  const search = await client.callTool({ name: "pixi_docs_search", arguments: { query: "exact locked environment", limit: 5 } });
  assert.notEqual(search.isError, true);
  assert.match(JSON.stringify(search.structuredContent), /workspace\/export\/conda-environment\.md/);
  const read = await client.callTool({ name: "pixi_docs_read", arguments: { path: "reference/cli/pixi_add.md" } });
  assert.notEqual(read.isError, true);
  assert.equal((read.structuredContent as { source_revision?: unknown }).source_revision, `v${SUPPORTED_PIXI_VERSION}`);
  assert.match(JSON.stringify(read.structuredContent), /Add dependencies/);
});
