import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";

const MCP_CANVAS_TRANSACTION_MARKER = "[test:mcp-canvas-transaction]";

let configOptions: acp.SessionConfigOption[] = [{
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "fast",
  options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }],
}];

let toolCallSequence = 0;
let somiteClientVersion = "missing";
let somiteMcpServer: acp.McpServerStdio | undefined;
let sessionWorkingDirectory = process.cwd();

type RpcResponse = {
  id: number;
  result?: unknown;
  error?: { message?: string };
};

class StdioMcpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();
  #sequence = 0;

  constructor(server: acp.McpServerStdio, cwd: string) {
    const environment = { ...process.env };
    for (const variable of server.env) environment[variable.name] = variable.value;
    this.#child = spawn(server.command, server.args, {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      const response = JSON.parse(line) as RpcResponse;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message ?? "MCP request failed"));
      else pending.resolve(response.result);
    });
    const stop = (cause: Error) => {
      for (const pending of this.#pending.values()) pending.reject(cause);
      this.#pending.clear();
    };
    this.#child.once("error", stop);
    this.#child.once("close", (code, signal) => stop(new Error(`MCP server exited with ${code ?? signal ?? "unknown status"}`)));
  }

  request(method: string, params: unknown = {}) {
    const id = ++this.#sequence;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  notify(method: string, params: unknown = {}) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async connect() {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "somite-fake-acp-agent", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const envelope = await this.request("tools/call", { name, arguments: args });
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error(`${name} returned an invalid MCP result`);
    const result = envelope as { isError?: boolean; structuredContent?: unknown };
    if (result.isError) throw new Error(`${name} returned a tool error: ${JSON.stringify(result.structuredContent)}`);
    return result.structuredContent;
  }

  close() {
    this.#child.stdin.end();
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM");
  }
}

function isStdioMcpServer(server: acp.McpServer): server is acp.McpServerStdio {
  return "command" in server;
}

function requestedTool(prompt: string) {
  if (prompt.includes("[test:too-many-permission-choices]")
    || prompt.includes("[test:empty-permission-choices]")
    || prompt.includes("[test:duplicate-permission-choice-id]")
    || prompt.includes("[test:oversized-permission-choice-id]")
    || prompt.includes("[test:oversized-permission-choice-name]")
    || prompt.includes("[test:oversized-permission-choice-aggregate]")) {
    return {
      title: "shell",
      name: "shell",
      rawInput: { command: "printf hostile-permission" },
    };
  }
  if (prompt.includes("[test:unknown-somite-tool]")) {
    return {
      title: "mcp.Somite.somite.workflow.erase",
      name: "mcp.Somite.somite.workflow.erase",
      rawInput: { server: "Somite", tool: "somite.workflow.erase", arguments: {} },
    };
  }
  if (prompt.includes("[test:shell-mislabeled-as-somite]")) {
    return {
      title: "mcp.Somite.somite.workflow.get",
      name: "shell",
      rawInput: { server: "Somite", tool: "somite.workflow.get", arguments: { command: "touch should-not-run" } },
    };
  }
  return {
    title: "mcp.Somite.somite.workflow.get",
    name: "mcp.Somite.somite.workflow.get",
    rawInput: { server: "Somite", tool: "somite.workflow.get", arguments: { path: "reads.fastq", api_key: "private" } },
  };
}

function permissionOptions(prompt: string): acp.PermissionOption[] {
  if (prompt.includes("[test:empty-permission-choices]")) return [];
  if (prompt.includes("[test:duplicate-permission-choice-id]")) {
    return [
      { optionId: "duplicate", name: "First", kind: "allow_once" },
      { optionId: "duplicate", name: "Second", kind: "reject_once" },
    ];
  }
  if (prompt.includes("[test:too-many-permission-choices]")) {
    return Array.from({ length: 40 }, (_, index) => ({
      optionId: `choice-${index}`,
      name: `Choice ${index}`,
      kind: "allow_once" as const,
    }));
  }
  if (prompt.includes("[test:oversized-permission-choice-id]")) {
    return [{ optionId: "🧬".repeat(128), name: "Allow once", kind: "allow_once" }];
  }
  if (prompt.includes("[test:oversized-permission-choice-name]")) {
    return [{ optionId: "allow-once", name: "🧬".repeat(1_024), kind: "allow_once" }];
  }
  if (prompt.includes("[test:oversized-permission-choice-aggregate]")) {
    return Array.from({ length: 24 }, (_, index) => ({
      optionId: `choice-${index}`,
      name: `Choice ${index} ${"x".repeat(256)}`,
      kind: "allow_once" as const,
    }));
  }
  return [
    { optionId: "allow-session", name: "Allow for this session", kind: "allow_always" },
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];
}

function permissionToolCall(
  prompt: string,
  toolCallId: string,
  requested: ReturnType<typeof requestedTool>,
): acp.ToolCallUpdate {
  if (prompt.includes("[test:minimal-correlated-somite-permission]")
    || prompt.includes("[test:reused-minimal-somite-permission]")) return { toolCallId, kind: "execute", status: "pending" };
  if (prompt.includes("[test:conflicting-correlated-permission]")) return { toolCallId, kind: "execute", status: "pending", name: "shell" };
  return {
    toolCallId,
    title: requested.title,
    name: requested.name,
    rawInput: requested.rawInput,
  };
}

async function invokeSomiteTool(
  client: acp.AgentContext,
  sessionId: string,
  mcp: StdioMcpClient,
  name: "somite.workflow.get" | "somite.graph.apply_transaction",
  args: Record<string, unknown>,
) {
  const toolCallId = `tool-${++toolCallSequence}`;
  const toolCall = {
    toolCallId,
    title: `mcp.Somite.${name}`,
    name: `mcp.Somite.${name}`,
    rawInput: { server: "Somite", tool: name, arguments: args },
  };
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "tool_call", ...toolCall, status: "pending" },
  });
  const permission = await client.request<acp.RequestPermissionResponse, acp.RequestPermissionRequest>(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall,
    options: permissionOptions(""),
  });
  if (permission.outcome.outcome !== "selected" || permission.outcome.optionId === "reject") {
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { cancelled: true } },
    });
    throw new Error(`${name} was not approved`);
  }
  try {
    const result = await mcp.callTool(name, args);
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: result },
    });
    return result;
  } catch (cause) {
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { error: cause instanceof Error ? cause.message : String(cause) },
      },
    });
    throw cause;
  }
}

async function applyMcpCanvasTransaction(client: acp.AgentContext, sessionId: string) {
  if (!somiteMcpServer) throw new Error("Somite stdio MCP was not supplied in session/new");
  const mcp = new StdioMcpClient(somiteMcpServer, sessionWorkingDirectory);
  try {
    await mcp.connect();
    const workflow = await invokeSomiteTool(client, sessionId, mcp, "somite.workflow.get", {});
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) throw new Error("workflow.get did not return an object");
    const baseStateRevision = (workflow as Record<string, unknown>).state_revision;
    if (typeof baseStateRevision !== "string") throw new Error("workflow.get did not return state_revision");
    await invokeSomiteTool(client, sessionId, mcp, "somite.graph.apply_transaction", {
      base_state_revision: baseStateRevision,
      idempotency_key: "browser-agent-mcp-fastqc-1",
      summary: "Add a reviewed FastQC step",
      operations: [{
        op: "add_operator",
        node_id: "agent-fastqc",
        operator_id: "qc.fastqc",
        x: 260,
        y: 180,
      }],
    });
  } finally {
    mcp.close();
  }
}

const application = acp.agent({ name: "Somite test agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    somiteClientVersion = params.clientInfo?.version ?? "missing";
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {},
      agentInfo: { name: "somite-test-agent", title: "Somite Test Agent", version: "1.0.0" },
    };
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    sessionWorkingDirectory = params.cwd;
    somiteMcpServer = params.mcpServers.find((server): server is acp.McpServerStdio => server.name === "Somite" && isStdioMcpServer(server));
    return { sessionId: "test-session", configOptions };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    configOptions = configOptions.map((option) => option.id === params.configId && option.type === "select" && typeof params.value === "string"
      ? { ...option, currentValue: params.value }
      : option);
    return { configOptions };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const prompt = params.prompt
      .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `client-version:${somiteClientVersion}` },
      },
    });
    if (prompt.includes(MCP_CANVAS_TRANSACTION_MARKER)) {
      await applyMcpCanvasTransaction(client, params.sessionId);
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Added qc.fastqc through the attached Somite MCP." },
        },
      });
      return { stopReason: "end_turn" };
    }
    if (prompt.includes("[test:stage-stale-somite-tool]")) {
      const requested = requestedTool(prompt);
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-stale-correlation",
          title: requested.title,
          name: requested.name,
          status: "pending",
          rawInput: requested.rawInput,
        },
      });
      return { stopReason: "end_turn" };
    }
    if (prompt.includes("[test:reuse-stale-somite-permission]")) {
      const stale = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "tool-stale-correlation", kind: "execute", status: "pending" },
        options: permissionOptions(prompt),
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: stale.outcome.outcome === "selected" ? `stale:${stale.outcome.optionId}` : "stale:cancelled" },
        },
      });
      return { stopReason: "end_turn" };
    }
    const requested = requestedTool(prompt);
    const toolCallId = `tool-${++toolCallSequence}`;
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: requested.title,
        name: requested.name,
        status: "pending",
        rawInput: requested.rawInput,
      },
    });
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: permissionToolCall(prompt, toolCallId, requested),
      options: permissionOptions(prompt),
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: permission.outcome.outcome === "selected" ? `approved:${permission.outcome.optionId}` : "cancelled" },
      },
    });
    if (prompt.includes("[test:reused-minimal-somite-permission]")) {
      const reused = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId, kind: "execute", status: "pending" },
        options: permissionOptions(prompt),
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reused.outcome.outcome === "selected" ? `reused:${reused.outcome.optionId}` : "reused:cancelled" },
        },
      });
    }
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => undefined);

const connection = application.connect(acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
));
await connection.closed;
