# Somite

Somite is a local-first visual builder for reproducible bioinformatics
workflows. Search for tools and public data, drag them onto an infinite canvas,
connect typed ports, inspect the resulting DAG, and compile the same graph into
a Nextflow workflow with a Pixi environment.

## Start the app

Requirements: Rust, Pixi, and Node.js 22.13 or newer.

```bash
cd web
npm ci
cd ..
scripts/somite-web
```

Open <http://localhost:3000>. Somite creates the working graph at
`.somite/web.somite.json`. To open another graph:

```bash
scripts/somite-web path/to/workflow.somite.json
```

The canvas supports typed connections, magnetic alignment, multi-selection,
pan and deep zoom, undo/redo, light and dark themes, file picking, autosave, and
group viewer controls. The workflow name is editable directly in the top bar,
travels with the graph, and becomes the safe exported-package filename; it is
separate from the local project folder. **Run** freezes the graph to its exact Pixi/Nextflow
closure, then shows live queued/running/completed state and supports
cancellation. **Validate** substitutes small content-addressed FASTQ fixtures,
runs that same production path, and records configuration-scoped evidence.
Export downloads the same frozen production package.

## Build workflows

The Library is one universal add surface. Its search spans typed operators,
public data, and workflow catalogs without forcing the user to choose a source
type first. Empty-search sections group entries by their role on the graph:
data and inputs, quality control, alignment and assembly, measurement and
analysis, workflow catalog, and utilities. NCBI and Ensembl results appear
alongside matching tools and workflows; paired reads remain separate R1 and R2
streams.

The Project panel is the engine-neutral entry point for local workflow
projects. Somite detects a supported project and adds its visible structure to
the canvas. The current adapter recognizes Snakemake projects and Snakefiles
through their declared Pixi environment. Imported nf-core and Snakemake
workflows expand into editable structural nodes and edges; engine-authored
references remain clearly marked and are not presented as independently
executable tools until they have reviewed Somite contracts.

Paper Drop reconstructs one or more candidate graphs from methods text or a
PDF. The evidence view distinguishes text-supported tools, compatibility
inferences, and missing adapters; it never presents an inferred workflow as a
verbatim executable method.

## Bring your own agent

The Bot button detects installed ACP-compatible agents and presents them as a
one-click launcher. Codex, OpenCode, Claude Agent, GitHub Copilot, and other
entries come from the official ACP Registry; an arbitrary ACP command remains
available under the advanced disclosure. Once connected, model and mode choices
come from that agent's live ACP session rather than a separate Somite provider
setup. Somite bundles no model and adds no agent modes. The agent receives a
Somite-owned workflow contract plus a documented MCP tool server for graph
inspection, exact catalog search, native NCBI/Ensembl source research, atomic
graph transactions, production compilation and run/validation control, and
evidence lookup. Ordinary workflow turns start with these tools; a generic
browser is reserved for current evidence Somite cannot provide.
Messages, tool activity, permission requests, and graph edits stream into one
visible feed. Each successful agent transaction appears on the canvas as one
normal undoable edit; stale revisions fail instead of overwriting newer graph
state. Disconnecting the agent does not change any manual capability.

See [the agent protocol](docs/agent-protocol.md) for the tool contracts,
transaction format, trust boundary, and protocol verification.

## Compile a runnable workflow

Somite compiles a validated graph into deterministic Nextflow DSL2, an exact
node/edge source map, pinned operator manifests, parameters, and one graph-wide
Pixi environment. Every
external node becomes a stable process; local imports remain visible source
nodes. Compiled processes use deep content caching and reject missing,
zero-byte, or corrupt gzip outputs before they can enter the Nextflow cache.

```bash
cargo run -p somite-cli -- compile path/to/workflow.somite.json build/workflow
pixi run --manifest-path build/workflow/pixi.toml run
```

Compilation resolves and retains `pixi.lock`, then emits `run-closure.json` with
the semantic graph revision, exact operator revisions, platform, environment
digests, and compiler/engine identities. Validation receipts remain separate
under `evidence/` so new evidence never mutates executable identity.
Compilation refuses structural references, nested Nextflow or Snakemake
commands, unsupported collection semantics, invalid parameters, and operator
features it cannot lower faithfully.

## Validate with representative data

Validate currently supports graphs rooted in local single- or paired-end FASTQ
imports. The tiny fixture pack is embedded, materialized once by BLAKE3 digest,
and never overwrites the user's source paths. A passed run writes an append-only
receipt under `.somite/evidence/` containing the original Graph revision,
normalized fixture configuration, observed Run closure, per-node and per-edge
results, and artifact/log digests. Editing an execution-semantic parameter
invalidates the displayed receipt; layout-only changes do not.

Unsupported source kinds fail closed. Somite does not contact NCBI, Ensembl, or
another network provider merely because the user pressed Validate.

## CLI

The CLI uses the same graph and operator catalog as the web app.

```bash
cargo run -p somite-cli -- palette
cargo run -p somite-cli -- env
cargo run -p somite-cli -- compile testdata/fastq_to_fastqc.somite.json build/fastqc
cargo run -p somite-cli -- cook-oracle testdata/fastq_to_fastqc.somite.json
cargo run -p somite-cli -- paper testdata/papers/rnaseq_methods.txt
cargo run -p somite-cli -- import-snakemake path/to/project workflow.somite.json target_a target_b
```

## Architecture

```text
web/ React canvas
      | JSON over localhost
      v
somite-server
      +-- somite-ir       typed graph and validation
      +-- somite-ops      operator and workflow catalogs
      +-- somite-nextflow pure Graph-to-DSL2 compiler
      +-- somite-linker   run-closure and evidence identities
      +-- somite-fixtures content-addressed representative test data
      +-- somite-cook     explicit native differential oracle
      +-- somite-paper    evidence-bound reconstruction
      +-- somite-bundle   frozen Pixi/Nextflow packages
      +-- ACP bridge      one user-provided conversational agent
      +-- MCP server      revision-safe Somite capability surface
```

The graph JSON is the source of truth; browser, CLI, execution engine, and
exporter are clients of the same Rust model. See
[the architecture](docs/somite-design.md), [domain model](docs/domain-model.md),
and [operator contract](docs/operator-contract.md).

## Verify a checkout

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd web
npm run typecheck
npm run lint
npm test
```

Somite is licensed under Apache-2.0.
