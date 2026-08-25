# Axial architecture

Axial is a web-first node canvas for building reproducible bioinformatics
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
axial-server
      ├── axial-ir       graph types and invariants
      ├── axial-ops      operator contracts and Pixi manifest rendering
      ├── axial-cook     staging, Pixi execution, and artifact cache
      ├── axial-paper    methods extraction and evidence-backed reconstruction
      └── axial-bundle   portable Pixi run bundles
```

The CLI is a headless client of the same Rust modules. There is no native GUI
or alternate desktop implementation.

## Deep modules

### `axial-ir`

Interface: `Graph`, `Node`, `Edge`, typed ports, validation, and topological
ordering.

Invariants:

- graph IDs are unique;
- edges reference existing nodes and ports;
- source and destination port types are compatible;
- the graph is acyclic;
- graph JSON is the persisted and exported source of truth.

### `axial-ops`

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

### `axial-cook`

Interface: `cook_graph(project, catalog, graph)`.

Before running external nodes, the cook engine writes one graph-wide
`.axial/pixi.toml`. Packaged tools always execute through `pixi run`, which
resolves the environment, updates `.axial/pixi.lock`, installs packages when
needed, and activates them. Operators without package declarations may call a
real system binary; missing declarations produce an actionable error.

Inputs are staged from the content-addressed store into isolated work
directories. Outputs are matched using the operator contract and ingested back
into the store. The cook key includes operator schema, parameters, and input
artifact hashes.

### `axial-paper`

Interface: extract methods text and return candidate graphs with evidence for
every reconstructed node and inferred edge.

The module preserves uncertainty. It distinguishes text-supported tools,
compatibility inferences, and tools that need adapters. Parallel analyses and
compared methods remain separate candidate graphs.

### `axial-bundle`

Interface: `build_bundle(graph, catalog, target, binary_probe)`.

The output ZIP contains only what is needed to inspect and run the graph:

```text
workflow.axial.json
operators/<used-id>.json
toolchain/pixi.toml
toolchain/tools.json
README.md
run.sh
```

`run.sh` executes the graph through the bundled Pixi manifest. The generated
lock belongs beside that manifest and freezes exact package builds.

### `axial-server`

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
- Node dragging uses a magnetic grid and neighbor alignment.
- Pan and zoom work with mouse, trackpad, keyboard, and canvas controls.
- Multi-selection moves, duplicates, deletes, and toggles viewers as a group.
- Clicking outside a temporary panel closes it.
- Saves and autosaves are server-validated.

## Project data

```text
.axial/
  web.axial.json       editable working graph
  autosave.axial.json  validated recovery graph
  pixi.toml            graph-wide generated environment
  pixi.lock            exact resolved builds
  cache/                artifacts and cook indexes
  catalog/              cached external catalog data
  uploads/              browser-imported files
```

Generated state stays under `.axial/`. Operator contracts remain in
`operators/`, and portable bundles carry copies of only the contracts they use.

## Non-goals

- maintaining a second desktop GUI;
- supporting multiple competing environment managers;
- silently translating arbitrary workflow DSLs into native nodes;
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
