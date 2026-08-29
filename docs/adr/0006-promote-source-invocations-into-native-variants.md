---
status: accepted
date: 2026-08-29
---

# Promote source invocations into native workflow variants

When a user promotes an imported invocation, Somite creates a Native workflow variant whose ordinary typed Nodes and Edges become executable truth and whose exact Source-backed workflow remains attached as provenance. Somite does not execute a mixture of retained Nextflow source and a native overlay: doing so would require guessing channel transformations and could silently run different code from the canvas. Promotion therefore exposes missing inputs and connections through normal Readiness, compiles through the existing native Nextflow compiler, and can return to the retained source view without mutating the pinned upstream bytes.
