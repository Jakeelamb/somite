# Source-workflow import profile — 2026-08-28

## Evidence boundaries and identities

The workload is the real pinned `nf-core/pangenome` 1.1.3 source tree driven
through Somite's release-mode load, index, parameter-edit, and freeze pipeline.
Raw source-example `perf`, Heaptrack, and timing artifacts are retained locally
under the ignored `.somite/perf/source-workflow/` directory. Historical server
profiler recordings were not retained; only their summarized observations
remain. Only the `final-v6-bounded` source and server artifacts named below
represent the final current tree; aborted v5 recordings are explicitly
nonfinal.

The original optimization rounds profiled the historical v2 derived read model.
They preserved these two identities:

- full serialized workflow: `blake3:2e5e3d3baa2a3a82975ef27052621d4a1be659e752cfaf6e38a3450eecf59e12`
- freeze-plan digest: `blake3:353c21a201d1463190f8dc93ce17fd4d2a668ce8c8f3b8aa1393ad93eef04b3e`

Later fail-closed schema, provenance, resource-bound, and numeric-transport
corrections intentionally changed the contract. The final source indexer
revision is v6, captured on 2026-08-29, and the final current identities are:

- requested revision: `1.1.3`
- canonical commit: `3d02bd1df79f48b4bfdb4ad95d4ca0d7f6aeb337`
- source digest: `blake3:4b8e157a3fbd3009095b60e4d857fba2af999ffe29c21bd01bd8304aaa427442`
- source extent: 170 files and 1,286,324 bytes
- full serialized workflow: `blake3:bc8c4fd5a97e3ad9423c80c2588a8813b25bfec5f7072dae6125c225515cafc2`
- freeze-plan digest after the profiled parameter edit: `blake3:886190dff2d23836c11ade6a2d2c2e92b5662de0003768c48bcd60572cb096bb`

Both `HEAD^{commit}` and `1.1.3^{commit}` resolved to the canonical commit.
The release example, all five `perf stat` repetitions, the 100-iteration CPU
recording, and the final Heaptrack run reproduced the same freeze-plan digest.
The measured tree passed the explicit pinned-pangenome acceptance, workspace
strict all-target/all-feature Clippy, Rust formatting, and diff checks. Five
unprofiled server repetitions and the profiled server run also passed the exact
ignored production-workload test.

## Historical v2 source-example rounds

These measurements describe the historical v2 loader and must not be treated as
v4 or current-v6 timings or symbol shares.

| Measure | Baseline | Regex cache | Borrowed tokens | Final change |
|---|---:|---:|---:|---:|
| Allocations per pipeline | 27,965.5 | 23,497.5 | 18,531.5 | -33.7% |
| Peak heap (Heaptrack MB) | 2.06 | 2.06 | 1.96 | -4.9% |
| Other `index_nextflow` allocations, excluding the separately counted token-pair subset | 6,983 | 6,983 | 2,122 | -69.6% |
| Regex-family CPU self-share | 14.19% | 8.92% | 9.07% | -5.12 points |
| All Somite index CPU self-share | 5.05% | — | 3.74% | -1.31 points |

The baseline single-pipeline timing was `32.69 ± 1.96 ms`. Its CPU profile
reported BLAKE3 29.49%, Git 23.07%, regex 14.19%, indexing 5.05%, and JSON
2.33%.

Round 1 introduced a transaction-local compiled-regex cache at the measured
validation hot path. It reduced total allocations by 15.98%, temporary
allocations by 23.35%, edit-application allocations by 51.27%, regex CPU share
to 8.92%, task clock by 1.35%, cycles by 2.50%, and instructions by 7.16%.
The confirmation timing was `32.95 ± 1.65 ms`; that distribution overlaps the
baseline, so it is not a defensible standalone wall-time improvement.

Round 2 replaced owned token strings with borrowed source ranges and replaced
allocation-heavy token-pair maps with sorted vectors and binary lookup.
Relative to the regex-cache round:

- total allocations fell 21.1%, from 23,497.5 to 18,531.5 per pipeline;
- other `index_nextflow` allocations, excluding the separately counted
  token-pair subset, fell 69.6%, from 6,983 to 2,122;
- the token-pair subset fell 45.1%, from 233 to 128 allocations;
- `load_local` allocations fell 31.2%, from 15,910.6 to 10,944.6;
- peak heap fell to 1.96 Heaptrack MB and native peak RSS to 8,536 KiB;
- aggregate `perf stat` elapsed time fell 3.45%, task clock 3.48%, cycles
  4.54%, instructions 3.52%, and branches 5.70%.

Temporary allocations rose 3.9% in that final historical round, from 4,288.3
to 4,456.3 per pipeline. The larger reductions in the persistent load/index
path still lowered total allocations and peak memory. Single observations of
32.745 ms and 33.758 ms overlap the earlier distribution; no isolated
wall-clock speedup is claimed.

The historical final CPU profile reported Git 33.41%, BLAKE3 29.65%,
regex-family symbols 9.07%, and all Somite-owned index code 3.74%. Those are v2
shares, not v4 or current-v6 shares.

## Historical v4 environment-isolation evidence

### Secure Git environment isolation

The prior v4 Heaptrack evidence attributed 38,400 allocations across ten
pipelines to `std::env::vars_os`. Every Git spawn inherited and copied the
entire process environment. Clearing the child environment and rebuilding an
explicit allowlist produced this isolated same-tree A/B:

| Ten-pipeline Heaptrack measure | Before env clear | After env clear | Change |
|---|---:|---:|---:|
| Allocation calls | 273,678 | 210,498 | -63,180 (-23.09%) |
| Allocation calls per pipeline | 27,367.8 | 21,049.8 | -23.09% |
| `std::env::vars_os` allocation calls | 38,400 | 0 | -100% |
| Temporary allocations | 40,886 | 40,689 | -197 (-0.48%) |
| Exact peak live heap | 1,962,503 B | 1,962,503 B | unchanged |
| Peak RSS including Heaptrack (MB) | 11.62 | 11.57 | -0.05 MB |

That A/B predates the requested-ref provenance check and later resource bounds.
The last v4 tree performed one additional isolated Git ref resolution per import
and recorded
214,948 allocations across ten pipelines. Its raw-event peak remains exactly
1,962,503 bytes; `heaptrack_print` reports 40,747 temporary allocations and
11.64 MB peak RSS including profiler overhead. A `vars_os`-filtered analysis is
empty. `capture_env` accounts for 7,100 calls from copying the small explicit
safe environment into the isolated child commands, rather than copying the
inherited environment.

The pre-env-clear v4 CPU sample had BLAKE3 at 14.59%, SHA-1 at 8.42%,
distributed Git zlib work, `index_nextflow` at 2.37%, several regex compiler
symbols, and visible inherited-environment copying. The last v4 CPU sample
reported Git zlib 33.39%, BLAKE3 15.38%, SHA-1 8.59%, all named
`somite_source_workflow` symbols 5.03%, and `index_nextflow` 2.55%. These are
historical contract-specific shares, not a baseline for calculating a v6
speedup or regression.

The isolation remains in v6 and remains fail closed. Each Git child retains
`PATH` so the executable can be located and, on Windows, `SYSTEMROOT` for
process/DLL startup. Somite then sets its fixed safe Git environment and
configuration: user/system config, credentials, prompts, hooks/templates,
filters, replacement refs, fsmonitor, SSH, and external/file protocols remain
disabled. The portability tradeoff is deliberate: installations that require
locale, proxy, credential-helper, wrapper, dynamic-loader, or other ambient
variables for Git will fail rather than silently broaden the import boundary.

## Current v6 source-example evidence

V6 adds fail-closed derived-work bounds to the existing exact-source boundary:
1,000,000 indexed tokens; 25,000 scopes; 50,000 include bindings; 50,000
invocations; 25,000 diagnostics; 1,024-byte identifiers; a shared 32 MiB
derived-projection budget; bounded schema shape/string projection; and
single-pass lexical-scope ownership for invocation discovery. It also preserves
exact integer-versus-floating numeric transport. The pangenome fixture remains
well inside those limits.

### Allocation and memory evidence

The final ten-pipeline Heaptrack analysis reports:

| Measure | Final v6 |
|---|---:|
| Allocation calls | 216,238 |
| Allocation calls per pipeline | 21,623.8 |
| `std::env::vars_os` allocation calls | 0 |
| `capture_env` allocation calls | 7,100 |
| Temporary allocations (`heaptrack_print`) | 40,988 |
| Exact raw-event peak live heap | 1,962,503 B |
| Peak RSS including Heaptrack | 11.60 MB |

Heaptrack's online recorder reported 40,896 temporary allocations, while the
post-run analyzer reported 40,988; the total allocation count and exact raw
peak agree. The empty `vars_os` filter confirms that v6 retains the environment
isolation result.

### Wall and counter observations

Hyperfine used three warmups and 20 fresh-process runs, one pipeline per run:

- mean: 48.171 ms
- standard deviation: 3.160 ms
- median: 48.210 ms
- range: 41.366–53.120 ms
- mean user/system time: 26.991/25.845 ms

This is a current-host observation, not a cross-version speedup or regression
estimate. Filesystem cache, process scheduling, CPU frequency, child Git
activity, and the changed security/correctness contract make the historical v2
and v4 wall timings non-comparable.

`perf stat` used 25 internal iterations and five repetitions:

| Counter | Five-run reported value |
|---|---:|
| Task clock (user) | 1,282.70 ms ± 0.70% |
| Cycles | 1,609,729,237 ± 0.49% |
| Instructions | 2,436,904,962 ± 0.62% |
| Branches | 368,102,740 ± 0.40% |
| Branch misses | 12,863,733 ± 0.34% |
| Cache references | 71,420,788 ± 0.66% |
| Cache misses | 9,077,065 ± 0.77% |
| Elapsed | 1.202719839 ± 0.007585969 s (±0.63%) |

Hardware counters were multiplexed at 83.90–85.76%, so these values remain
profile context rather than exact cross-run deltas.

### CPU evidence

The final 100-iteration `cycles:u` recording contains 5,648 reportable samples,
zero lost, over 4,828.227 ms. Flat self-share groupings are:

| CPU grouping | Self-share |
|---|---:|
| Git `libz-ng.so.2.3.3`, distributed across symbols | 39.38% |
| BLAKE3 AVX-512 `hash_many` + `compress_in_place` | 15.63% |
| SHA-1 hardware digest blocks | 8.45% |
| Named regex/regex-syntax/Aho-Corasick symbols | 4.42% |
| All named `somite_source_workflow` symbols | 3.17% |
| `index_nextflow_with_limits` | 1.51% |
| `capture_env` | 0.07% |

No derived-bound helper appears as a distinct self-share hot symbol; inlining
can hide some check cost, so this is not a claim of zero overhead. Current
disassembly still exposes `_blake3_hash_many_avx512` and
`_blake3_compress_in_place_avx512` with ZMM vector instructions. The SHA-1 path
contains `sha1rnds4`, `sha1nexte`, `sha1msg1`, and `sha1msg2`. The hash work
already selects upstream AVX-512 and SHA-NI kernels.

### Final v6 source artifacts

All paths below are relative to `.somite/perf/source-workflow/` and remain
ignored. SHA-256 identifies each exact local recording:

| Artifact | SHA-256 |
|---|---|
| `identity-final-v6-bounded.txt` | `97064fd2eca8035cb8ea77fcae9bd8a736d839566808f6e2dfd92f73884a3e10` |
| `hyperfine-final-v6-bounded.json` | `6e3da1b765473899c31cfef02aa996600aacfbd779d0796ad3bae9a58783073d` |
| `perf-stat-final-v6-bounded.txt` | `81325e99a2a7646eb2b8e47a0bace176e9c88ce6ce429d621947a9476b14f0ce` |
| `perf-final-v6-bounded.data` | `58ab69c596baa9ec6a120d001e2aabd6b096416d7110c708bdaf099f1a3375a6` |
| `perf-report-final-v6-bounded.txt` | `bf67de49b5b35802e978b95fc9534d4956eed50ed8d3de874d85054373d0049f` |
| `heaptrack-final-v6-bounded.zst` | `caec51de88fddec953cff578081e5b8401041494d5873067efa4a4386287b958` |
| `heaptrack-final-v6-bounded.txt` | `bd0d36287323d366354457d21377f82c330f9adca455b67fb05a7ac9ed5f07be` |

The expanded pre/post guard covered production source-workflow and IR Rust,
the profile example, their package manifests, workspace manifest/lock, and the
server `lib.rs`, `agent.rs`, and package manifest. The guard manifests are
retained as `source-hash-pre-final-v6-bounded.txt` and
`source-hash-post-final-v6-bounded.txt`; both hash to
`e77939e53fccc092f1580482c323d2b7b45b0edff5f4ef559e2663d6cf961c89`.

## Server evidence

The release server acceptance boundary uses the same catalog-pinned source:

~~~console
cargo test --release -p somite-server --lib tests::profile_live_nfcore_pangenome_source_store_warm_path -- --ignored --exact --nocapture
~~~

### Historical v2 observations

The old server allocation totals were likely whole-test totals that included
cold import; the historical raw Heaptrack recording was not retained, so they
cannot now be isolated to the warm loops:

| Historical whole-test measure | Baseline | Optimized | Observed change |
|---|---:|---:|---:|
| Allocations | 1,917,555 | 1,130,308 | -41.1% |
| Temporary allocations | 514,926 | 280,929 | -45.4% |
| Peak heap (profiler-reported MB) | 12.70 | 12.70 | no change |
| Peak RSS including profiler (MB) | 25.56 | 25.71 | no improvement |

The historical CPU observation contained 2,218 samples with zero lost over
12.259 seconds. Its notable self shares were JSON string escaping 4.91%,
BLAKE3 `compress_in_place` 4.39% and `hash_many` 3.04%, `realloc` 2.58%,
stored-tree verification 2.46%, ordered-map insertion 2.12%, `malloc` 2.00%,
and the regex Thompson compiler 1.84%.

The summarized server timings were single observed aggregates, not
distributions:

| Historical aggregate | Baseline | Optimized |
|---|---:|---:|
| 100 verification + readiness rounds | 149 ms | 104 ms |
| 100 nominal reset + metadata-persistence rounds | 110 ms | 77 ms |
| Cold import | 11,992 ms | 8,461 ms |

The nominal reset loop was a no-op, so its row does not measure actual edit
cost. Cold import was dominated by variable network and Git cache state.
Neither row supports a durable speedup claim.

### Historical v4 alternating observations

The corrected server acceptance performs real alternating set/reset work. Two
separate v4 observations were retained as noisy totals:

| Historical v4 observation | Cold import | Warm100 | Set-reset100 |
|---|---:|---:|---:|
| First observation | 3,016 ms | 401 ms | 467 ms |
| Confirmation | 2,401 ms | 275 ms | 165 ms |

Both used commit `3d02bd1df79f48b4bfdb4ad95d4ca0d7f6aeb337`, source digest
`blake3:4b8e157a3fbd3009095b60e4d857fba2af999ffe29c21bd01bd8304aaa427442`,
and the 170-file/1,286,324-byte source extent. The variation is material. These
numbers confirm that the real warm and alternating edit paths complete; they
do not establish a stable latency distribution or a speedup over historical
v2. They are acceptance stdout observations, not retained raw server profiler
recordings.

### Current v6 repeated observations

The final release test was executed directly from the built test binary five
times so Cargo startup and compilation were outside the test's own phase
timers. Every run passed and reported the pinned source identity:

| V6 run | Cold import | Warm100 | Alternating set/reset100 |
|---|---:|---:|---:|
| 1 | 17,377 ms | 209 ms | 227 ms |
| 2 | 1,857 ms | 203 ms | 225 ms |
| 3 | 1,817 ms | 205 ms | 227 ms |
| 4 | 1,945 ms | 213 ms | 224 ms |
| 5 | 1,928 ms | 205 ms | 230 ms |

| Phase | Mean | Median | Range |
|---|---:|---:|---:|
| Cold import | 4,984.8 ms | 1,928 ms | 1,817–17,377 ms |
| Warm100 | 207.0 ms | 205 ms | 203–213 ms |
| Alternating set/reset100 | 226.6 ms | 227 ms | 224–230 ms |

The 9.6-fold cold range is dominated by external Git/network/cache state and
must not be mixed into warm-path latency claims. Warm and alternating-edit
observations are substantially tighter, but five current-host samples are
still acceptance evidence rather than an SLA distribution.

All five timing runs and the Heaptrack run used commit
`3d02bd1df79f48b4bfdb4ad95d4ca0d7f6aeb337`, source digest
`blake3:4b8e157a3fbd3009095b60e4d857fba2af999ffe29c21bd01bd8304aaa427442`,
and 170 files/1,286,324 bytes. The profiled run completed in 2,319/641/676 ms
for cold/warm100/alternating100; those profiler-inflated timings are excluded
from the five-run summary.

The Heaptrack recording covers the real whole test—cold import, 100 warm
verification/readiness rounds, 100 alternating edits, and test harness:

| Whole-test Heaptrack measure | Final v6 |
|---|---:|
| Allocation calls | 4,346,605 |
| Temporary allocations (`heaptrack_print`) | 860,906 |
| Exact raw-event peak live heap | 12,702,304 B |
| Peak RSS including Heaptrack | 27.82 MB |

Heaptrack's online recorder reported 824,859 temporary allocations; the
post-run analyzer reported 860,906. Allocation totals and the exact raw peak
agree. These are whole-test totals and cannot be assigned to an individual
phase from this trace alone.

The trace does identify a Somite-owned allocation target:
`PortableSourcePathRegistry` appears in stacks for 1,179,115 allocation calls,
27.13% of the whole-test total. `String::clone` accounts for 1,521,325 calls,
35.00% overall. A follow-up may therefore investigate borrowed or
operation-local reused path validation, but it must preserve manifest
normalization, collision detection, symlink safety, and verification on
untrusted persisted state.

Final server artifacts:

| Artifact | SHA-256 |
|---|---|
| `server-timings-final-v6-bounded.txt` | `b8aa7ca3a6b44a9a04c82ea0f2cb81bc529e3652efe3f0a481b7839ba71ef20b` |
| `server-timing-summary-final-v6-bounded.txt` | `54013be57df9bd14c407746a527fae24aab39aba23360da3b0e96fbdeefba529` |
| `heaptrack-server-final-v6-bounded.zst` | `c7aa22af2dffc52724ba9b78860ab09133b92d856f4cd9d0fd2f9cc06263f4df` |
| `heaptrack-server-final-v6-bounded.txt` | `5df0f083359ff24eac21d081ac5796eede1d9f581f4d19d4690fec7b990525a1` |
| `heaptrack-server-registry-final-v6-bounded.txt` | `17a02b1c011b0b31b72d18e4f9c8643088b0807f2ff7e5d2823b6aae8a4fd8c5` |

## Stop boundary

The final v6 source-example CPU evidence does not justify another indexer/source
refactor or handwritten assembly round. External Git zlib is 39.38%;
hardware-accelerated BLAKE3 and SHA-1 account for another 24.08%.
`index_nextflow_with_limits` is 1.51%, and all named Somite source-workflow
symbols total 3.17%. The new bound checks do not form a measured owned hot
kernel.

BLAKE3 already uses AVX-512 and SHA-1 already uses SHA-NI. Handwritten assembly
would duplicate optimized upstream kernels while external Git/library work
dominates, so assembly is not justified.

The server allocation trace does justify one future Rust refactor
investigation: `PortableSourcePathRegistry`-attributed cloning is 27.13% of
whole-test allocation calls. It is an allocation/data-ownership problem, not a
numeric or assembly kernel. No production change is made in this profiling
round; any follow-up must preserve the persisted-source trust boundary and
repeat the exact acceptance, Heaptrack, and identity gates.
