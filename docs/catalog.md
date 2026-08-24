# Axial catalog

Not a boutique. Not a Galaxy shed we maintain. **Examples + a generator.** Users wrap the tools they already run. Stars below are demand signal for *examples*, not a porting queue. See [operator-contract.md](./operator-contract.md).

Proof that agents can compile when the format exists: Jake's agent on HoX, `nf-core/rnaseq 3.26.0 (HoX-native)`, `hox-nfcore.adapter: bulk-rna-v1`. Axial's job is the wrap path, not to hand-build `bulk-rna-v1` for every pipeline.

---

## Tiers

### Tier 0 — v0.1-cli (must cook without a window)

| id | Kind | Why |
|---|---|---|
| `files.import` | in-process | Source. Path relative to the graph file → CAS. |
| `sra.prefetch` | brick | NCBI data plane. Always `-O`. |
| `sra.fasterq_dump` | brick | `--split-3`. Optional r2 / unpaired. |
| `qc.fastqc` | brick | Wedge inspect. Glob `per_base_quality.png` → `Preview`. |

Acceptance: fixture FASTQ → FastQC PNG in CAS; second cook skips. Live SRA optional.

### Tier 1 — wrap generator (this is the catalog)

`axial ops wrap`. Shipped JSON is **copy-paste for the generator**, not a porting queue.

| id | Snap | Why it is an example |
|---|---|---|
| `qc.fastp` | `FastqGz → FastqGz` | Typical CLI, optional r2 |
| `sheet.build` | `FastqGz → Table` | Hostile I/O. Adapter, not a boutique module |
| `align.star` | `FastqGz + Fasta → Bam` | Heavy binary, still JSON + staging |
| `quant.salmon` | `FastqGz + index → Table` | |
| `samtools.index` | `Bam → Bai` | Tiny glob |
| `class.kraken2` | `FastqGz + db → Table` | |

`hisat2`, `spades`, a lab Python script: wrap it. Do not wait for a tier.

### Tier 2 — nf-core demand signal, not a port list

rnaseq 1356★, sarek 594, scrnaseq 350, mag 316, ampliseq 257, taxprofiler 192, …

User paths: wrap modules as bricks, or `nextflow run` as a `Directory` compound, or agent-compile a small graph (the HoX `bulk-rna-v1` move). Axial ships **none** of those as a tasteful native app. An in-tree compile is a fixture for `ops wrap`.

`fetchngs` is not ingest. Use SRA bricks.

### Tier 3 — never Axial's job

- Galaxy tool shed we host
- HoX boutique of eight optimized natives
- Every nf-core module mirrored
- HPC executor wrappers
- A second canvas

---

## Shared binaries (why wrap-once still pays)

The same CLIs sit under many pipelines: fastqc, fastp, samtools, star, salmon, bwa, kraken2, spades. Wrap as bricks. A user who hates Nextflow snaps FASTQ → fastp → STAR → Salmon. A user who wants the gold DAG wraps `nextflow run`. Both legal. Neither requires Jake to tastefully optimize salmon.

---

## Metagenomics (two questions, user wraps both)

taxprofiler = what's in the soup (`FastqGz → Table`). mag = recover genomes (`FastqGz → Fasta` bins). ampliseq = 16S, not shotgun. Do not collapse them. Do not native-port them.

---

## Version pins

Cook key includes the resolved operator schema. The schema MUST pin `nf-core/<name>` **version**. A pipeline bump is a new operator `version:` and a new cook. Do not hash the Nextflow binary (same lie as prefetch: distro rebuilds must not bust the cache). Optional `tool_version` probe is session-cached, not in the key (design Decision 21).
