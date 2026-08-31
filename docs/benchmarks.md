# Benchmarks and performance claims

Somite separates portable outcome checks from host-specific performance trends.
A benchmark result is useful only when its workload still produces the reviewed
scientific and product outcome. Faster output with a changed semantic digest is
a failed run, not an optimization.

## Commands and lanes

Run the quick suite during development and in ordinary deterministic CI:

```bash
npm run benchmark:quick
```

The quick suite uses fixed, local fixtures and no live sources. It records wall
time, CPU time, peak resident memory, output size, and case-specific stage
timings, but its portable gate is the adjudicated outcome: every assertion must
pass and the semantic digest must remain unchanged. Timing from a laptop and a
hosted CI runner must not be compared.

Run the release suite only on a stable, identified host:

```bash
npm run benchmark:release
```

The release lane covers the slower host-trend workload. It can cross production
processes and pinned external tools, so it may be expensive and network- or
cache-sensitive. Preserve its JSON report as trend evidence, but compare it only
with a report from the same performance series and an identical workload.
Release benchmark timing is not a substitute for the release smoke tests.

Compare two reports explicitly:

```bash
npm run benchmark:compare -- <baseline-report.json> <candidate-report.json>
```

The first path is the accepted baseline and the second is the candidate. The
comparison fails closed when the suite, host series, case set, case kind, or
workload digest differs. Do not edit a report to make two runs comparable. Start
a new series or establish a new reviewed baseline instead.

When a pull request intentionally changes dependencies, fixtures, sampling, or
the benchmark contract, a maintainer may apply the
`benchmark-series-reset` label. CI then requires both candidate runs to pass and
requires the trusted baseline comparator to confirm that the series really did
change; the label fails if the reports remain comparable or the hosts differ.
The next `main` receipt becomes the new baseline. The first pull request that
introduces benchmarking is handled as an explicit bootstrap and never compared
against a base revision with no benchmark task.

CI adds `--report-only` to keep noisy timing deltas informational. That mode
still fails when comparability or semantic quality changes; it only declines to
gate wall, CPU, and RSS trends.

The pull-request job measures base/candidate/candidate/base in identical,
resource-bounded Node containers. Each measured checkout is the container's
only repository mount, so candidate benchmark code cannot read or rewrite the
baseline checkout. The trusted baseline checkout performs both comparisons.
This isolates the evidence source while retaining same-host paired timing; it
does not turn a shared hosted runner into a stable long-term performance host.

Capture a CPU or sampled-heap profile for one exact quick-suite case outside
the timed repetitions:

```bash
npm run profile:cpu -- source.index_8k
npm run profile:heap -- canvas.wide_deep_5k
```

Profiles are written under `output/profiles/`, are never committed, and are not
benchmark receipts. Each profile has a JSON sidecar binding it to the revision,
dirty state, lockfile, benchmark contract, host, passing outcome digest, and
profile content digest. Inspector sampling begins only around the case's primary
product operations after module loading and synthetic-fixture preparation, and
stops before adjudication and semantic hashing. Use it to locate work after a
repeatable baseline proves which case regressed.

Before a release, independently prove that the committed source archive can be
installed, built, and launched:

```bash
npm run proof:source
```

`proof:source` archives `HEAD`, extracts it into a private temporary directory,
enforces the strict source-size contract, runs `npm ci`, builds the product, and
exercises the production launcher. It writes a bounded phase receipt under
`output/benchmarks/` and removes the temporary checkout. Because it archives
`HEAD`, it does not include uncommitted changes; record the reported source
commit with the release evidence.

This is a clean-source reproducibility proof, not a benchmark and not a claim
that a real workflow executed. Source outlines remain inspectable,
non-executable evidence. Real Pixi and Nextflow execution is proved separately
by the release smoke path.

## Current workloads

The quick suite keeps one synthetic scale per hot boundary and one reviewed
scientific corpus:

| Case | Shape | Warmups / samples | Required outcome |
| --- | --- | ---: | --- |
| `workflow.graph_wide_10k` | 10,000 independent Nodes | 1 / 5 | Valid graph and stable complete topological order |
| `canvas.wide_deep_5k` | 5,000 calls, then 5,000 nested groups | 1 / 5 | Stable entities, focus, and breadcrumbs |
| `source.index_8k` | 8,000 Nextflow process declarations | 1 / 5 | Complete source outline without invented calls |
| `compiler.linear_1k` | 1,000 typed fastp stages | 1 / 3 | Complete Node map, final process, and Pixi package |
| `paper.gold_text` | 15 adjudicated method excerpts | 1 / 3 | Outcomes, assays, methods, topology, evidence, and graph validity |

The release trend runs the production build, records the bounded client bundle,
drives the production browser journeys, and exercises the real Pixi/Nextflow
release smoke once each. These are deliberately not PR timing gates.

## What a report contains

Reports use schema version 1 and are bounded JSON. The top-level provenance is:

```json
{
  "schema_version": 1,
  "suite": "quick",
  "revision": "<git revision>",
  "dirty": false,
  "lockfile_digest": "sha256:<digest>",
  "started_at": "<ISO-8601 timestamp>",
  "completed_at": "<ISO-8601 timestamp>",
  "environment": {
    "series_key": "<host-series identity>",
    "hostname_digest": "sha256:<digest>",
    "platform": "linux",
    "architecture": "x64",
    "cpu_model": "<CPU model>",
    "logical_cpus": 16,
    "node": "22.x",
    "locale": "en-US",
    "timezone": "UTC",
    "toolchain": {
      "pixi": null,
      "nextflow": null
    }
  },
  "cases": []
}
```

Each case records whether it is deterministic or a host trend, an exact workload
digest, warmup and repetition counts, raw samples, a recomputed summary, and the
quality result:

Quick samples run in fresh Node processes. The reported warmup is an untimed
process-isolated cache-primer; it does not claim to preserve V8 JIT or
module-local state for the measured process.

```json
{
  "id": "workflow.graph_wide_10k",
  "kind": "deterministic",
  "workload_digest": "sha256:<digest>",
  "warmups": 1,
  "repetitions": 5,
  "samples": [{
    "wall_ms": 100.0,
    "cpu_user_ms": 90.0,
    "cpu_system_ms": 5.0,
    "peak_rss_bytes": 134217728,
    "output_bytes": 120001,
    "stages_ms": {
      "validate": 40.0,
      "topological_order": 55.0
    }
  }],
  "summary": {
    "median_wall_ms": 100.0,
    "max_wall_ms": 110.0,
    "median_cpu_ms": 95.0,
    "max_peak_rss_bytes": 134217728,
    "median_output_bytes": 120001
  },
  "quality": {
    "passed": true,
    "assertions_passed": 3,
    "assertions_total": 3,
    "semantic_digest": "sha256:<digest>"
  }
}
```

Metrics have one meaning across suites:

- `wall_ms` is elapsed time for one measured case body, including fixture
  construction performed inside that body. Named stages isolate the core work.
- `cpu_user_ms` and `cpu_system_ms` are process CPU time when the host exposes it.
- `peak_rss_bytes` is the child process's lifetime peak resident memory in bytes,
  including module loading and fixtures. Compare it only within the same host
  series and measurement method. GNU `time` supplies release-command RSS; for
  browser, npm, Java, Pixi, and Nextflow trees this is not a sum of every
  simultaneously resident descendant.
- `output_bytes` is case-defined: serialized semantic output for quick cases,
  client bytes for the bundle case, and bounded process output for multi-process
  release journeys. It is not a throughput estimate.
- `stages_ms` separates named work inside a case so a regression can be located.
- The summary contains median and maximum wall time, median combined CPU time,
  maximum peak RSS, and median output bytes. The parser recomputes the summary
  from raw samples rather than trusting supplied aggregates.
- `quality` is the reviewed outcome contract. Quick cases digest their complete
  deterministic semantic result; browser and toolchain cases digest stable TAP
  outcomes, and the real-toolchain outcome also binds the exact managed Pixi
  lock digest used for Nextflow execution; build and bundle cases prove their
  command and absolute size contracts. Timings, paths, timestamps, and
  incidental run IDs do not belong in it.

The repository's tracked-source and client-bundle budgets remain separate hard
size limits under `npm run check:size`. Benchmark output size helps explain a
change but does not replace those release limits.

## Comparison and regression policy

Performance comparisons are valid only when all of the following are true:

1. Both reports use the same suite and schema.
2. `environment.series_key` is identical. Its identity includes a hashed host,
   platform, architecture, CPU model, logical CPU count, Node runtime, locale,
   timezone, and the measured Pixi/Nextflow versions for the release lane. A
   virtual-machine or runner-image change starts a new series.
3. The case sets and case kinds are identical.
4. The combined package and Pixi lock digest is identical, and every case has
   the same `workload_digest`. Task flags, fixtures, scorers, warmups, or
   repetition changes require a new workload or baseline; they must not be
   hidden inside a comparison.
5. Cache state matches the case definition. Cold and warm runs are different
   workloads even on the same machine.

Quality is a hard gate before performance is considered. The candidate fails if
any assertion fails, if fewer assertions pass than were adjudicated, or if the
semantic digest differs from the baseline. Do not waive quality because a case
became faster.

For otherwise comparable reports, the current automatic regression thresholds
are deliberately coarse:

- Median wall time and median CPU time regress only when the candidate is both
  more than 25 percent slower and more than 10 milliseconds slower.
- Each named deterministic product stage uses the same 25 percent and 10
  millisecond median threshold, so fixture or scorer overhead cannot hide a hot
  path regression.
- Peak RSS regresses only when the candidate is both more than 15 percent larger
  and more than 16 MiB larger.
- Maximum wall time and output bytes are retained for diagnosis and trend review but
  do not currently trigger an automatic regression by themselves.

A threshold breach should be reproduced on the same host before an optimization
claim or rollback decision. Conversely, a change below the automatic threshold
is not proof of improvement. Report the raw samples, absolute delta, relative
delta, workload digest, and quality result.

Never compare timings across developer machines, GitHub runner types, CPU
models, Node versions, Pixi or Nextflow versions, or materially different cache
states. Those results can each form useful trends, but they are separate series.
The weekly GitHub-hosted workflow therefore retains outcome and release
snapshots without claiming a week-over-week performance trend; its ephemeral
hostnames intentionally start separate series. Continuous performance deltas
come from the paired base/candidate job or repeated runs on one stable host.

## Live unseen checks are not benchmarks

`npm run challenge:live` deliberately selects a recent paper and nf-core release
that are absent from its novelty ledger. Network latency, source size, upstream
content, and scientific difficulty change from run to run. This is valuable
compatibility evidence, but it is not a stable performance workload and must
never be promoted into a baseline automatically.

Keep live unseen reports separate from `benchmark:quick`, `benchmark:release`,
and `benchmark:compare`. Only a reviewed, pinned, versioned fixture with an
explicit scorer may enter the benchmark corpus. Updating the fixture or scorer
changes the workload digest and requires a new reviewed baseline.

## Profile, measure, optimize

Use this loop for performance work:

1. **Prove the outcome.** Run the relevant semantic tests. Do not optimize an
   unproven result.
2. **Measure a baseline.** Run the appropriate benchmark lane on the intended
   host, preserve its JSON report, and record whether the checkout is dirty and
   whether the workload is cold or warm.
3. **Profile the measured case.** Capture CPU or heap evidence for the specific
   case outside its timed repetitions. Profiling overhead must not be presented
   as benchmark timing.
4. **Change one owned bottleneck.** Prefer an algorithmic or allocation fix at
   the measured boundary. Avoid broad refactors that make attribution
   impossible.
5. **Rerun the identical workload.** Produce a candidate report on the same host
   and compare it with `npm run benchmark:compare -- <baseline> <candidate>`.
6. **Recheck quality and product gates.** The semantic digest and every reviewed
   assertion must still pass, followed by the relevant unit, browser, size, and
   release-smoke gates. For release or packaging work, run `npm run proof:source`
   against the committed target and retain its receipt.
7. **State only supported claims.** Report the case, host series, fixture,
   repetitions, median and maximum wall time, peak RSS, output size, and quality
   result. If noise or workload drift prevents a comparison, say so and start a
   new series instead of manufacturing a speedup.
