---
status: accepted
date: 2026-08-25
---

# Use Nextflow as Somite's production execution engine

Somite's persisted Graph remains the source of truth, Pixi remains the only
managed tool environment, and Nextflow is the target production engine for
scheduling, resume, failure recovery, cancellation, and executor reach. A
bounded paired-read FASTP to FastQC spike selected Nextflow over the native
Rust executor: exact pinned nf-core modules passed all 30 upstream tests and
the composed workflow passed fresh, resume, same-path mutation, failure,
recovery, stable task mapping, and child-cleanup gates; the native oracle
failed content invalidation, poisoned-cache recovery, and cancellation gates.

This decision does not make hand-authored Nextflow the product model. Somite
compiles its visible Graph into deterministic DSL2 and retains an explicit
node/edge source map. The initial compiler has executed a generated paired-read
FASTP to FastQC graph through cold, cached, same-path mutation, invalid-output,
and repaired-input cases. Source-backed nf-core modules are executable only
when a reviewed Adapter maps their full Interface without hidden workflow
semantics.
Snakemake remains an import and test ecosystem, and CWL remains a possible
interchange export rather than another production engine.

The native executor stays temporarily as a differential oracle. It can be
removed only after locked and offline Pixi replay, source-backed module parity,
and cancellation through Somite's actual run Interface. Initial remote support
is limited to execution targets where the locked Pixi workspace is available;
cloud transport is not claimed while containers remain deferred.
