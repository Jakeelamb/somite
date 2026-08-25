# Axial UI = canvas-first biological workflow studio

WYSIWID: what you see on the node is what it did. We copy TD’s **building** and **config**. We do not copy the timeline, 60 Hz, or Python expressions in v0.1.

## Window

```
┌ project ───────────────────────────── Save  Fit  Cook ─┐
│ ┌──┐                                                 │
│ │ +│      canvas + artifact-rich nodes              │
│ │ /│          ╰─ compatible continuation            │
│ │ID│                          contextual inspector  │
│ │nf│                                                 │
│ └──┘                                                 │
└ status ──────────────────────────────────────────────┘
```

- The canvas owns the window; navigation and configuration float above it only
  when requested.
- One selected node opens that node's inspector. Clearing selection removes it.
- The rail opens Build, Sources, Pipelines, and Paper Drop without reserving a
  permanent sidebar.
- An empty project offers outcome-based starts instead of an empty tool tree.
- The bottom-bar **Machine** tab opens a collapsed-by-default capability card.
  Detection runs once off the render path and reports the CPU model, physical
  cores, logical threads, total memory, display adapters, and operating system;
  Refresh reruns detection on demand.

## Studio color system

Axial uses a near-black canvas with quiet dotted navigation marks. Surfaces are
charcoal and appear only for active tools, menus, nodes, and inspectors. Warm
white carries content; green marks selection, continuation, and success. Amber
and red mean caution or active work and failure. Operator families, port types,
and sequence bases keep categorical colors because their color carries data.

## Node (copy TD)

Left/bottom **flags**, not extra menus:

| Flag | TD | Axial |
|---|---|---|
| Viewer | data in the node body | Preview PNG/table on the node |
| Viewer Active | interact with the viewer | pan/zoom the plot without moving the node |
| Bypass | pass first input through | later |
| Lock | freeze output | later (= cache pin) |

Connectors: **left = in, right = out**. Drag out → in. Type mismatch: no wire.
Selecting or hovering a node reveals `+` beside each output. Clicking it opens
**Continue with**, already filtered to operators that accept that output. The
chosen operator is placed and wired in one action.

Middle-click node: info popup (cook_time, skip, hash, size).

Wires **animate while upstream is cooking**. Cached = still.

Resize node by dragging the edge (bigger viewer).

Viewer visibility is selection-aware. With multiple nodes selected, the Common
page reports `on`, `off`, or `mixed` and its viewer action applies to the whole
selection. A mixed selection resolves to **Hide selected viewers**; when every
selected viewer is hidden, the action becomes **Show selected viewers**. The
top-bar Show/Hide Viewers action applies the same rule to every node on the
canvas.

## Parameters (copy TD)

Every operator has **pages** (tabs). Unique pages first, then **Common**.

```
[ FastQC ] [ Output ] [ Common ]
```

Common (all nodes):

- name
- cook (pulse): Cook this node
- viewer on/off
- cost (display only)

Tool page: the real knobs (`threads`, `k`, accession). Types: int, float, toggle, menu, string. Min/max like TD.

v0.1: **constant mode only**. No expression/export/bind.

`enable` when a param only makes sense if another is on (TD enable flag).

## Library and workflow catalog

Double-click empty network or **Tab**: search operators, drop node. Not a wall of 1000 icons.

The temporary Library overlay uses the same search-and-drop interaction without
forcing every kind of work into one flat tree:

- **Build** groups tools by intent: quality, align and map, quantify, assemble,
  analyze, and utilities.
- **Sources** groups NCBI/SRA, Ensembl, and local-file inputs.
- **Pipelines** opens local Snakemake projects and combines Axial's typed
  curated wrappers with the official nf-core catalog.

Library, Paper Drop, and OP Create are one family of transient surfaces. Only
one can be open at a time; choosing another rail action switches immediately.
Clicking anywhere outside the active surface closes it, as do Escape and the
surface's own toggle. Search focus is requested once when a surface opens so
the fields never steal focus back while the user navigates results.

Completing Paper Drop opens a reconstruction report beside the editable canvas.
Each node is labeled **paper**, **inferred**, or **missing**, with its retained
evidence span or inference explanation. Generated connections are separately
listed as inferred rather than presented as paper-stated fact. Clicking a report
entry selects the corresponding node or wire; clicking the paper name in the
top bar reopens the report after dismissal. If the methods describe separate
analysis tracks or compare mutually exclusive tools, the report keeps them as
named **Candidate Graphs** with Parallel or Alternative roles. The candidate
selector swaps the editable canvas without discarding per-candidate edits.

File-source paths are never picker-only. Import File, Paired Reads, and Import
Directory nodes keep editable path fields and add **Browse...** controls that
open the system file or directory picker as appropriate.

One search spans all three modes. Recent tools and starred Favorites are
shortcuts, not new operator types; they and the active mode persist in
`.axial/library-state.json`. Rows show a compact purpose line; hover reveals the
full description, typed ports, and topics. Quick Add routes directly to read
import, accession entry, pipeline discovery, or a Snakemake project directory.
The footer distinguishes local operator definitions from catalog discoveries;
it never labels discovery as installation.

Dragging a wire onto empty network opens OP Create filtered to compatible
operators. Choosing one places it at the drop point and completes the wire in
one action. When identically named `r1` and `r2` ports exist at both ends,
snapping either mate also snaps its free companion; an already occupied mate is
never replaced implicitly.

Dropping a recognized local FASTQ pair together (`R1`/`R2` or `_1`/`_2` naming)
creates one Paired reads source with two visible output ports. fastp, STAR,
HISAT2, BWA, Salmon, and Kraken2 preserve those streams. Their `r2` ports remain
optional so the same nodes also support single-end reads.

The Sources card accepts an accession or a copied record URL and previews the
provider and resulting artifact before insertion. It recognizes public SRA run
accessions (`SRR`, `ERR`, `DRR`), NCBI assemblies (`GCA_`, `GCF_`), and Ensembl
gene/transcript/protein stable IDs. SRA insertion creates and wires the download
and FASTQ-conversion nodes; assembly insertion creates and wires the NCBI
Datasets package download and ZIP-unpack nodes; Ensembl insertion creates a
REST-backed FASTA source with genomic, cDNA, or protein mode inferred from the
stable ID. Small readiness indicators expose whether SRA Toolkit, Datasets, and
curl are available. Nothing downloads until Cook. Pipelines searches the
official cached nf-core catalog and every result is click- or drag-insertable.

Catalog entries communicate purpose, release and provenance, typed inputs and
outputs, and whether the operator is local or discovered. Axial deliberately
does **not** claim runtime estimates: execution depends on input size, available
cores, machine architecture, storage, cache state, and remote services. Cost is
only a coarse low/high execution guard.

Opening or dropping a directory with `Snakefile` or `workflow/Snakefile`
creates a typed directory-import → Snakemake pair. The workflow engine receives
a writable staged copy, never the immutable CAS directory. Its completed
project directory is captured as the `run: Directory` output. Parameters expose
cores, dry-run, keep-going, printed commands, and Snakemake's Conda deployment.

## Canvas controls

- Wheel/trackpad: pan in two axes.
- Pinch or Ctrl/Cmd-wheel: zoom around the cursor. The persistent − / + canvas
  controls provide the same bounded zoom for a mouse without gesture support;
  click the percentage between them to reset to 100%.
- Space + primary drag, middle drag, or secondary drag: pan.
- Empty-space drag: marquee select. Shift adds; Ctrl/Cmd toggles.
- Drag any selected node: move the whole selected group. Nodes softly magnetize
  to the 20-unit dot grid and to matching edges or centers on nearby nodes;
  green guides show the active alignment. Hold Alt while dragging for free
  placement.
- Ctrl/Cmd-D: duplicate selected nodes and their internal wires.
- Ctrl/Cmd-K: open and focus the global Library search from anywhere.
- Click a wire: select it; Delete removes the selected wire or nodes.
- Ctrl/Cmd-Z / Shift-Ctrl/Cmd-Z: undo / redo graph edits.
- Edit the node name in the parameter header to rename it without breaking wires.
- Ctrl/Cmd-S: save the graph. Valid edits also maintain `.axial/autosave.axial.json` for startup recovery.
- F: fit the graph.

## Components (our Technique)

TD COMP = network inside a node. Enter to go in. Same: a technique is one node until you go inside (Detach / enter). v0.1 IR already has Compound. UI enter is v1; until then one node with published ports.

## Do not copy

- Timeline / frame cook
- TOP/CHOP/SOP family soup
- Python in parameters
- Render/Display 3D flags
- Clone/immune
