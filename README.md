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

Portable `.somite.json` documents are capped at 64 MiB when opened, imported,
or saved. This compatibility envelope does not widen general or Agent request
limits.

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
- A source-backed Workflow instance contains a live miniature of every indexed
  invocation and known relationship. Scrolling into it seamlessly reveals the
  full outline inside the same persistent canvas; scrolling out reverses the
  camera transform. The toolbar, Agent, grid, and interaction model never
  change. Users can organize any selection into soft hulls, collapse a hull to
  a previewing Macro, recursively zoom through groups, or ungroup them without
  changing the pinned source. Promoting a supported invocation creates a normal
  editable Somite node; missing connections become readiness requirements.

Whole source-backed nf-core imports remain inspect-and-bind workflows when the
upstream source does not freeze every task in one root Pixi environment. A
dropped local Nextflow project becomes executable when its exact source contains
both a root `pixi.toml` and `pixi.lock`, that environment locks Nextflow and
OpenJDK, and no process delegates its environment to a container, Conda,
Spack, or a system module. Somite then preserves those bytes, validates the
source with Nextflow preview mode, runs it with the frozen Pixi environment,
and exports the same closure. Every incomplete source stays inspectable with an
explicit blocker. Promoting reviewed invocations creates an editable native
partial variant; it does not claim to convert an entire imported pipeline.

The canvas supports cursor-centered semantic zoom, magnetic alignment,
undo/redo, multi-selection,
editable document titles, light and dark themes, sticky notes, stage boxes, pen
strokes, and labeled node colors. Presentation edits travel with the graph but
never change execution identity.

### Know what works

Somite computes one deterministic Workflow assessment from the graph and its
pinned operator catalog. The bottom status bar and node badges continuously
show missing inputs, parameters, managed resources, manual checkpoints, and
unsupported contracts. Run, Validate, and Agent compilation stop before doing
work when readiness is blocked.

Downloadable managed resources remain a separate, explicit decision. Somite
shows the declared transfer size, installed size, provenance, and scientific
tradeoff before starting an install; progress, cancellation, checksum failure,
and retry stay visible. A completed resource is connected through a typed
import Node, so the graph records exactly which specialized input it satisfies.

For native workflows rooted in local single or paired FASTQ inputs, Validation
substitutes small content-addressed fixtures, runs the same frozen Nextflow path
as production, and records an append-only evidence receipt for the exact
semantic graph revision. A source workflow with a complete imported Pixi lock
uses Nextflow preview mode instead; that evidence proves source compilation and
DAG construction without claiming that scientific tasks ran. Other input roots
remain runnable with real data, but Validate stays unavailable until Somite has
a reviewed fixture adapter. A compiled graph is never described as validated
until its applicable evidence path succeeds.

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
| `SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS` | 120 | 1–3,600 seconds per extraction command |
| `SOMITE_PAPER_MAX_ACTIVE_JOBS` | 2 | 1–32 concurrent paper jobs |
| `SOMITE_OCR_LANGS` | `eng` | Tesseract list such as `eng` or `eng+deu` |

`OMARCHY_OCR_LANGS` remains a compatibility fallback when
`SOMITE_OCR_LANGS` is unset. Somite verifies the requested trained-data codes
with `tesseract --list-langs` before OCR and includes the language list in its
cache and tool identities.

### Work with an Agent

Agent is an optional bring-your-own ACP collaborator. Somite reads the official
ACP registry, launches the selected agent without a shell in a disposable
workspace, and attaches three first-party stdio MCP servers: Somite for the
canvas and evidence, Pixi for package/environment work, and Nextflow for source
analysis and execution. Exact Somite calls and bounded read-only Pixi/Nextflow
calls are automatically allowed for that session. Installs, runs, remote
launches, deletion, secret mutation, shell, and unknown tools remain explicit
approval boundaries.

ACP children receive only a portable runtime/configuration allowlist, not the
runner's ambient secrets. If an agent authenticates through an environment
credential, opt in to its existing variable by name before launch:

```bash
SOMITE_AGENT_CREDENTIAL_ENV_NAMES=OPENAI_API_KEY pixi run start
```

Somite forwards the named value only to the selected Agent process. This is
explicit environment forwarding, not a credential vault or operating-system
sandbox.

The agent can inspect the graph, search exact operator and data contracts,
apply validated compare-and-swap graph transactions, read readiness, compile,
validate, run, cancel, and inspect evidence. It can also search and read every
page of the version-matched official Pixi and Nextflow documentation, search Conda,
freeze Pixi environments, lint and inspect Nextflow source, discover registry
modules, preview DAGs, and climb from stub/test fixtures to real run evidence.
Every successful graph transaction is one normal undoable canvas edit. Activity
stays available behind progressive disclosure, and redacted turn transcripts
are stored under `.somite/agent-transcripts/`.

When the reviewed catalog does not contain a tool, Agent can draft a
`project.*` contract in Project tools from authoritative documentation, package
recipes, source, and known workflow use. The candidate must run once in an
isolated tiny fixture graph before it becomes eligible; only the user can accept
it into that project's catalog. A package search result alone is never a tool
contract.

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

The browser uses one client whose normalized runner origin and transport are
fixed at construction. JSON responses are size-bounded and runtime-validated at
their endpoint before they can enter browser state; TypeScript types alone are
not treated as network validation.

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
  pixi/locks/
  runs/
  evidence/
  agent-transcripts/
  operator-workshop/
  operators/
```

Frozen Pixi manifests and locks remain project-local under
`.somite/pixi/locks/`. Installed environments are reused across projects from a
short private user cache (`$XDG_CACHE_HOME/somite/pixi` on Linux or
`~/Library/Caches/Somite/pixi` on macOS), keyed by the exact platform, manifest,
and lock content. Set `SOMITE_PIXI_CACHE_DIR` to an absolute private directory
when the default user-cache path is unsuitable; durable environments never use
a temporary directory.

Managed scientific resources use a separate private user cache at
`$XDG_CACHE_HOME/somite/resources` on Linux or
`~/Library/Caches/Somite/resources` on macOS. Set
`SOMITE_RESOURCE_CACHE_DIR` to an absolute path when large reference data
belongs on another local or mounted volume. Resource receipts and file hashes
are verified before a cache entry is published; partial downloads are removed
after failure or cancellation. The Graph stores
`somite-resource:<provider-id>`, so another machine sees the same requirement
and can materialize it into its own cache instead of inheriting this machine's
absolute path.

Interactive graph writes use a full state-revision compare-and-swap. The
canonical graph, recovery autosave, and input-origin sidecar are each published
with a durable temporary file and atomic rename; they are not one crash-atomic
multi-file commit. If a recovered graph no longer matches its saved input
origin, Somite blocks graph persistence, Run, Validate, Export, and Agent
compilation until the user explicitly rebinds the original workflow location
or confirms the project folder.

## Verify a checkout

```bash
npm ci
npm run check
npm run smoke:browser
npm audit --audit-level=moderate
```

`npm run check` typechecks every workspace and the launcher, lints the browser,
builds the production web bundle, enforces tracked-source and client-bundle
size budgets, and runs the runner, shared-workflow, and UI tests.
`npm run smoke:browser` then launches that built bundle in a system Chrome or
Chromium and checks document persistence, Agent controls, local and public data,
local Snakemake and pinned Nextflow workflows, paper reconstruction, readiness,
and validate/run/export control journeys. The Agent journey makes one real turn
through Somite, Pixi, Nextflow, and back to Somite readiness. Set
`SOMITE_BROWSER_PATH` when the
browser is not in a standard system location; this deterministic gate does not
replace real workflow execution.

Maintainers and CI also run `pixi run smoke`. This networked release gate first
exercises the runner directly, then drives the built browser through validation,
execution, durable evidence, and ZIP export for a tiny FastQC workflow using the
real Pixi lock/install and Nextflow path. The direct smoke also imports a fresh
locked-Pixi Nextflow directory, previews it, and executes one real source task.
It does not use fake executables.

`npm run challenge:live` adds a separate compatibility lane. It selects one
recent open-access methods paper and one current nf-core release that are absent
from the content-addressed novelty ledger, runs reconstruction and source
indexing without turning either source into a fixture, and writes a dated report
under `output/challenges/`. Scheduled CI advances the ledger daily so the same
small corpus cannot hide regressions.

Bug reports and user-outcome proposals are welcome through
[GitHub Issues](https://github.com/Jakeelamb/somite/issues); workflow questions
belong in [Discussions](https://github.com/Jakeelamb/somite/discussions). See
[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[RELEASING.md](RELEASING.md). Somite is licensed under the
[Apache License 2.0](LICENSE).
