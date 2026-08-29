# Plan 001: Make paper intake truthful, fast, complete, and polished

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat e5549d2..HEAD -- \
>   crates/somite-paper/src/lib.rs crates/somite-cli/src/main.rs \
>   crates/somite-ops/src/lib.rs crates/somite-server/src/lib.rs operators \
>   web/app/SomiteApp.tsx web/app/WorkspacePanels.tsx \
>   web/app/paperResolution.ts web/app/types.ts web/app/globals.css \
>   web/tests testdata/papers scripts/fetch-paper-corpus \
>   docs/domain-model.md docs/somite-design.md
> git diff --stat -- \
>   crates/somite-paper/src/lib.rs crates/somite-cli/src/main.rs \
>   crates/somite-ops/src/lib.rs crates/somite-server/src/lib.rs operators \
>   web/app/SomiteApp.tsx web/app/WorkspacePanels.tsx \
>   web/app/paperResolution.ts web/app/types.ts web/app/globals.css \
>   web/tests testdata/papers scripts/fetch-paper-corpus \
>   docs/domain-model.md docs/somite-design.md
> ```
>
> This plan was written against commit `e5549d2` **plus an existing dirty
> working tree** containing the current paper-intake implementation. If any
> excerpt below does not match the live working tree, or if those dirty changes
> are neither present nor represented by later commits, treat it as a STOP
> condition and reconcile with the owner before editing.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug, perf, tests, direction
- **Planned at**: commit `e5549d2`, 2026-08-28

## Why this matters

Somite currently reports a workflow draft as ready whenever the response contains
one candidate, even when that candidate contains zero nodes. This was reproduced
with two distinct real papers: one truly lacked a bioinformatics DAG, while the
other explicitly described Oxford Nanopore, Porechop, dnaPipeTE, Trinity,
RepeatMasker, and a custom Perl step that Somite did not recognize. Those are
different outcomes and the product must explain them differently.

The fast path is already fast: five native-text PDFs reconstructed in roughly
45–176 ms on the audit machine. The work is therefore not “add more animation.”
It is to establish an honest intake contract, make coverage measurable, avoid
duplicate work and stale races, make slow OCR observable and cancellable, and
surface retained evidence without claiming that an empty or unsupported method
set is a usable workflow.

## Current state

### Product and domain constraints

- `docs/domain-model.md:191-205` defines Reconstruction as an evidence-bound
  draft, Candidate graphs as distinct method tracks, and a Paper intake job as
  an observable operation with `ready`, `empty`, or `failed` terminal results.
- `docs/domain-model.md:207-224` requires scientific evidence, executable
  support, citations, and exact downloadable resources to remain separate.
- `docs/adr/0004-one-workflow-assessment.md:8-26` requires one deterministic
  `WorkflowAssessment`; Paper, Readiness, Export, run admission, MCP, and Agent
  may not invent separate readiness classifiers. AI is escalation only.
- `docs/research/paper-methods-benchmark-corpus.md:175-229` already defines the
  correct long-term target: package -> evidence ledger -> named subworkflow set,
  with entity, parameter, topology, control-flow, and evidence-support scoring.
  Do not replace that with a single “candidate count” metric.

### Reproduced failures and baseline

The audit exercised ten committed text fixtures and five distinct uploaded PDFs
through the live `POST /api/paper` route.

| Real PDF | Extractor | Time | Candidates | Nodes | Result |
|---|---:|---:|---:|---:|---|
| axolotl assembly | Poppler | 57 ms | 1 | 15 | draft with managed and unsupported steps |
| DNA gains/losses | Poppler | 103 ms | 1 | 5 | RNA-seq draft |
| Metamorphosis constraints | Poppler | 176 ms | 1 | **0** | false-ready; statistical/phylogenetic analysis |
| TE diversity | Poppler | 58 ms | 1 | **0** | false-ready; missed explicit computational methods |
| aphid preprint | Poppler | 45 ms | 1 | 12 | assembly draft |

All ten committed text fixtures returned one non-empty candidate. However, the
fixture corpus is heavily linear: several assembly fixtures use five to seven
`gap.missing` nodes, and the real-PDF corpus is skipped when gitignored
`testdata/papers/pdf/` and `raw/` assets are absent.

The upload directory contained 19 PDFs but only five unique SHA-256 values:
13 copies of the axolotl PDF and three copies of the DNA paper. They occupied
48.82 MiB. Retrying the same paper uploads it again under a suffixed filename.

### False-success path

`crates/somite-paper/src/lib.rs:78-84` currently assumes a Reconstruction is
never empty:

```rust
fn new(candidates: Vec<CandidateGraph>) -> Self {
    debug_assert!(!candidates.is_empty());
    Self { candidates, active: 0 }
}
```

`crates/somite-paper/src/lib.rs:785-788` turns failed recognition into a
zero-node candidate plus a warning:

```rust
if g.nodes.is_empty() {
    warnings.push(
        "no tools or assay I could map. drop a methods section, not a cover page.".into(),
    );
}
```

`crates/somite-server/src/lib.rs:2843-2911` serializes every internal candidate,
including that zero-node candidate, and successfully assesses its empty graph.

`web/app/SomiteApp.tsx:1233-1240` equates candidate count with success:

```tsx
const review = await jsonRequest<PaperReview>("/api/paper", ...);
if (review.candidates.length) {
  const message = `${review.candidates.length} workflow draft... ready to review`;
  setPaperJob({ phase: "complete", ... });
}
```

The same candidate-count check is duplicated in the example and bioRxiv paths
around `web/app/SomiteApp.tsx:1264-1293`, while
`web/app/WorkspacePanels.tsx:874` repeats the count in the panel header.

### Coverage model

`crates/somite-paper/src/lib.rs:191-237` contains small hard-coded `BRICKS` and
`GAPS` tables. The current Operator contract in
`crates/somite-ops/src/lib.rs:217-242` contains execution metadata but no paper
aliases or operation semantics. As a result:

- the TE-diversity paper's Porechop, dnaPipeTE, Trinity, and RepeatMasker steps
  are neither candidates nor retained unsupported-method diagnostics;
- the Metamorphosis paper's R/phytools/modeling analysis is indistinguishable
  from dropping a cover page;
- adding recognition vocabulary requires editing the reconstruction engine
  rather than the relevant operator or a reviewed method registry.

### Extraction and upload behavior

- `crates/somite-paper/src/lib.rs:293-316` tries Poppler and falls back to OCR
  when fewer than 400 ASCII letters are extracted.
- `crates/somite-paper/src/lib.rs:346-435` rasterizes up to 30 pages at 300 DPI,
  then runs Tesseract serially. It exposes no progress, timeout, cancellation,
  or cache key.
- `crates/somite-server/src/lib.rs:2812-2825` wraps the entire extraction and
  reconstruction in one opaque `spawn_blocking` call.
- `crates/somite-server/src/lib.rs:746-805` disables Axum's body limit globally.
- `crates/somite-server/src/lib.rs:3129-3190` streams each upload into a newly
  suffixed filename without a byte bound, content hash, or deduplication.
- `/api/system` reports Pixi, SRA, datasets, Ensembl, Nextflow, and Snakemake,
  but not Poppler/Tesseract paper capability.

### UI race and retry behavior

- `rebuildPaper` has no `AbortController`, request token, or job id.
- The Paper panel refuses a second drop while loading, but the canvas drop path
  at `web/app/SomiteApp.tsx:1324-1339` calls `rebuildPaper` unconditionally.
  Two rapid canvas drops can run concurrently; an older response can overwrite
  the newer paper review and clear the newer loading flag.
- `lastPaperFileRef` stores only the browser File. “Try again” calls
  `rebuildPaper` and therefore uploads the same bytes again.
- `PaperJob` in `web/app/types.ts:418-425` has only upload/reconstruct phases and
  no server job id, progress, durations, cancellation, cache-reuse flag, or
  recognition outcome.

### Test gap

- `crates/somite-server/src/lib.rs:4371-4433` tests one successful plain-text
  paper. It asserts only that candidates, evidence, and assessment nodes are
  non-empty.
- `crates/somite-paper/src/lib.rs:3044-3206` contains a useful real-paper corpus
  test, but silently skips every missing gitignored asset.
- `web/tests/paper-resolution.test.ts` covers helper functions, not overlapping
  drops, stale responses, an empty graph, retry reuse, or server progress.
- There is no checked-in CI configuration that requires the fetched corpus.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust paper tests | `cargo test -p somite-paper` | exit 0; all paper unit tests pass |
| Rust server paper tests | `cargo test -p somite-server paper` | exit 0; all filtered server tests pass |
| Full Rust tests | `cargo test --workspace` | exit 0; all workspace tests pass |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0; no warnings |
| Rust format | `cargo fmt --all -- --check` | exit 0; no diff |
| Web checks | `cd web && npm run typecheck && npm run lint && npm test` | all three exit 0 |
| Fetch licensed corpus | `scripts/fetch-paper-corpus` | checksums pass and all declared assets exist |
| Required real corpus | `SOMITE_PAPER_CORPUS=required cargo test -p somite-paper downloaded_real_paper_corpus_reconstructs` | exit 0; zero cases skipped |

## Scope

**In scope** (the only files or path families you should modify):

- `crates/somite-paper/src/lib.rs`
- `crates/somite-cli/src/main.rs`
- `crates/somite-ops/src/lib.rs`
- `crates/somite-server/Cargo.toml` and the corresponding `Cargo.lock` entries
- `crates/somite-server/src/lib.rs`
- reviewed `operators/*.json` entries whose paper-recognition metadata changes
- `web/app/SomiteApp.tsx`
- `web/app/WorkspacePanels.tsx`
- focused `web/app/paperIntake*.ts` and `web/app/paperReading.ts` modules
- `web/app/paperResolution.ts`
- `web/app/types.ts`
- `web/app/globals.css`
- `web/package.json` to admit the focused tests to the standard web gate
- `web/tests/paper-resolution.test.ts`
- `web/tests/rendered-html.test.mjs`
- additional focused paper-intake tests under `web/tests/`
- `testdata/papers/README.md`
- `testdata/papers/*.txt` and a small machine-readable gold manifest
- `scripts/fetch-paper-corpus` and one focused corpus-check script if needed
- `README.md`
- `docs/domain-model.md`
- `docs/somite-design.md`

**Out of scope**:

- changing Graph, Node, Edge, or execution semantics;
- adding a second readiness classifier instead of `WorkflowAssessment`;
- making an LLM, network search, or Agent connection required for paper intake;
- silently turning unsupported method names into executable operators;
- committing user-downloaded or rights-unclear PDFs;
- changing NCBI/Ensembl resource selection rules;
- broad visual redesign of non-Paper surfaces;
- deleting existing uploads as part of migration. Deduplication applies to new
  intake; a separate explicit cleanup tool can be proposed later.

## Git workflow

- Branch: `advisor/001-paper-intake`
- Preserve the pre-existing dirty worktree; do not reset or rewrite it.
- Commit one logical unit per numbered step after its verification passes.
- Match the repository's conventional messages, for example:
  `fix: make paper reconstruction outcomes truthful` and
  `feat: add observable cached paper intake jobs`.
- Do not push or open a PR unless the operator explicitly requests it.

## Steps

### Step 1: Lock the failure classes into deterministic tests

Add characterization tests before changing behavior.

1. In `crates/somite-paper/src/lib.rs`, add cases for:
   - ordinary prose with no methods;
   - a method section with an unsupported but recognizable computational
     sequence: Oxford Nanopore -> Porechop -> dnaPipeTE/Trinity and
     RepeatMasker -> custom script;
   - a statistical/phylogenetic analysis using R and phytools;
   - the existing successful RNA-seq and assembly paths.
2. Add a small machine-readable gold manifest under `testdata/papers/` that
   records, per committed fixture: expected outcome, required/forbidden assay,
   required/forbidden operator, required unsupported mentions, minimum evidence
   coverage, and whether zero candidates is legitimate. Keep full PDFs in the
   already-gitignored `pdf/`/`raw/` paths.
3. Change `downloaded_real_paper_corpus_reconstructs` so
   `SOMITE_PAPER_CORPUS=required` fails with an explicit list of missing assets
   instead of silently succeeding. Preserve the default developer behavior when
   the environment flag is absent.
4. In `crates/somite-server/src/lib.rs`, add failing route tests proving that a
   zero-node reconstruction cannot be serialized as a ready candidate.
5. In `web/tests/paper-resolution.test.ts`, add a failing helper-level test for
   a response containing one zero-node candidate. Its expected result is an
   `empty` or `recognized_unsupported` terminal state, never `complete`.

Do not copy prose from the user PDFs into committed fixtures beyond the minimum
fact-like tool sequence needed for a regression case. Record title/DOI/source
metadata in the manifest only after rights and identity are verified.

**Verify**:

```bash
cargo test -p somite-paper
cargo test -p somite-server paper
cd web && npm test
```

Expected before implementation: the new truthfulness tests fail for the
documented reason, while unrelated tests pass. Commit the red tests only if the
repository accepts test-first commits; otherwise continue directly to Step 2.

### Step 2: Replace “candidate exists” with a truthful reconstruction outcome

Deepen the `somite-paper` result so callers do not infer state from collection
length.

1. In `crates/somite-paper/src/lib.rs`, introduce explicit deterministic data:

   ```rust
   enum ReconstructionOutcome {
       DraftsReady,
       RecognizedUnsupported,
       NoReconstructableMethods,
   }

   struct MethodMention {
       display_name: String,
       normalized_name: String,
       operation_class: Option<String>,
       evidence: String,
       page: Option<usize>,
       support: MethodSupport,
   }

   struct Reconstruction {
       outcome: ReconstructionOutcome,
       candidates: Vec<CandidateGraph>,
       mentions: Vec<MethodMention>,
       warnings: Vec<String>,
       active: Option<usize>,
   }
   ```

   Exact enum/field names may follow existing Rust naming, but retain these
   semantics. `DraftsReady` requires at least one candidate with at least one
   node. `RecognizedUnsupported` requires retained method evidence but no usable
   candidate. `NoReconstructableMethods` means no executable/unsupported method
   track was found; it is not an extraction error.
2. Remove the `debug_assert!(!candidates.is_empty())` invariant and unsafe
   `Deref` assumption. Expose `active() -> Option<&CandidateGraph>` and update
   the CLI/tests explicitly. The CLI must print diagnostics and exit normally for
   a legitimate empty result rather than indexing candidate zero.
3. Drop zero-node candidates before the public result is constructed. Add a
   debug/test invariant that every exported Candidate graph has at least one
   node and validates against the Catalog.
4. In `crates/somite-server/src/lib.rs`, add the explicit outcome, method
   mentions, warnings, and extraction summary to `PaperResponse`. Preserve
   `WorkflowAssessment` unchanged for each real candidate.
5. Update `web/app/types.ts` to mirror the Rust response exactly. Put one pure
   classification helper in `web/app/paperResolution.ts`; all local upload,
   example, and bioRxiv paths must call it. Remove duplicated candidate-count
   state inference from `SomiteApp.tsx` and `WorkspacePanels.tsx`.

Terminal UI language must be concrete:

- `drafts_ready`: “2 workflow drafts ready to review”;
- `recognized_unsupported`: “Methods found, but Somite cannot build a workflow
  yet” plus named methods and evidence;
- `no_reconstructable_methods`: “Paper read; no reconstructable workflow was
  found” plus a suggestion to use the Methods/supplement only when extraction
  diagnostics support that suggestion;
- extraction failure: “Could not read this PDF” plus exact dependency/file
  reason.

**Verify**:

```bash
cargo test -p somite-paper
cargo test -p somite-server paper
cd web && npm run typecheck && npm test
```

Expected: all pass; a grep for candidate-count success checks returns no matches:

```bash
rg -n 'candidates\.length \?|if \(review\.candidates\.length\)' web/app
```

Expected: no paper-job outcome decisions remain based only on candidate count.

### Step 3: Make method recognition catalog-driven and evidence-preserving

Do not solve coverage by continuously expanding `BRICKS` and `GAPS` in one Rust
file.

1. Extend the human/non-execution portion of the Operator JSON contract in
   `crates/somite-ops/src/lib.rs` with optional paper-recognition metadata:
   aliases, operation class, and assay hints. Exclude this metadata from the
   execution-semantic revision, as existing title/palette metadata is excluded;
   add a test proving aliases do not change a pinned operator revision.
2. Move existing `BRICKS` aliases to the relevant reviewed Operator JSON files.
   Preserve special compound-workflow behavior (for example named
   `nf-core/rnaseq`) in reconstruction logic where it represents topology rather
   than alias lookup.
3. Keep a small reviewed unsupported-method registry for methods without an
   executable Operator. Each entry must include canonical name, aliases,
   operation class, input/output shape when known, and whether it may become a
   `gap.missing` node. If the I/O contract is not known, retain it only as a
   `MethodMention`; never invent an edge.
4. Add the TE regression vocabulary from Step 1. Porechop, dnaPipeTE, Trinity,
   RepeatMasker, and the custom script must appear in retained diagnostics.
   Promote any of them to real executable operators only if their authoritative
   versions, Pixi packages, typed ports, argv, outputs, and representative
   fixtures are reviewed. Otherwise keep the result honest and unsupported.
5. Add a statistical-analysis boundary. R/phytools/model-fitting evidence should
   produce either a separately named statistical method track if a reviewed
   operator exists, or `recognized_unsupported`; it must not claim the user
   dropped a cover page.
6. Preserve exact surface spelling, nearby evidence, and PDF page on every
   mention. Recognition metadata is deterministic and local; Agent may be
   offered only after these facts are shown.

**Verify**:

```bash
cargo test -p somite-ops
cargo test -p somite-paper
cargo clippy -p somite-ops -p somite-paper --all-targets -- -D warnings
```

Expected: all pass; the TE case returns named evidence and never a ready
zero-node candidate; operator revision tests prove recognition aliases do not
alter execution identity.

### Step 4: Introduce bounded, content-addressed, observable paper intake jobs

Use the existing run/validation job style in `crates/somite-server/src/lib.rs`
rather than keeping one opaque blocking request.

1. Make upload responses include SHA-256, byte size, stored path, original
   filename, and `reused`. Stream the hash while writing; do not buffer the whole
   upload. Store one immutable content-addressed object per digest and maintain
   display-name metadata separately. If the digest already exists, discard the
   temporary bytes and reuse the existing object.
2. Apply a route-scoped configurable paper size limit (default 100 MiB unless a
   repo convention already exists) and accepted PDF/text MIME/extension checks.
   Remove the router-wide unlimited-body behavior or constrain it to endpoints
   that genuinely require it. Clean temporary partial files on client
   disconnect, limit breach, and write failure.
3. Add server-managed paper intake endpoints following existing conventions:
   start from an uploaded path/digest, long-poll status with `wait_ms`, and
   cancel. A status should contain:
   - stable job id and source digest;
   - phase: queued, extracting text, OCR page N/M, locating methods,
     recognizing methods, assessing drafts, completed, empty, failed,
     cancelling, or cancelled;
   - completed/total/unit/message progress;
   - per-stage durations;
   - cache-reuse flag;
   - terminal PaperResponse or actionable error.
4. Cache normalized extracted text and deterministic reconstruction by source
   digest plus extractor-version and Catalog digest. Retry must reuse the stored
   object and successful extraction. A Catalog change may invalidate
   reconstruction without rerunning Poppler/OCR.
5. Keep native Poppler extraction on the fast path. For OCR, report page
   progress, enforce an explicit page bound, support cancellation between pages,
   and kill child processes on timeout/cancel. Do not leave raster pages behind.
6. Extend `/api/system` with paper capability: Poppler text, Poppler raster, and
   Tesseract availability. Prefer Somite's managed Pixi toolchain when present;
   otherwise return a preflight error that names the missing executable and the
   supported installation path. Do not silently depend on Omarchy.
7. Add server tests for size rejection, partial-file cleanup, same-content
   deduplication, cache reuse, cancellation, dependency absence, and terminal
   status retention.

Do not remove the existing `/api/paper` route until the UI is migrated and all
tests pass. It may become a thin compatibility wrapper over a completed job,
then be removed in a later dedicated cleanup.

**Verify**:

```bash
cargo test -p somite-server paper
cargo test -p somite-server upload
cargo test -p somite-server system_profile
```

Expected: all pass. The deduplication test uploads identical bytes twice,
returns the same digest/object path with `reused: true` on the second response,
and proves only one content object exists.

### Step 5: Make the Paper UI latest-safe, calm, and immediately informative

1. Replace the local boolean-driven request flow in `SomiteApp.tsx` with one
   active intake identity. Keep both an `AbortController` and monotonically
   increasing request token. Only the current token may update review, job,
   status, or loading state.
2. Handle a second canvas or panel drop consistently. The new paper becomes the
   active intake, the old poll is aborted/cancelled, and the prior completed
   review remains visible until the new job reaches a terminal result. Never let
   an older response overwrite a newer result.
3. Store the uploaded digest/path in `PaperJob`. “Try again” restarts from that
   stored artifact; it must not send the File bytes again. Show “Using cached
   paper” when appropriate.
4. Expand `PaperJob` and `paperJobSteps` to the real server phases. Show a small
   phase label, determinate progress when total pages are known, elapsed time for
   slow work, and one short current message. Put technical logs, extractor name,
   durations, and recognized/unsupported method lists in a collapsed “Details”
   disclosure.
5. On `recognized_unsupported`, show:
   - “What Somite found” with method names and page-located evidence;
   - “Why no draft was built” with missing reviewed contracts or missing
     topology evidence;
   - deterministic actions such as use Methods/supplement or attach workflow
     source;
   - one optional “Ask Agent” action using the retained evidence. Agent must not
     be the only recovery path.
6. On `no_reconstructable_methods`, do not render candidate tabs, apply buttons,
   readiness UI, or “1 workflow draft.” Preserve cited resources and extraction
   details if present.
7. Keep animation subtle: spinner/progress only while active, no artificial
   delay on the 45–176 ms fast path, and respect `prefers-reduced-motion`.
   `aria-live` should announce phase transitions, not every OCR page.
8. Add tests for fast success, no-workflow, recognized-unsupported, extraction
   failure, stale overlapping responses, cancellation, retry reuse, and prior
   review preservation. Use a deferred-Promise test to force response B to
   finish before response A and assert that B remains visible.

**Verify**:

```bash
cd web && npm run typecheck && npm run lint && npm test
```

Expected: all pass. Then run the local app and manually exercise these exact
cases: successful text fixture, prose/no-workflow fixture, TE unsupported
fixture, same file twice, two rapid canvas drops, cancellation during OCR, and
missing Tesseract. Every case ends in one visible terminal result and the canvas
changes only after explicit Candidate acceptance.

### Step 6: Turn the multi-paper corpus into a quality and performance gate

1. Make the machine-readable manifest from Step 1 drive one evaluator. Report
   separate metrics for extraction, assay/track classification, method entity
   precision/recall, operator support, parameters, nodes, typed edges, ordering,
   branches/alternatives, and evidence-span support. Follow
   `docs/research/paper-methods-benchmark-corpus.md:175-229`.
2. Require every committed text fixture in ordinary `cargo test`. Keep the
   provenance-checked full-paper corpus fetch explicit, then make
   `SOMITE_PAPER_CORPUS=required` an all-or-nothing gate for release/CI use.
3. Add at least these negative assertions:
   - no exported candidate has zero nodes;
   - comparison tools do not become executable stages;
   - alternative assembly methods remain separate Candidate graphs;
   - an unsupported mention is retained, not discarded or wired by guess;
   - resource citations do not become reads until an exact run is selected.
4. Record per-stage timing without imposing a fragile machine-specific unit-test
   deadline. Add a repeatable benchmark/report command that separates upload,
   native extraction, OCR, recognition, assessment, and cache-hit time. The
   release review should flag regressions relative to the checked baseline,
   while correctness tests enforce timeouts and bounded work.
5. Add a corpus summary to test output: total papers, skipped papers, outcome
   counts, empty candidates (must be zero), unsupported mentions, and metric
   failures. Silent skips are forbidden in required mode.
6. If a CI workflow is introduced, keep it focused: ordinary workspace/web
   checks on every change and the licensed fetched corpus on a scheduled or
   release job with cache/checksum validation. Do not commit third-party PDFs to
   make CI convenient.

**Verify**:

```bash
scripts/fetch-paper-corpus
SOMITE_PAPER_CORPUS=required cargo test -p somite-paper downloaded_real_paper_corpus_reconstructs -- --nocapture
```

Expected: all declared cases are present, zero are silently skipped, every
exported candidate is non-empty, and metric failures name the exact paper,
track, expected fact, and observed fact.

### Step 7: Document the stable contract and run the full gate

1. Update `docs/domain-model.md` so Paper intake job phases, reconstruction
   outcomes, method mentions, cached artifacts, and Candidate non-emptiness are
   named domain concepts.
2. Update `docs/somite-design.md` with the content-addressed intake/cache
   boundary, deterministic outcome rules, OCR progress/cancellation, and
   optional Agent escalation.
3. Update `testdata/papers/README.md` with the manifest, required-mode command,
   licensing rule, and quality metrics.
4. Make sure no UI copy promises “ready” unless the explicit outcome is
   `drafts_ready` and every candidate has a validated non-empty graph.

**Verify**:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd web && npm run typecheck && npm run lint && npm test
git status --short
```

Expected: all commands exit 0. `git status --short` shows only files listed in
Scope plus the pre-existing owner changes and the plan-status update.

## Test plan

### Rust unit and integration cases

- Native text PDF -> `DraftsReady`, validated non-empty candidates.
- Plain article/cover page -> `NoReconstructableMethods`, zero candidates.
- Explicit unsupported methods -> `RecognizedUnsupported`, zero candidates,
  named evidence and page locations.
- Mixed supported/unsupported track -> non-empty draft plus retained unsupported
  mentions; unsupported methods are not silently wired.
- Poppler missing, OCR available -> OCR path with page progress.
- Poppler/Tesseract missing -> actionable extraction failure, no false empty.
- OCR cancellation/timeout -> child killed and temp directory removed.
- Duplicate upload -> same content object, second response `reused: true`.
- Same digest/new Catalog digest -> extraction cache hit, reconstruction rerun.
- Same digest/same versions -> full terminal cache hit.
- Oversized upload/client disconnect -> bounded failure and no partial file.
- Required corpus mode -> missing asset list and nonzero exit.

### Web cases

- All terminal outcomes render distinct copy and actions.
- One zero-node candidate cannot reach `complete`, even from a legacy response.
- A later intake wins over an older late response.
- Retry uses stored path/digest and does not invoke upload.
- Previous review remains until replacement succeeds.
- Cancel reaches a visible terminal state and can be retried.
- Fast native path does not flash multiple artificial steps.
- OCR progress is determinate when page count is known and accessible to screen
  readers without noisy page-by-page announcements.
- Candidate application remains the only paper action that replaces the canvas.

### Manual matrix

Exercise at least five different real papers covering:

- successful assembly;
- successful RNA-seq;
- a legitimate statistical/non-DAG paper;
- explicit but unsupported TE/long-read methods;
- a scanned/OCR PDF.

For each, record source digest, size/pages, extractor, phase timings, outcome,
candidate/node/edge count, unsupported mentions, citations, and terminal UI copy.
Do not add these user PDFs to Git.

## Done criteria

- [x] Every exported `PaperCandidate` has at least one node and passes Graph and
      Catalog validation.
- [x] The server returns an explicit reconstruction outcome; no UI path infers
      success solely from `candidates.length`.
- [x] The two zero-node failure classes have different, actionable terminal UI.
- [x] The TE regression retains Porechop, dnaPipeTE, Trinity, RepeatMasker, and
      custom-script evidence without inventing execution semantics.
- [x] Retry does not upload identical bytes again; same-content uploads reuse one
      content object.
- [x] Two overlapping paper drops cannot produce a stale visible review.
- [x] OCR exposes progress, timeout, cancellation, and dependency diagnostics;
      all temporary raster files are cleaned.
- [x] Paper extraction prerequisites appear in deterministic system capability
      data and work outside Omarchy through the managed toolchain or an
      actionable preflight.
- [x] Ordinary text-fixture tests always run; required full-corpus mode cannot
      silently skip missing papers.
- [x] Corpus output separates extraction, entity, topology, parameter, control
      flow, and evidence-support failures.
- [x] `cargo test --workspace` exits 0.
- [x] `cargo clippy --workspace --all-targets -- -D warnings` exits 0.
- [x] `cargo fmt --all -- --check` exits 0.
- [x] `cd web && npm run typecheck && npm run lint && npm test` exits 0.
- [x] No unrelated pre-existing work is overwritten; task edits remain within
      the implementation and documentation scope above.
- [x] `plans/README.md` status row is updated.

## STOP conditions

Stop and report back; do not improvise if:

- the live dirty working tree no longer matches the current-state excerpts;
- a proposed solution requires an LLM, web search, or Agent connection for the
  ordinary local-paper path;
- a method can be recognized but its authoritative input/output or execution
  contract is unknown and implementation would require guessing;
- preserving exact evidence/page location would require discarding or rewriting
  the source text without a provenance-preserving replacement;
- the change starts duplicating `WorkflowAssessment` logic in Paper-specific UI
  or server code;
- a source PDF's redistribution/license status is uncertain and a test would
  require committing it;
- cancellation cannot reliably terminate Poppler/Tesseract child processes on a
  supported platform;
- the implementation needs to change Graph or execution semantics rather than
  the paper-intake boundary;
- any verification command fails twice after one focused correction;
- completing a step requires modifying a file outside Scope.

## Maintenance notes

- Treat the corpus manifest and gold annotations as versioned product assets.
  A recognizer improvement that changes expected topology requires explicit
  annotation review, not automatic snapshot replacement.
- Recognition aliases are human/evidence metadata; keep them excluded from
  execution-semantic Operator revisions. Typed ports, argv, outputs, packages,
  and resource behavior remain revision-bearing.
- Cache keys must include extractor/recognizer versions and Catalog digest.
  Never reuse an old reconstruction merely because the PDF digest matches.
- Progress is a domain fact, not simulated UI. If the backend cannot measure a
  stage, show an indeterminate active state rather than fabricated percentages.
- Reviewers should scrutinize stale-response handling, child-process cleanup,
  path containment, upload limits, evidence retention, and false executability.
- A future cleanup/migration can offer explicit deletion of superseded legacy
  uploads. Do not silently remove user project files during this plan.
