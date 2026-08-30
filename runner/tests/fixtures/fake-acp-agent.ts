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

const application = acp.agent({ name: "Somite test agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    agentInfo: { name: "somite-test-agent", title: "Somite Test Agent", version: "1.0.0" },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "test-session", configOptions }))
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    configOptions = configOptions.map((option) => option.id === params.configId && option.type === "select" && typeof params.value === "string"
      ? { ...option, currentValue: params.value }
      : option);
    return { configOptions };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "mcp.Somite.somite.workflow.get",
        name: "mcp.Somite.somite.workflow.get",
        status: "pending",
        rawInput: { server: "Somite", tool: "somite.workflow.get", arguments: { path: "reads.fastq", api_key: "private" } },
      },
    });
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "tool-1",
        title: "mcp.Somite.somite.workflow.get",
        name: "mcp.Somite.somite.workflow.get",
        rawInput: { server: "Somite", tool: "somite.workflow.get", arguments: { path: "reads.fastq", api_key: "private" } },
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
