import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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
