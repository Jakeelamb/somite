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
adds an operator; dragging a wire onto empty space opens a compatible-tool
picker; Ctrl/Cmd-D duplicates; Ctrl/Cmd-Z and Shift-Ctrl/Cmd-Z undo/redo; F
fits the graph. Drag empty space for marquee selection; Shift adds and Ctrl/Cmd
toggles nodes. Selected groups move and duplicate together with their internal
wires. Click a wire to select it, then Delete to remove it. Rename a node in the
parameter header. Ctrl/Cmd-S saves; edits also write a validated recovery graph
to `.axial/autosave.axial.json`.

The docked Library has one global search and three focused modes: **Build** for
task-oriented tools, **Sources** for NCBI/SRA, Ensembl, and local inputs, and
**Pipelines** for Snakemake projects plus curated and official nf-core
workflows. Tool rows are
draggable, recent tools stay close at hand for the session, and the star keeps
frequent tools in a Favorites section. Hover a row for ports and full details.

Paste an `SRR` / `ERR` / `DRR` run accession into the palette source box to
insert a wired `prefetch → fasterq-dump` pair. Paste a `GCA_` / `GCF_` assembly
accession to insert a wired NCBI Datasets download → ZIP unpack pair. Axial
prepares the graph; large transfers still require an explicit **Cook**.

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

Paper Drop is a bonus graph-drafting feature. For its optional acceptance
corpus, run `scripts/fetch-paper-corpus`, then
`cargo test -p axial-paper downloaded_real_paper_corpus_reconstructs`.
