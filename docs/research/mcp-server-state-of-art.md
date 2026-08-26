# State of the art for Somite's MCP server

**Research date:** 2026-08-26
**Scope:** MCP server design and agent evaluation, using only the MCP specification and first-party documentation or source from the MCP project, GitHub, Microsoft Playwright, and OpenAI's open-source Agents SDK and API documentation.

**Protocol baseline:** MCP `2026-07-28` is the current core specification. Somite should target it explicitly while retaining a separately tested `2025-11-25` compatibility path only for ACP hosts that have not migrated. The two eras have materially different lifecycles and must not be blended. [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [TypeScript SDK migration note](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

## Executive conclusion

Somite has the right product boundary: nine domain tools, one typed graph, atomic compare-and-swap edits, exact catalog contracts, and the same compile/run/validation implementation used by the UI. That is a better foundation than a large collection of thin CRUD tools.

It is not yet a state-of-the-art MCP server. The most important gaps are protocol quality rather than additional features:

1. Successful responses are wrapped in a generic `data: any` payload, so the MCP output schema does not teach a weak model what fields to use.
2. All HTTP 4xx failures become JSON-RPC `invalid_params` protocol errors. The MCP specification instead says input-validation and business-logic failures should be tool execution errors because those results can give the model actionable recovery instructions.
3. The stdio process is constrained to loopback, but the loopback runtime hop is not authenticated. A different local process can reach the same internal HTTP surface.
4. Somite records UI activity, but it lacks a durable, normalized, redacted MCP transcript suitable for regression grading. Diagnostic logs, audit receipts, and agent traces are separate needs.
5. The implementation and tests do not prove which wire era Somite serves. That is now a first-order compatibility risk because the 2026 core removed initialization and connection-scoped state.
6. Catalog search has a hard result limit but no cursor, explicit match explanation, synonym vocabulary, or deterministic exact-lookup companion. Tool discovery is therefore likely to degrade before graph editing does.
7. Compile and run supervision do not expose MCP-standard progress. Cancellation exists as a Somite tool, but not for an in-flight MCP request.

The next milestone should be **MCP contract hardening plus a repeatable multi-model eval harness**, not more tools.

## What the protocol actually requires

### Current lifecycle and compatibility

The 2026 core is stateless. There is no initialize handshake or protocol session: every request carries protocol version, client identity, and capabilities in `_meta`. A client can optionally call `server/discover`, and application state must be addressed through explicit handles rather than an implicit connection. List results must be deterministic for the same request context and can carry `ttlMs` and `cacheScope` hints; authorization-sensitive results must not be advertised as publicly cacheable. [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [current tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

This reinforces Somite's explicit graph and run identities. `state_revision`, run IDs, evidence IDs, catalog revision, and any pagination cursor must be request-visible handles, authorized on every call, and never derived from a presumed MCP connection. The server should record the request's protocol version and advertised client capabilities in every trace.

Compatibility must be empirical, not inferred from an SDK version. The official TypeScript migration guide warns that a library can expose newer APIs without speaking the new wire protocol by default. Somite should therefore:

1. declare the exact protocol eras it supports;
2. keep lifecycle adapters separate from the domain handler;
3. run the dated conformance requirement set for each claimed era;
4. test every actual ACP host against the same compatibility matrix; and
5. reject unsupported combinations clearly instead of silently mixing initialize-era and stateless semantics.

### Tool identity, descriptions, and schemas

MCP tool names are case-sensitive identifiers, should be unique within a server, and use a restricted ASCII character set. A tool definition can carry a human title, description, input JSON Schema, optional output JSON Schema, and annotations. The description is explicitly a hint clients can use to improve the model's understanding. The current Somite names such as `somite.workflow.get` and `somite.graph.apply_transaction` fit this guidance. [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

An output schema is not decorative. When one is declared, the server must return conforming `structuredContent`, and clients should validate it. The current schema allows any JSON type, not only an object. For compatibility with older clients, structured content should also be serialized into a text content block. The official Everything server demonstrates this dual response. [MCP structured content](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#structured-content), [Everything server feature reference](https://github.com/modelcontextprotocol/servers/blob/main/src/everything/docs/features.md)

For Somite, every public field that an agent must reuse must exist in a typed output schema:

- `state_revision` and `graph_revision`, with their different meanings;
- exact operator revision, ports, parameters, package identity, and match reason;
- transaction ID, prior/new state revisions, applied operations, and graph delta;
- run ID, phase, progress, closure identity, evidence identity, and terminal error;
- pagination cursor and result counts.

Avoid a generic `data: {}` envelope. It discards most of the value of structured MCP output.

Descriptions should be short but operational. Each should say:

1. when to use the tool;
2. what it reads or changes;
3. the required precondition;
4. the field to pass to the next tool;
5. the expected recovery for a common failure.

Global workflow policy belongs in server instructions; tool-local mechanics belong in the tool and parameter descriptions. The two must not restate contradictory rules.

### Errors that weak models can repair

MCP distinguishes protocol errors from tool execution errors. Unknown tools, malformed JSON-RPC, and invalid request envelopes are protocol errors. API failures, input validation, and business logic failures belong in a tool result with `isError: true`; the specification explains that actionable tool results enable model self-correction. [MCP tool error handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)

Somite should return machine-readable tool errors like:

```json
{
  "isError": true,
  "structuredContent": {
    "error": {
      "code": "stale_state_revision",
      "message": "The canvas changed after inspection.",
      "retryable": true,
      "supplied_state_revision": "blake3:old",
      "current_state_revision": "blake3:new",
      "recovery": "Call somite.workflow.get, re-check the intended edit, then retry once against current_state_revision."
    }
  }
}
```

Use stable domain codes for at least: `stale_state_revision`, `unknown_operator`, `unknown_port`, `incompatible_artifact_type`, `invalid_parameter`, `compile_failed`, `validation_failed`, `run_not_found`, `run_terminal`, `permission_denied`, and `runtime_unavailable`. Include the current revision or valid alternatives when they are known. Do not turn an expected stale edit into an internal server error.

### Revisions, concurrency, and replay safety

MCP does not define application-level optimistic concurrency. The server must expose it through its own typed tools. GitHub's official server is a useful precedent: file replacement accepts the blob `sha`, and pull-request branch update accepts `expectedHeadSha`. [GitHub MCP tool reference](https://github.com/github/github-mcp-server#tools)

Somite's stronger graph-wide CAS is correct. Harden it as follows:

- Before public release, rename ambiguous `base_revision` to `base_state_revision`.
- Return `state_revision` and `graph_revision` at the top level of every graph-affecting result.
- Describe `state_revision` as the edit precondition and `graph_revision` as semantic evidence identity in both schemas, not only prose.
- On a stale write, return the current state revision and a retry recipe in a tool execution error.
- Add a client-generated `idempotency_key` to transactions and starts. Store the outcome for a bounded period so a response-loss retry cannot duplicate a non-idempotent edit or run.
- Include `previous_state_revision`, `state_revision`, transaction ID, and operation digest in the audit receipt.

Atomicity prevents partial graph changes. It does not by itself prevent duplicate application after a lost response; the idempotency key closes that separate failure mode.

### Search and pagination

MCP's standard list operations use opaque cursor pagination. Servers choose page size; clients must not parse cursors. In the current core, list responses can additionally include cache hints and must remain deterministic for the same request context. [MCP tools listing](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools)

`somite.catalog.search` is a domain tool rather than a protocol list method, but the same design is appropriate:

```json
{
  "query": "paired FASTQ input",
  "cursor": null,
  "limit": 12,
  "detail": "contract"
}
```

```json
{
  "items": [
    {
      "operator_id": "files.import_paired",
      "operator_revision": "...",
      "title": "Paired FASTQ files",
      "aliases": ["paired reads", "R1 R2", "PE FASTQ"],
      "tags": ["source", "fastq", "paired-end"],
      "match_reason": ["alias: paired reads", "artifact: FASTQ"],
      "ports": {"out": [{"name": "r1"}, {"name": "r2"}]},
      "parameters": {}
    }
  ],
  "next_cursor": null
}
```

Ranking must be stable for the same catalog revision. Exact ID and exact alias should outrank prefix, tags, title, package, and fuzzy text. Return the catalog revision and match reason so an eval can explain discovery failures. Add `somite.catalog.get` only if search summaries become too large; do not split a contract that fits comfortably in the search response.

GitHub's official server demonstrates two other scaling controls: it supports toolsets and individual-tool allowlists to reduce context, and its list/search tools expose result-size controls and field selection. It also preserves renamed tools as aliases for compatibility. Somite has only nine MCP tools, so dynamic MCP toolsets would be feature bloat today; apply these ideas to the much larger operator catalog instead. [GitHub MCP tool configuration](https://github.com/github/github-mcp-server#tool-configuration), [GitHub server configuration guide](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)

### Permissions and annotations

MCP annotations describe `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, but the specification is explicit that these are untrusted hints, not an authorization boundary. Their defaults are conservative: not read-only, destructive, not idempotent, and open-world. [MCP ToolAnnotations schema](https://modelcontextprotocol.io/specification/2026-07-28/schema#toolannotations)

Somite is already right to declare annotations explicitly on every tool. Keep one CI assertion that every registered tool declares all four behavioral hints. Then enforce permissions independently:

- Read tools may be auto-approved by a trusted host policy.
- Graph edits should show transaction summary, exact operation list, affected node/edge IDs, and whether the operation is undoable.
- Compile should show the source/build closure it will materialize.
- Validation and run should show executable closure, external access, and input bindings.
- `run.start` must require explicit server-mediated approval whenever imported/custom code can execute, regardless of what the connected agent does with annotations.
- Approval, denial, and timeout must be correlated to the exact MCP call ID and arguments in the transcript.

The current core's multi-round tool-result flow can return `input_required` when a tool needs missing information or explicit confirmation, together with a resumable `requestState`. This is the protocol-native option for a server-mediated execution approval, but Somite should depend on it only after its real hosts pass interoperability tests; the UI's existing permission gate must remain authoritative. [MCP multi-round tool results](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#multi-round-tool-results)

GitHub uses server-side read-only filtering that takes priority even over explicitly requested write tools. Its lockdown filter reduces exposure to untrusted public-repository content, while explicitly warning that the filter is not an authorization boundary. This is a useful distinction for Somite: server policy is the upper bound; content filtering is defense in depth. [GitHub server configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md), [GitHub secret push protection for MCP](https://docs.github.com/en/code-security/concepts/secret-security/push-protection-and-the-github-mcp-server)

### Progress, task lifetime, and cancellation

Cancellation is transport-specific in the current core. On stdio, a client sends `notifications/cancelled`; the server must stop processing and send no further messages for that request. On Streamable HTTP, closing the request's response stream is the cancellation signal. Long operations can stream request-scoped progress, but durable background work belongs behind an explicit application handle or the separate Tasks extension. [MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [MCP Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks)

The official Everything server demonstrates progress and task behavior, but it is a protocol test fixture rather than product architecture. [Everything server feature reference](https://github.com/modelcontextprotocol/servers/blob/main/src/everything/docs/features.md)

For Somite:

- Keep durable workflow runs as Somite run resources. They outlive one MCP request and already have domain-specific evidence.
- Return from `run.start` and `validation.start` quickly with a run ID.
- Add normalized `progress: {completed, total, unit, message}` to `run.status`.
- Emit request-scoped MCP progress during synchronous compile/materialization when supported by the negotiated era and transport.
- Honor transport cancellation for in-flight compile/materialization, including cleanup and completion-race tests.
- Keep `somite.run.cancel` for durable runs.
- Do not adopt the Tasks extension until the actual ACP clients Somite supports pass interoperability tests.

### Structured logging and auditability

The 2026 core deprecates the MCP Logging capability and explicitly advises new implementations not to adopt deprecated capabilities. For stdio, stdout must contain only MCP JSON-RPC messages; diagnostic text belongs on stderr. Somite therefore needs three intentionally separate channels, without adding protocol Logging to the modern path: [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)

1. **Local diagnostics:** structured, rate-limited, redacted stderr records for stdio and equivalent server telemetry for HTTP.
2. **Operational observability:** OpenTelemetry spans/metrics or an equivalent internal sink for latency, failures, queues, and resource use.
3. **Durable audit transcript:** append-only, normalized records for each eval or user-authorized export.

The durable record should include:

- schema version, server version, negotiated MCP version, agent harness, exact model/config advertised through ACP, and fixture/catalog/graph digests;
- trace ID, turn ID, MCP call ID, tool name, start/end timestamps, duration, redacted arguments, structured result/error, and retry relationship;
- permission request, exact tool/arguments shown, decision, decision source, and latency;
- graph revisions before/after, transaction/run/evidence IDs, cancellation reason, and terminal outcome;
- visible agent messages and final response.

Do not claim to capture hidden chain-of-thought. Log only protocol-visible messages, plans exposed by the agent, tool calls/results, state changes, and final answers. OpenAI's Agents SDK traces end-to-end runs and nested tool activity, while its documentation warns that tool inputs/outputs can contain sensitive data and supports custom processors and disabling sensitive capture. [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)

### Security and prompt injection

The current HTTP transport requires `Origin` validation and recommends local binding and authentication against DNS rebinding. The authorization and security guidance treats tokens as audience-bound capabilities and rejects token passthrough. For local operation, stdio or restricted IPC minimizes attack surface. [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)

Somite's stdio mode and loopback-only URL validation are good. The remaining hop should use one of:

1. a per-runtime random bearer capability passed directly to the stdio child and required by every `/api/agent/*`, run, and validation request; or
2. a user-private Unix-domain socket.

The token must never appear in graph files, tool output, model context, or transcripts.

Imported workflow labels, repository text, paper text, catalog descriptions, command output, and validation logs are untrusted data. Add provenance and a trust label to returned content; delimit external text; never promote content-derived text into server instructions; and require explicit approval before external text can lead to code execution or irreversible mutation. Include prompt-injection fixtures in the eval suite. Filtering helps but is not authorization, as GitHub's lockdown documentation emphasizes.

Playwright MCP offers useful defense-in-depth patterns: filesystem access is workspace-restricted by default, dangerous capability groups are opt-in, browser actions use exact references from a structured accessibility snapshot, and arbitrary JavaScript is explicitly labeled RCE-equivalent. It also warns that its guardrails are not a security boundary. [Playwright MCP configuration and tools](https://github.com/microsoft/playwright-mcp)

Somite's equivalent should be: exact node/port/operator references from inspected state; project-root containment; no shell interpolation; opt-in network/build capabilities; and explicit RCE-level approval for custom source execution.

## Reference implementation comparison

| Source | What it is good for | Pattern Somite should take | Pattern not to copy blindly |
| --- | --- | --- | --- |
| MCP Everything server | Broad protocol feature coverage across legacy and current clients | Use it as a compatibility fixture and feature oracle | It explicitly says it is a test server, not a useful product server; do not copy deprecated capabilities or expose every feature merely because it exists |
| GitHub MCP server | Large-capability discovery, exact search schemas, field selection, read-only upper bounds, concurrency SHA fields, prompt-injection reduction | Stable catalog search, exact aliases, least-privilege server enforcement, mutation preconditions | Somite has nine domain tools; GitHub-scale dynamic MCP toolsets would add needless UI and protocol complexity |
| Playwright MCP | Consistent verb-oriented names, state-first structured snapshots, exact action references, human-readable permission context, capability gates | Return compact graph snapshots/deltas and exact references; expose dangerous execution explicitly | Browser state semantics differ from immutable workflow/evidence identity; do not collapse graph state to ephemeral element handles |
| OpenAI Agents SDK | Client-side filtering, approval policies, retries, tool-list caching/invalidation, structured-content preference, traces | Test Somite against real host behavior, approval, failure conversion, retries, and trace export | Client retries must not substitute for server idempotency or correct domain errors |
| MCP Inspector and Conformance | Interactive inspection, scriptable calls, wire-schema and lifecycle verification | Put protocol tests in CI and retain artifacts | Passing conformance proves protocol behavior, not that agents can use the domain correctly |

Primary sources: [Everything server](https://github.com/modelcontextprotocol/servers/tree/main/src/everything), [GitHub MCP server](https://github.com/github/github-mcp-server), [Playwright MCP](https://github.com/microsoft/playwright-mcp), [OpenAI Agents SDK MCP integration](https://openai.github.io/openai-agents-python/mcp/), [MCP Inspector](https://github.com/modelcontextprotocol/inspector), [MCP Conformance](https://github.com/modelcontextprotocol/conformance).

## Current Somite assessment

This section is a code audit of [`crates/somite-server/src/mcp.rs`](../../crates/somite-server/src/mcp.rs), [`crates/somite-server/tests/mcp_stdio.rs`](../../crates/somite-server/tests/mcp_stdio.rs), and [`docs/agent-protocol.md`](../agent-protocol.md), not a claim about behavior that was not executed in this research task.

### Strong now

- The tool surface is small, domain-shaped, and consistently namespaced.
- Every tool has explicit behavioral annotations.
- `workflow.get` now distinguishes `state_revision` from `graph_revision`, and the stdio integration test asserts the distinction.
- Graph edits are atomic, bounded, validated, undoable, and stale-safe.
- Agents must retrieve operator IDs and ports rather than invent them.
- Stdio output is reserved for MCP messages, and the proxy only accepts loopback runtime URLs.
- MCP calls reuse production graph, compile, run, validation, and evidence boundaries.

### Gaps now

- `ToolPayload { data: Value }` produces only a shallow output contract.
- Input constraints such as query length and limit bounds are mostly prose/runtime checks rather than precise JSON Schema constraints.
- `http_error` maps every HTTP 4xx response to a JSON-RPC `invalid_params` error, including expected domain failures.
- The proxy has a fixed 30-second blocking HTTP timeout and no MCP progress context.
- Search clamps results at 50 with no cursor or `next_cursor`.
- The current implementation/test style uses an initialize-era `ServerHandler` path, while project documentation links the 2026 specification; no conformance artifact proves that the served wire protocol matches the documented target.
- No structured stderr/telemetry configuration is visible in the MCP entry path. Not declaring MCP Logging is correct for a new 2026 implementation.
- The UI feed retains only the newest 500 in-memory events; there is no normalized transcript export for evals.
- The internal loopback HTTP hop has no per-session capability shown in this code.
- The integration test proves list/call/edit/read against the official Rust client, but it is not the official MCP conformance suite and does not test output schemas, annotations, errors, progress, cancellation, or adversarial content.

## Rigorous multi-model agent evaluation

Protocol conformance and agent usability are different test layers. OpenAI's trace-grading guidance recommends grading the end-to-end record of model decisions and tool calls rather than only the final answer. The Evals guidance starts from a declared task, representative test inputs, and explicit graders. [OpenAI trace grading](https://developers.openai.com/api/docs/guides/trace-grading), [OpenAI evals](https://developers.openai.com/api/docs/guides/evals)

There is unusually direct first-party evidence that concise server-level workflow instructions can improve weak-model reliability. In the MCP project's controlled experiment, 40 sessions used the same code-change tasks and exact-sequence success rule. GPT-5 Mini improved from 2/10 without instructions to 8/10 with them; Claude Sonnet 4 moved from 10/10 to 9/10; overall success improved from 12/20 (60%) to 17/20 (85%). The useful instructions were operational—prefer search over list, batch small groups, start with minimal data and drill down—not verbose restatements of tool schemas. This is evidence to test concise Somite workflow instructions across models, not permission to encode security policy in prompts. [MCP server-instructions experiment](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/)

### Test layers

1. **Schema/unit:** every input and output validates; annotations are complete; sensitive values are redacted; error codes are stable.
2. **Protocol conformance:** request metadata/discovery, tools/list pagination and cache hints, tools/call, errors, progress, cancellation, and wire schema for every claimed protocol era.
3. **Deterministic domain integration:** expected graph/revision/run/evidence outcomes without a model.
4. **Blind agent usability:** the agent receives only the user task, server instructions, and MCP tools.
5. **Adversarial/security:** stale state, response loss, permission denial, malicious imported text, oversized graphs, invalid catalogs, and cancellation races.

The official conformance runner captures interactions, validates wire messages, and exposes a dated `--requirements 2026-07-28` set. It currently documents HTTP server testing by URL, so Somite can expose a test-only Streamable HTTP transport backed by the same domain handler while retaining stdio in production. Run every dated requirement set Somite claims and use expected-failure baselines only temporarily; the runner deliberately fails stale baselines when a formerly failing check passes. [MCP Conformance](https://github.com/modelcontextprotocol/conformance)

Also run the Inspector CLI directly against the production stdio command. Inspector supports interactive, CLI, and terminal front ends, which is useful for preserving exact request/response artifacts. [MCP Inspector](https://github.com/modelcontextprotocol/inspector)

### Agent matrix

Run the same blind suite through ACP with:

- a fast, low-reasoning model such as GPT-5.6 Luna at low effort;
- a mid-capability/default reasoning agent;
- a frontier/high-reasoning agent;
- at least one non-OpenAI ACP agent when installed.

Pin the exact model identifier, reasoning configuration, ACP adapter version, Somite commit, operator catalog digest, fixture digest, and prompt. Start every attempt with a fresh server and isolated graph. Do not add model-specific hints to rescue one cell.

Use multiple repetitions because model trajectories vary. Keep a small repeated CI smoke set and run the fuller repeated matrix before MCP/tool/schema releases. Report counts and uncertainty, not a single cherry-picked trace.

### Core blind tasks

| Task | Required observable behavior |
| --- | --- |
| Discover paired FASTQ source | Finds the exact operator and ports without invented IDs; low search-call count |
| Add and connect a source | Inspects first; performs one atomic transaction; preserves unrelated graph state |
| Concurrent canvas edit | First write is forced stale; agent refreshes, re-checks intent, and retries once against the new state |
| Invalid port/type | Receives a structured domain error, searches/inspects, and repairs without unrelated edits |
| Validation failure | Starts validation, polls status, reports the exact blocker, and never claims runnable state |
| Cancel active validation | Uses the returned run ID, cancels, observes terminal cancelled state, and does not treat a late result as success |
| Response-loss replay | Reuses idempotency key; exactly one transaction/run exists |
| Permission denial | Stops cleanly, reports denial, and leaves graph/run state unchanged |
| Prompt injection in imported note/log | Treats text as data; performs no unauthorized mutation or execution |
| Large graph/catalog | Uses bounded search/pagination; does not dump the entire graph repeatedly |

### Deterministic graders

Primary graders should inspect facts, not prose style:

- final semantic graph digest or exact node/edge/parameter set;
- unchanged unrelated graph projection;
- transaction and run counts;
- required and forbidden tool calls;
- ordering constraints such as inspect-before-edit and start-before-status;
- exact use of returned IDs/revisions;
- stale/error recovery outcome;
- approval result and state before/after denial;
- terminal run/evidence state;
- unsupported runnable/scientific claims in the final answer;
- wall time, tool calls, catalog queries, invalid calls, retries, and prompt/response token usage when available.

Use a separate human or model grader only for explanation clarity. A successful graph mutation must not depend on a subjective LLM judge.

### Comparing server versions

To measure MCP server quality rather than model quality:

1. freeze agent, model/config, prompt, and fixture;
2. run old and candidate server versions from fresh isolated state;
3. counterbalance version order;
4. grade the same deterministic outcomes and trajectory costs;
5. inspect failing traces;
6. accept a change only if it fixes the target behavior without regressions on weaker agents or security tasks.

The main product metric should be **minimum-capability task success**: if a fast low-reasoning agent can reliably discover, edit, recover, validate, and explain through the declared contracts, stronger agents should need less compensating intelligence.

## Prioritized implementation plan

### P0 — correctness and evidence

1. Prove and declare the wire baseline: implement/test `2026-07-28`, isolate any initialize-era compatibility adapter, and record the per-request protocol version/capabilities.
2. Replace `ToolPayload<Value>` with typed per-tool output schemas and add backward-compatible text content.
3. Return structured `isError: true` domain failures; reserve JSON-RPC errors for malformed protocol/server faults.
4. Add normalized durable MCP/ACP transcript export with redaction and correlation IDs; never claim hidden reasoning capture.
5. Authenticate the MCP-to-runtime loopback hop with a per-runtime capability or Unix socket.
6. Add idempotency keys for transactions and run/validation starts.
7. Build the isolated eval harness and run the blind low/mid/high matrix before further tool expansion.

### P1 — discoverability and long operations

8. Add stable catalog ranking, aliases/tags, match reasons, catalog revision, opaque cursor pagination, and deterministic/cache-scope tests.
9. Add structured stale-revision recovery fields and rename `base_revision` to `base_state_revision` before publication.
10. Add transport-correct progress/cancellation for synchronous compile/materialization and normalized progress to run status.
11. Make permission events show the exact tool name, correlated call ID, arguments, graph delta, and execution closure; test `input_required` only with hosts that advertise and honor it.

### P2 — protocol assurance

12. Run official dated conformance against a test-only HTTP transport and Inspector against production stdio.
13. Snapshot the complete tool inventory, descriptions, input/output schemas, annotations, and server instructions in CI.
14. Add fuzz/property tests for malformed schemas, cursor stability, concurrent edits, idempotent replay, cancellation races, and secret redaction.
15. Add structured stderr/OpenTelemetry diagnostics; do not add deprecated MCP protocol Logging to the modern path.

## Release bar

Do not call the MCP server polished until all of these are true:

- every tool has precise input and output schemas;
- every expected domain failure is model-correctable and machine-readable;
- stale and replay races cannot lose or duplicate work;
- long work is observable and cancellable;
- a durable redacted trace can reconstruct every visible decision and state transition;
- the internal runtime hop is authenticated;
- official conformance passes for every claimed protocol version, and the exact clients Somite supports pass a recorded compatibility matrix;
- the blind fast/low agent passes the core workflow suite repeatedly;
- at least one other ACP/model family passes the same tasks;
- prompt-injection and permission-denial fixtures produce no unauthorized mutation or execution.

That release bar keeps Somite clean: no agent modes, no duplicated runner, and no explosion of narrow MCP tools—just a precise, testable capability surface over the product it already has.
