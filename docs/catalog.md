# Somite catalog

Somite has one Library with three evidence-backed entry points: data Sources,
typed Tools, and imported Pipeline structure. They all create the same Graph;
they do not create separate execution modes.

See [the operator contract](operator-contract.md) for the executable boundary.

## Data Sources

The source launcher searches NCBI SRA, NCBI assemblies, and Ensembl, and also
accepts exact accessions or local paths. A suggestion identifies its provider
and artifact role before it creates a visible source Node.

Examples:

| Operator | Interface |
|---|---|
| `files.import` | local file to one typed artifact |
| `files.import_paired` | separate local R1 and R2 artifacts |
| `sra.prefetch` | SRA accession to an SRA artifact |
| `sra.fasterq_dump` | SRA artifact to R1, optional R2, and optional unpaired reads |
| `ncbi.datasets_assembly` | GCA or GCF accession to an assembly package |
| `ensembl.sequence` | stable Ensembl ID to FASTA |

Provider discovery and data transfer remain separate. Search metadata never
pretends that a remote dataset has already been downloaded or validated.

## Typed Tools

Checked-in Operators are curated examples and immediately usable contracts,
not a promise that Somite manually maintains every bioinformatics package.

| Operator | Interface |
|---|---|
| `qc.fastp` | R1 plus optional R2 to trimmed R1 plus optional R2 |
| `qc.fastqc` | FASTQ to HTML plus optional preview |
| `align.star` | reads plus reference to BAM |
| `align.bwa` | reads plus reference to BAM |
| `align.bowtie2_build` | reference FASTA to a reusable Bowtie2 index directory |
| `align.bowtie2` | reads plus Bowtie2 index to SAM |
| `quant.salmon` | reads plus index to abundance table |
| `samtools.index` | BAM to BAI |
| `class.kraken2` | reads plus a required local Kraken2 database directory to a classification table |

The scalable catalog path is contract generation and audit:

1. inspect a binary's `--help`, package recipe, and trusted workflow uses;
2. propose typed ports, parameters, argv tokens, outputs, and Pixi packages;
3. run a tiny fixture in an isolated Pixi environment;
4. inspect artifacts and record the evidence receipt; and
5. review before promotion into `operators/`.

The first automated fixture pack covers local single- and paired-end FASTQ
graphs. It is deliberately not a universal biological test corpus: unsupported
source kinds remain unvalidated until a representative pack and binding policy
are added.

Agents can perform steps 1 through 4 in parallel. A package name or generated
guess alone never passes step 5.

## nf-core Pipeline catalog

The Pipeline panel searches released nf-core workflows. Dropping one resolves
its selected revision to an immutable Git commit, verifies the complete tracked
source tree, and inserts one `workflow.source` Node. The clean outer card opens
into a nested, source-anchored outline of workflows, subworkflows, processes,
and invocations.

The outline is a navigation and editing lens, not a process DAG. Nextflow
channel transforms, composite values, conditions, and task environments remain
in the exact source unless Somite has their complete structured contract. DOT
output is never used as execution truth.

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
