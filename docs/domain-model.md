# Somite domain model

Somite has one persisted graph model shared by the canvas, CLI, executor, and
exporter. These terms are intentionally small and precise.

## Graph structure

**Graph** — the directed, typed network stored in a `*.somite.json` file. It is
the source of truth.

**Operator** — a catalog definition for a tool: typed ports, parameters,
execution kind, package requirements, arguments, output rules, and cache
behavior.

**Node** — one placed instance of an operator, including parameter values and
canvas layout.

**Port** — a named, typed input or output on an operator.

**Edge** — an IR connection from an output port to a compatible input port.
The canvas draws an edge as a wire.

**Parameter** — node configuration that does not flow through an edge, such as
a scalar, enum, path, or flag.

## Data and execution

**Artifact** — a content-addressed file or directory produced or consumed by a
node. The graph type-checks the declared artifact kind, not a filename suffix.

**Project** — a directory containing graphs and local `.somite/` state.

**Run** — one request to realize a graph or a node cone, with timestamps and
provenance.

**Compilation** — deterministic lowering of a validated Graph into a runnable
workflow package. Generated engine syntax is an artifact, never a second
source of truth.

**Run package** — generated Nextflow, node source map, operator contracts,
parameters, and Pixi manifest needed to execute one Graph revision. Its first
Pixi resolution materializes the lockfile that must travel with a frozen run.

**Node source map** — the explicit mapping from every executable Node to its
generated process identity and, when applicable, its pinned upstream source.

**Cook** — the temporary native-oracle action that realizes a node's outputs.
It is not Somite's long-term production execution identity.

**Cache** — the artifact store and cook index. A cook key covers the operator
contract, parameters, and input hashes.

**Staging** — materializing cached inputs in an isolated work directory under
tool-friendly names.

## Discovery and composition

**Catalog** — the operators and workflows available for insertion. A catalog
entry being discoverable does not mean its engine or package is installed.

**Connector** — an operator that resolves or downloads data from a provider
such as NCBI, SRA, or Ensembl.

**Native operator** — an independently executable operator with a reviewed
Somite contract.

**Structural workflow reference** — a node reconstructed from an engine-authored
workflow such as nf-core or Snakemake. It makes the imported DAG transparent
but is not independently executable until promoted to a native operator.

**Source-backed module** — a pinned upstream module with a reviewed Adapter
that maps its complete Interface into visible Somite ports and parameters.

**Compound** — a reusable graph with published input and output ports.

## Paper reconstruction

**Reconstruction** — an evidence-bound interpretation of a paper package. It is
a draft for review, not a claim that the paper supplied an executable graph.

**Candidate graph** — one named interpretation of a distinct method track.
Parallel analyses and mutually exclusive alternatives remain separate.

**Evidence** — retained source text or explicit inference attached to a
reconstructed node or edge. Missing operator contracts remain visible adapter
gaps.

## Invariants

- Node IDs are unique and edges reference existing nodes and ports.
- Every edge passes port-type validation and the graph remains acyclic.
- Scientific bytes live in artifacts, never inside graph JSON.
- Package metadata alone never substitutes for an operator contract.
- Imported structure and paper inference are labeled honestly.
- All persisted graph writes are validated by the Rust graph model.
- Generated engine syntax never introduces an unmapped executable node.
