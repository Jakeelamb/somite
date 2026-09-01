---
status: accepted
date: 2026-08-31
---

# Freeze Nextflow source execution before running it

Somite separates source-backed Nextflow execution into a pure static plan and
an effectful preparation phase. The planner consumes only the immutable source
snapshot, entrypoint, and exact scalar parameter bindings. It either returns a
deterministic, content-addressed execution plan or explicit blockers; it does
not solve packages, install software, rewrite source, invoke Nextflow, or claim
that the workflow works. Preparation may then adopt or solve the Pixi lock,
realize named environments, create a guarded staged source copy, freeze plugins,
and assemble the portable or host-specific package.

This decision supersedes only the root-lock-only execution paragraph in ADR
0005. ADR 0005's source-provenance, projection, editing, and evidence boundaries
remain unchanged.

Configuration closure uses a deliberately bounded, side-effect-free evaluator.
It can resolve the small literal, scalar-parameter, interpolation, boolean,
conditional, `startsWith`, and offline-environment subset needed by reviewed
`includeConfig` patterns. It is not a general Groovy interpreter. Somite emits
one effective configuration wrapper as the sole `-C` input: exact scalar
bindings appear before source configuration so includes can resolve, appear
again after source defaults so the selected bindings remain authoritative, and
the frozen Somite execution policy is included last.

A complete source-owned root `pixi.toml` and `pixi.lock` may be adopted when it
does not delegate task environments. Otherwise, each reachable process must
map unambiguously to one static Conda environment file or bounded direct
MatchSpec expression. Each unique environment becomes its own
content-addressed Pixi environment and retains its own case-sensitive channel
priority; differing channel orders in isolated environments are not merged into
one invented global order. A direct expression may use its explicit channels or
an exact source `conda.channels` declaration. When that declaration belongs to
the source `conda` profile, Somite activates that profile before its final
execution-policy profile and requires native configuration resolution to return
the planned channel order.

Rendering does not replace source-owned requirements or alter the frozen source
channel provenance or digest. Each task Pixi feature contains exactly its
scientific dependencies and source channel order; Somite injects neither
task-wrapper utilities nor an implementation-support channel. The separate
default runtime pins Nextflow, OpenJDK, micromamba, Bash, coreutils, gawk, grep,
sed, and procps-ng on Linux. Nextflow starts with ambient `CONDA_PREFIX`
removed, allowing micromamba to prepend a realized task prefix while retaining
the default runtime only as a wrapper-utility fallback.

The final policy is included after source configuration. It disables trace,
timeline, report, container, Wave, and Fusion engines. In generated-task mode,
a catch-all process selector additionally forces local execution, disables
scratch staging, and selects the locked default-environment Bash for task
scripts. The unavoidable outer local-task wrapper still uses `/bin/bash`, so a
source Run checks that explicit host prerequisite before doing preparation.

Nextflow plugins are part of the frozen closure rather than ambient runtime
state. Only exact `id@version` requirements are admitted. Preparation installs
them with the locked Pixi/Nextflow runtime into a private directory, captures a
bounded portable file inventory, and publishes a content-addressed store keyed
by platform, runtime manifest and lock, and exact requirements. Execution uses
only the packaged store and explicit plugin allowlist; cache hits are fully
reverified. Portable packaging realizes only the default locked runtime needed
for plugin installation, never the scientific task environments, and includes
the verified store digest in package and closure identity.

Before preview or ordinary execution, the locked runtime must complete native
`nextflow config` and `nextflow inspect` commands against the effective wrapper,
selected profiles, exact parameters, frozen plugins, private `NXF_HOME`, and
offline policy. Somite tries the default syntax parser first. It retries once
with parser v1 only for the exact legacy compatibility diagnostic that variable
declarations cannot be mixed with config statements, keeps `inspect` on the
selected parser, and records hashed receipts for every attempt. No timeout,
signal, malformed output, plugin failure, or other parser error triggers that
fallback.

Dynamic or external configuration, unresolved or missing includes, unsupported
configuration precedence, inexact or conflicting plugins, dynamic task
environments, missing environment files, and ambiguous process mappings fail
closed. Their source remains inspectable but is not executable through this
contract. The native proof establishes bounded structural and configuration
resolution only. Preview additionally establishes compilation and DAG
construction; neither proof executes scientific tasks or demonstrates
scientific correctness, production-scale behavior, or equivalence to another
workflow.
