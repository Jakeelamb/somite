import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { SOMITE_VERSION } from "@somite/workflow/version";
import type { AgentTransactionResult } from "@somite/workflow/agentTransaction";
import {
  AgentManager,
  AgentManagerError,
  boundedAgentConfigOptions,
  boundedDetail,
  parseAgentCommand,
  trustedAutomaticMcpPermissionTool,
  trustedSomiteMcpPermissionTool,
} from "../src/agentManager.ts";
import { SOMITE_MCP_TOOL_NAMES } from "../src/mcpTools.ts";

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

test("agent command parsing never invokes a shell and preserves quoted arguments", () => {
  assert.deepEqual(parseAgentCommand(`npx -y "@scope/agent@1.0.0" --mode 'fast mode'`), {
    command: "npx",
    args: ["-y", "@scope/agent@1.0.0", "--mode", "fast mode"],
  });
  assert.deepEqual(parseAgentCommand("agent '$HOME' '$(touch nope)'"), {
    command: "agent",
    args: ["$HOME", "$(touch nope)"],
  });
  assert.deepEqual(parseAgentCommand('"C:\\Program Files\\Somite Agent\\agent.exe" --mode fast'), {
    command: "C:\\Program Files\\Somite Agent\\agent.exe",
    args: ["--mode", "fast"],
  });
  assert.throws(() => parseAgentCommand("agent 'unfinished"), AgentManagerError);
});

test("Agent details and configuration are bounded by UTF-8 bytes", () => {
  const detail = boundedDetail("🧬".repeat(100), 64);
  assert.ok(Buffer.byteLength(detail, "utf8") <= 64);
  assert.ok(detail.endsWith("…"));
  assert.deepEqual(boundedAgentConfigOptions([]), []);
  assert.equal(boundedAgentConfigOptions([{ value: "x".repeat(64) }] as never[], 32), undefined);
});

function agentTransaction(sequence: number, graphName: string): AgentTransactionResult {
  return {
    transaction_id: `transaction-${sequence}`,
    previous_state_revision: `state-${sequence - 1}`,
    state_revision: `state-${sequence}`,
    graph_revision: `graph-${sequence}`,
    summary: `Transaction ${sequence}`,
    graph: { schema_version: 3, name: graphName, nodes: [], edges: [], annotations: [] },
  };
}

test("Agent event retention evicts complete oldest events within one byte envelope", () => {
  const maximumEventBytes = 2_048;
  const manager = new AgentManager("http://127.0.0.1:9", "test-capability", "unused", undefined, {
    eventBytes: maximumEventBytes,
  });
  for (let sequence = 1; sequence <= 12; sequence += 1) {
    manager.recordTransaction(agentTransaction(sequence, "g".repeat(400)));
  }

  const snapshot = manager.snapshot(0, "state-12");
  assert.equal(snapshot.cursor, 12);
  assert.equal(snapshot.authoritative_state_revision, "state-12");
  assert.ok(snapshot.events.length < 12);
  assert.equal(snapshot.events.at(-1)?.transaction?.transaction_id, "transaction-12");
  assert.deepEqual(snapshot.events.map((event) => event.cursor), snapshot.events.map((event) => event.cursor).toSorted((left, right) => left - right));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.events), "utf8") <= maximumEventBytes);
});

test("one oversized Agent transaction becomes a graphless metadata event", () => {
  const manager = new AgentManager("http://127.0.0.1:9", "test-capability", "unused", undefined, {
    eventBytes: 768,
    detailBytes: 256,
  });
  manager.recordTransaction(agentTransaction(1, "g".repeat(4_096)));

  const snapshot = manager.snapshot(0, "state-1");
  assert.equal(snapshot.cursor, 1);
  assert.equal(snapshot.authoritative_state_revision, "state-1");
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.kind, "transaction");
  assert.equal(snapshot.events[0]?.transaction, undefined);
  assert.match(snapshot.events[0]?.detail ?? "", /authoritative canvas/);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.events), "utf8") <= 768);
});

test("every canonical Somite MCP tool has one exact trusted permission identity", () => {
  for (const name of SOMITE_MCP_TOOL_NAMES) {
    assert.equal(trustedSomiteMcpPermissionTool({
      toolCallId: `tool-${name}`,
      title: `mcp.Somite.${name}`,
      name: `mcp.Somite.${name}`,
      rawInput: { server: "Somite", tool: name, arguments: {} },
    }), name);
  }
});

test("bundled Pixi and Nextflow MCP auto-approval is exact and read-only", () => {
  assert.equal(trustedAutomaticMcpPermissionTool({
    toolCallId: "pixi-search",
    title: "mcp.Pixi.pixi_package_search",
    name: "mcp.Pixi.pixi_package_search",
    rawInput: { server: "Pixi", tool: "pixi_package_search", arguments: { spec: "samtools" } },
  }), "pixi_package_search");
  assert.equal(trustedAutomaticMcpPermissionTool({
    toolCallId: "nextflow-lint",
    title: "mcp.Nextflow.nextflow_analyze",
    name: "mcp.Nextflow.nextflow_analyze",
    rawInput: { server: "Nextflow", tool: "nextflow_analyze", arguments: { action: "lint" } },
  }), "nextflow_analyze");
  assert.equal(trustedAutomaticMcpPermissionTool({
    toolCallId: "nextflow-run",
    title: "mcp.Nextflow.nextflow_run",
    name: "mcp.Nextflow.nextflow_run",
    rawInput: { server: "Nextflow", tool: "nextflow_run", arguments: { mode: "full" } },
  }), undefined);
  assert.equal(trustedAutomaticMcpPermissionTool({
    toolCallId: "nextflow-auth-config",
    title: "mcp.Nextflow.nextflow_platform",
    name: "mcp.Nextflow.nextflow_platform",
    rawInput: { server: "Nextflow", tool: "nextflow_platform", arguments: { action: "auth_config" } },
  }), undefined);
  assert.equal(trustedAutomaticMcpPermissionTool({
    toolCallId: "nextflow-secret-read",
    title: "mcp.Nextflow.nextflow_storage",
    name: "mcp.Nextflow.nextflow_storage",
    rawInput: { server: "Nextflow", tool: "nextflow_storage", arguments: { action: "cat", source: ".env" } },
  }), undefined);
  assert.equal(trustedAutomaticMcpPermissionTool({
    toolCallId: "nextflow-source-read",
    title: "mcp.Nextflow.nextflow_storage",
    name: "mcp.Nextflow.nextflow_storage",
    rawInput: { server: "Nextflow", tool: "nextflow_storage", arguments: { action: "cat", source: "main.nf" } },
  }), "nextflow_storage");
  assert.equal(trustedAutomaticMcpPermissionTool({
    toolCallId: "mislabeled",
    title: "mcp.Nextflow.nextflow_docs_read",
    name: "shell",
    rawInput: { server: "Nextflow", tool: "nextflow_docs_read", arguments: {} },
  }), undefined);
});

test("ACP manager streams events, configures the session, and auto-approves only Somite tools", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-agent-transcript-"));
  const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.ts", import.meta.url));
  const manager = new AgentManager("http://127.0.0.1:9", "test-capability", fixture, root);
  context.after(async () => {
    await manager.disconnect().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const command = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fixture)}`;
  await manager.connect(command);
  await until(() => manager.snapshot().connected);
  assert.equal(manager.snapshot().agent_name, "Somite Test Agent");
  assert.equal(manager.snapshot().config_options[0]?.type, "select");

  const configured = await manager.configure("model", "deep");
  const model = configured.config_options[0];
  assert.equal(model?.type === "select" ? model.currentValue : null, "deep");

  await manager.prompt("Inspect the workflow");
  await until(() => !manager.snapshot().busy);
  const snapshot = manager.snapshot();
  assert.ok(snapshot.events.some((event) => event.kind === "message" && event.detail === `client-version:${SOMITE_VERSION}`));
  assert.ok(snapshot.events.some((event) => event.kind === "message" && event.detail === "approved:allow-session"));
  assert.ok(snapshot.events.some((event) => event.kind === "permission" && event.status === "approved" && event.title === "Approve somite.workflow.get"));
  assert.ok(!snapshot.events.some((event) => event.kind === "permission" && event.status === "waiting"));
  const transcript = manager.transcript();
  assert.equal(transcript.messages.at(-1)?.role, "assistant");
  assert.equal(transcript.messages.at(-1)?.text, "approved:allow-session");
  assert.equal(transcript.tool_calls[0]?.title, "somite.workflow.get");
  assert.equal(transcript.tool_calls[0]?.permissions.length, 1);
  assert.deepEqual((transcript.tool_calls[0]?.input as { arguments?: unknown })?.arguments, { path: "reads.fastq", api_key: "[redacted]" });
  await until(() => readdir(join(root, ".somite", "agent-transcripts")).then((files) => files.length === 1).catch(() => false));
  const stored = JSON.parse(await readFile(join(root, ".somite", "agent-transcripts", (await readdir(join(root, ".somite", "agent-transcripts")))[0]!), "utf8"));
  assert.equal(stored.tool_calls[0].input.arguments.api_key, "[redacted]");
  await manager.disconnect();
  await until(() => !manager.snapshot().connected && !manager.snapshot().connecting);
});

test("ACP manager contains Pixi and Nextflow tools in the disposable Agent workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-agent-contained-tools-"));
  const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.ts", import.meta.url));
  const manager = new AgentManager("http://127.0.0.1:9", "test-capability", fixture, root);
  context.after(async () => {
    await manager.disconnect().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const command = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fixture)}`;
  await manager.connect(command);
  await until(() => manager.snapshot().connected);
  const cursor = manager.snapshot().cursor;
  await manager.prompt("[test:mcp-workspace-roots]");
  await until(() => !manager.snapshot().busy);
  const detail = manager.snapshot(cursor).events.find((event) => event.kind === "message" && event.detail?.startsWith("{"))?.detail;
  assert.ok(detail);
  const attached = JSON.parse(detail) as { cwd: string; servers: Array<{ name: string; args: string[] }> };
  assert.notEqual(attached.cwd, root);
  for (const name of ["Pixi", "Nextflow"]) {
    const server = attached.servers.find((candidate) => candidate.name === name);
    assert.ok(server);
    assert.equal(server.args[server.args.indexOf("--workspace-root") + 1], attached.cwd);
  }
});

test("ACP manager never auto-approves unknown Somite labels or shell actions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-agent-permissions-"));
  const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.ts", import.meta.url));
  const manager = new AgentManager("http://127.0.0.1:9", "test-capability", fixture, root);
  context.after(async () => {
    await manager.disconnect().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const command = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fixture)}`;
  await manager.connect(command);
  await until(() => manager.snapshot().connected);

  for (const [prompt, title] of [
    ["[test:unknown-somite-tool]", "Approve somite.workflow.erase"],
    ["[test:shell-mislabeled-as-somite]", "Approve shell (claims somite.workflow.get)"],
    ["[test:conflicting-correlated-permission]", "Approve shell"],
  ]) {
    const cursor = manager.snapshot().cursor;
    await manager.prompt(prompt);
    await until(() => {
      const snapshot = manager.snapshot(cursor);
      return !snapshot.busy || snapshot.events.some((event) => event.kind === "permission" && event.status === "waiting");
    });
    const waiting = manager.snapshot(cursor).events.find((event) => event.kind === "permission" && event.status === "waiting");
    assert.ok(waiting, `${title} must wait for the user`);
    assert.equal(waiting.title, title);
    assert.ok(waiting.permission_id);
    manager.answerPermission(waiting.permission_id);
    await until(() => !manager.snapshot().busy);
  }
});

test("ACP manager requires approval and redacts sensitive storage output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-agent-sensitive-output-"));
  const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.ts", import.meta.url));
  const manager = new AgentManager("http://127.0.0.1:9", "test-capability", fixture, root);
  context.after(async () => {
    await manager.disconnect().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const command = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fixture)}`;
  await manager.connect(command);
  await until(() => manager.snapshot().connected);
  await manager.prompt("[test:sensitive-storage-read]");
  await until(() => manager.snapshot().events.some((event) => event.kind === "permission" && event.status === "waiting"));
  const waiting = manager.snapshot().events.find((event) => event.kind === "permission" && event.status === "waiting");
  assert.ok(waiting?.permission_id);
  const allow = waiting.permission_choices?.find((choice) => choice.kind === "allow_once");
  assert.ok(allow);
  manager.answerPermission(waiting.permission_id, allow.option_id);
  await until(() => !manager.snapshot().busy);
  const transcript = manager.transcript();
  assert.equal(transcript.tool_calls.at(-1)?.output, "[redacted sensitive tool output]");
  assert.doesNotMatch(JSON.stringify(transcript), /should-never-persist/);
});

test("ACP manager correlates one canonical Somite update to Codex ACP's sparse permission request", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-agent-minimal-permission-"));
  const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.ts", import.meta.url));
  const manager = new AgentManager("http://127.0.0.1:9", "test-capability", fixture, root);
  context.after(async () => {
    await manager.disconnect().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const command = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fixture)}`;
  await manager.connect(command);
  await until(() => manager.snapshot().connected);

  let cursor = manager.snapshot().cursor;
  await manager.prompt("[test:minimal-correlated-somite-permission]");
  await until(() => {
    const snapshot = manager.snapshot(cursor);
    return !snapshot.busy || snapshot.events.some((event) => event.kind === "permission" && event.status === "waiting");
  });
  let events = manager.snapshot(cursor).events;
  assert.ok(!events.some((event) => event.kind === "permission" && event.status === "waiting"));
  await until(() => !manager.snapshot().busy);
  events = manager.snapshot(cursor).events;
  assert.ok(events.some((event) => event.kind === "permission" && event.status === "approved" && event.title === "Approve somite.workflow.get"));
  assert.ok(events.some((event) => event.kind === "message" && event.detail === "approved:allow-session"));

  cursor = manager.snapshot().cursor;
  await manager.prompt("[test:reused-minimal-somite-permission]");
  await until(() => manager.snapshot(cursor).events.some((event) => event.kind === "permission" && event.status === "waiting"));
  events = manager.snapshot(cursor).events;
  assert.equal(events.filter((event) => event.kind === "permission" && event.status === "approved").length, 1);
  const reused = events.find((event) => event.kind === "permission" && event.status === "waiting");
  assert.ok(reused?.permission_id);
  assert.equal(reused.title, `Approve Tool ${reused.tool_call_id}`);
  manager.answerPermission(reused.permission_id);
  await until(() => !manager.snapshot().busy);
  assert.ok(manager.snapshot(cursor).events.some((event) => event.kind === "message" && event.detail === "reused:cancelled"));

  await manager.prompt("[test:stage-stale-somite-tool]");
  await until(() => !manager.snapshot().busy);
  cursor = manager.snapshot().cursor;
  await manager.prompt("[test:reuse-stale-somite-permission]");
  await until(() => manager.snapshot(cursor).events.some((event) => event.kind === "permission" && event.status === "waiting"));
  const stale = manager.snapshot(cursor).events.find((event) => event.kind === "permission" && event.status === "waiting");
  assert.ok(stale?.permission_id);
  assert.equal(stale.title, "Approve Tool tool-stale-correlation");
  manager.answerPermission(stale.permission_id);
  await until(() => !manager.snapshot().busy);
  assert.ok(manager.snapshot(cursor).events.some((event) => event.kind === "message" && event.detail === "stale:cancelled"));
});

test("ACP manager cancels oversized permission choices without an invisible wait", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "somite-agent-hostile-permissions-"));
  const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.ts", import.meta.url));
  const manager = new AgentManager("http://127.0.0.1:9", "test-capability", fixture, root, {
    detailBytes: 4_096,
    eventBytes: 16_384,
  });
  context.after(async () => {
    await manager.disconnect().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const command = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fixture)}`;
  await manager.connect(command);
  await until(() => manager.snapshot().connected);

  for (const [prompt, reason] of [
    ["[test:empty-permission-choices]", /between 1 and 32/],
    ["[test:duplicate-permission-choice-id]", /was repeated/],
    ["[test:too-many-permission-choices]", /sent 40 choices/],
    ["[test:oversized-permission-choice-id]", /ID exceeded 256 UTF-8 bytes/],
    ["[test:oversized-permission-choice-name]", /name exceeded 1024 UTF-8 bytes/],
    ["[test:oversized-permission-choice-aggregate]", /exceeded the 4096-byte visible event allowance/],
  ] as const) {
    const cursor = manager.snapshot().cursor;
    const started = Date.now();
    await manager.prompt(prompt);
    await until(() => !manager.snapshot().busy, 3_000);
    assert.ok(Date.now() - started < 3_000, "invalid permission request must settle promptly");
    const events = manager.snapshot(cursor).events;
    assert.ok(!events.some((event) => event.kind === "permission" && event.status === "waiting"));
    const rejected = events.find((event) => event.title === "Agent permission request cancelled" && event.status === "cancelled");
    assert.ok(rejected, `${prompt} must emit an actionable cancellation`);
    assert.match(rejected.detail ?? "", reason);
    assert.ok(Buffer.byteLength(rejected.detail ?? "", "utf8") <= 4_096);
    assert.ok(events.some((event) => event.kind === "message" && event.detail === "cancelled"));
  }

  const cursor = manager.snapshot().cursor;
  await manager.prompt("Inspect the workflow after a rejected permission request");
  await until(() => !manager.snapshot().busy, 3_000);
  const recoveryEvents = manager.snapshot(cursor).events;
  assert.ok(recoveryEvents.some((event) => event.kind === "message" && event.detail === "approved:allow-session"));
});

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function hostileStdoutSettles(context: TestContext, mode: "newline-free" | "oversized-frame") {
  const root = await mkdtemp(join(tmpdir(), `somite-agent-${mode}-`));
  const pidPath = join(root, "child.pid");
  const fixture = fileURLToPath(new URL("./fixtures/hostile-acp-stdout.ts", import.meta.url));
  const manager = new AgentManager("http://127.0.0.1:9", "test-capability", "unused", root, {
    acpFrameBytes: 1_024,
    detailBytes: 128,
  });
  context.after(async () => {
    await manager.disconnect().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const command = [
    JSON.stringify(process.execPath),
    "--experimental-strip-types",
    JSON.stringify(fixture),
    mode,
    JSON.stringify(pidPath),
    "2048",
  ].join(" ");

  await manager.connect(command);
  await until(() => manager.snapshot().events.some((event) => event.kind === "error" && /ACP stdout frame exceeds/.test(event.detail ?? "")));
  const pid = Number((await readFile(pidPath, "utf8")).trim());
  assert.ok(Number.isSafeInteger(pid));
  await until(() => !processIsAlive(pid));
  const snapshot = manager.snapshot();
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.connecting, false);
  assert.equal(snapshot.busy, false);
  const stopped = snapshot.events.find((event) => event.title === "ACP agent stopped" && event.status === "failed");
  assert.ok(stopped);
  assert.match(stopped.detail ?? "", /acp_frame_too_large/);
  assert.ok(Buffer.byteLength(stopped.detail ?? "", "utf8") <= 128);
  await assert.rejects(manager.disconnect(), (error: unknown) => error instanceof AgentManagerError && error.code === "not_connected");
}

test("ACP manager terminates a child that floods stdout without an NDJSON newline", async (context) => {
  await hostileStdoutSettles(context, "newline-free");
});

test("ACP manager terminates a child that emits one oversized NDJSON frame", async (context) => {
  await hostileStdoutSettles(context, "oversized-frame");
});
