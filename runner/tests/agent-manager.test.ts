import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SOMITE_VERSION } from "@somite/workflow/version";
import { AgentManager, AgentManagerError, parseAgentCommand, trustedSomiteMcpPermissionTool } from "../src/agentManager.ts";
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
