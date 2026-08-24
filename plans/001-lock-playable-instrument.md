# Plan 001: Lock playable-instrument product thesis in docs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: There is no git history at planning time.
> If `git rev-parse --is-inside-work-tree` is true, run
> `git diff --stat HEAD -- CONTEXT.md docs/axial-design.md docs/operator-contract.md docs/catalog.md`
> and compare the "Current state" excerpts. On a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: unborn repo (no commits), 2026-08-24

## Why this matters

Three docs currently disagree about what Axial *is*. The design says a local instrument with a canvas. The operator contract says the wrap generator is the product. The catalog says examples-only. A novice-to-expert tool that is "extremely fun" cannot be a wrap SDK, a HoX boutique, or a CLI that skips on the second FastQC. This plan makes the docs tell one story so later code does not implement the wrong one.

## Current state

- `docs/axial-design.md:16-28` — instrument + two tags; CLI is first mergeable demo, canvas is second.
- `docs/axial-design.md:133-138` — canvas goals exist but are "second tag".
- `docs/axial-design.md:149-150` — no technique marketplace; kitchen-sink we maintain is a non-goal.
- `docs/operator-contract.md:11-20` — "**Axial is a bridge, not a boutique**" and "**the wrap generator is the product**".
- `docs/catalog.md:1-5` — "Examples + a generator."
- `CONTEXT.md:107-108` — "**Bridge**: … The product."

Repo conventions: Markdown, RFC 2119 in the operator contract, glossary in `CONTEXT.md` (one or two sentences, `_Avoid_`). Do not add implementation to `CONTEXT.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Grep thesis | `rg -n "wrap generator is the product\\|Bridge.*The product" docs CONTEXT.md` | no matches after the edit (except historical quotes if any; there should be none) |
| Grep playable | `rg -n "playable instrument" docs CONTEXT.md` | at least one hit in design, contract, catalog |

No `cargo` in this plan.

## Scope

**In scope:**

- `docs/axial-design.md` (Overview, Goals/Non-goals, Key Decision 20 only)
- `docs/operator-contract.md` (title through "Product: the bridge" section, and the "Default canvas" paragraph)
- `docs/catalog.md` (opening + Tier 0/1 headings)
- `CONTEXT.md` (Bridge, Technique, Catalog entries)

**Out of scope:**

- Any Rust/JSON/operator implementation
- Rewriting the cook/CAS contract (staging, cook keys, pull cook) — leave it
- wgpu vs other canvas stacks
- Adding a marketplace
- Plan 002/003 content (inspector details, pack CLI) — only the *thesis* here

## Git workflow

- If git does not exist: do not `git init` unless the operator asked. Edit files in place.
- If git exists: branch `advisor/001-lock-playable-instrument`. Commit message: `docs: lock playable-instrument thesis (novice canvas + expert wrap)`

## Steps

### Step 1: Rewrite CONTEXT.md terms

Replace **Bridge** with:

```md
**Bridge**:
The wrap path (JSON operator + staging + generated adapter) for tools Axial does not ship. Expert DX. Not the novice product.
_Avoid_: calling this "the product"
```

Add/replace **Technique**:

```md
**Technique**:
A graph with published ports that appears as one node. Novices run it. Experts detach it (v1 UI; IR exists now). The share unit for non-git users is a technique file. Same IR as Graph.
```

Keep **Catalog** as shipped tested operators + JSON drops. Add one sentence: "Novice palette is the shipped tested set. Expert palette includes project wraps."

**Verify**: `rg -n "The product. Not a boutique" CONTEXT.md` → no matches.

### Step 2: Lock Overview + Goals in `docs/axial-design.md`

In Overview (`docs/axial-design.md` ~lines 16–28), after the existing first paragraph, insert (do not delete the IR/Rust paragraph):

```md
**User thesis (novice → expert, one IR):** Axial is a playable local instrument. A novice opens a window, sees a FASTQ on the canvas, watches FastQC paint a PNG on the node, drags fastp, wires it, cooks, saves a graph file, and sends it to a colleague. An expert wraps a new CLI, detaches a technique, or runs `axial cook` headless. The wrap generator is how the catalog *grows*. It is not what a first-time user opens.

CLI remains the **engine test harness** (same `cook()`). The **product demo** is the window. A CLI skip-on-recook that no human plays is not a shipped v0.1.
```

Change Key Decision 20 from "v0.1-cli wedge is fixture FASTQ → FastQC" to:

```md
20. **v0.1 user wedge is the playable QC loop:** shipped FASTQ on the canvas → FastQC Preview on the node → drag fastp → Cook-to-here → save `*.axial.json`. Headless `axial cook` of the same graph is the engine acceptance test, not the demo.
```

In Non-goals, keep "kitchen-sink we maintain" and "not a HoX boutique". Add:

```md
- Empty novice palette. A wrap-only catalog is not playable.
```

Do **not** remove "Technique marketplace / sharing servers" — plan 003 only allows file share.

**Verify**: Decision 20 mentions canvas. Overview mentions novice window.

### Step 3: Rewrite operator-contract product section

Replace the section titled `## Product: the bridge` (`docs/operator-contract.md` ~lines 11–24) with:

```md
## Product: the playable instrument

Axial is a local node canvas for building, seeing, and sharing bioinformatics graphs. It is not a wrap SDK, not a HoX boutique, not Galaxy.

| Role | What they do |
|---|---|
| **Novice** | Palette of **tested** shipped nodes. Drag, wire, click outputs, Execute / Cook-to-here. Open a technique as one node. |
| **Expert** | Wrap a CLI (`axial ops wrap` or JSON). Detach a technique. Headless cook. Optional kinds. Agent-compile. |

The **bridge** (JSON + staging + generated adapters) is how experts add tools. The **playable set** (shipped, fixture-tested, Preview or Table on the sample FASTQ) is how novices have fun. Both required. Neither is sufficient alone.

Default snap is artifact type (`FastqGz`, `Bam`, `Vcf`). Untyped connect-anything is still Galaxy.
```

Replace "Default canvas: **bricks the user wrapped**" with "Default canvas: **shipped playable bricks**. User-wrapped bricks appear in the project palette."

**Verify**: `rg -n "wrap generator is the product" docs/operator-contract.md` → no matches.

### Step 4: Rewrite catalog opening + Tier 0/1

`docs/catalog.md` opening becomes:

```md
# Axial catalog

**Playable set + wrap path.** Novices get a small tested palette. Experts wrap everything else. Stars on nf-core pipelines are demand signal, not a porting queue.
```

Tier 0 stays (import, SRA, FastQC) but add: this graph **must open in the GUI** as the first-run project, not only via `axial cook`.

Rename Tier 1 from "wrap generator (this is the catalog)" to "**Playable palette (shipped, fixture-tested)**". Keep the example table (fastp, sheet.build, star, salmon, samtools.index, kraken2) but mark: a node is *playable* only if CI or a documented local fixture produces Preview or Table. Missing binary → palette entry disabled with `BinNotFound`, not a crash.

Keep wrap generator as a subsection: expert path, not the catalog heading.

**Verify**: `rg -n "this is the catalog" docs/catalog.md` → no match on wrap generator as the catalog.

### Step 5: Status

Update `plans/README.md` row 001 to DONE.

**Verify**: `rg "001" plans/README.md` shows DONE.

## Test plan

- No runtime tests. Manual: read the four files top-to-bottom; they must not contradict on "what is the product."
- `rg -n "wrap generator is the product|Bridge.*The product" CONTEXT.md docs` → empty.

## Done criteria

- [ ] `CONTEXT.md` does not call Bridge "the product"
- [ ] `docs/axial-design.md` Key Decision 20 describes the playable QC loop
- [ ] `docs/operator-contract.md` product section is "playable instrument" with novice/expert table
- [ ] `docs/catalog.md` playable palette is the shipped set; wrap is expert
- [ ] Cook/CAS/pull-cook/staging text in the design is unchanged
- [ ] No files outside scope modified
- [ ] `plans/README.md` row 001 DONE

## STOP conditions

- Operator asks to restore wrap-as-product — STOP, do not mix theses.
- You need to change cook-key / staging / wgpu to make the thesis work — STOP; those are other plans.
- Git diff shows unexpected files.

## Maintenance notes

- Later plans (002, 003) quote this thesis. If someone reverts "wrap is the product," 002/003 are invalid.
- Reviewer: check you did not delete the engine-first *test* story (`axial cook` still exists). You inverted the *user* story only.
