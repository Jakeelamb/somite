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
- Continuous verification for Rust and web code on pushes and pull requests.
- Dependency review, automated dependency updates, issue forms, and pull
  request guidance.
- A source-release workflow that verifies the tag against both package versions
  before creating a GitHub release.
- Security, contribution, conduct, and release-maintainer policies.

### Changed

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

[Unreleased]: https://github.com/Jakeelamb/somite/commits/main
