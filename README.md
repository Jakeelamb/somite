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
group viewer controls. The current **Run** and ZIP export paths still use the
native Rust oracle while the generated Nextflow path is integrated into the
web run supervisor; use `somite compile` for the selected production engine.

## Build workflows

The Library provides three complementary entry points:

- **Build** searches typed operators with declared ports, parameters, Pixi
  packages, commands, and output collection rules.
- **Sources** searches NCBI and Ensembl without leaving the canvas. It recognizes
  SRA runs, NCBI assemblies, Ensembl stable IDs, and local files. Paired reads
  remain separate R1 and R2 streams.
- **Pipelines** searches nf-core and Snakemake catalogs. Imported workflows
  expand into editable structural nodes and edges so their internal DAG is
  visible. Engine-authored references are clearly marked and are not presented
  as independently executable tools until they have reviewed Somite
  contracts.

Paper Drop reconstructs one or more candidate graphs from methods text or a
PDF. The evidence view distinguishes text-supported tools, compatibility
inferences, and missing adapters; it never presents an inferred workflow as a
verbatim executable method.

## Compile a runnable workflow

Somite compiles a validated graph into deterministic Nextflow DSL2, an exact
node/edge source map, parameters, and one graph-wide Pixi manifest. Every
external node becomes a stable process; local imports remain visible source
nodes. Compiled processes use deep content caching and reject missing,
zero-byte, or corrupt gzip outputs before they can enter the Nextflow cache.

```bash
cargo run -p somite-cli -- compile path/to/workflow.somite.json build/workflow
pixi run --manifest-path build/workflow/pixi.toml run
```

The first Pixi run writes `pixi.lock`; retain it to freeze exact package builds.
Compilation refuses structural references, nested Nextflow or Snakemake
commands, unsupported collection semantics, invalid parameters, and operator
features it cannot lower faithfully.

## CLI

The CLI uses the same graph and operator catalog as the web app.

```bash
cargo run -p somite-cli -- palette
cargo run -p somite-cli -- env
cargo run -p somite-cli -- compile testdata/fastq_to_fastqc.somite.json build/fastqc
cargo run -p somite-cli -- cook testdata/fastq_to_fastqc.somite.json
cargo run -p somite-cli -- paper testdata/papers/rnaseq_methods.txt
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
      +-- somite-cook     temporary native differential oracle
      +-- somite-paper    evidence-bound reconstruction
      +-- somite-bundle   portable workflow exports
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
