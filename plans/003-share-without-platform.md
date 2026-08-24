# Plan 003: Specify share-without-a-platform

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: Plan 001 DONE. Thesis is playable instrument.
> Design still lists "Technique marketplace" and "Multi-user, accounts, sharing servers" as non-goals — keep those.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lock-playable-instrument.md
- **Category**: direction
- **Planned at**: unborn repo, 2026-08-24

## Why this matters

Fun pipelines that cannot leave your laptop are a sketchbook. Experts already share Nextflow repos. Novices share *files* (a `.toe`, a Flora technique, a Figma link). Axial already has a git-diffable graph IR (`*.axial.json`). The design forbids a marketplace and accounts (`docs/axial-design.md` Non-goals). This plan specifies **file share** so "send this to a colleague" works without becoming HoX/Galaxy hosted.

## Current state

- Graph JSON is the source of truth (`docs/axial-design.md` Goals v0.1-cli item 1).
- Compound IR: `GraphRef` + published ports. Technique Builder UI is v1. "A graph file *is* a technique" (Key Decision 16).
- Non-goals: technique marketplace, community recipe store, multi-user, accounts, sharing servers.
- Operator overlay: project > user > shipped.
- Missing: what a recipient needs besides the graph (operators, binaries, sample data). Missing: a pack format.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Section exists | `rg -n "^## Share" docs/axial-design.md` | match after edit |

## Scope

**In scope:**

- `docs/axial-design.md` — add `## Share`; one Key Decision; tweak Non-goals only to clarify file share is allowed
- `docs/operator-contract.md` — one short "Sharing a wrap" paragraph (operators travel with the project or fail `BinNotFound`)
- `CONTEXT.md` — Technique already updated in 001; add **Pack** if needed

**Out of scope:**

- HTTP server, gist integration code, accounts
- Implementing `axial pack` binary (specify CLI shape only)
- Marketplace UI
- Scatter/gather

## Git workflow

- Branch `advisor/003-share-files`
- Commit: `docs: file-based graph and technique share`

## Steps

### Step 1: Clarify non-goals

In `docs/axial-design.md` Non-goals, change the marketplace line so it cannot be read as "do not share files":

```md
- Technique **marketplace**, community recipe **store**, accounts, sharing **servers**. Sharing a `*.axial.json` (or a packed technique directory) out of band (git, email, USB) is in-scope.
```

Keep "Multi-user, accounts, sharing servers" or merge into that bullet so it is not duplicated.

**Verify**: marketplace still forbidden; file share explicitly allowed.

### Step 2: Add Key Decision

Append to Key Decisions (next number after 24):

```md
25. **Share is a file, not a service.** The unit is `*.axial.json` plus any project `operators/` JSON the graph needs. A technique is a graph with published ports (already IR). Recipients run GUI or `axial cook`. Missing `bin` is `BinNotFound` with the operator id, not a download from us. No registry in v0.1/v1.
```

**Verify**: Decision 25 exists.

### Step 3: Write `## Share`

```md
## Share

Novice: File → Save. Send `qc.axial.json`. Colleague: File → Open (or `axial cook qc.axial.json`).

Expert: put wraps in `$PROJECT/operators/` next to the graph. Pack = zip or directory:

```
my-technique/
  graph.axial.json
  operators/*.json          # optional wraps this graph needs
  README.md                 # bins the human must have on PATH
```

CLI shape (specify now, implement with CLI crate later):

- `axial pack <graph> -o my-technique/` copies graph + referenced project operators. MUST NOT copy CAS, FASTQ, or `.axial/cache`.
- `axial cook` / GUI open of a packed technique MUST validate operators; missing schema = load error; missing bin = `BinNotFound`.

MUST NOT upload anywhere. MUST NOT require an Axial account.

Fixture data: the *shipped* tiny FASTQ may be referenced by a relative `files.import` path inside the pack if the author includes `testdata/`. MUST NOT embed 40 GB FASTQs in a technique. Large inputs stay the recipient's problem (they re-bind `files.import`).

Provenance tags on artifacts (optional, steal HoX SHARED TAGS as metadata, not as a server): `source.pipeline`, `source.version`, `axial.adapter` when a wrap/compound produced the artifact. Local only.
```

**Verify**: pack MUST NOT copy CAS.

### Step 4: Operator contract blurb

At the end of `docs/operator-contract.md` sharing/submitting section, add: project operators travel with a pack; shipped ids need not be duplicated; never share secrets in graph JSON (accessions may be present — already in AI threat model).

**Verify**: no instruction to publish to a URL.

### Step 5: CONTEXT Pack term

```md
**Pack**:
A directory containing a graph file and optional operator JSON, without the CAS. The share unit besides a lone `*.axial.json`.
```

### Step 6: Status

Mark 003 DONE.

## Test plan

- Docs only. Confirm Non-goals still forbid servers.

## Done criteria

- [ ] File share is explicit; marketplace/servers still non-goals
- [ ] Decision 25 exists
- [ ] Pack format specified; CAS not included
- [ ] `BinNotFound` is the missing-tool story
- [ ] `plans/README.md` row 003 DONE

## STOP conditions

- You add an HTTP registry, gist API, or accounts
- 001 not DONE
- You require recipients to have every nf-core pipeline installed

## Maintenance notes

- Implement `axial pack` in the CLI crate after PR 7 (`axial cook`). Not in this plan.
- Reviewer: watch for accidental marketplace language ("publish to Axial").
