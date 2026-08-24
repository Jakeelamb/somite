# Plan 004: Cargo workspace + `axial-ir` verification baseline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: Plan 001 DONE so crate/product names are Axial.
> No application `Cargo.toml` should exist yet. If it does, STOP and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-lock-playable-instrument.md
- **Category**: tests
- **Planned at**: unborn repo, 2026-08-24

## Why this matters

There is no compiler, no test, no crate. Every later cook/canvas plan will invent a workspace. The design already specified IR as the deepest module (`docs/axial-design.md` Key Decision 4) and PR 1 as `axial-ir`. This plan *is* that PR 1, with tests, so the repo has a verification command.

This is the engine foundation. It does not ship the playable window. Without it, the playable thesis cannot be implemented.

## Current state

- No `Cargo.toml`, no `crates/`, no git required.
- Names: CLI `axial`, crates `axial-ir` / `axial-cook` / `axial-ops` / `axial-cli` / `axial-canvas` / `axial-app` / `axial-ai`, graphs `*.axial.json` (Key Decision 1).
- IR sketch lives in `docs/axial-design.md` under `## Graph IR sketch` (search that heading). Types include Graph, Node, Edge, Edit, PortType, Preview, GraphRef, published I/O, `n_`/`e_` + 32 hex ids, `OrderedF64` with custom serde (no NaN).
- License Apache-2.0. No `unwrap()` in library code.
- Tests: unit + proptest roundtrip. No cook in this crate. No I/O in `axial-ir` (`CompoundLoader` is a trait, no filesystem).

If the IR sketch in the design is too long to copy blindly: implement the *minimal* types needed for: Graph with nodes/edges/params/layout, PortType enum including Preview and Gtf, validate IDs + DAG + dangling endpoints, serde JSON roundtrip, Edit enum with AddNode/RemoveNode/AddEdge/SetParam (Branch may stub as a type with tests in a later PR). Prefer matching the design sketch; if a field is ambiguous, STOP.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `cargo test -p axial-ir` | exit 0, tests pass |
| Check | `cargo check --workspace` | exit 0 |
| Clippy (optional this plan) | `cargo clippy -p axial-ir -- -D warnings` | exit 0 if clippy available; if not installed, skip and note |

## Scope

**In scope:**

- `Cargo.toml` (workspace)
- `crates/axial-ir/**`
- `LICENSE` (Apache-2.0 text)
- `.gitignore` (target/, `.axial/`, editor junk)
- `README.md` at repo root: one paragraph + `cargo test -p axial-ir`

**Out of scope:**

- `axial-cook`, canvas, CLI cook, operators JSON, SRA, FastQC
- wgpu
- `unwrap()` in lib
- Implementing Branch apply fully if it needs CompoundLoader filesystem — types only + roundtrip is enough; `validate` DAG is required

## Git workflow

- `git init` **only if** the operator wants a repo; otherwise just write files.
- If git: branch `advisor/004-axial-ir`, commit `chore: cargo workspace and axial-ir core types`

## Steps

### Step 1: Workspace + license + gitignore

Edition 2021 or 2024 matching local `rustc`. Workspace members: `crates/axial-ir` only for now.

`.gitignore`: `/target`, `**/.axial/`, `*.swp`.

LICENSE: Apache-2.0.

**Verify**: `cargo metadata --no-deps --format-version 1` lists `axial-ir`.

### Step 2: Core types + serde roundtrip

Implement Graph/Node/Edge/PortType/Layout/ParamValue as in the design sketch. `schema_version` on Graph. IDs `n_`/`e_` + 32 lowercase hex. `OrderedF64`: reject NaN/Inf on deserialize.

No `unwrap` in `src/` library paths. Tests may `expect` with a message.

**Verify**: `cargo test -p axial-ir roundtrip` (name the test accordingly) passes.

### Step 3: `validate`

- Unique node/edge ids
- Edge endpoints exist
- Graph is a DAG (cycle = error)
- Dangling edge = error

**Verify**: tests for empty graph OK, one-node OK, cycle errors, dangling errors.

### Step 4: proptest JSON roundtrip

proptest: generate small graphs (bounded nodes), serialize, deserialize, equal. Skip layout float equality if you normalize; document the choice. Prefer integer millipixels if the design's float noise bothers tests — if you change layout representation, STOP and report (design accepted float git churn).

**Verify**: `cargo test -p axial-ir` includes a proptest.

### Step 5: README + plan status

Root README: product one-liner from 001 (playable instrument), `cargo test -p axial-ir`.

Mark 004 DONE.

## Test plan

- Roundtrip serde
- validate: cycle, dangling, duplicate ids
- proptest roundtrip
- `cargo test -p axial-ir` is the repo verification command until cook exists

## Done criteria

- [ ] `cargo test -p axial-ir` exits 0
- [ ] `cargo check --workspace` exits 0
- [ ] No `unwrap()` in `crates/axial-ir/src` (except tests)
- [ ] No cook/canvas crates yet
- [ ] `plans/README.md` row 004 DONE

## STOP conditions

- `Cargo.toml` already exists with different crate names — STOP
- You need network crates (reqwest) — STOP, IR has no I/O
- You add wgpu or cook in this plan
- Design IR sketch and this minimal set conflict on a type you cannot resolve — STOP and quote both

## Maintenance notes

- Next code plans (not written here): cook (design PR 3–5b), ops JSON, CLI, then canvas. This crate must stay free of I/O.
- Reviewer: watch extra dependencies. Prefer `serde`, `thiserror`, `proptest` (dev). `blake3` is cook, not IR, unless the sketch puts hashes in IR types — if so, only as hex strings.
