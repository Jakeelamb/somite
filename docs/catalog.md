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
| `ncbi.datasets_assembly` | brick | GCA/GCF → genome and annotation package. |
| `ensembl.sequence` | brick | Ensembl stable ID → inferred genomic/cDNA/protein FASTA. |
| `qc.fastqc` | brick | Wedge inspect. Glob `per_base_quality.png` → `Preview`. |

Acceptance: fixture FASTQ → FastQC PNG in CAS; second cook skips. Live SRA optional.

The Sources launcher accepts exact accessions immediately and also searches
NCBI SRA, NCBI reference assemblies, and Ensembl from ordinary terms such as
`human`, `mouse RNA-seq`, or `human BRCA2`. Suggestions identify their provider
and artifact role (`Reads`, `Genome`, `Reference`, `Gene`) before creating the
same explicit source nodes listed above. Provider calls are independent and
short-lived; a slow Ensembl response must not block available NCBI results.

### Tier 1 — wrap generator (this is the catalog)

`axial ops wrap`. Shipped JSON is **copy-paste for the generator**, not a porting queue.

| id | Snap | Why it is an example |
|---|---|---|
| `qc.fastp` | `r1 + r2? → trimmed r1 + r2?` | Paired mates remain separate; single-end remains valid |
| `sheet.build` | `FastqGz → Table` | Hostile I/O. Adapter, not a boutique module |
| `align.star` | `r1 + r2? + genome → Bam` | Heavy binary, still JSON + staging |
| `quant.salmon` | `r1 + r2? + index → Table` | Selects paired or single CLI form from the bound ports |
| `samtools.index` | `Bam → Bai` | Tiny glob |
| `class.kraken2` | `r1 + r2? + db → Table` | Adds `--paired` only when r2 is bound |

`hisat2`, `spades`, a lab Python script: wrap it. Do not wait for a tier.

### Tier 2 — nf-core workflow references, not native ports

The canvas may discover every released, non-archived pipeline from nf-core's
official catalog. Dropping one asks Nextflow for its process graph and expands
that graph into movable, connectable `workflow.reference` nodes. This exposes
the pipeline's structure without claiming that every process has been converted
into an independently executable Axial brick. The selected release is pinned in
the reference metadata.

Read-consuming boundary processes expose separate typed `r1` and optional `r2`
inputs when the engine graph establishes that boundary. Internal reference
nodes keep conservative structural ports, so an imported FASTQ cannot be wired
arbitrarily into the middle of a pipeline. Checked-in `nf.*` adapters remain
available to execution and paper tooling, but a catalog drop expands the
catalog's selected workflow rather than collapsing it into that adapter.

rnaseq 1356★, sarek 594, scrnaseq 350, mag 316, ampliseq 257, taxprofiler 192, …

User paths: replace reference nodes with wrapped bricks, run the original
workflow as a compound boundary, or agent-compile a small native graph (the HoX
`bulk-rna-v1` move). Reference expansion is a transparency and editing surface;
standalone execution still requires explicit promotion to native operators.

`fetchngs` is not ingest. Use SRA bricks.

### Tier 2b — Snakemake projects

`files.import_directory → smk.workflow` is the native local-project boundary.
The Library accepts a project containing `Snakefile` or `workflow/Snakefile`,
stages it as a writable copy, and invokes `snakemake --directory <copy>` with
explicit cores and execution flags. The completed project returns as a typed
`Directory`; the original and CAS copy remain unchanged.

The Library also searches the Snakemake Workflow Catalog. When a released
catalog entry has a graph-ready rulegraph, dropping it expands that engine graph
into editable `workflow.reference` nodes. Repositories retain their own
configuration, targets, licenses, and output conventions, so this structural
view is not presented as a uniform typed execution API. Local execution remains
the explicit `files.import_directory → smk.workflow` boundary above.

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
