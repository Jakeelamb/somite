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

## Palette (copy TD OP Create)

Double-click empty network or **Tab**: search operators, drop node. Not a wall of 1000 icons.

## Components (our Technique)

TD COMP = network inside a node. Enter to go in. Same: a technique is one node until you go inside (Detach / enter). v0.1 IR already has Compound. UI enter is v1; until then one node with published ports.

## Do not copy

- Timeline / frame cook
- TOP/CHOP/SOP family soup
- Python in parameters
- Render/Display 3D flags
- Clone/immune
