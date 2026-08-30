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
- Native NCBI, Ensembl, nf-core, local-file, and Snakemake discovery or import
  paths without hiding source operations from the graph.
- Evidence-bound paper reconstruction with reviewable candidates and explicit
  unsupported-method, input, resource, and manual-checkpoint boundaries.
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
- Enforced source and production-client size budgets, including rejection of
  tracked generated state and oversized browser chunks.
- Security, contribution, conduct, and release-maintainer policies.

### Changed

- Completed the migration to one TypeScript web product. The browser and runner
  now share graph contracts, catalog loading, assessment, compilation, Pixi
  freezing, source-workflow handling, and paper reconstruction through
  `@somite/workflow`.
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
- Snakemake catalog intake now streams the current upstream catalog within
  aggregate wire, entry, and cache limits instead of buffering its full source.
- Nextflow source indexing and parameter-schema projection now carry aggregate
  cardinality, depth, precision, string, and derived-memory limits across the
  complete pinned workflow.
- Release verification separates read-only tagged-source execution from the
  minimal publish authority and crosses Linux and macOS on x64 and arm64.
- Replaced the abbreviated license notice with the complete Apache License 2.0
  text so hosting and compliance tools can identify the project license.

### Fixed

- Paper reconstruction now keeps recognized unsupported methods and explains
  that workflow support is unavailable instead of blaming the uploaded paper.
- nf-core imports now retry older pinned pipelines with process-scoped legacy
  parser compatibility and show expansion progress or actionable failures in
  the catalog instead of relying on the footer status line.
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
- Launcher shutdown now cancels active workflow, paper, and Agent process trees
  without leaving the local runner behind. Module paths and Pixi executable
  discovery use platform-appropriate layouts on supported direct platforms.

[Unreleased]: https://github.com/Jakeelamb/somite/commits/main
