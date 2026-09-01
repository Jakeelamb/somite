# Somite catalog

Somite has one Library with three evidence-backed entry points: data Sources,
typed Tools, and imported Pipeline structure. They all create the same Graph;
they do not create separate execution modes.

See [the operator contract](operator-contract.md) for the executable boundary.

## Data Sources

The source launcher searches NCBI SRA, NCBI assemblies, and Ensembl, and also
accepts exact accessions or local paths. A suggestion identifies its provider
and artifact role before it creates a visible source Node. Exact SRA runs wait
for NCBI's declared single- or paired-end layout; Somite never infers layout
from the accession string.

Examples:

| Operator | Interface |
|---|---|
| `files.import` | local file to one typed artifact |
| `files.import_paired` | separate local R1 and R2 artifacts |
| `files.import_fastq_gz` | one local gzip-compressed FASTQ retained as `FastqGz` |
| `files.import_paired_gz` | separate gzip-compressed R1 and R2 artifacts retained as `FastqGz` |
| `files.import_bam` | one local BAM retained as a typed `Bam` artifact |
| `files.import_multiqc_reports` | one existing report directory explicitly typed for MultiQC scanning |
| `sra.prefetch` | SRA accession to an SRA artifact |
| `sra.fasterq_dump` | paired-end SRA artifact to required R1 and R2 FASTQ streams |
| `sra.fasterq_dump_single` | single-end SRA artifact to one FASTQ stream |
| `ncbi.datasets_assembly` | GCA or GCF accession to an assembly package |
| `ncbi.datasets_extract_assembly` | NCBI package to typed genome FASTA, optional GFF3/GTF, and metadata |
| `ensembl.sequence` | stable Ensembl ID to FASTA |

Provider discovery and data transfer remain separate. Search metadata never
pretends that a remote dataset has already been downloaded or validated.
Local compressed reads stay compressed on import so gzip-aware tools can use
them directly. Starting a connection from a `FastqGz` port offers the visible
decompression adapter when a downstream tool, such as STAR, requires plain
FASTQ; Somite does not disguise decompression inside that tool.

## Typed Tools

Checked-in Operators are curated examples and immediately usable contracts,
not a promise that Somite manually maintains every bioinformatics package.

| Operator | Interface |
|---|---|
| `qc.fastp` | R1 plus optional R2 to trimmed R1 plus optional R2 |
| `qc.fastqc` | FASTQ to HTML plus optional preview |
| `archive.gunzip_fastq` | gzip-compressed FASTQ to plain FASTQ |
| `align.star` | reads plus reference to BAM |
| `align.bwa` | reads plus reference to BAM |
| `align.bowtie2_build` | reference FASTA to a reusable Bowtie2 index directory |
| `align.bowtie2` | reads plus Bowtie2 index to SAM |
| `ref.samtools_faidx` | reference FASTA to its typed FAI sidecar |
| `ref.gatk_sequence_dictionary` | reference FASTA to its typed sequence dictionary |
| `align.gatk_add_read_groups` | BAM plus explicit sample/library identity to read-grouped BAM |
| `align.samtools_sort_gatk` | read-grouped BAM to coordinate-sorted GATK-ready BAM |
| `align.samtools_index` | GATK-ready BAM to BAI |
| `align.picard_mark_duplicates` | coordinate-sorted BAM to duplicate-marked BAM plus Picard metrics |
| `var.haplotypecaller` | GATK-ready BAM, BAI, reference FASTA, FAI, and dictionary to VCF |
| `qc.multiqc` | one reviewed analysis-report directory to HTML report plus parsed-data directory |
| `quant.kallisto_index` | transcript FASTA to a reusable Kallisto transcriptome index directory |
| `quant.kallisto` | paired reads plus Kallisto index to abundance table and run metadata |
| `quant.kallisto_single` | single-end reads plus fragment distribution and Kallisto index to abundance table and run metadata |
| `quant.salmon` | reads plus index to abundance table |
| `class.kraken2` | reads plus a required local Kraken2 database directory to a classification table |

`Bam`, `ReadGroupedBam`, and `GatkReadyBam` are distinct channel types.
A generic or merely sorted BAM cannot satisfy HaplotypeCaller: the visible
read-group, coordinate-sort, and index nodes must produce the exact artifacts,
and paper drafts leave sample identity values unresolved rather than inventing
them. The bundled read-group operator is deliberately single-sample because
Picard replaces existing read groups wholesale; multiplexed BAMs need a more
specific preparation contract. Picard MarkDuplicates also requires the
`coordinate-sorted-bam` profile: STAR's sorted output provides it directly,
while a generic or imported BAM must pass through the visible SAMtools sort
node first.

MultiQC scans a directory, not one arbitrary HTML file. Its profiled input
therefore accepts the reviewed existing-report-directory source and cannot be
silently wired to an unrelated tool index directory. Somite's current scalar
graph can aggregate one directory tree; gathering independent report channels
from many upstream Nodes remains an explicit collection-contract gap.

Kallisto indexing is separate from quantification because the index is a real
reusable artifact built from transcript sequences, not a genomic assembly.
Paired-end quantification lets Kallisto estimate fragment length from the read
pair. The single-end Operator separately requires the measured mean and
standard deviation instead of inventing them.

The scalable catalog path is the Project tools Operator Workshop:

1. inspect a binary's `--help`, package recipe, and trusted workflow uses;
2. propose typed ports, parameters, argv tokens, outputs, and Pixi packages;
3. run a tiny fixture in an isolated Pixi environment;
4. inspect artifacts and record the evidence receipt; and
5. let the user accept the proven candidate into `.somite/operators/`.

The automated fixture packs cover reviewed local FASTQ, FASTA, BAM, GTF, and GFF3
roots plus exact SRA, NCBI assembly, and Ensembl retrieval shapes. Public
retrieval is bypassed and remains inconclusive while downstream tools run on
typed local fixtures. Fixture-only parameter changes are part of the evidence
configuration and shown to the user. This is deliberately not a universal
biological test corpus: unknown source shapes fail closed until a reviewed
binding policy is added.

Agents can perform steps 1 through 4 through the bounded Somite, Pixi, and
Nextflow MCP surfaces. Acceptance is human-only. A package name, inferred argv,
or generated guess alone never passes step 5. Checked-in `operators/` remains
the reviewed distribution catalog; a project-local contract never silently
changes another project or a built-in revision.

## nf-core Pipeline catalog

The Pipeline panel searches released nf-core workflows. Dropping one resolves
its selected revision to an immutable Git commit, verifies the complete tracked
source tree, and inserts one `workflow.source` Node. The outer card contains a
live miniature of the source-anchored outline. Cursor-centered zoom grows that
preview until the same persistent canvas rebases into every indexed invocation
call and known relationship; zooming out performs the exact inverse. No second
canvas, alternate toolbar, breadcrumb strip, or open button is introduced.
Workflow, subworkflow, and process scopes remain quiet provenance and may offer
grouping suggestions, but accepting one performs the same explicit, undoable
action as grouping any other user selection.

An expanded Source group is a soft hull overlay; it does not shrink its members
or turn them into child Nodes. A collapsed group is a non-executable Macro with
a live child preview whose proxy relationships retain their exact underlying
member endpoints. Soft hulls and Macros are recursive Semantic portals: when
one fills the viewport, its members become the active level of detail without
replacing the canvas. Moving members out, moving them back, renesting, and
ungrouping are lossless presentation changes. Arbitrarily deep membership
persists with the document but does not change source, execution, or evidence
identity.

Dashed Source-structure relationships are nonconnectable and never typed
dataflow. Each indexed invocation appears once; unresolved calls remain
explicit, and shared or cyclic scope metadata never duplicates a call. The
outline is an inspection and editing lens, not a process DAG. Nextflow channel
transforms, composite values, conditions, and task environments remain in the
exact source unless Somite has their complete structured contract. DOT output
is never used as execution truth.

The first supported source-backed form is a whole-root workflow with no
fabricated ports or Edges. Required public parameters come from the workflow's
own schema and appear as bindings in the inspector. Mixed native/source
composition waits for a complete callable channel interface.

A catalog-pinned invocation replacement is editable intent inside this Source
view. Promoting it crosses an explicit boundary into a normal native Graph. The
promoted Node gets the selected Operator's exact ports, parameters, revision,
Nextflow compilation, and Pixi requirements; Somite does not infer neighboring
channels. The original Source Node and invocation mapping remain attached only
as provenance and never execute underneath the native Graph. Returning to the
pinned Source view is an explicit restore operation.

Readiness remains blocked until every required binding and the source-defined
task environment are frozen. Existing DOT-based `workflow.reference` imports
remain visible and blocked; Somite never silently promotes them because their
original source cannot be recovered from process labels.

Somite never nests `nextflow run nf-core/<pipeline>` as an opaque canvas node.

## Snakemake Workflow catalog

The Pipeline panel also searches the Snakemake Workflow Catalog. When a
revision exposes a usable rule graph, Somite imports its rules and dependencies
as structural references.

Snakemake is an evidence and testing ecosystem, not a second production engine.
Its fixtures can help audit typed Operators. Generated production workflows do
not invoke `snakemake`.

## Local Snakemake workflows

The Pipeline panel can also open a local project directory, `Snakefile`, or
`.smk` entrypoint. Somite locates `workflow/Snakefile` before a root
`Snakefile`, uses the project's declared Pixi environment when present, and
asks Snakemake for an engine-authored `--rulegraph`. Optional target rule names
select independent branches. This is a read-only preview: no workflow jobs run.

Each rule becomes a structural reference node. Fan-in rules receive one stable
scalar input port per dependency, and FASTQ-facing boundary rules expose
separate R1 and R2 inputs. The import records the source path plus the current
Git revision and visibly marks a dirty worktree. Custom graph launches use a
graph-scoped autosave, so previewing a workflow cannot recover or overwrite an
unrelated canvas autosave.

The TypeScript runner exposes this same import through
`POST /api/workflows/snakemake/import`; the browser does not maintain a second
import implementation.

## Version and provenance rules

- Imported workflows record the selected upstream revision.
- Source-backed modules must pin source content and revision.
- Tool package constraints enter the generated Pixi manifest.
- The first successful Pixi resolution creates the lockfile that freezes exact
  builds.
- The node source map records every visible Node, every edge, and every emitted
  Nextflow process identity.

## Explicit non-goals

Somite is not a hosted Galaxy ToolShed, a mirror of every nf-core module, or a
second package repository. It supplies a strict contract, a compiler, audit
fixtures, and a community contribution path so useful tools can be added
without hand-editing the application.
