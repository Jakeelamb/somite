# Nextflow execution-identity spike

This is an isolated architecture spike, not production Somite code. It asks one
bounded question: can Somite preserve pinned nf-core module behavior while
Nextflow owns scheduling and Pixi supplies the runtime?

The harness downloads exact nf-core `FASTP` and `FASTQC` sources at the commit
recorded in `upstream.json`, verifies every source and fixture checksum, and
runs the original module files as a paired-read `FASTP -> FASTQC` workflow.
Nothing fetched or generated is tracked.

`node-map.json` is the stable mapping between Somite node IDs, generated
Nextflow aliases, and immutable upstream process sources.

Run:

```bash
/home/jake/.pixi/bin/pixi run \
  --manifest-path spikes/nextflow-identity/pixi.toml \
  --locked verify
```

The verification first runs the two exact upstream nf-test files, then performs
a fresh workflow run, a resumed run, and a same-path input mutation run. It
checks exact per-node trace states, input and output digests, deliberate FASTP
failure and recovery, and bounded cancellation with child cleanup. It writes
transient JUnit, timing, trace, report, work-directory, and result evidence
under `.work/`. After the upstream tests have passed once, repeat only the
mechanics with `SOMITE_SKIP_NF_TEST=1` before the command above.

Passing this harness proves only the tested paired-end path on Linux x86-64. It
does not prove that arbitrary nf-core modules can be compiled into Somite's
file-port model, that Pixi environments transport to remote executors, or that
the module outputs are biologically appropriate. The hand-authored DSL2 harness
also does not prove Somite Graph-to-DSL2 compilation or server run-handle
cancellation.
