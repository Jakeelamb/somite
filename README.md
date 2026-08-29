<p align="center">
  <img src="web/public/favicon.svg" width="80" height="80" alt="Somite logo">
</p>

<h1 align="center">Somite</h1>

<p align="center">
  <a href="https://github.com/Jakeelamb/somite/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Jakeelamb/somite/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <a href="rust-toolchain.toml"><img alt="Rust 1.96" src="https://img.shields.io/badge/rust-1.96-orange.svg"></a>
  <a href=".nvmrc"><img alt="Node 22.13+" src="https://img.shields.io/badge/node-22.13%2B-43853d.svg"></a>
</p>

Somite is a local-first visual builder for reproducible bioinformatics
workflows. Search for tools and public data, drag them onto an infinite canvas,
connect typed ports, inspect the resulting DAG, and compile the same graph into
a Nextflow workflow with a Pixi environment.

> [!IMPORTANT]
> Somite is in active pre-1.0 development. The first release will ship as
> source; there is not yet a standalone desktop or binary install. Review
> generated workflow packages before running them with research data.

## Start the app

Requirements: [Rust](https://www.rust-lang.org/tools/install),
[Pixi](https://pixi.sh/latest/installation/), and Node.js 22.13 or newer. The
repository pins the supported Rust and minimum Node.js versions.

```bash
git clone https://github.com/Jakeelamb/somite.git
cd somite
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

The bottom status bar continuously reports deterministic **Readiness** for the
current graph revision. Its drawer lists every missing required connection,
parameter, or managed scientific resource; known storage and scientific
tradeoffs; current validation evidence; and one direct next action. File and
connection work stays deterministic; **Ask Agent** appears only for requirements
that explicitly need scientific interpretation or a reviewed contract. Nodes mark their own missing inputs. Run, Validate, and agent Compile
stop before preparation when readiness is blocked.

Agent is a compact right-side collaborator whose ordinary conversation hides
protocol noise behind one activity disclosure. The window can be dragged,
resized, collapsed, closed, and reopened without ending its session. Sticky
notes, stage boxes, pen strokes, and labeled node colors are portable, undoable
presentation state and do not change workflow execution identity.

## Build workflows

The Library is one universal add surface. Input data has two user-facing paths:
choose local files, or search the live NCBI and Ensembl catalogs by organism,
common name, or accession. Somite keeps the lower-level import and download
operators out of this list and selects them from the chosen result. Tools are
grouped by their role, while the nf-core Nextflow catalog is an open, directly
browsable workflow section; paired reads remain separate R1 and R2 streams.

The Project panel is the engine-neutral entry point for local workflow
projects. Somite detects a supported project and adds its visible structure to
the canvas. The current adapter recognizes Snakemake projects and Snakefiles
through their declared Pixi environment.

An imported nf-core release stays one source-backed Workflow on the canvas.
Its exact Git revision and raw immutable commit-tree blobs remain source truth;
Somite does not pretend that its outline is an executable native graph. The
outer canvas keeps it as one compact node. Entering that node opens a separate
nested source canvas containing only the current scope and its immediate child
invocations. Enter a child to move inward one layer; Back, breadcrumbs, or Escape
returns outward. These Source scopes are explicitly source calls, not runnable
graph nodes or data wires. The inspector stays focused on parameters, readiness,
and provenance. Any source invocation can be assigned a catalog-pinned
replacement. **Edit on canvas** then promotes that one call into a normal native
Somite Graph: real typed ports, ordinary Edges, deterministic Readiness, generated
Nextflow, and a shared Pixi environment. The exact original source Node and
invocation-to-Node mapping stay attached as non-executable provenance; returning
to the pinned source is explicit and undoable. Promotion never guesses adjacent
channels, so missing inputs immediately appear as ordinary Logic checks that the
user or Agent can resolve by rewiring. Representative validation is the proof
that the resulting native variant works. Run and executable export remain honest
while required connections or resources are unresolved. Snakemake imports remain structural
references and are likewise not presented as independently executable tools
without a real execution path.

Rebuild from a Paper searches bioRxiv by topic, title, author, or DOI without
mixing literature into the Add surface. Papers whose JATS full text is available
through Europe PMC can be previewed and reconstructed in place; a local PDF or
text file can be chosen or dropped anywhere on the open Paper panel. Search and
reconstruction produce reviewable drafts only. The canvas changes only when the
user explicitly accepts a candidate workflow. A pre-canvas intake guides the
user through one unresolved input, checkpoint, or method decision at a time;
attached files clear the shared assessment immediately. Evidence excerpts,
PDF page locations, compatibility inferences, supported tools, and study notes
remain available under progressive provenance disclosure.

Paper intake also retains cited SRA studies, experiments, samples, runs,
BioProjects, BioSamples, assemblies, and Ensembl identifiers with their nearby
paper text and PDF page. Somite checks those citations through the same cached
NCBI/Ensembl source adapters used by Add. A collection is presented as its exact
downloadable runs instead of being silently reduced to the first result. Choosing
one run replaces the next unresolved local-read placeholder with the native,
version-pinned `sra.prefetch -> sra.fasterq_dump` recipe and immediately refreshes
the draft's deterministic readiness assessment. Before acceptance this remains
draft-only. Once that candidate is on the canvas, the same explicit choice
applies the source delta immediately, selects the new fetch nodes, and preserves
unrelated canvas work.

Local paper intake reports its live stage inside the Paper panel: copying the
content-addressed file, extracting native text or bounded OCR, locating and
recognizing methods, assessing drafts, and the terminal result. Identical bytes
reuse one stored artifact and retry starts from that artifact rather than
uploading again. Failures keep the exact reason visible, offer retry only when
repeating the operation is safe, and otherwise explain that the configuration
must change; the previous draft and canvas stay unchanged.
Recognized-but-unsupported methods, a paper with no reconstructable workflow,
and extraction failure are three different results. A workflow is “ready to
review” only when every exported Candidate is non-empty and validates against
the current Catalog.

The Machine panel checks paper-reading dependencies without an agent. Somite
looks for Poppler and Tesseract first in the project-local managed environment
at `.somite/tools/paper/.pixi/envs/default/bin`, then the project's normal
`.pixi/envs/default/bin`, and finally `PATH`; the panel reports the exact source
or an actionable missing-tool explanation. Deployments can bound intake with
`SOMITE_PAPER_MAX_UPLOAD_BYTES`, `SOMITE_PAPER_MAX_TEXT_BYTES`,
`SOMITE_PAPER_MAX_OCR_PAGES`, `SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS`, and
`SOMITE_PAPER_MAX_ACTIVE_JOBS`.

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

Paper reconstruction uses deterministic resolution profiles rather than a
single “needs adapter” bucket. Managed Pixi tools, local inputs, licensed manual
checkpoints, legacy source environments, and underspecified methods remain
distinct in Paper review, Readiness, and export. For example, the linkage-guided
assembly profile models BWA stdout as SAM, explicit SAMtools conversion/sorting,
Rascaf and ALLMAPS as managed operators, JoinMap as an attachable manual result,
AGOUTI as a legacy source tool, and an unnamed GATK 3.5 caller as a method choice
that Somite will not guess.

All four surfaces consume one `WorkflowAssessment`. Exceptional methods may
publish versioned resolution recipes containing reviewed steps, parameters,
and an official source. Those recipes travel in `assessment.json` inside the
frozen bundle; they guide human or agent work but never execute hidden commands.

## Architecture

```text
web/ React canvas
      | JSON over localhost
      v
somite-server
      +-- somite-ir       typed graph and validation
      +-- somite-ops      operator and workflow catalogs
      +-- somite-assessment shared requirements, recipes, and support
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
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --release --locked

cd web
npm run typecheck
npm run lint
npm test
```

## Community and release policy

Bug reports and user-outcome proposals are welcome through
[GitHub Issues](https://github.com/Jakeelamb/somite/issues); workflow questions
belong in [Discussions](https://github.com/Jakeelamb/somite/discussions). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development contract and verification
gate. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

Release changes are recorded in [CHANGELOG.md](CHANGELOG.md), and the exact
maintainer procedure is documented in [RELEASING.md](RELEASING.md). Somite is
licensed under the [Apache License 2.0](LICENSE).
