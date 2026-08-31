import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

test("Pixi MCP creates, locks, installs, runs, and exports a real frozen workspace", { timeout: 5 * 60_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pixi-mcp-smoke-"));
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
  const docs = await client.readResource({ uri: "pixi://docs/catalog" });
  const docsContent = docs.contents[0];
  assert.ok(docsContent && "text" in docsContent);
  const docsCatalog = JSON.parse(docsContent.text) as { revision?: string; pages?: string[] };
  assert.equal(docsCatalog.revision, "v0.77.1");
  assert.ok((docsCatalog.pages?.length ?? 0) > 100);
  const docsSearch = await call(client, "pixi_docs_search", { query: "from-lock-file conda environment export", limit: 10 });
  assert.match(JSON.stringify(docsSearch.structuredContent), /workspace\/export\/conda-environment/);
  const runtime = await call(client, "pixi_runtime_info", {});
  assert.match(JSON.stringify(runtime.structuredContent), /"compatible":true/);
  const packageSearch = await call(client, "pixi_package_search", { spec: "samtools", channels: ["bioconda"], platform: "linux-64", limit: 3 });
  const packageSearchContent = packageSearch.structuredContent as { total_records?: number; matches?: Array<{ name?: string }> };
  assert.ok((packageSearchContent.total_records ?? 0) >= 3);
  assert.equal(packageSearchContent.matches?.length, 3);
  assert.ok(packageSearchContent.matches?.every((match) => match.name === "samtools"));
  await call(client, "pixi_workspace", { action: "init", path: ".", channels: ["conda-forge"] });
  const info = await call(client, "pixi_inspect", { view: "workspace" });
  assert.match(JSON.stringify(info.structuredContent), /0\.77\.1/);

  await call(client, "pixi_dependency", { action: "add", packages: ["coreutils"], source: "conda" });
  await call(client, "pixi_task", { action: "add", name: "proof", command: "printf 'pixi-mcp-ok\\n'" });
  await call(client, "pixi_lock", { action: "resolve" });
  await call(client, "pixi_environment", { action: "install", frozen: true });
  const ran = await call(client, "pixi_task", { action: "run", name: "proof" });
  assert.match(JSON.stringify(ran.structuredContent), /pixi-mcp-ok/);

  await call(client, "pixi_workspace", { action: "export_conda", path: "environment.yml", pinned: true });
  assert.ok((await stat(join(root, "pixi.lock"))).isFile());
  assert.match(await readFile(join(root, "environment.yml"), "utf8"), /name: default/);
});
