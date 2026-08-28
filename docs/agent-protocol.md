# Agent integration

Somite has one optional agent boundary. It does not bundle a model, choose a
provider, or invent agent modes. The user starts one trusted
[ACP-compatible agent](https://agentclientprotocol.com/protocol/v1/overview),
and Somite remains useful when no agent is connected.

## Protocol split

ACP is the conversation boundary between the web workspace and the user's
agent. Somite negotiates stable ACP v1, launches the agent and creates its
session in one disposable empty workspace, sends prompts, renders streamed
messages and tool activity, surfaces permission requests, and supports
cancellation. This prevents repository instructions and direct filesystem
inspection from silently displacing the native workflow tools. The real project
remains reachable through Somite's capability surface, and normalized
transcripts are still persisted there. The session receives Somite's MCP server
in its `session/new` request, using ACP's mandatory stdio MCP transport.

MCP is the capability boundary between the agent and Somite. The server is the
same `somite-server` executable in a protocol-only mode:

```bash
somite-server mcp --server-url http://127.0.0.1:7310
```

Standard output is reserved for newline-delimited MCP JSON-RPC. Operational
logging never initializes in this mode. The MCP proxy accepts only a loopback
Somite runtime URL. The parent runtime gives each MCP child a cryptographically
random capability through its process environment; every tool call back into
the HTTP runtime must present that capability. It never appears in the command
line, activity log, transcript, or tool result. MCP-only graph, catalog,
transaction, compile, and evidence routes reject requests without it even when
the caller omits the MCP activity header. Human-facing run routes remain part
of the loopback web application; this capability is not a sandbox for arbitrary
local processes running as the same user.

## Automatic launcher and model selection

Opening the Agent panel scans executable commands on the local `PATH` and reads
the curated [ACP Registry](https://agentclientprotocol.com/get-started/registry).
Installed agents appear first and launch with one click. Registry package
versions and arguments remain pinned; a live fetch can fall back to Somite's
bundled registry snapshot when offline. Somite never executes a discovered
entry until the user chooses it, and subprocess arguments never pass through a
shell.

The launcher prefers a native ACP command when the registry declares one. It
also supports registry adapters such as
[Codex ACP](https://github.com/agentclientprotocol/codex-acp) and agents with
native ACP support such as [OpenCode](https://dev.opencode.ai/docs/acp/). A
custom command is still available for any compatible bring-your-own agent.

After `session/new`, Somite renders the session configuration advertised by the
agent. Models, modes, and boolean options are changed through ACP's stable
[`session/set_config_option`](https://agentclientprotocol.com/rfds/session-config-options)
request. Somite does not maintain a second provider list, copy credentials, or
pretend that every agent exposes the same options.

Every user turn also receives a concise Somite-owned workflow contract before
the user's unchanged message. It tells the agent to act on the canvas through
MCP immediately, use exact catalog contracts, make ordinary reversible edits
without a confirmation round trip, and reserve generic web research for current
external evidence that Somite cannot supply. The visible activity feed and
persisted transcript retain only the user's original message, not this internal
routing context.

The contract also requires short single-concept catalog queries in parallel and
a deterministic readiness check after editing. Missing local resources such as
a Kraken2 database remain explicit typed requirements with known resolutions;
the agent does not waste a web or NCBI search trying to fabricate them and does
not compile or launch a validation while readiness is blocked.

## Tool surface

| Tool | Effect |
| --- | --- |
| `somite.workflow.get` | Read the current typed graph, full state revision, and semantic revision. |
| `somite.readiness.get` | Read deterministic missing inputs, parameters, and Managed resources plus known resolutions for the current graph revision. |
| `somite.catalog.search` | Search exact operator contracts, ports, parameters, Pixi packages, and revisions with deterministic ranking and opaque pagination. |
| `somite.source.search` | Search current NCBI or Ensembl reads, reference assemblies, organisms, accessions, and genes with structured provenance and ordered native source-recipe operators. |
| `somite.graph.apply_transaction` | Apply up to 64 graph operations atomically against a compare-and-swap base revision. |
| `somite.workflow.compile` | Freeze the current graph through the production Pixi/Nextflow compiler into a content-addressed package. |
| `somite.validation.start` | Start the production runner with a supported representative fixture binding. |
| `somite.run.start` | Start the production runner with configured inputs. |
| `somite.run.status` | Read lifecycle, graph-node state, closure identity, and evidence. |
| `somite.run.cancel` | Cancel one active run or validation. |
| `somite.evidence.lookup` | Read immutable receipts for a graph revision. |

The tool annotations identify reads, writes, destructive actions, idempotence,
and open-world behavior. Workflow and catalog reads are closed-world; source
search is explicitly open-world because it queries NCBI or Ensembl through
Somite's existing provider boundary. The server instructions require an agent
to inspect the graph, search rather than invent contracts, prefer native source
search over a generic browser, make small edits, and validate.
Every tool has a concrete output schema. Expected catalog, edit, compile, run,
and validation failures return structured `isError: true` tool results with a
stable code and a recovery action instead of being disguised as transport
failures.

Catalog matches include the immutable catalog revision, a deterministic score,
the terms that matched, and an opaque continuation cursor. A cursor is valid
only for the query and catalog revision that created it.

## Atomic graph edits

An edit is one `GraphTransaction`:

```json
{
  "base_state_revision": "blake3:...",
  "idempotency_key": "edit-018f...",
  "summary": "Add reads and quality control",
  "operations": [
    {
      "op": "add_operator",
      "node_id": "reads",
      "operator_id": "files.import",
      "params": { "path": "reads.fastq" },
      "x": 80,
      "y": 120
    },
    {
      "op": "connect",
      "edge_id": "reads-to-qc",
      "from_node": "reads",
      "from_port": "file",
      "to_node": "qc",
      "to_port": "fastq"
    }
  ]
}
```

`base_state_revision` is the returned full `state_revision`, not the execution-only
`graph_revision`. It includes layout and notes so concurrent presentation edits
also fail safely.

`idempotency_key` identifies one intended edit. Repeating an identical request
with the same key returns its original result without applying the edit again;
reusing the key for different content is rejected.

Run and validation starts use the same rule. The start tool requires a fresh
key for one intended launch. Retrying an identical launch with that key returns
the original `run_id` with `replayed: true`; using it for a different launch is
rejected. This prevents a lost response from creating duplicate compute jobs.
Before a launch is queued, the server applies the same readiness analysis used
by the web drawer. A blocked graph returns `workflow_not_ready` before Pixi,
Nextflow, downloads, or fixture binding begin.

Somite clones the current graph, applies every operation, validates graph and
catalog invariants, and writes the result only if all operations pass. A stale
base revision returns an error; it never overwrites newer server state. Added
operators are instantiated from the catalog and pin the exact operator
revision and port contract. Supported operations add or remove operators, set
or unset parameters, connect or disconnect ports, and edit notes.

Each successful transaction enters the activity feed with its complete result
graph. The browser applies consecutive transactions in cursor order and adds
one history entry for each, so normal Undo reverses them individually.

## Trust and visibility

- The command is parsed and launched as a local subprocess in the disposable
  agent workspace; Somite does not pass it through a shell.
- Discovered launch commands come from the official ACP Registry, are checked
  against a conservative token allowlist, and remain visible before launch.
- The agent command is not saved in the project.
- Agent messages, status, tool input/output, transactions, and permission
  prompts appear in one chronological feed.
- Somite-owned `somite.*` calls are automatically allowed for the active agent
  session and remain visible and correlated by ACP tool-call id in the activity
  feed and transcript. This covers only Somite's typed, server-enforced
  capability surface; it does not approve shell commands or other tools.
- Non-Somite permission requests identify the exact tool-call id and block until
  the user chooses an advertised ACP option, cancels it, or the five-minute
  timeout expires.
- Disconnect and Stop remain available while the agent works. Canvas, run,
  validation, and export remain available without an agent.
- Graph writes pass through the same Rust validation and autosave boundary as
  human edits. Compile, run, and validation tools call the same production
  freezer and supervisor as the web controls.

The in-memory activity feed retains the newest 4,096 events for the current
server process. After every completed turn, Somite also writes a normalized,
redacted transcript under `.somite/agent-transcripts/`. It correlates visible
messages, tool inputs and results, permission decisions, and transactions by
tool-call id. Secret-shaped fields such as authorization values, API keys,
tokens, passwords, credentials, and secrets are recursively redacted. Somite
does not claim to record a model's hidden chain of thought.

Immutable execution and validation claims live in Run closures and Evidence
receipts, not in conversation history. Run status includes bounded node-level
progress (`completed`, `total`, `unit`, and `message`); cancellation uses the
same supervisor for human and agent launches. Agents can long-poll status for
up to 25 seconds with `wait_ms`, reducing repeated status calls while preserving
bounded response time.

## Verification

Server tests cover invalid, failed, stale, replayed, and successful atomic
transactions and launches; authenticated loopback calls; structured tool
errors and output schemas; transcript correlation and secret redaction; HTTP
persistence and activity events; a spawned ACP v1 subprocess turn; and an
official RMCP client spawning Somite's stdio server, listing every tool,
editing a graph, and reading the result back. Web tests cover event
de-duplication and exactly-once transaction delivery to canvas history.

The repeatable live-agent harness runs the same blind task against a selected
Codex ACP model and reasoning level, auto-approves only exact `somite.*`
permissions, and writes a deterministic score plus redacted evidence:

```bash
scripts/mcp-agent-eval gpt-5.6-luna low 7391 baseline
scripts/mcp-agent-eval gpt-5.6-luna low 7393 natural
scripts/mcp-agent-eval gpt-5.6-luna low 7394 source
scripts/mcp-agent-eval gpt-5.6-luna low 7396 metagenomics
scripts/mcp-agent-eval gpt-5.6-luna low 7395 stale
```

Current results and limitations are recorded in
[the 2026-08-26 agent evaluation](research/mcp-agent-evaluation-2026-08-26.md).

Protocol references:

- [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Official MCP Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)
