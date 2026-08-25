# Somite

Somite is a local-first visual builder for reproducible bioinformatics
workflows. Search for tools and public data, drag them onto an infinite canvas,
connect typed ports, inspect the resulting DAG, and run or export the same graph
through a Rust execution engine and Pixi environment.

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
group viewer controls. Use **Run** to execute the current graph and **Export**
to download a portable Pixi-backed `.somite.zip` bundle.

## Build workflows

The Library provides three complementary entry points:

- **Build** searches native operators with declared ports, parameters, Pixi
  packages, commands, and output collection rules.
- **Sources** searches NCBI and Ensembl without leaving the canvas. It recognizes
  SRA runs, NCBI assemblies, Ensembl stable IDs, and local files. Paired reads
  remain separate R1 and R2 streams.
- **Pipelines** searches nf-core and Snakemake catalogs. Imported workflows
  expand into editable structural nodes and edges so their internal DAG is
  visible. Engine-authored references are clearly marked and are not presented
  as independently executable native operators until they have reviewed Somite
  contracts.

Paper Drop reconstructs one or more candidate graphs from methods text or a
PDF. The evidence view distinguishes text-supported tools, compatibility
inferences, and missing adapters; it never presents an inferred workflow as a
verbatim executable method.

## Reproducible execution

Somite uses one graph-wide Pixi environment. On the first run it resolves the
packages declared by the graph's operators and writes `.somite/pixi.toml` and
`.somite/pixi.lock`. Inputs are staged into isolated work directories, outputs
are content-addressed, and the cook key includes operator schema, parameters,
and input hashes.

An exported bundle contains the graph, only the operator contracts it uses, a
tool audit, its Pixi manifest, and a launcher. Run `./run.sh` in the unpacked
bundle and retain the generated lockfile to freeze exact package builds.

## CLI

The CLI uses the same graph, catalog, executor, and cache as the web app.

```bash
cargo run -p somite-cli -- palette
cargo run -p somite-cli -- env
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
      +-- somite-cook     Pixi execution and artifact cache
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
