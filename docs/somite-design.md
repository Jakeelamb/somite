# Somite architecture

Somite is a web-first node canvas for building, understanding, validating, and
sharing reproducible bioinformatics workflows. The product has one graph model,
one production compiler, one execution engine, and one environment manager:
Somite Graph, Nextflow, and Pixi respectively.

## Product shape

```text
React canvas
     │ runtime-validated graph and job contracts
     ▼
TypeScript runner
     │ frozen package / ordered job events
     ▼
Pixi --frozen → Nextflow → scientific tools
```

The source release runs the browser and runner on one machine. The runner is a
localhost Adapter, not a second application model. A future hosted execution
Adapter must accept the same frozen package and return the same ordered events;
it may not introduce a second graph, compiler, or readiness system.

Linux x64 is the verified direct execution target. Other host adapters may be
added later without changing the graph, compiler, or evidence contracts.

Somite is implemented in TypeScript. Pixi and Nextflow remain external tools,
and scientific Python belongs inside workflow environments rather than the
Somite application.

## Module map

```text
web/
  app/                 browser interaction and presentation
  app/api.ts           fixed-origin, runtime-validated runner client
  app/SourceWorkflowCanvas.tsx
                        flat source graph and soft-hull React adapter

packages/workflow/     @somite/workflow
  model.ts             persisted Graph vocabulary
  graphCodec.ts        runtime trust boundary
  workflow.ts          invariants, ordering, and identity
  catalog*.ts          Operator contracts and immutable revisions
  assessment.ts        deterministic Readiness
  nextflow.ts          pure Graph-to-DSL2 compiler
  linker.ts            Run closure and evidence identity
  bundle.ts            deterministic frozen ZIP
  sourceWorkflow.ts    pinned workflow intent and promotion
  sourceCanvas.ts      source projection and grouping semantics
  paper.ts             evidence-bound reconstruction

runner/
  server.ts            project and HTTP Interface
  jobs.ts              Pixi/Nextflow supervision
  *Gateway.ts           remote catalog and scientific-source Adapters
  paper*.ts            bounded artifact intake and PDF.js extraction
  agentManager.ts      ACP conversation Adapter
  mcp.ts               capability-scoped Somite tools
  uploadStore.ts       streamed project-contained scientific files

operators/             reviewed versioned tool contracts
```

`@somite/workflow` is the deepest Module. It hides canonical serialization,
hashing, graph invariants, catalog identity, readiness, compilation, and bundle
layout behind small deterministic Interfaces. Both browser and runner depend on
it directly; the runner never imports UI code. Host, process, filesystem, and
network effects remain local to runner Adapters.

The browser's runner Adapter is configured once per client instance; it has no
mutable global origin. Every JSON result crosses a byte limit, fatal UTF-8 and
JSON decoding, and an endpoint-specific runtime decoder before UI state sees it.

## Core contracts

### Graph

A Graph is the persisted and exported source of truth. Runtime validation
rejects unknown fields, unsafe numbers, stale Operator pins, invalid ports,
incompatible Edges, duplicate scalar inputs, and cycles. TypeScript types are
developer assistance, not the trust boundary.

The semantic Graph revision covers executable Nodes, ports, parameters, Edges,
source pins, profiles, and bindings. Layout, notes, annotations, colors, and the
document title are excluded. Source-group membership, nesting, collapse, and
placement are excluded as well. The Graph state revision includes that
presentation state and is used for compare-and-swap persistence, undo, and
Agent transactions.

### Operator catalog

Each Operator declares stable identity, typed ports, scalar parameters,
execution kind, argv tokens, Pixi packages, output rules, and optional paper
recognition metadata. Its immutable revision covers execution semantics but not
presentation labels. Discovering a package name never creates an Operator.

Remote nf-core and Snakemake entries are dynamic catalog references pinned to
exact upstream releases. They cannot impersonate independently executable native
Operators.

### Workflow assessment

`assessWorkflow(graph, catalog)` is one pure Interface used by canvas badges,
the Readiness drawer, paper review, Export, Run, Validate, and Agent tools. It
returns every ordered Requirement, known Resolution, Node support state, input
control, recipe, and escalation flag. It performs no filesystem, process,
network, or AI work.

Readiness and evidence remain different claims. A structurally complete graph
may be ready to run without having a passing validation receipt.
Representative validation is capability-gated separately. Reviewed local
FASTQ, FASTA, GTF, and GFF3 roots bind content-addressed fixtures. Exact SRA,
NCBI assembly, and Ensembl source shapes may bind the same typed data without a
network transfer, but every bypassed retrieval Node stays skipped and
inconclusive. Unknown shapes use their real inputs for Run and never enter a
synthetic validation attempt.

### Compilation and freezing

`compileNextflow` is deterministic and performs no I/O. It emits DSL2,
`nextflow.config`, parameters, a Node source map, and a Pixi manifest pinned to
the selected Nextflow and Java versions. Unsupported collection semantics,
structural references, nested engines, stale contracts, and unbound required
inputs fail closed.

The runner asks Pixi to resolve a lock, links it to the semantic Graph and
Operator closure, and writes the frozen package. Execution always uses:

```bash
pixi run --frozen --manifest-path <package>/pixi.toml run
```

The freezer is shared by browser export, Run, Validate, and Agent compilation.

A whole-source Nextflow workflow has two mutually exclusive freezing modes. If
the source tree contains either root Pixi file, it uses the conservative
root-lock mode: both `pixi.toml` and `pixi.lock` must exist, lock Nextflow and
OpenJDK, and cover source with no delegated container, Conda, Spack, system
module, or config-level task environment. Somite adopts those exact bytes and
does not solve a replacement environment or fall back from an incomplete pair.

Static source admission is pure. It consumes immutable bytes, the entrypoint,
and exact scalar bindings and returns either one content-addressed plan or
ordered blockers. It never invokes Nextflow or Pixi, installs a plugin, rewrites
source, or treats a candidate closure as execution evidence. The later
preparation Adapter owns Pixi adoption or solving, environment realization,
plugin installation, staged rewrites, and package assembly.

With no root Pixi files, the per-task planner closes over invocations reachable
from the indexed entry workflow and accepts each process only when it maps
unambiguously to one static, quoted Conda literal. That literal may name a
source-relative environment file or a bounded direct MatchSpec list. One named
Pixi environment is rendered per unique environment-file content or
direct-expression digest. The pinned default environment supplies Nextflow,
OpenJDK, micromamba, Bash, coreutils, gawk, grep, sed, and procps-ng on Linux.
Each named environment retains its own exact dependency constraints, builds,
channel spelling, and case-sensitive channel priority; different isolated
environments may use different channel orders. Direct expressions use their
explicit channels or an exact `conda.channels` declaration from the frozen
config closure. Multiple channels without a proven priority are blocked rather
than sorted.

Pixi rendering preserves source-owned requirements rather than replacing them.
Each task feature contains exactly its frozen scientific dependencies and exact
source channel order; no launcher dependency or implementation-support channel
is injected. The default environment separately pins Nextflow, OpenJDK,
micromamba, Bash, coreutils, gawk, grep, sed, and procps-ng on Linux. Nextflow is
launched with ambient `CONDA_PREFIX` removed. Its micromamba activation can then
prepend an existing task prefix while the default Pixi runtime remains a
fallback for wrapper utilities, without perturbing scientific task solves or
their identity.

The planner follows only source-local configuration paths proven by a bounded,
side-effect-free expression evaluator. It accepts exact scalar parameter
defaults and bindings plus the fixed `NXF_OFFLINE` value needed by reviewed
literal, interpolation, boolean, conditional, and `startsWith` include guards.
It is not a Groovy interpreter. Unresolved reachable invocations, ambiguous
process mappings, dynamic or missing environments, dynamic or external config,
unsupported configuration precedence, and missing includes fail closed.
Unreachable process declarations do not enlarge the software closure.

Static plugin declarations are admitted only as exact, non-conflicting
`id@version` requirements. Preparation installs them with the frozen
Pixi/Nextflow runtime into a private store, bounds and hashes every portable
file, and publishes a cache object keyed by platform, runtime manifest and lock,
and requirements. Cache reads reverify the complete manifest and file inventory;
dynamic, inexact, conflicting, corrupt, or oversized plugin state fails closed.

Pixi solves one lock containing the default and every planned named
environment. Run realizes and verifies every prefix, then byte-guards the
original Conda expressions while rewriting a host-only staged source copy to
those canonical prefixes. Compile, Agent compilation, and Export never realize
scientific task environments and instead rewrite their staged source to portable
`${projectDir}/.pixi/envs/<content-addressed-name>` literals. Both forms retain
the original source digest, plan digest, rewrite ranges, and executed-source
digest; the frozen imported object is never mutated. A portable package with
exact plugins may realize only the locked default runtime needed to freeze those
plugin bytes. Their store digest enters the package and closure identity.
Generated runs enable
Nextflow's micromamba-backed Conda adapter against the existing Pixi prefixes.

Source execution never inherits the user's Nextflow configuration search path.
The runner creates one effective wrapper as the sole `nextflow -C` input. Exact
scalar bindings precede source config so parameter-dependent includes resolve,
the same bindings follow source defaults so the selected values stay
authoritative, and the generated Somite policy is included last. When the
frozen channel order originates in the source `conda` profile, the runner
activates that profile before the final Somite profile and later requires native
`conda.channels` resolution to match the plan. An unrelated profile is not
activated merely because it exists. The final profile disables trace, timeline, report,
container, Wave, and Fusion engines. In generated-task mode, a catch-all process
selector also forces the local executor, disables scratch staging, and uses the
locked default-environment Bash for task scripts even when source selectors set
different values. Nextflow's outer local wrapper still invokes `/bin/bash`, so
source Run checks that explicit host prerequisite before preparation. Compile
and Export add a mode-preserving
`somite-run` launcher that installs every locked Pixi environment and repeats
this exact configuration. Input bindings stay project-relative rather than
embedding the authoring machine's absolute paths.

Before either preview or ordinary execution, the runner asks the locked
Nextflow runtime for bounded JSON from native `config` and `inspect` commands.
Both run offline with a private `NXF_HOME`, private work and cache directories,
the exact wrapper and profiles, and only the frozen plugin store and allowlist.
The default syntax parser is tried first. Parser v1 is tried exactly once only
when the default parser returns the known mixed-variable/config-statement
compatibility diagnostic; `inspect` then uses the same selected parser. Hashed
receipts retain every attempt and parser decision. All other failures remain
fail-closed blockers.

Validate invokes Nextflow preview mode for either whole-source mode and records
source-preview evidence only after Nextflow emits one bounded regular DAG
artifact whose digest enters the receipt. It proves compilation and DAG
construction. The preceding config/inspect proof establishes only structural
and configuration resolution. Neither executes scientific tasks, provides
representative-data validation, or establishes scientific equivalence.
Missing parameter editing support is an inspector limitation, not an execution
blocker unless a required parameter is actually unresolved.

### Jobs and evidence

A job moves through preparing, queued, running, cancelling, and terminal phases.
Status includes bounded progress and Node states. Cancellation is checked again
at the process-spawn boundary, terminates the complete child process tree, and
clears process ownership on every exit. Starts are idempotent, so retrying a
lost response cannot create duplicate compute.

Validation binds supported root sources to small content-addressed typed
fixtures and enters the same compiler and runner. Fixture-only parameter
changes needed by tiny data are disclosed and enter configuration identity.
The Evidence scope names when public retrieval was not exercised, and those
Nodes remain inconclusive even when downstream work passes. A passing scoped
run creates an append-only receipt keyed to both semantic Graph and fixture
configuration. Layout-only edits keep the receipt current; semantic edits do
not.

## Workflow imports

### Nextflow repositories

nf-core imports resolve an exact release to an immutable Git commit and verified
source tree. A cited public GitHub workflow uses the same pinned-source model:
Somite accepts only a canonical repository URL, resolves its default branch or
requested revision to one full commit ID, bounds and extracts that exact source
archive, and requires an unambiguous Nextflow entrypoint. Repository, requested
revision, resolved commit, source digest, and indexer revision enter cache and
trust identity. The paper-derived candidate and cited source remain distinct;
using a citation never treats prose extraction as source conversion.

One outer source-backed Node shows a live miniature of every indexed invocation
call and known relationship. Cursor-centered zoom crosses into that outline
within the same persistent React Flow host; the canvas grid, controls, Agent,
and tools remain unchanged. Zooming outward applies the exact inverse camera
transform. Workflow, subworkflow, and process scopes remain quiet provenance
and may drive grouping suggestions, but only an explicit user action creates a
Source group.

The workflow Module stores group membership as a presentation forest separate
from source entities and executable Graph topology. The React adapter renders
an expanded group as a soft hull overlay without `parentId`, member resizing, or
React Flow containment. Collapsing a group substitutes a non-executable Macro
and proxy relationships for presentation only. Each proxy retains the exact
underlying relationship and member endpoints, so expansion is lossless and no
visible relationship dangles.

Soft hulls and collapsed Macros are recursive Semantic portals. Their members
remain visible directly or as a live miniature; once a portal fills the
viewport, the camera rebases into the same identities and outside relationships
terminate at exact boundary portals. There is no alternate header, breadcrumb
navigation, modal, or second canvas. Moving a member out, moving it back,
renesting, and ungrouping update only presentation membership. Arbitrary depth,
disclosure, and placement persist in Graph state revision and participate in
undo/redo, but remain outside semantic Graph revision, Run closure, and
Evidence receipt identity.

Source-structure relationships are dashed and nonconnectable; they are not
typed dataflow and cannot satisfy a Port. Each indexed invocation appears once;
unresolved calls remain visible with their exact source anchors, and shared or
cyclic scope metadata never duplicates a call. This is a source outline, not a
fabricated process DAG.

A catalog-pinned invocation replacement is editable intent. Promoting it creates
one ordinary native Node and retains the exact source invocation as provenance.
Somite does not guess adjacent channels; missing connections immediately become
normal Requirements.

### Snakemake

Catalog and local-project imports use an engine-authored rule graph. Local import
prefers the project's declared Pixi environment, accepts only safe target names,
has a 45-second and 5-MiB graph limit, and requests `--rulegraph` without running
workflow jobs. The resulting Nodes are structural references and cannot pass
executable Readiness.

## Scientific inputs

The Add surface exposes two concepts: local input and public data. Local files
stream into `.somite/uploads/` with per-file and project budgets, collision-safe
names, atomic publication, and symlink containment. NCBI and Ensembl discovery
returns structured source identity; selecting a result creates visible fetch
and conversion Nodes.

Managed scientific resources such as Kraken2 databases are typed artifacts, not
Pixi packages. Their profile, provenance, materialization, storage needs, and
scientific tradeoffs belong in deterministic Requirements and Resolutions. A
reviewed provider is versioned by URL, archive checksum, required-file
checksums, expected transfer/storage bounds, and a human-readable scientific
effect. Installs stream into a private user cache, publish only after every
check passes, and expose bounded progress, cancellation, idempotent retry, and
one typed import Node. Somite never puts multi-gigabyte reference data into a
disposable Pixi prefix or an untracked temporary directory.

## Paper reconstruction

Paper intake stores bounded content-addressed PDF/text objects. An isolated
PDF.js worker extracts native text page by page with cancellation and progress.
Only unreadable pages in scanned or mixed PDFs enter bounded OCR. Somite can
install Poppler and Tesseract into a project-local, Pixi-locked environment,
then verifies versions and the configured trained data before publishing an
atomic receipt. Missing capability returns `paper_ocr_unavailable`; it never
produces a partial-paper reconstruction. Extraction caches retain the exact
PDF.js/OCR tool identity and options separately from deterministic
reconstruction caches.

One server-owned Paper configuration is parsed before the project opens and is
passed unchanged to upload storage, the isolated PDF worker, OCR, toolchain
preflight, extraction-cache policy, and the bounded intake scheduler.
`SOMITE_PAPER_MAX_UPLOAD_BYTES`,
`SOMITE_PAPER_MAX_TEXT_BYTES`, `SOMITE_PAPER_MAX_PAGES`, and
`SOMITE_PAPER_MAX_OCR_PAGES` bound input work;
`SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS` and `SOMITE_PAPER_MAX_ACTIVE_JOBS`
bound extraction command time and concurrent jobs. `SOMITE_OCR_LANGS`
selects a validated Tesseract language list; `OMARCHY_OCR_LANGS` is consulted
only as a compatibility fallback. Invalid settings fail startup with recovery
guidance, and a policy or language change cannot reuse an extraction cache from
the previous configuration.

Reconstruction retains exact method surfaces, nearby evidence, PDF pages,
unsupported identities, and cited resources. Parallel analyses and alternative
methods stay in separate Candidate graphs. A Candidate crosses the Interface
only when it is non-empty and valid against the current Graph and Catalog
contracts. Accession recognition uses bounded identifier shapes and a linear
page cursor, retaining at most 4,096 unique cited resources with an explicit
truncation warning. Every completed reconstruction fits a 16 MiB review
envelope, and paper-job status reserves a separate metadata allowance, so a
completed job is always receivable by the browser. The canvas changes only
after explicit acceptance.

## Agent collaboration

ACP carries conversation between the workspace and one user-selected agent.
Somite launches it without a shell in a disposable workspace and supplies a
capability-scoped stdio MCP server. MCP exposes the same graph, catalog,
assessment, compiler, runner, and evidence Modules used by humans.

Agent edits are short compare-and-swap transactions against a Graph state
revision. Somite applies them to a clone, validates the complete result,
serializes persistence, and presents each successful transaction as one
undoable canvas edit.
The ACP session receives separate Somite, Pixi, and Nextflow MCP servers. Somite
owns canvas mutation and proof. Pixi owns its complete version-matched official documentation,
package discovery, manifests, locks, environments, declared tasks, and global
tools. Nextflow owns its complete version-matched official documentation, source inspection,
lint/config/process analysis, modules, preview, execution, and evidence. Exact
Somite requests and an explicit read-only allowlist from the toolchain servers
are automatically allowed. Installs, execution, remote launch, cleanup, secret
mutation, conflicting identities, shell actions, and other tools remain
user-approved. Redacted transcripts persist under
`.somite/agent-transcripts/`.

Pixi and Nextflow share one initially empty session tool root. Agent compilation
retains the canonical frozen package under `.somite/compiled/`, verifies its
content-addressed path, complete Run-closure schema, and compiler-trusted file
manifest, then leases an isolated copy of that exact package into the tool
root. Both MCP servers receive the same workspace-relative path. Lease paths
are unique and remain stable so later compilation cannot invalidate an active
tool call; every lease is generation-bound and the complete private root is
removed before disconnect finishes. Unrelated project files remain outside the
tool filesystem boundary.

Missing tool contracts cross one explicit workshop rather than growing an
unreviewed global catalog. Agent may draft a `project.*` external Operator from
authoritative evidence and prove it through the ordinary frozen RunManager in
an isolated fixture graph. Passing proof changes the candidate to `proven`, not
`accepted`. Only the human Project tools route can publish it into the project
catalog; a failed live-catalog refresh removes the newly written file and leaves
the candidate retryable.

The launched Agent receives an explicit portable environment allowlist rather
than `process.env`. Credential-shaped variables cross only when named through
`SOMITE_AGENT_CREDENTIAL_ENV_NAMES`; the private Somite MCP capability never
crosses that boundary. ACP and MCP newline-delimited streams are byte-framed
before protocol parsing. Loopback MCP HTTP refuses redirects and streams every
response through the same bounded workflow envelope.

## Project data

```text
.somite/
  web.somite.json       canonical working graph
  autosave.somite.json  validated recovery graph
  input-origins/        local input bases scoped to recovered graphs
  uploads/              browser-imported scientific files
  catalog/              bounded remote catalog cache
  papers/               content-addressed artifacts and derived caches
  fixtures/             content-addressed representative data
  compiled/             reusable frozen Agent compilation output
  pixi/locks/           project-local frozen environment provenance
  runs/                 packages, logs, traces, work, and results
  evidence/             append-only receipts and index
  agent-transcripts/    redacted normalized turns
  operator-workshop/    evidence, candidates, and proof receipts
  operators/            user-accepted project-local Operator contracts
```

Pixi lock provenance remains project-local under `.somite/pixi/locks/`.
Installed prefixes live in a separate, short, private, content-addressed user
cache so deeply nested projects do not exceed package relocation placeholders
and identical frozen environments are reused across projects. The cache root is
configurable with the absolute `SOMITE_PIXI_CACHE_DIR` path; temporary storage
is not a durable environment adapter.

Cache schema v3 binds each in-progress entry to a unique builder identity. A
live builder is never reaped solely because its wall-clock age crosses a limit;
on Linux the marker also binds the PID's kernel start identity. Stale cleanup
first atomically quarantines the candidate and verifies its directory and
builder identities before deletion, so a delayed builder or cleaner cannot
delete a replacement entry it no longer owns.

Before publication, the cache creates a bounded entrypoint receipt over every
direct regular file and in-prefix symbolic-link target under `bin` (or
`Scripts` and `Library/bin` for a Windows-targeted prefix). The receipt records
path, type, mode, size, target, and BLAKE3 content digest. Reuse reads and hashes
only that bounded recorded list; missing, retargeted, mode-changed, resized, or
content-modified entrypoints fail closed, and cap overflow never produces a
partial receipt. This deliberately avoids an unbounded recursive scan on every
run. It is not full-prefix attestation: libraries, language site packages, and
other non-entrypoint payloads remain outside this Somite digest receipt.

Compiled workflow reuse is stricter than environment-prefix reuse. A trusted
manifest inventories every expected package file and directory with its mode,
size, and BLAKE3 digest. Reuse rescans that bounded inventory, rejects links,
special or extra entries, and verifies the Run closure still names the same
graph and closure. Failed verification preserves the suspect artifact for
inspection.

Managed resources live outside the project in a separate private cache rooted
at `SOMITE_RESOURCE_CACHE_DIR` or the platform user-cache directory. Their
receipt binds the exact provider manifest and verified installed file metadata;
the portable graph retains a `somite-resource:<provider-id>` import contract,
which production materialization resolves to that machine's canonical cache.

Portable Somite documents are bounded at 64 MiB. Only routes whose primary
payload is a Graph receive that compatibility envelope (plus 64 KiB for scoped
metadata); Agent prompts, transactions, configuration, and other JSON requests
retain the 16 MiB generic limit.

Interactive saves, autosaves, and Agent edits require the current full state
revision. The canonical Graph, recovery autosave, and input-origin sidecar each
use a durable temporary file and atomic rename, but the three publications are
not one crash-atomic commit. If startup cannot prove that a recovered Graph and
its input-origin sidecar match, all Graph persistence and local-input
materialization fail with `input_origin_recovery_required`. Run, Validate,
Export, and Agent compilation therefore cannot use the fallback project path.
Only an explicit, compare-and-swap-protected rebind clears the warning after the
replacement sidecar is durably published.

## Interaction invariants

- The canvas is the primary surface; temporary panels never become alternate
  editors.
- Connections are typed and paired reads retain separate R1/R2 streams.
- Workflow names edit in place and drive safe export names.
- Annotations and colors are portable presentation state only.
- Missing inputs are visible on Nodes and in the persistent bottom status bar.
- Agent is a compact right-side collaborator that can be dragged, resized,
  collapsed, closed, and reopened without ending the session.
- Search and paper reconstruction never mutate the Graph; insertion and
  acceptance are explicit transactions.
- Saves and autosaves are server-validated, compare-and-swap protected, and
  refuse an unresolved input origin.

## Non-goals

- a second desktop GUI or application runtime;
- another environment manager or production workflow engine;
- bundling a model, provider, or invented Agent modes;
- treating package names or DOT labels as executable contracts;
- embedding scientific file bytes in Graph JSON;
- inventing ports, channels, outputs, or provenance;
- describing compilation as validation or a visual reference as runnable.

## Verification

Required before merging:

```bash
npm ci
npm run check
npm audit
git diff --check
```

User journeys that cross Modules require a spawned-runner or real-browser check.
Export changes additionally require inspection of the live ZIP entries and a
frozen launch. Paper recognition changes require the committed gold corpus and,
when available, the ten-paper extraction corpus.

The scheduled unseen-source challenge complements those deterministic gates.
It content-deduplicates recent Europe PMC methods papers and current nf-core
releases against a persistent novelty ledger, records structured outcomes, and
never silently graduates a live source into the fixed test corpus.
