import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("Nextflow server negotiates MCP v2 and advertises its complete typed surface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "nextflow-mcp-protocol-"));
  const client = new Client({ name: "nextflow-mcp-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", new URL("../src/server.ts", import.meta.url).pathname, "--workspace-root", root],
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
  assert.notEqual(result.isError, true);
  assert.equal(typeof result.structuredContent, "object");
});
