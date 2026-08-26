# Somite architecture

Somite is a web-first node canvas for building reproducible bioinformatics
workflows. The product has one canvas, one graph model, one target execution
engine, and one managed environment system: Nextflow and Pixi respectively.

## Product shape

The browser owns interaction: node placement, typed wiring, parameter editing,
search, paper reconstruction, and export. A local Rust server owns validation,
catalog discovery, file import, execution, caching, paper extraction, and bundle
generation. The browser never creates a second graph or execution model.

```text
web/ React canvas
      │ JSON over localhost
      ▼
somite-server
      ├── somite-ir       graph types and invariants
      ├── somite-ops      operator contracts and Pixi manifest rendering
      ├── somite-nextflow pure Graph-to-DSL2 compilation
      ├── somite-linker   immutable revisions, run closures, evidence receipts
      ├── somite-fixtures content-addressed representative biological data
      ├── somite-cook     explicit native differential oracle
      ├── somite-paper    methods extraction and evidence-backed reconstruction
      ├── somite-bundle   frozen Pixi/Nextflow run packages
      ├── ACP bridge      one optional user-provided agent session
      └── MCP server      typed, revision-safe Somite capabilities
```

The CLI is a headless client of the same Rust modules. There is no native GUI
or alternate desktop implementation.

The agent is also a client. ACP carries one user-provided conversation into the
workspace; stdio MCP carries explicit Somite tool calls back. Somite supplies
neither a model nor behavioral modes. Graph mutations are compare-and-swap
transactions that enter the same browser history as human edits. See
[agent-protocol.md](agent-protocol.md).

## Deep modules

### `somite-ir`

Interface: `Graph`, `Node`, `Edge`, typed ports, validation, and topological
ordering.

Invariants:

- graph IDs are unique;
- edges reference existing nodes and ports;
- source and destination port types are compatible;
- each scalar input has at most one source edge;
- the graph is acyclic;
- graph JSON is the persisted and exported source of truth.

### `somite-ops`

Interface: load an operator catalog, render argv tokens, generate discovered
nf-core operators, and render a Pixi manifest from the operators used by a
graph.

Each operator declares:

- stable ID, title, and palette placement;
- typed input and output ports;
- scalar parameters;
- an executable and argv template for external tools;
- Pixi package requirements;
- output collection rules.

Package discovery is not operator discovery. A package does not define typed
ports, arguments, or outputs. Paper-only methods remain adapter gaps until a
reviewed operator contract exists.

### `somite-nextflow`

Interface: `compile(graph, catalog, options)`.

The compiler is a pure Module: it performs no filesystem, process, or network
I/O and either returns the complete run package or an error. Its output is
deterministic DSL2, `nextflow.config`, parameters, a node/edge source map, and a
Pixi manifest pinned to the selected Nextflow and OpenJDK versions. External
Operators become static processes with stable aliases. File imports become
input channels rather than hidden tasks.

Compiled processes use Nextflow deep caching and validate required artifacts
before task completion. The first implementation supports scalar ports and
single or paired local imports. It rejects structural references, nested
workflow engines, output exclusion rules, and all other semantics it cannot
lower exactly.

### `somite-cook`

Interface: `cook_graph(project, catalog, graph)`.

This is an explicit differential-test oracle, not a production engine. The web
server never calls it. Developers may invoke `somite cook-oracle` when comparing
native reference behavior with compiled Nextflow behavior.

### `somite-linker`

Interface: `link(graph, catalog, environment, options)` and
`freeze(draft, pixi_lock)`.

The linker keeps immutable operator identity, target-specific executable
closure identity, and validation evidence separate. Layout-only edits do not
change the semantic graph revision or run closure.

### `somite-fixtures`

Interface: `bind_representative_fastq(graph, fixture_store)`.

The first fixture family covers local single- and paired-end FASTQ source
graphs. Objects are stored once by content digest. Binding returns both the
actual runnable Graph and a path-independent configuration digest. Any source
operator outside the supported family fails closed instead of reaching a
network.

### `somite-paper`

Interface: extract methods text and return candidate graphs with evidence for
every reconstructed node and inferred edge.

The module preserves uncertainty. It distinguishes text-supported tools,
compatibility inferences, and tools that need adapters. Parallel analyses and
compared methods remain separate candidate graphs.

### `somite-bundle`

Interface: `create_frozen_package(graph, catalog, target, destination,
binary_probe)` and `archive_frozen_package(package)`.

The output ZIP contains only what is needed to inspect and run the graph:

```text
main.nf
nextflow.config
params.json
node-map.json
pixi.toml
pixi.lock
workflow.somite.json
operators/<used-id>.json
run-closure.json
evidence/index.json
toolchain/tools.json
```

The CLI, web runner, and web export all call this one freezer. The archive has
no native launcher and runs with `pixi run --frozen run`.

### `somite-server`

Interface: localhost endpoints for session state, graph validation and saving,
autosave recovery, uploads, cancellable Nextflow run supervision, paper
reconstruction, catalog discovery, system detection, export planning, frozen
ZIP export, agent transactions, evidence lookup, and ACP activity.

The server validates all graph writes. Uploaded files are copied into the
project, and the browser receives project-relative paths rather than arbitrary
server filesystem access. `POST /api/runs` creates a background run; status and
cancellation use the run-scoped endpoints while Nextflow trace data maps back
to graph node IDs.

## Web interaction contract

- The canvas is the primary surface.
- Library, Paper, Machine, and Export are temporary mutually exclusive panels.
- Connections are typed; incompatible ports never connect.
- Paired reads have separate R1 and R2 ports and snap together when possible.
- The source launcher resolves exact accessions locally and searches NCBI and
  Ensembl into provider- and artifact-tagged suggestions.
- Node dragging uses a magnetic grid and neighbor alignment.
- Pan and zoom work with mouse, trackpad, keyboard, and canvas controls; the
  overview range reaches 2% for very large imported workflows.
- A compact sun/crescent control switches the persisted light or dark theme.
- Multi-selection moves, duplicates, deletes, and toggles viewers as a group.
- Clicking outside a temporary panel closes it.
- Saves and autosaves are server-validated.
- The always-available Bot button opens one optional bring-your-own ACP agent.
- Agent messages, tools, permissions, and transactions remain visible; each
  transaction is one undoable canvas edit.

## Project data

```text
.somite/
  web.somite.json       editable working graph
  autosave.somite.json  validated recovery graph
  catalog/              cached external catalog data
  uploads/              browser-imported files
  fixtures/objects/     content-addressed representative data
  evidence/             append-only receipts and index
  compiled/<revision>/  reusable content-addressed agent compile output
  runs/<run-id>/        frozen closure, logs, trace, work, and results
  exports/              ephemeral staging; empty after each download
```

Generated state stays under `.somite/`. Operator contracts remain in
`operators/`, and frozen archives carry copies of only the contracts they use.

## Non-goals

- maintaining a second desktop GUI;
- supporting multiple competing environment managers;
- bundling a model, model provider, or a second set of agent modes;
- claiming that engine-authored structural workflow references are executable
  before they have reviewed contracts;
- treating a package name as a complete operator;
- embedding scientific file bytes in the graph JSON;
- inventing outputs or tool provenance that the source does not establish.

## Verification

Required before merging user-facing changes:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd web
npm run typecheck
npm run lint
npm test
```

Export changes additionally require an HTTP-level ZIP check against the live
server and inspection of the archive entries and launcher.
