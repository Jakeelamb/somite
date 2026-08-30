import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { AgentTransactionResult } from "@somite/workflow/agentTransaction";
import { SOMITE_VERSION } from "@somite/workflow/version";
import { atomicWrite, ensurePrivateDirectory } from "./files.ts";
import { isSomiteMcpToolName, type SomiteMcpToolName } from "./mcpTools.ts";

const EVENT_LIMIT = 4_096;
const TRANSACTION_EVENT_LIMIT = 32;
const MAX_PROMPT_BYTES = 64 * 1024;

const WORKFLOW_AGENT_CONTRACT = `You are the Agent embedded in Somite. The current Somite canvas is the work product.

Work through the Somite MCP tools immediately. Do not inspect or modify the Somite repository, run shell commands, read project files directly, or create workflow JSON by hand. Do not use developer tools to discover capabilities that Somite already exposes.

Begin by inspecting the current workflow. Search exact catalog contracts instead of inventing operator ids, ports, parameters, or revisions. Use short single-concept catalog queries. Discover exact nf-core repositories and releases through Somite's nf-core source search, then import through its source workflow resolver; never fabricate nf.* execution operators or add the bare workflow.source infrastructure operator. Edit source-backed intent only through its typed source editor. If the user wants to rewire a selected invocation replacement, promote that call to the native canvas first, then use ordinary typed graph edits. When current NCBI or Ensembl data is relevant, use Somite source search before leaving the application.

Generic web research is allowed only when the request genuinely requires current external evidence that no Somite tool can provide. Return immediately to Somite tools. Never use generic web research to inspect Somite's repository or operator contracts.

Before editing, identify every required non-optional input in the selected contracts. Apply a small coherent canvas transaction as soon as available information supports one. Do not ask for confirmation before ordinary reversible canvas edits. After editing, call Somite readiness and use its typed requirements. Build a scientifically useful partial graph when local resources are missing, report exact blockers, and do not compile or validate until readiness is clear. Never claim a workflow is runnable unless validation completed successfully.

Do not narrate a plan before the first relevant Somite tool call. Keep the final response short and centered on canvas changes, exact blockers, revisions, and validation evidence.

User request:`;

export type AgentPermissionChoice = {
  option_id: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "other";
};

export type AgentEvent = {
  cursor: number;
  recorded_at_unix_ms: number;
  kind: "status" | "user" | "message" | "tool" | "transaction" | "permission" | "error";
  title: string;
  detail?: string;
  status?: string;
  transaction?: AgentTransactionResult;
  permission_id?: string;
  tool_call_id?: string;
  permission_choices?: AgentPermissionChoice[];
};

export type AgentSnapshot = {
  connected: boolean;
  connecting: boolean;
  busy: boolean;
  agent_name?: string;
  config_options: acp.SessionConfigOption[];
  cursor: number;
  events: AgentEvent[];
  authoritative_state_revision?: string;
};

type PendingPermission = {
  options: Set<string>;
  resolve: (option: string | undefined) => void;
  timer: NodeJS.Timeout;
};

type Runtime = {
  generation: number;
  workspace: string;
  child: ChildProcess;
  connection?: acp.ClientConnection;
  sessionId?: string;
  shuttingDown: boolean;
  stderr: string;
};

export class AgentManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function error(code: string, message: string): never {
  throw new AgentManagerError(code, message);
}

function terminateTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 3_000);
  timer.unref();
}

/** Parse a displayed launch command without invoking a shell. */
export function parseAgentCommand(command: string) {
  const trimmed = command.trim();
  if (!trimmed) error("empty_command", "agent command must not be empty");
  if (trimmed.length > 4_096 || /[\0\r\n]/.test(trimmed)) error("invalid_command", "agent command is too long or contains control characters");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    const next = trimmed[index + 1];
    const escaped = character === "\\" && quote !== "'" && next !== undefined
      && (next === "\\" || next === '"' || (quote === null && (next === "'" || /\s/.test(next))));
    if (escaped) {
      current += next;
      index += 1;
      started = true;
    } else if (character === "\\") {
      current += character;
      started = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (quote) error("invalid_command", "agent command has an unfinished quote");
  if (started) tokens.push(current);
  if (!tokens.length || tokens.some((token) => token.includes("\0"))) error("invalid_command", "agent command is invalid");
  return { command: tokens[0]!, args: tokens.slice(1) };
}

function boundedDetail(value: unknown) {
  const detail = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
  return detail.length <= 64 * 1024 ? detail : `${detail.slice(0, 64 * 1024)}\n…`;
}

function redactedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactedValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, nested]) => {
    const normalized = name.toLowerCase().replaceAll("-", "").replaceAll("_", "");
    const sensitive = ["authorization", "apikey", "accesstoken", "refreshtoken", "password", "passwd", "credential", "secret"]
      .some((marker) => normalized.includes(marker));
    return [name, sensitive ? "[redacted]" : redactedValue(nested)];
  }));
}

function transcriptValue(detail: string | undefined) {
  if (!detail) return undefined;
  try { return redactedValue(JSON.parse(detail) as unknown); } catch { return detail; }
}

function toolAction(tool: acp.ToolCallUpdate) {
  const input = tool.rawInput && typeof tool.rawInput === "object" && !Array.isArray(tool.rawInput)
    ? tool.rawInput as Record<string, unknown>
    : undefined;
  const rawTool = typeof input?.tool === "string" ? input.tool : undefined;
  const presented = (tool.name ?? tool.title)?.replace(/^mcp\.Somite\./, "");
  if (rawTool && presented && rawTool !== presented) return `${presented} (claims ${rawTool})`;
  return rawTool ?? presented ?? `Tool ${tool.toolCallId}`;
}

function presentedSomiteToolName(value: unknown): SomiteMcpToolName | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.replace(/^mcp\.Somite\./, "");
  return isSomiteMcpToolName(candidate) ? candidate : undefined;
}

/** Trust only a canonical tool attributed consistently to Somite's MCP server. */
export function trustedSomiteMcpPermissionTool(tool: acp.ToolCallUpdate): SomiteMcpToolName | undefined {
  const input = tool.rawInput && typeof tool.rawInput === "object" && !Array.isArray(tool.rawInput)
    ? tool.rawInput as Record<string, unknown>
    : undefined;
  if (input?.server !== "Somite" || !isSomiteMcpToolName(input.tool)) return undefined;
  const presented = tool.name === undefined
    ? presentedSomiteToolName(tool.title)
    : presentedSomiteToolName(tool.name);
  return presented === input.tool ? input.tool : undefined;
}

function permissionDetail(request: acp.RequestPermissionRequest, action: string) {
  const input = request.toolCall.rawInput && typeof request.toolCall.rawInput === "object" && !Array.isArray(request.toolCall.rawInput)
    ? request.toolCall.rawInput as Record<string, unknown>
    : undefined;
  const argumentsValue = input?.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
    ? input.arguments as Record<string, unknown>
    : input;
  const parts = [`Tool call \`${request.toolCall.toolCallId}\``];
  if (typeof argumentsValue?.summary === "string") parts.push(argumentsValue.summary);
  if (Array.isArray(argumentsValue?.operations)) parts.push(`${argumentsValue.operations.length} operation${argumentsValue.operations.length === 1 ? "" : "s"}`);
  return { title: `Approve ${action}`, detail: parts.join(" · ") };
}

function timeout<T>(promise: Promise<T>, milliseconds: number, label: string) {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, rejectPromise) => {
      timer = setTimeout(() => rejectPromise(new Error(`${label} timed out`)), milliseconds);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer!));
}

export class AgentManager {
  readonly #serverUrl: string;
  readonly #mcpCapability: string;
  readonly #mcpPath: string;
  readonly #projectRoot?: string;
  #runtime?: Runtime;
  #generation = 0;
  #cursor = 0;
  #events: AgentEvent[] = [];
  #connected = false;
  #connecting = false;
  #busy = false;
  #agentName?: string;
  #configOptions: acp.SessionConfigOption[] = [];
  #permissionSequence = 0;
  #permissions = new Map<string, PendingPermission>();

  constructor(serverUrl: string, mcpCapability: string, mcpPath = fileURLToPath(new URL("./mcp.ts", import.meta.url)), projectRoot?: string) {
    this.#serverUrl = serverUrl;
    this.#mcpCapability = mcpCapability;
    this.#mcpPath = mcpPath;
    this.#projectRoot = projectRoot;
  }

  snapshot(after = 0, authoritativeStateRevision?: string): AgentSnapshot {
    return {
      connected: this.#connected,
      connecting: this.#connecting,
      busy: this.#busy,
      ...(this.#agentName ? { agent_name: this.#agentName } : {}),
      config_options: structuredClone(this.#configOptions),
      cursor: this.#cursor,
      events: this.#events.filter((event) => event.cursor > after).map((event) => structuredClone(event)),
      ...(authoritativeStateRevision ? { authoritative_state_revision: authoritativeStateRevision } : {}),
    };
  }

  transcript() {
    const start = this.#events.findLastIndex((event) => event.kind === "user");
    const events = this.#events.slice(start >= 0 ? start : 0);
    const messages: Array<Record<string, unknown>> = [];
    const toolCalls: Array<Record<string, unknown> & { statuses: string[]; permissions: unknown[] }> = [];
    const toolIndices = new Map<string, number>();
    const transactions: AgentTransactionResult[] = [];
    const activity: AgentEvent[] = [];
    let previousMessageRole: string | undefined;
    for (const event of events) {
      const role = event.kind === "user" ? "user" : event.kind === "message" ? "assistant" : undefined;
      if (role) {
        const previous = messages.at(-1);
        if (previousMessageRole === role && previous) {
          previous.text = `${String(previous.text ?? "")}${event.detail ?? ""}`;
          previous.cursor_end = event.cursor;
          previous.finished_at_unix_ms = event.recorded_at_unix_ms;
        } else {
          messages.push({
            role,
            text: event.detail ?? "",
            cursor_start: event.cursor,
            cursor_end: event.cursor,
            started_at_unix_ms: event.recorded_at_unix_ms,
            finished_at_unix_ms: event.recorded_at_unix_ms,
          });
        }
        previousMessageRole = role;
        continue;
      }
      previousMessageRole = undefined;
      if (event.tool_call_id) {
        let index = toolIndices.get(event.tool_call_id);
        if (index === undefined) {
          index = toolCalls.length;
          toolIndices.set(event.tool_call_id, index);
          toolCalls.push({
            tool_call_id: event.tool_call_id,
            title: event.title.replace(/^mcp\.Somite\./, ""),
            statuses: [],
            permissions: [],
            started_at_unix_ms: event.recorded_at_unix_ms,
            finished_at_unix_ms: event.recorded_at_unix_ms,
          });
        }
        const tool = toolCalls[index]!;
        tool.finished_at_unix_ms = event.recorded_at_unix_ms;
        if (String(tool.title).startsWith("Tool ") && !event.title.startsWith("Tool ")) tool.title = event.title.replace(/^mcp\.Somite\./, "");
        if (event.status && tool.statuses.at(-1) !== event.status) tool.statuses.push(event.status);
        if (event.kind === "permission") {
          tool.permissions.push({
            permission_id: event.permission_id,
            title: event.title,
            detail: event.detail ?? "",
            choices: event.permission_choices ?? [],
            recorded_at_unix_ms: event.recorded_at_unix_ms,
          });
        } else if (event.kind === "tool") {
          if (["completed", "failed", "cancelled"].includes(event.status ?? "")) tool.output = transcriptValue(event.detail);
          else if (tool.input === undefined) tool.input = transcriptValue(event.detail);
        }
        continue;
      }
      if (event.kind === "transaction" && event.transaction) transactions.push(redactedValue(structuredClone(event.transaction)) as AgentTransactionResult);
      else activity.push(structuredClone(event));
    }
    const now = Date.now();
    return {
      schema_version: 1,
      ...(this.#agentName ? { agent_name: this.#agentName } : {}),
      config_options: structuredClone(this.#configOptions),
      cursor_start: events[0]?.cursor ?? this.#cursor,
      cursor_end: events.at(-1)?.cursor ?? this.#cursor,
      started_at_unix_ms: events[0]?.recorded_at_unix_ms ?? now,
      finished_at_unix_ms: events.at(-1)?.recorded_at_unix_ms ?? now,
      raw_event_count: events.length,
      messages,
      tool_calls: toolCalls,
      transactions,
      activity,
    };
  }

  recordTransaction(transaction: AgentTransactionResult) {
    this.#push({ kind: "transaction", title: transaction.summary, detail: `${transaction.previous_state_revision} → ${transaction.state_revision}`, status: "completed", transaction });
  }

  async connect(displayCommand: string) {
    if (this.#runtime || this.#connecting || this.#connected) error("already_connected", "agent is already connected");
    const launch = parseAgentCommand(displayCommand);
    const workspace = await mkdtemp(join(tmpdir(), "somite-workflow-agent-"));
    const generation = ++this.#generation;
    const child = spawn(launch.command, launch.args, {
      cwd: workspace,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const runtime: Runtime = { generation, workspace, child, shuttingDown: false, stderr: "" };
    this.#runtime = runtime;
    child.stderr?.on("data", (chunk: Buffer) => { runtime.stderr = `${runtime.stderr}${chunk.toString("utf8")}`.slice(-64 * 1024); });
    child.once("error", (cause) => this.#finishRuntime(runtime, cause));
    child.once("close", (code, signal) => {
      const cause = runtime.shuttingDown ? undefined : new Error(runtime.stderr.trim() || `agent exited with ${code ?? signal ?? "unknown status"}`);
      this.#finishRuntime(runtime, cause);
    });
    this.#connecting = true;
    this.#connected = false;
    this.#busy = false;
    this.#agentName = undefined;
    this.#configOptions = [];
    this.#push({ kind: "status", title: "Connecting ACP agent", detail: "Somite is initializing the selected agent in an isolated workspace.", status: "connecting" });
    void this.#bootstrap(runtime).catch((cause) => this.#finishRuntime(runtime, cause));
    return this.snapshot();
  }

  async prompt(message: string) {
    const trimmed = this.preflightPrompt(message);
    const runtime = this.#readyRuntime();
    this.#busy = true;
    this.#push({ kind: "user", title: "You", detail: trimmed });
    void this.#runPrompt(runtime, `${WORKFLOW_AGENT_CONTRACT}\n\n${trimmed}`);
  }

  preflightPrompt(message: string) {
    const trimmed = message.trim();
    if (!trimmed || new TextEncoder().encode(trimmed).byteLength > MAX_PROMPT_BYTES) error("invalid_prompt", `prompt must contain between 1 and ${MAX_PROMPT_BYTES} bytes`);
    this.#readyRuntime();
    if (this.#busy) error("busy", "agent is still working");
    return trimmed;
  }

  async configure(configId: string, value: string | boolean) {
    const runtime = this.#readyRuntime();
    if (this.#busy) error("busy", "agent is still working");
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(configId) || !this.#configOptions.some((option) => option.id === configId)) {
      error("invalid_config_option", "invalid agent configuration option");
    }
    const response = await runtime.connection!.agent.request(acp.methods.agent.session.setConfigOption, typeof value === "boolean"
      ? { sessionId: runtime.sessionId!, configId, type: "boolean", value }
      : { sessionId: runtime.sessionId!, configId, value });
    this.#configOptions = response.configOptions;
    this.#push({ kind: "status", title: "Agent configuration updated", detail: configId, status: "ready" });
    return this.snapshot(this.#cursor);
  }

  async cancel() {
    const runtime = this.#readyRuntime();
    await runtime.connection!.agent.notify(acp.methods.agent.session.cancel, { sessionId: runtime.sessionId! });
    this.#cancelPermissions();
  }

  async disconnect() {
    const runtime = this.#runtime;
    if (!runtime) error("not_connected", "agent is not connected");
    const closed = runtime.child.exitCode !== null || runtime.child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => runtime.child.once("close", () => resolvePromise()));
    runtime.shuttingDown = true;
    if (runtime.connection && runtime.sessionId) {
      await runtime.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: runtime.sessionId }).catch(() => undefined);
      runtime.connection.close();
    }
    this.#cancelPermissions();
    terminateTree(runtime.child);
    await timeout(closed, 4_000, "Agent shutdown").catch(() => undefined);
  }

  answerPermission(permissionId: string, optionId?: string) {
    const pending = this.#permissions.get(permissionId);
    if (!pending) error("invalid_permission", `unknown permission ${permissionId}`);
    if (optionId !== undefined && !pending.options.has(optionId)) error("invalid_permission", `unknown permission option ${optionId}`);
    clearTimeout(pending.timer);
    this.#permissions.delete(permissionId);
    pending.resolve(optionId);
    this.#push({ kind: "status", title: "Agent permission resolved", detail: optionId ?? "Permission request cancelled", status: optionId ? "answered" : "cancelled" });
  }

  async #bootstrap(runtime: Runtime) {
    const stdin = runtime.child.stdin;
    const stdout = runtime.child.stdout;
    if (!stdin || !stdout) throw new Error("agent did not expose ACP stdio");
    const app = acp.client({ name: "Somite" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.#requestPermission(params))
      .onNotification(acp.methods.client.session.update, ({ params }) => this.#recordUpdate(params.update));
    const connection = app.connect(acp.ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
    ));
    runtime.connection = connection;
    const initialized = await timeout(connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
      clientInfo: { name: "somite", title: "Somite", version: SOMITE_VERSION },
    }), 30_000, "ACP initialization");
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Somite supports stable ACP protocol version ${acp.PROTOCOL_VERSION}`);
    const session = await timeout(connection.agent.request(acp.methods.agent.session.new, {
      cwd: runtime.workspace,
      mcpServers: [{
        name: "Somite",
        command: process.execPath,
        args: ["--experimental-strip-types", this.#mcpPath, "--server-url", this.#serverUrl],
        env: [{ name: "SOMITE_MCP_RUNTIME_CAPABILITY", value: this.#mcpCapability }],
      }],
    }), 45_000, "ACP session creation");
    if (this.#runtime?.generation !== runtime.generation) return;
    runtime.sessionId = session.sessionId;
    this.#configOptions = session.configOptions ?? [];
    this.#agentName = initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? "ACP agent";
    this.#connecting = false;
    this.#connected = true;
    this.#push({ kind: "status", title: `${this.#agentName} connected`, detail: "Stable ACP v1 · Somite tools attached over stdio", status: "ready" });
    void connection.closed.then(() => {
      if (this.#runtime?.generation === runtime.generation) {
        this.#finishRuntime(runtime, runtime.shuttingDown ? undefined : new Error(runtime.stderr.trim() || "ACP connection closed"));
      }
    });
  }

  async #runPrompt(runtime: Runtime, prompt: string) {
    try {
      const response = await runtime.connection!.agent.request(acp.methods.agent.session.prompt, {
        sessionId: runtime.sessionId!,
        prompt: [{ type: "text", text: prompt }],
      });
      this.#push({ kind: "status", title: "Agent turn finished", detail: response.stopReason, status: response.stopReason === "end_turn" ? "completed" : response.stopReason });
    } catch (cause) {
      this.#push({ kind: "error", title: "Agent turn failed", detail: cause instanceof Error ? cause.message : String(cause), status: "failed" });
    } finally {
      if (this.#runtime?.generation === runtime.generation) this.#busy = false;
      void this.#persistTranscript().catch((cause) => this.#push({
        kind: "error",
        title: "Agent transcript could not be saved",
        detail: cause instanceof Error ? cause.message : String(cause),
        status: "failed",
      }));
    }
  }

  async #persistTranscript() {
    if (!this.#projectRoot) return;
    const transcript = this.transcript();
    const directory = await ensurePrivateDirectory(this.#projectRoot, ".somite/agent-transcripts");
    await atomicWrite(join(directory, `turn-${transcript.started_at_unix_ms}-${transcript.finished_at_unix_ms}.json`), `${JSON.stringify(transcript, null, 2)}\n`);
  }

  #recordUpdate(update: acp.SessionUpdate) {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.#push({ kind: "message", title: "Agent", detail: update.content.text });
    } else if (update.sessionUpdate === "tool_call") {
      this.#push({ kind: "tool", title: update.title, detail: boundedDetail(update.rawInput), status: update.status ?? "pending", tool_call_id: update.toolCallId });
    } else if (update.sessionUpdate === "tool_call_update") {
      this.#push({ kind: "tool", title: update.title ?? `Tool ${update.toolCallId}`, detail: boundedDetail(update.rawOutput), ...(update.status ? { status: update.status } : {}), tool_call_id: update.toolCallId });
    } else if (update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
      this.#push({ kind: "status", title: "Agent plan updated", detail: boundedDetail(update), status: "planning" });
    } else if (update.sessionUpdate === "config_option_update") {
      this.#configOptions = update.configOptions;
      this.#push({ kind: "status", title: "Agent options refreshed", detail: "Models and session options were updated by the agent.", status: "ready" });
    }
  }

  async #requestPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const action = toolAction(request.toolCall);
    const fields = permissionDetail(request, action);
    const choices: AgentPermissionChoice[] = request.options.map((option) => ({
      option_id: option.optionId,
      name: option.name,
      kind: option.kind,
    }));
    const automatic = trustedSomiteMcpPermissionTool(request.toolCall)
      ? choices.find((choice) => choice.kind === "allow_always" && choice.name.toLowerCase().includes("session"))
        ?? choices.find((choice) => choice.kind === "allow_once")
      : undefined;
    const permissionId = `permission-${++this.#permissionSequence}`;
    if (automatic) {
      this.#push({ kind: "permission", ...fields, detail: `${fields.detail} · Automatically allowed for this Somite session`, status: "approved", permission_id: permissionId, permission_choices: [], tool_call_id: request.toolCall.toolCallId });
      return { outcome: { outcome: "selected", optionId: automatic.option_id } };
    }
    const selected = await new Promise<string | undefined>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.#permissions.delete(permissionId);
        resolvePromise(undefined);
      }, 300_000);
      timer.unref();
      this.#permissions.set(permissionId, { options: new Set(choices.map((choice) => choice.option_id)), resolve: resolvePromise, timer });
      this.#push({ kind: "permission", ...fields, status: "waiting", permission_id: permissionId, permission_choices: choices, tool_call_id: request.toolCall.toolCallId });
    });
    return selected ? { outcome: { outcome: "selected", optionId: selected } } : { outcome: { outcome: "cancelled" } };
  }

  #readyRuntime() {
    const runtime = this.#runtime;
    if (!runtime || !this.#connected || !runtime.connection || !runtime.sessionId) error("not_connected", "agent is not connected");
    return runtime;
  }

  #cancelPermissions() {
    for (const pending of this.#permissions.values()) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    this.#permissions.clear();
  }

  #push(event: Omit<AgentEvent, "cursor" | "recorded_at_unix_ms">) {
    this.#cursor += 1;
    this.#events.push({ cursor: this.#cursor, recorded_at_unix_ms: Date.now(), ...event });
    while (this.#events.filter((candidate) => candidate.transaction).length > TRANSACTION_EVENT_LIMIT) {
      const index = this.#events.findIndex((candidate) => candidate.transaction);
      if (index < 0) break;
      this.#events.splice(index, 1);
    }
    if (this.#events.length > EVENT_LIMIT) this.#events.splice(0, this.#events.length - EVENT_LIMIT);
  }

  #finishRuntime(runtime: Runtime, cause?: unknown) {
    if (this.#runtime?.generation !== runtime.generation) return;
    this.#runtime = undefined;
    this.#connecting = false;
    this.#connected = false;
    this.#busy = false;
    this.#agentName = undefined;
    this.#configOptions = [];
    this.#cancelPermissions();
    runtime.connection?.close();
    terminateTree(runtime.child);
    void rm(runtime.workspace, { recursive: true, force: true });
    if (cause) this.#push({ kind: "error", title: "ACP agent stopped", detail: cause instanceof Error ? cause.message : String(cause), status: "failed" });
    else this.#push({ kind: "status", title: "ACP agent disconnected", detail: "The canvas and Somite tools remain available.", status: "disconnected" });
  }
}
