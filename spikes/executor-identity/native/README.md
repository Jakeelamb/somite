# Native executor identity spike

This isolated fixture is the native side of the executor-identity comparison.
It uses one visible Somite graph:

```text
Paired FASTQ -> fastp -> paired FastQC
```

FastQC is one visible node with explicit `r1` and `r2` inputs and separate
`report_r1` and `report_r2` outputs. The spike-local catalog contains only the
three contracts needed by this graph. Shared production operators are not used
or modified.

The two FASTQ mates contain two 52-base records apiece. The mutation fixture
changes one R2 nucleotide without changing the path or file size, making cache
identity failures deterministic.

Run the cold/cache baseline:

```bash
spikes/executor-identity/native/verify-native.sh
```

Run the adversarial audit:

```bash
spikes/executor-identity/native/audit-adversarial.sh
```

The audit checks same-path input mutation, a `threads` parameter change cone,
and invalid FASTQ failure followed by same-path input repair. It exits nonzero when the executor
violates an expected state transition. Cancellation is reported as blocked
until the native executor exposes a run handle or cancellation Interface.
