# MCP agent evaluation, 2026-08-26

## Verdict

Somite's MCP surface passed the fixed paired-end workflow task with four model
configurations and a forced concurrent-edit scenario. The current evidence is
strong for this bounded graph-building path, not for every possible workflow,
operator, model provider, or MCP transport.

The final baseline needs five to seven MCP calls: exact catalog discovery,
state inspection, one atomic edit, one idempotent validation start, and one
bounded status wait. Each run produced a real passing Pixi/Nextflow validation
receipt for both nodes and both edges.

| Agent configuration | Scenario | Calls | Catalog calls | Status calls | Wall time | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GPT-5.6 Luna, low | baseline | 6 | 2 | 1 | 37.570 s | 12/12 checks passed |
| GPT-5.6 Terra, medium | baseline | 6 | 2 | 1 | 38.422 s | 12/12 checks passed |
| GPT-5.6 Sol, high | baseline | 7 | 2 | 1 | 70.680 s | 12/12 checks passed |
| GPT-5.4 Mini, low | baseline | 5 | 1 | 1 | 45.450 s | 12/12 checks passed |
| GPT-5.6 Luna, low | forced stale state | 8 | 2 | 1 | 50.583 s | 13/13 checks passed |

Wall time includes agent generation, two explicit ACP permission decisions,
Pixi preparation, Nextflow execution, and evidence persistence. It is not a
model-only latency benchmark.

## Fixed task and deterministic checks

Every baseline starts from an empty canvas and receives the same blind prompt:

1. Work only through Somite MCP tools.
2. Discover exact contracts rather than inventing identifiers.
3. Add one `files.import_paired` source with fixed R1/R2 paths.
4. Add `qc.fastp` with two threads.
5. Wire R1 to R1 and R2 to R2 in one coherent transaction.
6. Start representative validation, wait for a terminal phase, and report the
   evidence or exact blocker without overstating readiness.

The harness checks final graph structure and parameters, inspect-before-edit,
validation start, terminal status, use of bounded long polling, exactly one
successful agent edit, MCP-only tool use, and a passing evidence receipt. The
stale scenario also injects one concurrent human edit after inspection and
checks structured stale-state recovery plus preservation of that edit.

Run it from the repository root:

```bash
scripts/mcp-agent-eval gpt-5.6-luna low 7391 baseline
scripts/mcp-agent-eval gpt-5.6-luna low 7395 stale
```

Each run writes its prompt, configuration snapshots, raw events, redacted
normalized transcript, initial/final workflows, server log, and machine-readable
score under `.somite/mcp-agent-evals/`. The harness auto-approves only permission
titles in the exact `somite.*` namespace and refuses every other agent action.
It does not record or claim access to hidden model reasoning.

## Failures found by agents and the resulting changes

The value of the matrix was the failures it exposed before the final passing
runs:

| Observation | Root cause | Correction |
| --- | --- | --- |
| Luna used `graph_revision` as the transaction base and received a stale error. | The workflow tool description contradicted the transaction contract. | Tools and server instructions now distinguish full `state_revision` from semantic `graph_revision`; the stale error includes exact recovery fields. |
| A natural paired-read query needed seven searches. | Search indexed too little metadata and returned weak partial matches beside complete matches. | Search now indexes ports, artifact types, aliases, labels, Pixi packages, and outputs; complete multi-term matches suppress partial matches. The Inspector query now returns one exact match. |
| Validation approval briefly appeared as generic `agent action`. | ACP delivered the permission request before the matching tool update. | Permission handling waits up to 200 ms for the update keyed by `tool_call_id`, then emits the exact tool name and edit summary. |
| A successful Luna run used nine repeated status calls. | Status had no bounded wait contract. | `somite.run.status.wait_ms` long-polls for up to 25 seconds. Final agents used one status call. |
| Terra observed `phase: completed` with no receipt, then found the receipt through evidence lookup. | The runner exposed its process terminal state before evidence finalization. | Validation remains `finalizing` until its receipt is persisted; terminal completion and evidence now become visible atomically. |
| A compile blocker marked every unexecuted node failed. | Preparation failure was projected onto units that never ran. | Running units fail; queued units become skipped and evidence-inconclusive. |
| Lost transaction or launch responses could duplicate work. | Starts and edits lacked complete replay identity. | Edits, runs, and validations require bounded idempotency keys; identical retries return the original result and conflicting reuse is rejected. |

## Protocol and Inspector evidence

The official MCP Inspector enumerated nine tools from Somite's real stdio
process. Every tool had an object input schema, a concrete output schema, and
all four security-relevant annotations. No output property remained an
unconstrained `true` schema. A real Inspector call for
`paired local FASTQ source` returned only `files.import_paired`, its exact
revision, contract, score, and matched terms.

The RMCP integration test explicitly negotiates MCP `2026-07-28`, spawns the
production stdio process, checks all schemas and annotations, applies and
replays an atomic edit, verifies a structured stale error, and reads the result
back. The MCP-to-runtime HTTP hop is loopback-only and requires a per-process
cryptographic bearer capability that is passed through the child environment,
not its arguments. MCP-only runtime routes enforce the capability independently
of the activity header. This authenticates the intended proxy hop; it does not
claim to isolate arbitrary same-user processes from the human-facing local web
application.

The official conformance runner currently accepts a Streamable HTTP URL, while
Somite's ACP integration deliberately supplies MCP over ACP's stdio boundary.
Therefore this work does **not** claim a passing full HTTP conformance suite.
Adding a public HTTP MCP transport solely to satisfy that runner would expand
the security and product surface; it should be a separate decision backed by a
real external-client requirement.

## Remaining limits

- The matrix uses Codex ACP with four OpenAI model configurations. It does not
  yet establish cross-provider behavior for Claude, Grok, Gemini, or a native
  OpenCode model configuration.
- The fixed task covers a small, valid paired-end graph. More cases should test
  invalid ports, unsupported fixture families, large imported workflows,
  pagination, cancellation during execution, and recovery after process loss.
- MCP call results contain both compatibility text and structured content, so
  large catalog contracts still consume substantial transcript space.
- JSON Schema validators may warn about Schemars' nonstandard `uint` format
  annotations. Inspector validation succeeds, but removing those warnings would
  improve portability.

The reusable harness makes these extensions incremental rather than ad hoc.
