import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

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

function requestedTool(prompt: string) {
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

const application = acp.agent({ name: "Somite test agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    somiteClientVersion = params.clientInfo?.version ?? "missing";
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {},
      agentInfo: { name: "somite-test-agent", title: "Somite Test Agent", version: "1.0.0" },
    };
  })
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "test-session", configOptions }))
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
      toolCall: {
        toolCallId,
        title: requested.title,
        name: requested.name,
        rawInput: requested.rawInput,
      },
      options: [
        { optionId: "allow-session", name: "Allow for this session", kind: "allow_always" },
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: permission.outcome.outcome === "selected" ? `approved:${permission.outcome.optionId}` : "cancelled" },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => undefined);

const connection = application.connect(acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
));
await connection.closed;
