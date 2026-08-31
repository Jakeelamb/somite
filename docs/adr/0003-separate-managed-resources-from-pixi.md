---
status: accepted
date: 2026-08-26
---

# Separate managed scientific resources from Pixi environments

Pixi will continue to own executable packages and their lock, while large or
versioned scientific databases, indexes, models, and reference bundles become
Managed resources with explicit Resource profiles, provenance, content
identity, and lifecycle. Somite will resolve these resources through visible
import, download, or build choices into a user-owned persistent store; Graphs
will refer to their logical identity rather than hiding host paths or bytes in
the environment.

A downloaded provider is retained in the Graph as
`somite-resource:<provider-id>`. Each machine independently reports whether
that exact provider receipt is installed and verified, and Readiness returns
the same size-aware resolution when it is absent. Production materialization
resolves the logical reference to that machine's canonical private cache only
after admission; the portable Graph is never rewritten with the cache path.

The first accepted provider is the checksum-pinned Kraken2 Standard-8 database.
Its provider manifest binds the source page and archive URL, release, archive
checksum, required database-file checksums, declared transfer/storage bounds,
and scientific effect. Publication is an atomic rename after verification;
failure and cancellation remove the partial entry. Existing user databases
remain supported as ordinary explicit local imports, without claiming the
managed provider identity.

The same requirements Interface will drive the canvas and MCP agent: it will
identify unresolved Managed resources, return compatible provider choices, and
keep ordinary graph edits automatic. Downloading or building a large resource
will remain one explicit, size-aware user action rather than a series of tool
permission prompts. Representative validation may bind a small reviewed
resource fixture, but that evidence will not claim validation of a production
database.

Embedding resources inside `.pixi/envs`, relying on ambient variables such as
`KRAKEN2_DEFAULT_DB`, treating every Directory as compatible, and writing
persistent resources to sudo-owned or temporary paths are rejected. Pixi may
run a locked materializer such as `kraken2-build`, but its output belongs to the
Managed resource store and receives an independent materialization receipt.
