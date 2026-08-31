import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent)}`);
  return result;
}

test("Pixi MCP creates, locks, installs, and runs a local task without remote packages", { timeout: 5 * 60_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pixi-mcp-smoke-"));
  const proofTool = join(root, "proof-tool");
  await writeFile(proofTool, "#!/bin/sh\nprintf 'pixi-mcp-ok\\n'\n");
  await chmod(proofTool, 0o700);
  const client = new Client({ name: "pixi-mcp-smoke", version: "1.0.0" });
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
  const runtime = await call(client, "pixi_runtime_info", {});
  assert.match(JSON.stringify(runtime.structuredContent), /"compatible":true/);
  await call(client, "pixi_workspace", { action: "init", path: ".", channels: ["conda-forge"] });
  const info = await call(client, "pixi_inspect", { view: "workspace" });
  assert.match(JSON.stringify(info.structuredContent), /0\.77\.1/);

  await call(client, "pixi_task", { action: "add", name: "proof", command: "./proof-tool" });
  await call(client, "pixi_lock", { action: "resolve" });
  await call(client, "pixi_environment", { action: "install", frozen: true });
  const ran = await call(client, "pixi_task", { action: "run", name: "proof" });
  assert.match(JSON.stringify(ran.structuredContent), /pixi-mcp-ok/);

  assert.ok((await stat(join(root, "pixi.lock"))).isFile());
});
