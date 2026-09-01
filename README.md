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
When Somite is started through Pixi, the locked application environment includes
the exact Nextflow and OpenJDK versions used by the Agent and release smoke, so
execution never falls back to an unrelated host installation.

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

Source-backed workflows have two exact environment paths. A dropped Nextflow
project that contains both a root `pixi.toml` and `pixi.lock` keeps the existing
root-lock path: that environment must lock Nextflow and OpenJDK, and tracked
source must not delegate task environments to containers, Conda, Spack, or
system modules. Somite adopts those bytes without solving a replacement lock.
Supplying only one root Pixi file remains an error; Somite does not silently
fall through to another strategy.

When neither root Pixi file exists, Somite can freeze reachable processes whose
source contains exactly one static Conda literal. It may be a source-relative
environment file or a bounded direct MatchSpec list. Byte-identical files and
identical direct expressions share their own content-addressed named Pixi
environments; different contents stay isolated, so conflicting tool versions
across tasks remain valid. Each environment retains its own dependency versions,
builds, explicit channels, and case-sensitive channel priority. Different named
environments may use different channel orders because their solves remain
isolated. Direct expressions use their explicit channels or one exact
`conda.channels` order from frozen source configuration; Somite never sorts or
invents priority between multiple channels.

Rendering preserves every source-owned requirement, channel order, and digest.
Task features contain exactly the frozen scientific dependencies: Somite does
not inject launcher packages or an extra support channel into their solves. A
separate default runtime pins Nextflow, OpenJDK, micromamba, Bash, coreutils,
gawk, grep, sed, and procps-ng on Linux. Somite launches Nextflow without an
ambient `CONDA_PREFIX`, so that runtime remains the fallback after Nextflow
activates an existing task prefix without contaminating the task solve.

The static planner evaluates only a bounded, side-effect-free subset of
Nextflow configuration needed to resolve source-local `includeConfig` paths from
exact scalar bindings and the fixed offline environment. It is not a Groovy
interpreter. Dynamic, external, or missing configs; configuration precedence
that cannot be reduced statically; unresolved reachable calls; ambiguous
process mappings; and dynamic or missing task environments fail closed. Exact
`id@version` Nextflow plugins are installed with the locked runtime into a
content-addressed, fully inventoried store. Dynamic, unpinned, conflicting, or
corrupt plugins remain blockers.

Run installs the one frozen workspace and rewrites only a staged execution copy
to verified host prefixes. Compile and Export never embed those machine paths;
their staged copy uses portable
`${projectDir}/.pixi/envs/<content-addressed-name>` literals. The immutable
imported source remains provenance for both copies. Validate still invokes
Nextflow preview mode, so its receipt proves compilation and DAG construction,
not execution of the scientific processes. Whole imports outside either exact
path remain inspectable with explicit blockers. Promoting reviewed invocations
creates an editable native partial variant; it does not claim to convert an
entire imported pipeline.

Every admitted source run starts Nextflow with one generated effective `-C`
wrapper. It binds the selected scalar parameters around the exact source configs
and applies the final Somite profile last. For generated task environments, its
catch-all process selector forces the local executor, disables scratch staging,
uses the locked Pixi Bash for task scripts, and disables trace, timeline, report,
container, Wave, and Fusion engines. A frozen source `conda` profile is activated
only when the frozen channel order originates in that profile. Nextflow also receives a package-private
offline `NXF_HOME` and only the frozen plugin store, so user-global configuration
and plugins cannot alter execution. Nextflow's outer local wrapper currently
requires host `/bin/bash`; Somite checks that prerequisite before a source Run
instead of failing later with an opaque task error.

Before preview or Run, the locked Nextflow runtime must resolve that exact
configuration and emit a bounded process inspection offline. Somite uses the
default parser first and retries parser v1 only for the exact known legacy
configuration diagnostic; every attempt is retained in the proof receipt. This
proves configuration and structure, not task execution or scientific
equivalence. Exported source packages retain project-relative input bindings
and include an executable `./somite-run` launcher; after the named inputs are
placed beside the extracted project, the launcher installs the exact Pixi lock
and repeats the same frozen policy.

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

For native workflows rooted in reviewed FASTQ, FASTA, BAM, GTF, or GFF3 inputs,
Validation substitutes small content-addressed fixtures, runs the same frozen
Nextflow path as production, and records an append-only evidence receipt for the
exact semantic graph revision. Exact SRA, NCBI assembly, and Ensembl source
shapes use the same pack without network downloads: their retrieval nodes are
reported as skipped and inconclusive while connected downstream tools run.
Tiny-data-only parameter changes, such as STAR index sizing, are disclosed and
included in fixture-configuration identity. This proves only that scoped
representative run, not retrieval, production-scale behavior, or scientific
equivalence. A source workflow with a complete imported Pixi lock uses Nextflow
preview mode instead; that evidence proves source compilation and DAG
construction without claiming that scientific tasks ran. Unknown source shapes
remain runnable with real data but fail validation capability closed until a
reviewed fixture adapter exists.

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

When the paper explicitly cites a public GitHub workflow or pipeline repository,
Somite keeps that citation and page evidence beside the reconstruction. **Use
cited workflow** resolves the repository to an immutable Git commit, downloads
that exact source tree, and opens its indexed Nextflow structure on an unchanged
empty canvas. This is separate from the prose-derived candidate: the cited
source can be visualized even when Somite cannot infer an executable graph from
the Methods text. Exact Run and Export remain gated by the source workflow's
frozen environment evidence.

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
Compilation leases the exact frozen closure into the shared confined Pixi and
Nextflow workspace, so both tool servers inspect the artifact Somite actually
produced without gaining access to unrelated project files.
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
a temporary directory. Cache schema v3 gives each builder an ownership identity,
never reaps a live builder only because it is old, and quarantines an unchanged
stale entry before deletion so an older cleanup cannot remove its replacement.
Publication also records a bounded digest receipt for every direct file or
in-prefix symbolic-link target in each environment's executable directories
(`bin`, or `Scripts` and `Library/bin`). Reuse rechecks that fixed receipt, so a
deleted or modified recorded entrypoint fails closed without recursively
scanning the environment tree. This is entrypoint integrity, not complete
payload integrity: libraries, Python or R site packages, and other data below
the prefix are not content-hashed by this receipt.

Reusable compiled workflow directories have a separate complete package
manifest. Before reuse or Agent attachment, Somite rejects extra directories,
unlisted files, links, mode drift, changed bytes, or a Run-closure identity
mismatch. A failed integrity check leaves the suspect directory untouched for
inspection instead of silently replacing it.

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
npm run benchmark:quick
npm audit --audit-level=moderate
```

`npm run check` typechecks every workspace and the launcher, lints the browser,
builds the production web bundle, enforces tracked-source and client-bundle
size budgets, verifies native package locks for every supported CPU/OS target,
and runs the runner, shared-workflow, and UI tests.
`npm run smoke:browser` then launches that built bundle in a system Chrome or
Chromium and checks document persistence, Agent controls, local and public data,
local Snakemake and pinned Nextflow workflows, paper reconstruction, readiness,
and validate/run/export control journeys. The Agent journey makes one real turn
through Somite and verifies cross-server ACP/MCP routing with exact Pixi and
Nextflow version-contract fixtures before returning to Somite readiness. Set
`SOMITE_BROWSER_PATH` when the
browser is not in a standard system location; this deterministic gate does not
replace real workflow execution.

`npm run benchmark:quick` adds repeatable CPU, wall-time, peak-memory, output,
and adjudicated-outcome receipts for the graph, source-indexing, nested-canvas,
compiler, and paper-reconstruction hot paths. The outcome assertions are the
portable gate; timings are compared only as paired runs on the same host. The
slower `npm run benchmark:release` lane measures the production build, bundle
size, browser journeys, and real Pixi/Nextflow path. See
[docs/benchmarks.md](docs/benchmarks.md) for profiling commands, comparison
policy, and the committed-source install/build/start proof.

Maintainers and CI also run `pixi run smoke`. This networked release gate first
exercises the runner directly, then drives the built browser through validation,
execution, durable evidence, and ZIP export for a tiny FastQC workflow using the
real Pixi lock/install and Nextflow path. The direct smoke also imports a fresh
locked-Pixi Nextflow directory, requests and hashes its real preview DAG,
executes conflicting per-task tool versions, extracts the exported ZIP, and
runs its executable `./somite-run` launcher.
It does not use fake executables. The MCP-specific portion keeps documentation
and discovery networks out of this gate; its Pixi proof uses a local task and
its Nextflow fixture runs offline with version checks disabled.

`npm run canary:mcp:live` is the separate upstream contract check. It searches
and reads the complete pinned Pixi and Nextflow manuals, exercises Pixi package
discovery plus a real solve/install/export, and checks Nextflow module discovery
through the MCP servers. Scheduled CI runs it serially once a week, and it can
also be dispatched manually; its result is operational evidence, not a release
or performance gate.

`npm run challenge:live` adds a separate compatibility lane. It selects one
recent open-access methods paper and one current nf-core release that are absent
from the content-addressed novelty ledger, runs reconstruction and source
indexing without turning either source into a fixture, and writes a dated report
under `output/challenges/`. Scheduled CI advances the ledger daily so the same
small corpus cannot hide regressions.

Use `npm run challenge:live -- --dry-run` for an isolated live check. It reads
the existing novelty ledger but advances novelty only in memory, never persists
the ledger, and writes its report to a new private temporary directory printed
in the command result. `--state-dir PATH` and `--report-dir PATH` accept either
absolute paths or paths relative to the repository, so a reproducible external
run can keep both state and reports outside the checkout. Omitting these options
without `--dry-run` preserves the scheduled `.somite/challenges/ledger.json` and
`output/challenges/` behavior.

Weekly benchmark CI retains deterministic and production-host JSON snapshots
separately from that live challenge. Hosted runners are different performance
series, so those snapshots are not compared automatically. Live papers and
workflows are never used as performance baselines.

Bug reports and user-outcome proposals are welcome through
[GitHub Issues](https://github.com/Jakeelamb/somite/issues); workflow questions
belong in [Discussions](https://github.com/Jakeelamb/somite/discussions). See
[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[RELEASING.md](RELEASING.md). Somite is licensed under the
[Apache License 2.0](LICENSE).
