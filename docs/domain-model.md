# Somite domain model

Somite has one persisted graph model shared by the canvas, CLI, executor, and
exporter. These terms are intentionally small and precise.

## Graph structure

**Graph** — the directed, typed network stored in a `*.somite.json` file. It is
the source of truth.

**Workflow name** — the user-controlled document title stored in the Graph.
It names the work in the canvas and exported package without changing what the
Graph executes. It is distinct from the Project directory and Graph file path.

**Operator** — the stable catalog identity and human metadata for one tool.

**Operator revision** — an immutable Interface-to-Implementation binding for an
Operator. It covers typed ports, parameters, execution kind, package
requirements, arguments, output rules, and execution policy. A Graph Node pins
one exact Operator revision.

**Source revision** — an optional immutable source ingredient referenced by an
Operator revision: origin, selected paths, upstream revision, and verified
content digest. Source identity alone is not executable identity.

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

**Managed resource** — persistent, versioned scientific data required by a
tool but neither installed executable software nor a user's sample: for
example a Kraken2 database, BUSCO lineage, reference bundle, or aligner index.
A Managed resource has a Resource profile, provenance, and content identity;
it is not an anonymous path or part of a Pixi environment.

**Resource profile** — the machine-checkable scientific format of a Managed
resource, such as `kraken2-database`. It refines the physical artifact kind so
an arbitrary Directory cannot satisfy a specialized database or index input.

**Resource materialization** — importing, downloading, or building a Managed
resource into a user-owned persistent store and recording its identity. It is
separate from Staging, which places an already materialized artifact into one
isolated run.

**Project** — a directory containing graphs and local `.somite/` state.

**Run** — one request to realize a graph or a node cone, with timestamps and
provenance.

**Compilation** — deterministic lowering of a validated Graph into a runnable
workflow package. Generated engine syntax is an artifact, never a second
source of truth.

**Graph revision** — the semantic digest of Node identities, pinned Operator
revisions, ports, parameters, and Edges. Layout and human notes are excluded.

**Graph state revision** — the full editable-document digest used only for
compare-and-swap writes. It includes the Workflow name, layout, and notes so
concurrent document or presentation edits cannot silently overwrite one another.

**Run closure** — the target-specific identity linking one Graph revision to
its pinned Operator revisions, exact Pixi lock, platform, compiler, Nextflow,
and Java identities. Its digest identifies what can execute; it does not claim
scientific correctness.

**Run package** — generated Nextflow, node source map, pinned Operator
manifests, parameters, Pixi manifest and lock, Run closure, and evidence index
needed to execute one Graph revision.

**Evidence receipt** — an append-only, timestamped observation about an exact
Graph revision under a named fixture configuration. It retains the actual Run
closure observed, per-node and per-edge results, verifier, and artifact/log
digests. Evidence never changes executable identity.

**Fixture pack** — a small versioned set of representative biological
artifacts. Each artifact is materialized once by content digest and bound only
to a validation Graph; it never replaces the user's configured data.

**Node source map** — the explicit mapping from every executable Node to its
generated process identity and, when applicable, its pinned upstream source.

**Cook** — the temporary native-oracle action that realizes a node's outputs.
It is not Somite's long-term production execution identity.

**Cache** — the artifact store and cook index. A cook key covers the operator
contract, parameters, and input hashes.

**Staging** — materializing cached inputs in an isolated work directory under
tool-friendly names.

**Canvas annotation** — a human-authored Sticky, Box, or Stroke stored with the
Graph. Canvas annotations organize and explain the workflow but have no ports,
parameters, execution behavior, or role in executable identity.

**Node color** — an optional curated presentation label on a Node. It may help
the user group stages such as Input, QC, Analysis, Review, and Output, but it
never substitutes for typed ports, Readiness, validation evidence, or text.

## Readiness and assistance

**Requirement** — one deterministic fact that prevents the current Graph from
entering Preparation: a missing required input, parameter, Managed resource,
manual checkpoint, method detail, legacy environment, or reviewed Adapter. It
is computed from the pinned operator contracts and current Edges, not from an
agent response.

**Resolution** — a known action that can satisfy a Requirement, such as
connecting an existing artifact, setting a parameter, downloading a reviewed
resource, attaching a manual export, reviewing an ambiguous method, or building
a resource. A Resolution may include storage estimates, official guidance, and
scientific effects without claiming that the action has already occurred.

**Resolution recipe** — a portable, versioned procedure attached to a manual,
legacy, ambiguous, or missing-contract Resolution. It records reviewed steps,
required parameters, and an optional official source. A recipe is guidance and
provenance, never an implicitly executable shell command.

**Workflow assessment** — the one deterministic projection of a pinned Graph
and Catalog into ordered Requirements, Resolutions, Node support states, input
controls, recipes, and escalation eligibility. Paper review, Readiness, Export,
and Agent handoff consume this same value.

**Recommendation** — non-blocking, rule-based guidance derived from known
contracts or machine facts. It is distinct from a Requirement.

**Agent suggestion** — optional contextual help proposed through the Agent
bridge. It never changes deterministic Readiness or substitutes for evidence.

**Escalation** — an explicit Workflow-assessment property reserved for a
scientific choice, legacy environment, Managed-resource tradeoff, or missing
reviewed contract. Ordinary file attachment, parameter entry, and typed
connection work is deterministic and does not invoke the Agent.

**Preparation** — the observable install, download, build, transfer, freeze, or
verification work needed after requirements are satisfied and before execution.

**Readiness** — the computed summary for one exact Graph revision. It is
`empty`, `building`, `needs_action`, or `ready` and carries every unresolved
Requirement and known Resolution. Validation evidence is displayed beside
Readiness but remains a separate claim.

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

## Agent collaboration

**Agent bridge** — one optional ACP v1 session between the Somite workspace and
a user-selected local agent process. It owns conversation transport, not graph
semantics or execution.

**Somite MCP server** — the documented capability surface given to the agent.
It exposes graph, catalog, compiler, runner, validation, and evidence modules
without giving the agent a second internal data model.

**Graph transaction** — a short ordered list of graph operations with one Graph
state base revision and one user-facing summary. Somite applies it to a
clone, validates the complete result, and persists all or none. A successful
transaction is one undoable browser history entry.

## Paper reconstruction

**Reconstruction** — an evidence-bound interpretation of a paper package. It is
a draft for review, not a claim that the paper supplied an executable graph.
Literature discovery is not a graph source: selecting or reconstructing a
bioRxiv record cannot mutate the Graph. Only explicit acceptance of a Candidate
graph creates a Graph transaction.

**Candidate graph** — one named interpretation of a distinct method track.
Parallel analyses and mutually exclusive alternatives remain separate.

**Evidence** — retained source text or explicit inference attached to a
reconstructed node or edge. Operator support is shown separately as built-in,
managed, manual, method-details, legacy-source, or Adapter-needed; scientific
evidence strength is never used as a proxy for executability.

**Source location** — the exact PDF page when the extraction preserves page
separators. It is optional for plain text and JATS sources and never fabricated.

## Invariants

- Node IDs are unique and edges reference existing nodes and ports.
- Every Node pins the exact execution-semantic revision of its Operator.
- Every edge passes port-type validation and the graph remains acyclic.
- Scientific bytes live in artifacts, never inside graph JSON.
- Pixi environments contain executable dependencies, not Managed resource
  bytes; environment recreation must not delete scientific databases or
  indexes.
- A specialized resource input accepts only a compatible Resource profile;
  physical `Directory` shape alone is insufficient.
- Package metadata alone never substitutes for an operator contract.
- Imported structure and paper inference are labeled honestly.
- All persisted graph writes are validated by the Rust graph model.
- Generated engine syntax never introduces an unmapped executable node.
- Workflow name, presentation-only layout, notes, Canvas annotations, and Node
  colors never alter the semantic Graph revision; all remain part of the
  editable Graph state revision.
- Canvas annotation IDs are unique across the Graph and annotation coordinates,
  dimensions, text, and stroke size are validated before persistence.
- Evidence refers to executable identity but is never included in that identity.
- A passed fixture receipt applies only to its exact Graph and validation
  configuration; semantic edits invalidate it while presentation edits do not.
- Agent edits never bypass Graph or Catalog validation and never overwrite a
  newer server Graph revision.
- Readiness is deterministic and shared by UI and agents; an Agent suggestion
  cannot clear a Requirement.
- Paper, Readiness, Export, and Agent handoff consume one Workflow assessment;
  they cannot independently reclassify the same Node.
- Resolution recipes are portable guidance and cannot introduce execution
  outside the reviewed Operator contract.
- Agent escalation is absent for deterministic file, parameter, and connection
  work; escalation carries the exact Requirement, evidence, choices, and recipes.
- Run, validation, and agent compilation fail before Preparation unless the
  current Graph revision is ready.
