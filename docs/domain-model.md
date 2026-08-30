# Somite domain model

Somite has one persisted graph model shared by the canvas, runner, Agent, and
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

**Source-backed workflow** — one exact engine-authored workflow retained as a
pinned commit tree and represented by one outer Node. The Node is a collapsed
canvas view; opening it shows the source-anchored Workflow outline. Somite does
not translate that outline into native Nodes or execute it as a nested engine.

**Native workflow variant** — an ordinary executable Graph created by promoting
Source invocations. Its typed Nodes and Edges are executable truth, while its
exact original Source-backed workflow and invocation-to-Node mappings remain
attached as non-executable provenance.

**Invocation promotion** — the atomic transition from one selected Source
invocation to one native catalog-pinned Node. Promotion never guesses adjacent
channels; missing connections become ordinary Requirements on the resulting
native Graph.

**Workflow source pin** — the provider, repository, requested release, resolved
immutable revision, entrypoint, and complete tracked-file content digest for a
Source-backed workflow. Bytes come from raw blobs in that exact commit, never
from the mutable worktree, Git status, or checkout filters.

**Workflow outline** — a nested, source-anchored read model of workflow,
subworkflow, process, and invocation scopes. It supports navigation and honest
capability reporting. It is not a fabricated Port/Edge execution graph.

**Workflow binding** — one explicit parameter value or project file/directory
bound to a Source-backed workflow instance. Bindings and execution profiles are
part of executable identity; outline labels and diagnostics are not.

**Unsupported required workflow parameter** — a required upstream schema
property that Somite cannot faithfully express as a typed binding. It is
retained by name, group, description, and reason as a deterministic Readiness
blocker. The property itself remains source-only, but does not disable edits to
independently proven fields. Root/group ambiguity or cross-field assertions
still make the whole parameter schema read-only. The pinned source digest
already commits to its schema bytes,
so this derived read-model record does not independently change workflow
identity.

**Port** — a named, typed input or output on an operator.

**Edge** — a Graph connection from an output port to a compatible input port.
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
A reviewed existing-resource import provides this profile on its output; the
catalog verifies it against the consuming input before accepting the Edge.

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
revisions, ports, parameters, Edges, Workflow source pins, profiles, and
bindings. Layout, human notes, and Workflow-outline presentation are excluded.

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

**Structural workflow reference** — a legacy, non-executable Node reconstructed
from engine visualization output. It retains visible historical structure but
cannot recover the original program and remains blocked pending explicit
reimport or a reviewed Adapter.

**Source-only region** — exact retained workflow source for which Somite cannot
yet offer structured visual editing. It remains inspectable and executable only
when its complete task environment is supported; Somite never guesses Nodes,
Ports, or channel transformations for it.

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
graph creates its first Graph transaction. After acceptance, an explicit intake
choice such as “Use these reads” is a normal Graph edit: it applies the Candidate
delta to that on-canvas graph while off-canvas Candidates remain drafts.

**Reconstruction outcome** — one explicit scientific result, independent of
the transport job state. `DraftsReady` means at least one non-empty Candidate
validates against both Graph and Catalog contracts. `RecognizedUnsupported`
means computational methods and their evidence were retained but no safe
Candidate can be built. `NoReconstructableMethods` means neither an executable
nor a reviewed unsupported method track was found. Extraction failure is not a
Reconstruction outcome because no reliable source text was available.

**Candidate graph** — one named interpretation of a distinct method track.
Parallel analyses and mutually exclusive alternatives remain separate. A
Candidate is never empty or source-only; all exported Candidates validate
before they cross the shared Workflow Module boundary.

**Method mention** — a normalized method identity plus its exact surface name,
nearby evidence, optional source page, operation class, and either a reviewed
Operator identity or explicit unsupported status. Recognition does not invent
ports, edges, parameters, or equivalence between related tool names.

**Paper artifact** — an immutable, size-bounded local PDF or text object keyed
by its BLAKE3 content digest. Original filenames are display metadata. Uploading
identical bytes reuses the artifact; retry references its digest and does not
upload the bytes again.

**Paper intake job** — the observable attempt to copy a local paper, extract
its methods, and build Candidate graphs. Queued, native text extraction,
method location, recognition, assessment, cancellation, and terminal phases are
transport lifecycle state, distinct from Reconstruction outcome. A terminal job
retains stage timings, cache reuse, result or actionable error. Failure never
mutates the previous Reconstruction or Graph.

**Paper extraction cache** — normalized source text keyed by artifact digest and
extractor version. Reconstruction is cached separately by extracted-text key and
Catalog digest, so reviewed recognition changes do not rerun PDF.js extraction.

**Evidence** — retained source text or explicit inference attached to a
reconstructed node or edge. Operator support is shown separately as built-in,
managed, manual, method-details, legacy-source, or Adapter-needed; scientific
evidence strength is never used as a proxy for executability.

**Source location** — the exact PDF page when the extraction preserves page
separators. It is optional for plain text and JATS sources and never fabricated.

**Resource citation** — an accession-shaped paper claim retained with its
accession family, inferred scientific role, nearby paper text, and optional
Source location. A citation is evidence, not yet an executable input.

**Resolved resource group** — the current provider records returned for one
Resource citation through Somite's NCBI or Ensembl source boundary. Study,
experiment, sample, and BioProject identifiers are collections and may resolve
to several exact runs. Somite requires an explicit run choice and records that
run accession in the draft Graph; it never treats a sample identifier as a
downloadable run or silently chooses the first member of a collection.

## Invariants

- Node IDs are unique and edges reference existing nodes and ports.
- Every Node pins the exact execution-semantic revision of its Operator.
- A Graph containing a Source-backed workflow currently contains exactly one
  source Node and no Edges; mixed native/source composition waits for complete
  channel contracts.
- A Source-backed workflow pins exact source bytes and never runs by repository
  name or mutable release tag.
- DOT and other engine visualizations are never execution truth.
- Every edge passes port-type validation and the graph remains acyclic.
- Scientific bytes live in artifacts, never inside graph JSON.
- Pixi environments contain executable dependencies, not Managed resource
  bytes; environment recreation must not delete scientific databases or
  indexes.
- A specialized resource input accepts only a compatible Resource profile;
  physical `Directory` shape alone is insufficient.
- Package metadata alone never substitutes for an operator contract.
- Imported structure and paper inference are labeled honestly.
- No paper Candidate is empty, source-only, or invalid, and no caller infers a
  ready outcome solely from Candidate count.
- Paper artifact identity is content-based; filenames and retries do not create
  duplicate scientific bytes.
- All persisted graph writes are runtime-validated by the canonical Graph
  Module; static TypeScript types alone never admit persisted or network data.
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
