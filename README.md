# Axial

Local node canvas for bioinformatics. Drag pieces. Wire them. See the output on the node. Save the graph. Send it.

**Snap:** every port has a type (`FastqGz`, `Bam`, `Table`, …). Illegal wires do not connect.

**Glue:** if two pieces almost fit, an agent writes a tiny adapter. You keep dragging.

```
cargo test -p axial-ir -p axial-ops -p axial-cook
cargo run -p axial-cli -- palette
cargo run -p axial-cli -- cook testdata/fastq_to_fastqc.axial.json
cargo run -p axial-cli -- paper testdata/papers/rnaseq_methods.txt
cargo run -p axial-app
```

Canvas controls: wheel/trackpad pans; pinch or Ctrl/Cmd-wheel zooms at the
cursor; Space-, middle-, or right-drag pans; Tab or empty-space double-click
adds an operator. Every output exposes a `+` continuation action that opens a
type-filtered next-step picker and automatically wires the chosen node. Dragging
a wire onto empty space opens the same picker. Ctrl/Cmd-K opens and focuses the
global Library search; Ctrl/Cmd-D duplicates;
Ctrl/Cmd-Z and Shift-Ctrl/Cmd-Z undo/redo; F
fits the graph. Drag empty space for marquee selection; Shift adds and Ctrl/Cmd
toggles nodes. Selected groups move and duplicate together with their internal
wires. Click a wire to select it, then Delete to remove it. Rename a node in the
parameter header. Ctrl/Cmd-S saves; edits also write a validated recovery graph
to `.axial/autosave.axial.json`.

The canvas is the primary surface. A compact tool rail opens the Library as a
temporary overlay, and node parameters appear only while a node is selected.
The Library has one global search and three focused modes: **Build** for
task-oriented tools, **Sources** for NCBI/SRA, Ensembl, and local inputs, and
**Pipelines** for Snakemake projects plus curated and official nf-core
workflows. Tool rows are
draggable, recent tools stay close at hand, and the star keeps frequent tools
in a Favorites section. Favorites, recents, and the active Library mode persist
in `.axial/library-state.json`. Hover a row for ports and full details. The
footer reports local operator definitions separately from discovered nf-core
catalog entries; discovery does not imply that a workflow engine is installed.
nf-core and workflow-engine operators enter the canvas as compact workflow
cards exposing their typed inputs and outputs instead of expanding their
internal implementation.

Paste an accession—or its NCBI/Ensembl record URL—into **Sources**. Axial
recognizes `SRR` / `ERR` / `DRR` runs and inserts a wired
`prefetch → fasterq-dump` pair with separate R1/R2 streams. `GCA_` / `GCF_`
assemblies become an NCBI Datasets download → ZIP unpack pair. Ensembl gene,
transcript, and protein stable IDs (`ENSG`, species-prefixed `ENS…G/T/P`, and
optional versions) become a direct REST-backed FASTA source with the correct
genomic, cDNA, or protein sequence type. The source card previews the provider
and result before insertion and reports whether SRA Toolkit, Datasets, and curl
are configured. Downloads still require an explicit **Cook**.

The **Pipelines** mode and global Library search query the official nf-core
catalog by name,
description, and topic. Click or drag any result onto the network. Catalog data
refreshes asynchronously and is cached under `.axial/catalog/` for offline use;
curated Axial wrappers retain their richer typed ports.

In **Pipelines**, choose **Open Snakemake project** (or drop a directory with a
`Snakefile` or `workflow/Snakefile`). Axial inserts a typed directory-import →
Snakemake pair. Cook runs the project in an isolated writable copy, leaves the
source and content-addressed input untouched, and captures the completed run as
a `Directory` artifact. The runner exposes cores, dry-run, keep-going, command
logging, and workflow Conda environments.

Tools run via PATH or `conda run -n <env>` if the operator has a `conda` spec. See `axial env`.

Drop matching R1 and R2 FASTQs together to create a paired-read source with two
separate streams. Connecting either stream to a paired-aware tool snaps both
mates when the companion input is free; single-end inputs remain supported.
Import File, Paired Reads, and Import Directory nodes also keep their path fields
directly editable and provide a **Browse...** button for choosing sources with
the system file picker.

Paper Drop turns a methods PDF or text export into an editable typed graph and
opens an evidence report beside the canvas. Every reconstructed node is marked
as supported by retained paper text, inferred from workflow compatibility, or
named but missing a local implementation; every generated connection is
explicitly labeled as inferred. Click a report entry to select its node or wire,
and click the paper name in the top bar to reopen the report. When a paper
contains separate analyses or compared methods, the report presents named
**Candidate Graphs** as parallel tracks or alternatives instead of flattening
them into one misleading graph. Switching candidates preserves edits made to
each candidate during the review session. For the optional
acceptance corpus, run `scripts/fetch-paper-corpus`, then
`cargo test -p axial-paper downloaded_real_paper_corpus_reconstructs`.
