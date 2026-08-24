# Plan 002: Specify see-data-flow contract

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: Confirm plan 001 is DONE (`plans/README.md`).
> Confirm Overview in `docs/axial-design.md` contains "playable local instrument".
> If not, STOP — 001 did not land.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lock-playable-instrument.md
- **Category**: direction
- **Planned at**: unborn repo, 2026-08-24

## Why this matters

"See data flow" is why people want TouchDesigner and Flora. The design already rejects particles on a BAM (`docs/axial-design.md` inspirations table). It already has Preview-as-cook-output and pull cook. It does **not** specify what happens when a novice **clicks an output**. Without that, the canvas is a graph editor. Fun is the click: node body shows a plot, inspector shows the table head, wires show cooking vs cached.

This plan writes the contract only. No renderer code.

## Current state

- Pull cook: `docs/axial-design.md` Key Decision 11 — `cost: high` never viewer-pulled.
- Preview: Key Decision 15 — FastQC PNG on the node; downscale on upload; missing PNG is cook-state fill.
- Node anatomy is described later in the same design (header, body, ports).
- Non-goal: "Realtime data particles on sequence files."
- No inspector click-target spec. No "click port" spec.

Vocabulary from `CONTEXT.md`: Preview, Viewer, Cook, Dirty, Artifact, Wire (chrome, not IR).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Confirm 001 | `rg -n "playable local instrument" docs/axial-design.md` | match |
| Confirm section | `rg -n "^## See data flow" docs/axial-design.md` | match after edit |

## Scope

**In scope:**

- `docs/axial-design.md` — add section `## See data flow` after Proposed Design intro or after Node anatomy; add 3 bullets under v0.1-canvas Goals
- `CONTEXT.md` — add **Inspector** if missing (glossary only)

**Out of scope:**

- `operon-canvas` / wgpu implementation
- Changing pull-cook rules for `cost: high`
- Particles, BAM-in-GPU, embedded IGV
- Sharing (plan 003)

## Git workflow

- Branch `advisor/002-see-data-flow` if git exists
- Commit: `docs: specify click-output and cook-state chrome`

## Steps

### Step 1: Add Inspector to CONTEXT.md

```md
**Inspector**:
The chrome panel for the selected node: params, port bindings, Preview, log tail, cook_time vs skip. Not IR.
```

**Verify**: term exists, two sentences max, no implementation.

### Step 2: Add v0.1-canvas goals

Under `### Goals (v0.1-canvas)` in `docs/axial-design.md`, append:

```md
5. **Click node** opens Inspector (params, ports, Preview, stderr tail, skip vs cook_time).
6. **Click output port** shows that port's artifact metadata (basename, type, size, hash) and its Preview if any. Does not load FASTQ/BAM bytes into the UI process.
7. **Wires show cook state** of the upstream node: idle / dirty / cooking / cached / failed. Dashed = upstream cooking (TouchDesigner meaning).
```

**Verify**: three new numbered goals exist.

### Step 3: Write `## See data flow` in the design doc

Insert a section with these MUST rules (RFC 2119). Do not invent new cook kinds.

```md
## See data flow

Honest instrument chrome. Not particles.

1. The node **body** is the Preview texture when the port exists and the cook succeeded. Otherwise a fill colored by cook state.
2. Selecting a node MUST populate Inspector. Switching selection MUST NOT start a `cost: high` cook.
3. Selecting an output port MUST NOT read the artifact bytes except a Preview already in CAS (PNG / TSV head / log tail produced at cook time).
4. `cost: low` + viewer visible ⇒ cook request (existing pull rule). `cost: high` ⇒ Dirty chrome + explicit Cook or Cook-to-here.
5. Re-cook of a skipped node MUST show skip (not a fake spinner).
6. Failed cook: node body is error fill; Inspector shows stderr tail (1 MiB ring, already in cook design). Clicking does not retry; a Retry control may exist later.
7. Novice test: drop shipped FASTQ, FastQC paints a quality PNG on the node without opening a browser. If they still need Firefox, this section failed.
```

**Verify**: `rg -n "Novice test: drop shipped FASTQ" docs/axial-design.md` matches.

### Step 4: Status

Mark 002 DONE in `plans/README.md`.

## Test plan

- No runtime tests.
- Cross-check: nothing in the new section contradicts Key Decisions 11 and 15.

## Done criteria

- [ ] CONTEXT has Inspector
- [ ] v0.1-canvas goals include click node, click port, wire state
- [ ] `## See data flow` exists with the novice FastQC test
- [ ] No wgpu/code files added
- [ ] `plans/README.md` row 002 DONE

## STOP conditions

- 001 not DONE
- You would need to allow BAM bytes in the UI to satisfy a sentence — STOP; that is a rejected HoX-opposite
- You change cook-key or staging

## Maintenance notes

- Implementation belongs with design PRs 11–14 (canvas anatomy, inspector, preview blit). This plan is the acceptance text those PRs must meet.
- Reviewer: the novice test is the only product metric that matters here.
