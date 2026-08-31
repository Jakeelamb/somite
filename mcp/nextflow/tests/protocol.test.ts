import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { OfficialDocumentation } from "@somite/mcp-runtime/docs";
import { WorkspaceBoundary } from "@somite/mcp-runtime";

import { createNextflowServer, NEXTFLOW_DOCUMENTATION_SOURCE, SUPPORTED_NEXTFLOW_VERSION } from "../src/server.ts";

test("Nextflow server negotiates MCP v2 and advertises its complete typed surface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "nextflow-mcp-protocol-"));
  const client = new Client({ name: "nextflow-mcp-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--experimental-strip-types", new URL("../src/server.ts", import.meta.url).pathname,
      "--workspace-root", root, "--binary", join(root, "missing-nextflow"),
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
    "nextflow_analyze", "nextflow_docs_read", "nextflow_docs_search", "nextflow_history", "nextflow_maintenance",
    "nextflow_module", "nextflow_platform", "nextflow_plugin_install", "nextflow_project", "nextflow_run",
    "nextflow_runtime_info", "nextflow_storage",
  ]);
  assert.ok(tools.tools.every((tool) => tool.inputSchema && tool.outputSchema && tool.annotations));
  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [
    "nextflow://docs/catalog", "nextflow://guidance/validation-ladder", "nextflow://policy/execution",
  ]);
  const result = await client.callTool({ name: "nextflow_runtime_info", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(typeof result.structuredContent, "object");
  assert.equal((result.structuredContent as { ok?: unknown }).ok, false);
});

test("Nextflow documentation resource and tools use the injected official-source provider", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "nextflow-mcp-docs-root-"));
  const cache = await mkdtemp(join(tmpdir(), "nextflow-mcp-docs-cache-"));
  const pages = new Map([
    ["cli.md", "# Nextflow CLI\nPreview and run a pipeline from the command line.\n"],
    ["process.md", "# Process\nA process declares inputs, outputs, and an executable script.\n"],
  ]);
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ tree: [...pages.keys()].map((path) => ({ path: `docs/${path}`, type: "blob" })) }), { status: 200 });
    }
    const path = [...pages.keys()].find((candidate) => url.endsWith(`/docs/${candidate}`));
    return path ? new Response(pages.get(path), { status: 200 }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  const docs = new OfficialDocumentation(NEXTFLOW_DOCUMENTATION_SOURCE, cache, fetcher);
  const boundary = await WorkspaceBoundary.create(root);
  const binary = join(root, "fake-nextflow");
  await writeFile(binary, [
    "#!/bin/sh",
    "test \"$NXF_DISABLE_CHECK_LATEST\" = true || { echo 'latest check was not disabled' >&2; exit 41; }",
    `test \"$1\" != -version || { echo 'nextflow version ${SUPPORTED_NEXTFLOW_VERSION}'; exit 0; }`,
    "printf '{\"diagnostics\":[]}\\n'",
    "",
  ].join("\n"));
  await chmod(binary, 0o700);
  const server = createNextflowServer(boundary, binary, docs);
  const client = new Client({ name: "nextflow-mcp-docs-test", version: "1.0.0" });
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

  const resource = await client.readResource({ uri: "nextflow://docs/catalog" });
  const content = resource.contents[0];
  assert.ok(content && "text" in content);
  assert.deepEqual(JSON.parse(content.text), {
    repository: "nextflow-io/nextflow",
    revision: `v${SUPPORTED_NEXTFLOW_VERSION}`,
    directory: "docs",
    pages: [...pages.keys()].sort(),
  });

  const search = await client.callTool({ name: "nextflow_docs_search", arguments: { query: "declares inputs outputs", limit: 5 } });
  assert.notEqual(search.isError, true);
  assert.match(JSON.stringify(search.structuredContent), /process\.md/);
  const read = await client.callTool({ name: "nextflow_docs_read", arguments: { path: "cli.md" } });
  assert.notEqual(read.isError, true);
  assert.equal((read.structuredContent as { source_revision?: unknown }).source_revision, `v${SUPPORTED_NEXTFLOW_VERSION}`);
  assert.match(JSON.stringify(read.structuredContent), /Preview and run/);

  const runtime = await client.callTool({ name: "nextflow_runtime_info", arguments: {} });
  assert.notEqual(runtime.isError, true);
  assert.equal((runtime.structuredContent as { compatible?: unknown }).compatible, true);
  const lint = await client.callTool({ name: "nextflow_analyze", arguments: { action: "lint", source: "local", project: "." } });
  assert.notEqual(lint.isError, true, JSON.stringify(lint.structuredContent));
});
