---
status: accepted
date: 2026-08-25
---

# Separate operator, execution closure, and evidence identities

Somite Nodes pin immutable Operator revisions. An Operator revision is the
portable Interface-to-Implementation binding: typed ports and parameters,
invocation and output rules, package constraints, build or source binding, and
declared execution capabilities. It is not a target-specific executable.

Linking a semantic Graph revision for one target produces a Run closure. The
closure binds the Graph and Operator revisions to the exact Pixi lock,
platform, Somite compiler, Nextflow, and Java identities. Source revisions are
optional provenance ingredients inside Operator bindings; Git commits do not
substitute for environment, adapter, or runtime identity.

Validation produces independent, append-only Evidence receipts referring to
an exact Operator revision or Run closure. Adding evidence never changes the
subject digest, and a closure digest establishes identity and integrity rather
than biological or scientific correctness.

The alternative single `source revision` identity was rejected because the
same source may produce different programs under different toolchains, one
source tree may expose several Operators, package-provided executables may not
carry source, and validation evidence changes independently. Exposing every
source, materialization, adapter, environment, and evidence record directly was
also rejected as a shallow caller Interface. A linker Module hides federation
and derives the target closure behind a small Interface.

Schema-v1 Graphs are migrated through an exact catalog. Schema-v2 Graphs with
missing or mismatched Operator pins fail before compilation or execution. A
frozen CLI package contains the migrated Graph, exact Operator manifests,
`pixi.toml`, `pixi.lock`, generated source map, Run closure, and a separate
evidence index.
