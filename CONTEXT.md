# Axial

Local-first node graph for bioinformatics. The graph file is the source of truth; canvas, cook, connectors, and AI are clients of it. Product, CLI, and crates are all Axial (`axial`, `axial-*`, `*.axial.json`). Former working name: Operon.

## Language

**Graph**:
The directed typed network the user edits. The source of truth on disk.
_Avoid_: Pipeline, patch, network, workflow

**Reconstruction**:
An evidence-bound interpretation of a paper package that contains one or more named Candidate Graphs. It is a draft for review, not a claim that the paper supplied an executable graph.

**Candidate Graph**:
One named Graph interpretation of a distinct method track in a Reconstruction. Comparisons and mutually exclusive methods remain separate Candidate Graphs instead of being flattened into one Graph.
_Avoid_: Subworkflow, extracted workflow

**Candidate Role**:
The relationship of a Candidate Graph to its siblings: Primary is the default interpretation, Parallel is a separately reported track, and Alternative is a mutually exclusive or compared method.

**Project**:
A directory that contains one or more graph files, a local cache, and project config.

**Session**:
One OS process (GUI or CLI) attached to a project.

**Run**:
One requested cook of a graph (or a node cone), with an ID, timestamps, and provenance.

**Operator**:
A catalog entry: typed ports, params, cook kind, cache behavior. The tool.

**Node**:
A placed instance of an operator in a graph, with its own param values and layout.

**Port**:
A named, typed hole on an operator. Input ports receive; output ports emit.

**Edge**:
An IR connection from one output port to one input port. Must type-check.
_Avoid_: Connection (prefer Edge in IR)

**Wire**:
The canvas stroke that depicts an edge. Chrome, not IR.

**Param**:
A configuration value on a node that is not wired. Scalars, enums, paths, flags.

**Input**:
A port that is filled by an edge (or a default). Distinct from a param.

**Artifact**:
A content-addressed file or directory in the cache. The bytes behind a Kind. Staging uses this. The canvas typechecks Kind, not the extension.

**Value**:
A small typed datum that flows on a value port (accession, int, JSON metadata). Not hashed as a file; included in the cook key.

**Preview**:
A cheap, bounded cook output meant for the node body: PNG, TSV head, log tail. Never the backing artifact loaded into the renderer.

**Look**:
Selecting a node or turning Viewer on. A cook *request* for `cost: low` nodes. Not the drawing itself.

**Viewer**:
The drawing in the center of the node (TD Node Viewer). Axial: Preview. Toggled by the Viewer flag.

**Flag**:
Binary node chrome, not a param. Viewer, Viewer Active; later Bypass/Lock. TD: left and bottom edges of the node.

**Inspector**:
TD Parameter Dialog. Right pane, **p** to toggle. Pages (tabs) of params for the selected node. Not IR.

**Cook**:
The engine's act of realizing a node's outputs from its inputs and params. Happens only if requested and there is a reason (dirty / never cooked). Not a frame clock.
_Avoid_: Execute, run (Run is a provenance object; Cook is the engine act)

**Dirty**:
Derived view: current cook key has no verified index hit. Not stored in the graph file. Downstream of Dirty is Dirty. Dirty is not a cook.

**Cache hit / skip**:
Current cook key hits the index and artifacts verify; the node does not re-run.

**Staging**:
Copy or hardlink of a CAS artifact into a work directory under the original basename so CLIs see real names. CAS stays hex.

**Attempt**:
One spawn of an ExternalProcess. Work dir is unique per attempt.

**Compound**:
A node whose cook is another graph with published ports. Nested DAG. The graph file is the reusable unit.

**Technique**:
User-facing name for a reusable compound. Not an IR type.
_Avoid_: Recipe, template, workflow (when you mean Compound)

**Branch**:
An Edit that duplicates a node (and optionally its downstream cone) so an alternative operator/params can be tried in parallel.

**Provenance**:
Cache record: artifact id → producer node, cook key, parent artifact ids. Not a patient/sample ontology.

**Connector**:
An operator whose job is to talk to a remote data source (NCBI, SRA, Ensembl). Same IR type as any operator.

**Catalog**:
The set of operators the session can instantiate. Built-in + JSON drops + graph-as-compound files.

**Brick**:
An operator that wraps one command (or one nf-core module). The Lego piece.
_Avoid_: Tool, module (when you mean an Axial operator)

**Sheet**:
A Table artifact whose columns match a named samplesheet schema (rnaseq, sarek, ampliseq, …).
_Avoid_: Samplesheet as an untyped CSV path

**Unpacker**:
The last step of an adapter: nf-core publishDir files bound to Kinds. Not a generic unzip. Not a product port.

**Adapter**:
Glue Axial owns that compiles a hostile tool or nf-core pipeline into a small graph of resource kinds. Named and versioned (`bulk-rna-v1`). Not a fork of the scientific binary. Agents write it; the format makes that cheap.

**Kind**:
Optional scientific tag on a port (`Reads`, `Assembly`, …). Default snap is Artifact type. Users/agents add kinds when they compile a pipeline. Axial does not maintain an ontology.
_Avoid_: File, path, Directory-as-output (as the product port)

**Bridge**:
The wrap path: JSON operator + staging + generated adapter. How existing tools become nodes. The product. Not a boutique of optimized tools.
