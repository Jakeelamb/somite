# Axial

Local node canvas for bioinformatics. Drag pieces. Wire them. See the output on the node. Save the graph. Send it.

**Snap:** every port has a type (`FastqGz`, `Bam`, `Table`, …). Illegal wires do not connect.

**Glue:** if two pieces almost fit, an agent writes a tiny adapter. You keep dragging.

```
cargo test -p axial-ir -p axial-ops -p axial-cook
cargo run -p axial-cli -- palette
cargo run -p axial-cli -- cook testdata/fastq_to_fastqc.axial.json
cargo run -p axial-cli -- paper testdata/papers/rnaseq_methods.txt
cargo run -p axial-app
# drop a PDF or methods .txt on the canvas to rebuild the pipeline the paper describes
```

Palette groups: **NCBI** (SRA, datasets), **Ensembl** (FASTA/GTF), **nf-core** (rnaseq, sarek, mag, taxprofiler), **QC** (FastQC, fastp).

Tools run via PATH or `conda run -n <env>` if the operator has a `conda` spec. See `axial env`.
