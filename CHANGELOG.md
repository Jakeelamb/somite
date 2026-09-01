# Changelog

Notable changes to Somite are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and release versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A local-first visual canvas for typed bioinformatics graphs, direct editing,
  autosave, undo/redo, annotations, and human-readable readiness guidance.
- Deterministic Nextflow DSL2 and Pixi package generation with pinned operator,
  graph, environment, and run-closure identities.
- Representative-data validation with content-addressed fixtures and
  configuration-scoped evidence receipts.
- Offline representative validation for exact SRA, NCBI assembly, and Ensembl
  source shapes using typed FASTQ, FASTA, BAM, GTF, and GFF3 fixtures, with public
  retrieval retained as inconclusive and tiny-data parameter changes disclosed.
- Native NCBI, Ensembl, nf-core, local-file, and Snakemake discovery or import
  paths without hiding source operations from the graph.
- Evidence-bound paper reconstruction with reviewable candidates and explicit
  unsupported-method, input, resource, and manual-checkpoint boundaries.
- Paper reconstruction retains cited public workflow repositories with page
  evidence and can open their immutable Nextflow source independently of a
  prose-derived draft.
- Bounded public GitHub Nextflow import with immutable commits, verified source
  archives, decoded cache metadata, and unambiguous entrypoint selection.
- Reviewed paper adapters for MultiQC, Picard MarkDuplicates, and Kallisto
  indexing plus paired- and single-end quantification.
- Bring-your-own ACP agents backed by revision-safe MCP tools and normal,
  undoable canvas transactions.
- A content-addressed, observable paper-intake pipeline using native PDF.js
  extraction, cached reconstruction, explicit outcomes, and retained evidence.
- Streaming, bounded local-file intake; engine-authored Snakemake import; and a
  thin stdio MCP adapter for Somite-owned Agent tools.
- One root npm workspace and Pixi development lock spanning Linux and macOS,
  with a launcher that starts and stops the browser and runner together. Windows
  users run the same Linux path through WSL2.
- Continuous verification for the complete TypeScript product on pushes and
  pull requests.
- Dependency review, automated dependency updates, issue forms, and pull
  request guidance.
- A source-release workflow that verifies the tag against both package versions
  before creating a GitHub release.
- A build-once production launcher and gated POSIX release smoke that exercises
  the real Pixi, Nextflow, representative-data, and `RunManager` execution path.
- A deterministic production-browser gate covering document persistence, Agent
  controls, data and pinned-workflow placement, nested visualization, paper
  reconstruction, readiness, and validate/run/export control journeys.
- Browser-to-runner release smoke that validates and runs a real frozen
  Nextflow package, records durable evidence, and downloads the exported ZIP.
- Full browser directory import for local Nextflow trees, plus exact validation,
  execution, compilation, and export when the source carries one complete root
  Pixi lock without delegated task environments.
- Exact per-task execution for source Nextflow projects. Static Conda task
  environments retain their dependencies and channel order in one Pixi lock;
  dynamic, missing, ambiguous, or unsupported environments fail closed.
  Host-only Run rewrites and portable Compile/Export rewrites are separately
  verified, while wrapper tools remain isolated in the default runtime.
- Frozen source preparation with bounded configuration closure, exact plugins,
  one final local/no-scratch policy, and offline native `config` and `inspect`
  receipts before execution.
- A daily unseen-source challenge that advances a content-addressed novelty
  ledger across recent Europe PMC methods papers and current nf-core releases
  and retains structured diagnostic reports without expanding the fixed corpus.
- Enforced source and production-client size budgets, including rejection of
  tracked generated state and oversized browser chunks.
- Versioned benchmark receipts, paired same-host comparison, CPU and heap
  profiles, quality digests, and machine-readable bundle budgets.
- A clean committed-source proof that installs, builds, launches, health-checks,
  and shuts down the source archive before releases are published.
- A project-local Operator Workshop where agents can draft evidence-backed
  `project.*` contracts, prove them through isolated frozen fixture runs, and
  leave final catalog acceptance to the user.
- Checksum-pinned managed resources with consent, effect disclosure, private
  caching, progress, cancellation, retry, receipts, and typed graph insertion.
- Security, contribution, conduct, and release-maintainer policies.

### Changed

- Source-backed workflows now use cursor-centered semantic zoom in the one
  persistent canvas. Workflow instances and collapsed Macros show live child
  previews; zooming through them recursively rebases the camera without
  changing the grid, tools, Agent, or interaction model, and zooming out applies
  the exact inverse transform. Users can still nest arbitrary selections into
  soft hulls, move members between groups, and ungroup them through persisted,
  undoable presentation state. Proxy and Source-structure relationships remain
  distinct from executable typed dataflow.
- Completed the migration to one TypeScript web product. The browser and runner
  now share graph contracts, catalog loading, assessment, compilation, Pixi
  freezing, source-workflow handling, and paper reconstruction through
  `@somite/workflow`.
- Browser-to-runner calls now use a per-instance client with fixed transport
  configuration, bounded response bodies, and runtime validation for every JSON
  result before it enters UI state.
- Agent subprocesses now receive an explicit portable environment allowlist,
  credential variables require named opt-in, and ACP/MCP streams are bounded
  before protocol parsing.
- Paper reconstruction now bounds accession shapes and cardinality, scans PDF
  pages linearly, reports resource truncation, and guarantees that every
  completed review fits the browser's paper-status envelope.
- Removed the Cargo workspace, Rust toolchain, native-executor spike, duplicate
  web lockfile, and obsolete implementation documents. Accepted output fixtures
  remain as language-independent regression contracts.
- Replaced the server and shell launcher with a cross-platform TypeScript runner
  and process supervisor. Pixi and Nextflow remain external execution tools.
- Paper intake now has one startup-validated configuration for its upload, text,
  PDF-page, OCR-page, command-timeout, concurrency, and Tesseract-language
  bounds, with actionable failures.
- Kept all 15 concrete Agent result contracts while reducing their serialized
  discovery footprint from 87,874 to 24,042 bytes.
- Deferred workspace panels into a bounded production chunk and reused the
  immutable source-call index across semantic previews and edits.
- Snakemake catalog intake now streams the current upstream catalog within
  aggregate wire, entry, and cache limits instead of buffering its full source.
- Nextflow source indexing and parameter-schema projection now carry aggregate
  cardinality, depth, precision, string, and derived-memory limits across the
  complete pinned workflow.
- Source parameter projection now accepts nf-core path-existence constraints
  only where project-file trust can enforce them, validates common bounded
  anchored patterns, and retains remote URI defaults in pinned source. Unseen
  workflow reports also time discovery, import, and the same semantic canvas
  projection used by the UI, with exact invocation coverage.
- Release verification separates read-only tagged-source execution from the
  minimal publish authority and crosses Linux and macOS on x64 and arm64.
- Replaced the abbreviated license notice with the complete Apache License 2.0
  text so hosting and compliance tools can identify the project license.

### Fixed

- Clean-source proof drops inherited npm configuration and excludes generated
  build outputs from the archive's tracked-source profile.
- Local gzip-compressed FASTQ inputs now retain exact `FastqGz` types and paired
  read roles. Mixed-compression pairs fail before upload, and STAR accepts them
  only through a visible typed decompression step while gzip-aware tools can
  consume the compressed source directly.
- GATK HaplotypeCaller no longer appears runnable from an arbitrary BAM and
  FASTA. Its visible typed path now requires reviewed read-group metadata,
  coordinate sorting, BAM indexing, FASTA indexing, and a sequence dictionary;
  the Linux Pixi/Nextflow smoke verifies the resulting VCF artifact.
- Source-backed calls and relationships can no longer disappear through canvas
  deletion, and semantic zoom now exits with current group geometry after
  moving, re-nesting, or dissolving presentation groups.
- Agent-compiled Pixi/Nextflow packages now verify a compiler-trusted manifest
  and canonical Run closure before entering the shared tool root. Stable,
  generation-bound lease paths no longer invalidate active tool calls, and
  disconnect waits for complete private-workspace cleanup.
- Native and source compilation caches now require an exact bounded inventory,
  file modes, BLAKE3 digests, and matching Run-closure identity before reuse;
  corrupt or extra entries fail closed and remain available for inspection.
- Source execution now uses one effective `-C` wrapper, exact bindings, private
  offline state, local-only policy, and frozen plugins. Native config, process,
  and DAG proofs gate admission; exported ZIPs retain a portable launcher.
- Run cancellation now rechecks the abort signal at process creation and always
  releases child ownership, closing the cancel-before-spawn race.
- Source-index cache identity now advances whenever immutable indexing or
  execution-capability derivation changes, so an older source graph is rebuilt
  instead of failing later trust verification against newer semantics.
- Pixi cache schema v3 no longer reaps a live builder because of elapsed time or
  lets stale cleanup delete a replacement entry. Published prefixes carry a
  bounded, reverified digest receipt for executable-directory entrypoints;
  deleted or modified entrypoints now fail closed without claiming integrity
  for libraries, language site packages, or the complete environment tree.
- Paper reconstruction now keeps recognized unsupported methods and explains
  that workflow support is unavailable instead of blaming the uploaded paper.
- Supported paper drafts now retain executable but untyped methods as
  unconnected evidence nodes instead of silently omitting them or presenting
  them as missing runtime inputs. Command-specific SAMtools nodes are selected
  only from explicit action evidence, while unresolved suite work stays visible.
- nf-core imports now retry older pinned pipelines with process-scoped legacy
  parser compatibility and show expansion progress or actionable failures in
  the catalog instead of relying on the footer status line.
- Frozen Nextflow imports now resolve repository-root `projectDir` module
  paths and keep imported helper and plugin functions out of the visual
  process/subworkflow outline.
- Imported workflow references now retain their generated dependency ports
  through autosave and readiness checks without becoming executable contracts.
- The Agent window is clamped into the current viewport when it opens or the
  browser is resized, so its launcher cannot disappear behind an off-screen
  panel.
- Custom runner ports now propagate into the browser, Agent discovery avoids a
  repeated remote-registry round trip, and every Agent mutation path uses the
  same bounded replay cache.
- Portable workflow open, import, and save paths again accept documents up to
  64 MiB without widening general or Agent request limits.
- Source parameter editing now fails closed on duplicate JSON members,
  precision-losing numbers, coupled or future schema assertions, malformed
  annotations, and type-incompatible constraints while leaving independently
  proven parameters editable.
- Local Snakemake projects now cross the production browser and runner path in
  release tests, including actionable Pixi-environment failure guidance and a
  verified engine-authored rule graph.
- Production-browser export now starts the generated ZIP download and reports
  its filename instead of stopping after bundle creation.
- Recovered workflows with an uncertain local input origin now fail closed:
  graph persistence, Run, Validate, Export, and Agent compilation remain blocked
  until a compare-and-swap-protected explicit rebind succeeds.
- Launcher shutdown now cancels active workflow, paper, and Agent process trees
  without leaving the local runner behind. Module paths and Pixi executable
  discovery use platform-appropriate layouts on supported direct platforms.
- Lazy workspace-panel loading now exposes authoritative expanded state, and
  semantic-zoom browser checks retain stable source invocation identities while
  viewport rendering mounts only visible Nodes.

[Unreleased]: https://github.com/Jakeelamb/somite/commits/main
