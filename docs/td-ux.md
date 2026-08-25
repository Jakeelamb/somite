# Axial UI = TouchDesigner Network + Parameters

WYSIWID: what you see on the node is what it did. We copy TD’s **building** and **config**. We do not copy the timeline, 60 Hz, or Python expressions in v0.1.

## Window (from your TD 2025.33070, 2026-08-24)

```
┌ Palette │ Network (/project1)              │ Parameters     ┐
│ tree    │ grid + nodes with viewers        │ pages (tabs)   │
│ search  │ selected node: green border      │ sliders/menus  │
│ preview │ wires                            │               │
└─────────┴──────────────────────────────────┴───────────────┘
  (timeline at bottom — we do not copy)
```

Observed: Palette left (Tools → showCooks, Icon/Info/Suggestions). Network center. `displace1` selected. Param dialog top-right: pages **Displace | Common**. Hint: "To Add Operators Double-click in a Network".

- One selected node → that node's params. No form for the whole graph.
- Palette is a **docked browser**, not a hidden Tab-only menu. Tab/double-click still works.

## Node (copy TD)

Left/bottom **flags**, not extra menus:

| Flag | TD | Axial |
|---|---|---|
| Viewer | data in the node body | Preview PNG/table on the node |
| Viewer Active | interact with the viewer | pan/zoom the plot without moving the node |
| Bypass | pass first input through | later |
| Lock | freeze output | later (= cache pin) |

Connectors: **left = in, right = out**. Drag out → in. Type mismatch: no wire.

Middle-click node: info popup (cook_time, skip, hash, size).

Wires **animate while upstream is cooking**. Cached = still.

Resize node by dragging the edge (bigger viewer).

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

## Library (TD OP Create, organized for biology)

Double-click empty network or **Tab**: search operators, drop node. Not a wall of 1000 icons.

The docked Library uses the same search-and-drop interaction without forcing
every kind of work into one flat tree:

- **Build** groups tools by intent: quality, align and map, quantify, assemble,
  analyze, and utilities.
- **Sources** groups NCBI/SRA, Ensembl, and local-file inputs.
- **Pipelines** opens local Snakemake projects and combines Axial's typed
  curated wrappers with the official nf-core catalog.

One search spans all three modes. Recent tools and starred Favorites are
session shortcuts, not new operator types. Rows show a compact purpose line;
hover reveals the full description, typed ports, and topics. Quick Add routes
directly to read import, accession entry, pipeline discovery, or a Snakemake
project directory.

Dragging a wire onto empty network opens OP Create filtered to compatible
operators. Choosing one places it at the drop point and completes the wire in
one action.

The Sources accession box recognizes public SRA run accessions (`SRR`, `ERR`,
`DRR`) and NCBI assembly accessions (`GCA_`, `GCF_`). SRA insertion creates and
wires the download and FASTQ-conversion nodes; assembly insertion creates and
wires the data-package download and ZIP-unpack nodes. Pipelines searches the
official cached nf-core catalog and every result is click- or drag-insertable.
Discovery never auto-cooks high-cost downloads or pipelines.

Opening or dropping a directory with `Snakefile` or `workflow/Snakefile`
creates a typed directory-import → Snakemake pair. The workflow engine receives
a writable staged copy, never the immutable CAS directory. Its completed
project directory is captured as the `run: Directory` output. Parameters expose
cores, dry-run, keep-going, printed commands, and Snakemake's Conda deployment.

## Canvas controls

- Wheel/trackpad: pan in two axes.
- Pinch or Ctrl/Cmd-wheel: zoom around the cursor.
- Space + primary drag, middle drag, or secondary drag: pan.
- Empty-space drag: marquee select. Shift adds; Ctrl/Cmd toggles.
- Drag any selected node: move the whole selected group.
- Ctrl/Cmd-D: duplicate selected nodes and their internal wires.
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
