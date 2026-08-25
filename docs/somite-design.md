# Somite architecture

Somite is a web-first node canvas for building reproducible bioinformatics
workflows. The product has one canvas, one graph model, one executor, and one
managed environment system: Pixi.

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
      ├── somite-cook     staging, Pixi execution, and artifact cache
      ├── somite-paper    methods extraction and evidence-backed reconstruction
      └── somite-bundle   portable Pixi run bundles
```

The CLI is a headless client of the same Rust modules. There is no native GUI
or alternate desktop implementation.

## Deep modules

### `somite-ir`

Interface: `Graph`, `Node`, `Edge`, typed ports, validation, and topological
ordering.

Invariants:

- graph IDs are unique;
- edges reference existing nodes and ports;
- source and destination port types are compatible;
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

### `somite-cook`

Interface: `cook_graph(project, catalog, graph)`.

Before running external nodes, the cook engine writes one graph-wide
`.somite/pixi.toml`. Packaged tools always execute through `pixi run`, which
resolves the environment, updates `.somite/pixi.lock`, installs packages when
needed, and activates them. Operators without package declarations may call a
real system binary; missing declarations produce an actionable error.

Inputs are staged from the content-addressed store into isolated work
directories. Outputs are matched using the operator contract and ingested back
into the store. The cook key includes operator schema, parameters, and input
artifact hashes.

### `somite-paper`

Interface: extract methods text and return candidate graphs with evidence for
every reconstructed node and inferred edge.

The module preserves uncertainty. It distinguishes text-supported tools,
compatibility inferences, and tools that need adapters. Parallel analyses and
compared methods remain separate candidate graphs.

### `somite-bundle`

Interface: `build_bundle(graph, catalog, target, binary_probe)`.

The output ZIP contains only what is needed to inspect and run the graph:

```text
workflow.somite.json
operators/<used-id>.json
toolchain/pixi.toml
toolchain/tools.json
README.md
run.sh
```

`run.sh` executes the graph through the bundled Pixi manifest. The generated
lock belongs beside that manifest and freezes exact package builds.

### `somite-server`

Interface: localhost endpoints for session state, graph validation and saving,
autosave recovery, uploads, execution, paper reconstruction, catalog discovery,
system detection, export planning, and ZIP export.

The server validates all graph writes. Uploaded files are copied into the
project, and the browser receives project-relative paths rather than arbitrary
server filesystem access.

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

## Project data

```text
.somite/
  web.somite.json       editable working graph
  autosave.somite.json  validated recovery graph
  pixi.toml            graph-wide generated environment
  pixi.lock            exact resolved builds
  cache/                artifacts and cook indexes
  catalog/              cached external catalog data
  uploads/              browser-imported files
```

Generated state stays under `.somite/`. Operator contracts remain in
`operators/`, and portable bundles carry copies of only the contracts they use.

## Non-goals

- maintaining a second desktop GUI;
- supporting multiple competing environment managers;
- claiming that engine-authored structural workflow references are translated
  native executable nodes;
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
