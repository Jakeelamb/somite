# Axial

Local node canvas for bioinformatics. Drag pieces. Wire them. See the output on the node. Save the graph. Send it.

## Open the Web App

The browser workspace is now the primary product slice. It uses the same Rust
graph and operator crates as the CLI and validates every connection and save in
the local Rust server.

```bash
scripts/axial-web
```

Open <http://localhost:3000>. The first launch creates an editable working graph
at `.axial/web.axial.json`, leaving the tracked fixture unchanged. To open a
specific graph instead:

```bash
scripts/axial-web path/to/project.axial.json
```

The current web slice supports operator search, click or drag insertion,
magnetic grid and neighbor alignment, typed connections, multi-selection, pan
and zoom, undo/redo, viewer controls, server-validated saves, recovery
autosaves, a parameter inspector, and browser file import. **Run** calls the
same native Rust executor and content-addressed cache used by the CLI.

**Export** opens an environment audit for the current graph. It inventories only
the tools the graph actually uses and separates tools that are built in, already
available, installable from a declared package, or still need a reviewed Axial
adapter. Download creates a portable `.axial.zip` containing:

- the graph and the exact operator contracts it references;
- a machine-readable tool report;
- one Pixi manifest for every managed tool in the graph; and
- a launcher that runs Axial inside the Pixi environment.

Run `./run.sh`. Pixi resolves missing packages, creates `toolchain/pixi.lock`,
installs the environment, and executes the graph. Retain the lock with the
bundle to freeze exact builds. Axial does not claim that finding a package
defines a usable node: typed ports, argv, and output collection still come from
the exported operator contract.

**Snap:** every port has a type (`FastqGz`, `Bam`, `Table`, …). Illegal wires do not connect.

**Glue:** if two pieces almost fit, an agent writes a tiny adapter. You keep dragging.

```
cargo test -p axial-ir -p axial-ops -p axial-cook
cargo run -p axial-cli -- palette
cargo run -p axial-cli -- env
cargo run -p axial-cli -- cook testdata/fastq_to_fastqc.axial.json
cargo run -p axial-cli -- paper testdata/papers/rnaseq_methods.txt
```

Canvas controls: wheel/trackpad pans; pinch or Ctrl/Cmd-wheel zooms at the
cursor; Space-, middle-, or right-drag pans; Tab or empty-space double-click
opens the Library at the intended insertion point. Ctrl/Cmd-K opens and focuses
global Library search; Ctrl/Cmd-D duplicates;
Ctrl/Cmd-Z and Shift-Ctrl/Cmd-Z undo/redo; F
fits the graph. Drag empty space for marquee selection and Ctrl/Cmd toggles
nodes. Selected groups move and duplicate together with their internal
wires. Click a wire to select it, then Delete to remove it. Rename a node in the
parameter header. Ctrl/Cmd-S saves; edits also write a validated recovery graph
to `.axial/autosave.axial.json`. F5 or Ctrl/Cmd-Enter runs the graph.

Hover a node to reveal a small `+` beside each output. Clicking it opens a
typed continuation view containing only tools that accept that output; choosing
a tool places it in the next clear lane and wires it as one undoable edit.
Dragging any input or output wire onto empty canvas opens the same compatible
view at the drop point.

The canvas is the primary surface. A compact tool rail opens the Library as a
temporary overlay, and node parameters appear only while a node is selected.
The Library has one global search and three focused modes: **Build** for
task-oriented tools, **Sources** for NCBI/SRA, Ensembl, and local inputs, and
**Pipelines** for Snakemake projects plus curated and official nf-core
workflows. Tool rows are
draggable, recent tools stay close at hand, and the star keeps frequent tools
in a Favorites section. The web app keeps favorites, recents, and the active
Library mode in the browser profile. Hover a row for ports and full details. The
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
are configured. Downloads still require an explicit **Run**.

The **Pipelines** mode and global Library search query the official nf-core
catalog by name,
description, and topic. Click or drag any result onto the network. Catalog data
refreshes asynchronously and is cached under `.axial/catalog/` for offline use;
curated Axial wrappers retain their richer typed ports.

In **Pipelines**, choose **Open Snakemake project** (or drop a directory with a
`Snakefile` or `workflow/Snakefile`). Axial inserts a typed directory-import →
Snakemake pair. Run executes the project in an isolated writable copy, leaves the
source and content-addressed input untouched, and captures the completed run as
a `Directory` artifact. The runner exposes cores, dry-run, keep-going, and
command logging while the Snakemake executable itself comes from Pixi.

Managed tools run in one graph-wide Pixi workspace. On the first **Run**, Pixi
resolves the operator package declarations, writes `.axial/pixi.lock`, installs
the environment, and activates it automatically. Operators without a Pixi
package declaration may use a true system binary; otherwise Axial reports the
missing declaration instead of guessing. See `axial env`.

Drop matching R1 and R2 FASTQs together to create a paired-read source with two
separate streams. Connecting either stream to a paired-aware tool snaps both
mates when the companion input is free; single-end inputs remain supported.
Import File, Paired Reads, and Import Directory nodes also keep their path fields
directly editable and provide a **Browse...** button for choosing sources with
the system file picker.

Paper Drop turns a methods PDF or text export into an editable typed graph and
opens an evidence report beside the canvas. Every reconstructed node is marked
as supported by retained paper text, inferred from workflow compatibility, or
named but still needing a reviewed tool adapter; every generated connection is
explicitly labeled as inferred. Click a report entry to select its node or wire,
and Axial frames that target on the canvas without changing the graph. When a
paper contains separate analyses or compared methods, the report presents named
**Candidate Graphs** as parallel tracks or alternatives instead of flattening
them into one misleading graph. Switching candidates preserves edits made to
each candidate during the review session. For the optional
acceptance corpus, run `scripts/fetch-paper-corpus`, then
`cargo test -p axial-paper downloaded_real_paper_corpus_reconstructs`.
