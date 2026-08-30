<p align="center">
  <img src="web/public/favicon.svg" width="80" height="80" alt="Somite logo">
</p>

<h1 align="center">Somite</h1>

<p align="center">
  <a href="https://github.com/Jakeelamb/somite/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Jakeelamb/somite/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <a href=".nvmrc"><img alt="Node 22.13+" src="https://img.shields.io/badge/node-22.13%2B-43853d.svg"></a>
  <a href="pixi.toml"><img alt="Pixi environment" src="https://img.shields.io/badge/environment-Pixi-f4c542.svg"></a>
</p>

Somite is a web-based visual builder and explainer for reproducible
bioinformatics workflows. Search scientific data and workflow catalogs, place
typed tools on an infinite canvas, inspect inputs and outputs, and export the
same graph as a Nextflow workflow frozen with Pixi.

> [!IMPORTANT]
> Somite is in active pre-1.0 development. The current release is a source
> checkout with a browser UI and local TypeScript runner, not a managed hosted
> service. Review generated workflows before using research data.

## Start Somite

For a normal local install, use Pixi to install and build once:

```bash
git clone https://github.com/Jakeelamb/somite.git
cd somite
pixi run setup
pixi run start
```

Later launches use the existing production bundle, so `pixi run start` does not
rebuild it. After pulling application changes, run `pixi run setup` again.

Or use Node.js 22.13.x directly and keep the same build-once flow. Somite pins
the Node 22 runtime line so local and hosted builds use the same tested runtime:

```bash
npm ci
npm run build
npm start
```

Open <http://localhost:3000>. The launcher starts both the React app and the
TypeScript runner, waits for the runner to become healthy, and stops both
process trees together. To open a specific graph:

```bash
npm start -- path/to/workflow.somite.json
```

For active development, install once with `pixi run install`, then use
`pixi run dev` for the hot-reloading server.

Pixi is optional for browsing and editing. It is required to freeze and execute
the generated Nextflow environment.

Linux and macOS are supported directly. On Windows, run Somite inside WSL2;
native Windows execution is not supported because Somite's reviewed Nextflow
execution path and bioinformatics package set target a POSIX environment.

## What Somite does

### Build and understand workflows

- Typed ports make incompatible connections impossible.
- Local files stream into project-contained storage instead of entering graph
  JSON or browser memory.
- NCBI and Ensembl search accepts organisms, common names, and accessions and
  creates visible download nodes.
- The nf-core catalog resolves exact releases and retains their immutable
  source, parameters, hierarchy, and provenance.
- The Snakemake catalog and local-project importer ask Snakemake only for an
  engine-authored rule graph. These nodes are clearly structural references;
  Somite does not pretend that they are independently runnable tools.
- A nested source canvas lets users inspect a workflow one scope at a time.
  Promoting a supported invocation creates a normal editable Somite node; any
  missing connections become ordinary readiness requirements.

The canvas supports magnetic alignment, deep zoom, undo/redo, multi-selection,
editable document titles, light and dark themes, sticky notes, stage boxes, pen
strokes, and labeled node colors. Presentation edits travel with the graph but
never change execution identity.

### Know what works

Somite computes one deterministic Workflow assessment from the graph and its
pinned operator catalog. The bottom status bar and node badges continuously
show missing inputs, parameters, managed resources, manual checkpoints, and
unsupported contracts. Run, Validate, and Agent compilation stop before doing
work when readiness is blocked.

For workflows rooted in local single or paired FASTQ inputs, Validation
substitutes small content-addressed fixtures, runs the same frozen Nextflow path
as production, and records an append-only evidence receipt for the exact
semantic graph revision. Other input roots remain runnable with real data, but
the Validate control stays unavailable until Somite has a reviewed fixture
adapter for that root. A compiled graph is never described as validated until
its representative run succeeds.

### Rebuild from a paper

The Paper panel searches bioRxiv through Europe PMC and accepts local PDF,
Markdown, or text files. Native PDF text is extracted with PDF.js, recognized
methods retain their page evidence, and reconstruction creates reviewable
candidate graphs without changing the canvas. The user explicitly accepts a
candidate.

Cited SRA, BioProject, BioSample, assembly, and Ensembl identifiers are resolved
through the same data search used by the canvas. Collections remain collections
until the user chooses an exact run. Supported methods, unsupported methods,
missing inputs, and extraction failures remain distinct outcomes.

For scanned or mixed PDFs, Somite identifies the exact pages that need OCR. The
Machine panel can install a project-local, Pixi-locked Poppler and Tesseract
toolchain in one click, verifies executable identities and every configured OCR
language, and refreshes readiness immediately. Missing OCR capability remains
an explicit actionable result; Somite never silently treats scanned pages as
empty.

Paper limits are parsed once when the runner starts. Invalid values stop startup
with the exact variable and accepted range; upload and extraction failures name
the setting to change:

| Variable | Default | Accepted value |
| --- | ---: | --- |
| `SOMITE_PAPER_MAX_UPLOAD_BYTES` | 100 MiB | 1 byte–1 GiB |
| `SOMITE_PAPER_MAX_TEXT_BYTES` | 64 MiB | 1 byte–1 GiB |
| `SOMITE_PAPER_MAX_PAGES` | 200 | 1–10,000 PDF pages |
| `SOMITE_PAPER_MAX_OCR_PAGES` | 200 | 1–10,000 and no greater than the PDF-page limit |
| `SOMITE_OCR_LANGS` | `eng` | Tesseract list such as `eng` or `eng+deu` |

`OMARCHY_OCR_LANGS` remains a compatibility fallback when
`SOMITE_OCR_LANGS` is unset. Somite verifies the requested trained-data codes
with `tesseract --list-langs` before OCR and includes the language list in its
cache and tool identities.

### Work with an Agent

Agent is an optional bring-your-own ACP collaborator. Somite reads the official
ACP registry, launches the selected agent without a shell in a disposable
workspace, and attaches a capability-scoped stdio MCP server. Somite-owned tool
calls are automatically allowed for that session; shell and non-Somite tools
are not.

The agent can inspect the graph, search exact operator and data contracts,
apply atomic compare-and-swap graph transactions, read readiness, compile,
validate, run, cancel, and inspect evidence. Every successful graph transaction
is one normal undoable canvas edit. Activity stays available behind progressive
disclosure, and redacted turn transcripts are stored under
`.somite/agent-transcripts/`.

See [the Agent protocol](docs/agent-protocol.md) for the exact trust and tool
contracts.

## Reproducible execution

Export creates a deterministic ZIP containing:

```text
main.nf
nextflow.config
params.json
node-map.json
pixi.toml
pixi.lock
workflow.somite.json
assessment.json
operators/
run-closure.json
evidence/
toolchain/
```

After extracting a ready package, run it with:

```bash
pixi run --frozen run
```

The Run closure pins the semantic graph revision, operator revisions, platform,
Pixi lock, compiler, Nextflow, and Java identities. Evidence remains separate,
so adding a validation receipt never changes what the workflow means.

## Architecture

Somite has one application language and one production path:

```text
web/                  React canvas and browser interaction
packages/workflow/    graph contracts, catalog, assessment, compiler, freezing
runner/               project state, search, paper, Agent, and job supervision
operators/            reviewed versioned tool contracts
```

The browser and runner both depend directly on `@somite/workflow`; the runner
does not depend on UI code. Pixi and Nextflow remain external execution tools,
and scientific Python belongs inside frozen workflow environments rather than
the Somite application.

The current source release binds the browser to a loopback runner. Windows users
run that local stack inside WSL2. The execution Interface already accepts a
frozen job and emits ordered events, allowing a
future hosted Linux adapter without introducing a second graph or compiler.
See [the architecture](docs/somite-design.md),
[domain model](docs/domain-model.md), and
[operator contract](docs/operator-contract.md).

## Project data

Generated state lives under `.somite/` and is ignored by Git:

```text
.somite/
  web.somite.json
  autosave.somite.json
  input-origins/
  uploads/
  papers/
  catalog/
  fixtures/
  compiled/
  runs/
  evidence/
  agent-transcripts/
```

## Verify a checkout

```bash
npm ci
npm run check
npm audit
```

`npm run check` typechecks every workspace and the launcher, lints the browser,
builds the production web bundle, and runs the runner, shared-workflow, and UI
tests.

Maintainers and CI also run `pixi run smoke`. This networked release gate starts
the built application and executes a tiny FastQC validation through the real
`RunManager`, Pixi lock/install, and Nextflow path; it does not use fake
executables.

Bug reports and user-outcome proposals are welcome through
[GitHub Issues](https://github.com/Jakeelamb/somite/issues); workflow questions
belong in [Discussions](https://github.com/Jakeelamb/somite/discussions). See
[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[RELEASING.md](RELEASING.md). Somite is licensed under the
[Apache License 2.0](LICENSE).
