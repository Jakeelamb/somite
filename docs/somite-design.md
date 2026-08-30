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

The direct local execution targets are Linux and macOS. Windows users run the
same Linux runner and workflow environments inside WSL2; native Windows is not
an execution target.

Somite is implemented in TypeScript. Pixi and Nextflow remain external tools,
and scientific Python belongs inside workflow environments rather than the
Somite application.

## Module map

```text
web/
  app/                 browser interaction and presentation

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

## Core contracts

### Graph

A Graph is the persisted and exported source of truth. Runtime validation
rejects unknown fields, unsafe numbers, stale Operator pins, invalid ports,
incompatible Edges, duplicate scalar inputs, and cycles. TypeScript types are
developer assistance, not the trust boundary.

The semantic Graph revision covers executable Nodes, ports, parameters, Edges,
source pins, profiles, and bindings. Layout, notes, annotations, colors, and the
document title are excluded. The Graph state revision includes that presentation
state and is used for compare-and-swap persistence and Agent transactions.

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
Representative validation is capability-gated separately: the current fixture
adapter supports local single and paired FASTQ roots. Other roots use their real
inputs for Run and never enter a synthetic validation attempt.

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

### Jobs and evidence

A job moves through preparing, queued, running, cancelling, and terminal phases.
Status includes bounded progress and Node states. Cancellation terminates the
complete child process tree. Starts are idempotent, so retrying a lost response
cannot create duplicate compute.

Validation binds supported root sources to small content-addressed FASTQ
fixtures and enters the same compiler and runner. A passing run creates an
append-only Evidence receipt keyed to both semantic Graph and fixture
configuration. Layout-only edits keep the receipt current; semantic edits do
not.

## Workflow imports

### nf-core

Somite resolves an exact release to an immutable Git commit and verified source
tree. One outer source-backed Node opens a nested source canvas containing only
the current scope and its immediate invocations. This is a source outline, not a
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
scientific tradeoffs belong in deterministic Requirements and Resolutions.

## Paper reconstruction

Paper intake stores bounded content-addressed PDF/text objects. An isolated
PDF.js worker extracts native text page by page with cancellation and progress.
Only unreadable pages in scanned or mixed PDFs enter bounded OCR. Somite can
install Poppler and Tesseract into a project-local, Pixi-locked environment,
then verifies versions and English trained data before publishing an atomic
receipt. Missing capability returns `paper_ocr_unavailable`; it never produces
a partial-paper reconstruction. Extraction caches retain the exact PDF.js/OCR
tool identity and options separately from deterministic reconstruction caches.

Reconstruction retains exact method surfaces, nearby evidence, PDF pages,
unsupported identities, and cited resources. Parallel analyses and alternative
methods stay in separate Candidate graphs. A Candidate crosses the Interface
only when it is non-empty and valid against the current Graph and Catalog
contracts. The canvas changes only after explicit acceptance.

## Agent collaboration

ACP carries conversation between the workspace and one user-selected agent.
Somite launches it without a shell in a disposable workspace and supplies a
capability-scoped stdio MCP server. MCP exposes the same graph, catalog,
assessment, compiler, runner, and evidence Modules used by humans.

Agent edits are short atomic transactions against a Graph state revision. Somite
applies them to a clone, validates the complete result, atomically persists all
or none, and presents each successful transaction as one undoable canvas edit.
Only exact `somite.*` permission requests are automatically allowed for the
session. Redacted normalized transcripts persist under
`.somite/agent-transcripts/`.

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
  runs/                 packages, logs, traces, work, and results
  evidence/             append-only receipts and index
  agent-transcripts/    redacted normalized turns
```

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
- Saves and autosaves are server-validated and compare-and-swap protected.

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
