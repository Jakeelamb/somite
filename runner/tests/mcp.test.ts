import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SOMITE_VERSION } from "@somite/workflow/version";
import { SOMITE_MCP_TOOL_NAMES } from "../src/mcpTools.ts";

type RpcResponse = { id: number; result?: Record<string, unknown>; error?: Record<string, unknown> };

class McpClient {
  readonly child: ChildProcess;
  readonly responses = new Map<number, (value: RpcResponse) => void>();

  constructor(url: string, capability: string) {
    const script = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
    this.child = spawn(process.execPath, ["--experimental-strip-types", script, "--server-url", url], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SOMITE_MCP_RUNTIME_CAPABILITY: capability },
    });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => {
      const response = JSON.parse(line) as RpcResponse;
      this.responses.get(response.id)?.(response);
      this.responses.delete(response.id);
    });
  }

  request(id: number, method: string, params: unknown = {}) {
    const response = new Promise<RpcResponse>((resolvePromise) => this.responses.set(id, resolvePromise));
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  close() {
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
  }
}

test("thin MCP adapter supports modern discovery, legacy initialization, and structured Somite tools", async (context) => {
  const capability = "a".repeat(64);
  const seen: string[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers["x-somite-mcp-capability"], capability);
    seen.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ state_revision: "blake3:state", graph_revision: "blake3:graph", graph: { schema_version: 3, nodes: [], edges: [] } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new McpClient(`http://127.0.0.1:${address.port}`, capability);
  context.after(() => {
    client.close();
    server.close();
  });

  const discovered = await client.request(1, "server/discover");
  assert.deepEqual(discovered.result?.supportedVersions, ["2026-07-28", "2025-11-25"]);
  const initialized = await client.request(2, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.result?.protocolVersion, "2025-06-18");
  assert.deepEqual(initialized.result?.serverInfo, { name: "somite", title: "Somite", version: SOMITE_VERSION });
  const listed = await client.request(3, "tools/list");
  const tools = listed.result?.tools as Array<{ name: string }>;
  assert.deepEqual(tools.map((tool) => tool.name), SOMITE_MCP_TOOL_NAMES);
  assert.ok(tools.some((tool) => tool.name === "somite.graph.apply_transaction"));
  assert.ok(tools.some((tool) => tool.name === "somite.validation.start"));
  const called = await client.request(4, "tools/call", { name: "somite.workflow.get", arguments: {} });
  const structured = called.result?.structuredContent as Record<string, unknown>;
  assert.equal(structured.state_revision, "blake3:state");
  assert.deepEqual(seen, ["/api/agent/graph"]);
});
