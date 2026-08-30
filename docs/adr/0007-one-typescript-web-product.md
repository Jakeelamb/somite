---
status: accepted
date: 2026-08-29
---

# Build Somite as one TypeScript web product

Somite will be a hosted web product implemented in TypeScript. React owns the
browser canvas, a TypeScript control plane owns projects and collaboration, and
TypeScript workers own workflow preparation and execution supervision. Pixi and
Nextflow remain external execution tools; Somite does not reimplement their
scientific programs or schedulers.

The previous Rust implementation was used only as a temporary parity oracle
during the migration, not retained as a second production runtime. Replacement
proceeded in dependency order: graph contracts and canonical identity, catalog
and assessment, Nextflow compilation, frozen packages, paper reconstruction,
Agent tooling, then run supervision. Each TypeScript Module passed shared
fixtures and differential tests before its production callers switched. The
replaced Rust path was deleted with the final migration slice.

The target repository has one application language and one package manager:

```text
web/                  React canvas and browser interaction
runner/               projects, search, paper, Agent, and job supervision
packages/workflow/    Graph contracts, catalog, assessment, compilation, freeze
operators/            reviewed, versioned scientific tool contracts
```

The seams remain language-independent even though every implementation is
TypeScript. In particular, an execution target accepts one frozen Job spec and
returns ordered Job events and an Artifact manifest. Hosted Linux execution and
the optional local runner are two adapters at that seam. Browser code never
constructs shell commands or depends on host paths.

Strict TypeScript types are not runtime validation. Persisted Graphs, network
messages, catalog records, paper outputs, and runner events must cross one
runtime-validated contract. Canonical serialization and hashes have shared
goldens. Property tests cover graph invariants, and production-browser tests
cover the user journeys that cross modules.

A big-bang rewrite and a permanent Rust/TypeScript split were rejected. The
first loses already-proven behavior; the second makes every feature cross a
language seam indefinitely. Temporary differential execution is allowed only
while a named migration slice is active.

## Outcome

The migration completed on 2026-08-29. Browser and runner callers now share
`@somite/workflow`; the Cargo workspace, Rust toolchain, native-executor spike,
and local Rust build cache were removed. The parity fixtures remain as stable
product contracts, independent of the deleted implementation.
