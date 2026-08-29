---
status: accepted
date: 2026-08-29
---

# Preserve imported workflows as source-backed nested programs

Somite represents an imported Nextflow workflow as one compact Workflow instance. Entering that instance replaces the main workspace with a separate, source-anchored Nested source canvas. The nested canvas shows exactly the current Source scope and its immediate child invocations; entering a child replaces the visible level, while Back, breadcrumbs, or Escape returns outward. Its immutable pinned source plus explicit user edits remains executable truth. DOT output may assist presentation or cross-check an outline, but Somite never compiles a flattened DOT reconstruction because it loses channel transformations, composite values, conditions, hierarchy, configuration, and task environments.

An opaque launcher was rejected because it prevents meaningful inspection and modification. A flat process graph was rejected because it falsely implies that dependency edges are typed dataflow and that every process can run independently. Expanding the Workflow instance in place was rejected because it mixes navigation depth with canvas zoom and destabilizes the outer graph. Relationships inside the nested canvas are visibly source invocations, not Graph edges. Unresolved calls retain their exact source span without becoming guessed nodes.

The nested canvas is permissively editable. A user may replace an invocation before Somite knows every channel contract; the edit creates a Workflow variant anchored to the original invocation, and every unknown connection remains explicit rather than blocking creativity. Typed contracts power automatic rewiring and Logic checks, not permission. Catalog operator revisions and Pixi requirements freeze the tools selected by the variant. Representative validation remains the proof that a modified workflow works; connected, environment-ready, plausible, and validated are distinct states.

Source bytes remain raw blobs from the exact resolved commit tree; mutable worktree files, Git status, and checkout filters are outside provenance. An Invocation replacement never mutates those bytes or erases the upstream definition. Export and execution must consume the variant edits or report them as unresolved; Somite must never show a cosmetic replacement while silently running the original source.

An Invocation promotion crosses into the separate Native workflow variant model described by ADR 0006. The retained source then becomes provenance rather than a partially executed layer beneath the native graph.
