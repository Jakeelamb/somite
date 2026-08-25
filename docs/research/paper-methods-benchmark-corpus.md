# Paper-methods benchmark corpus

| Field | Value |
|---|---|
| **Question** | Which open-access papers will most improve paper-to-DAG reconstruction? |
| **Date checked** | 2026-08-24 |
| **Status** | Recommended acquisition and benchmark design |
| **Scope** | Bulk RNA-seq, short- and long-read variant calling, assembly, metagenomics, and single-cell RNA-seq |

## Decision

Build the first gold corpus from **seven CC BY PMC Open Access packages**, not from PDFs alone:

1. Kyritsis et al. — explicit CWL RNA-seq workflows
2. Garcia et al. — Sarek germline/somatic short-read workflow
3. Human Pangenome Reference Consortium — long-read small- and structural-variant workflows
4. Smolka et al. — Sniffles2 population and mosaic structural-variant workflows
5. Jarvis et al. — 23 alternative diploid assembly pipelines
6. Krakau et al. — nf-core/mag assembly, binning, classification, and QC
7. Thomas et al. — scRNAbox standard and hashtag-oligo single-cell tracks

Together these papers cover the control-flow constructs absent from the current fixtures: per-sample scatter, cohort gather, optional nodes, mutually exclusive modes, tumour-normal routing, parallel callers, quality gates, iteration, manual boundaries, and alternative pipelines. Five also provide author-maintained executable workflow source or an archived workflow release, giving us an external graph against which to score reconstruction.

Retain the current Love, VGP, and Kraken2 extracts as small regression seeds. Their articles are also CC BY and available as PMC Open Access packages. Keep the current Pertea, GATK Best Practices, and hifiasm extracts, but do not vendor their PDFs: PMC's OA service reports those PMCIDs as outside the Open Access Subset. The PEPPER-Margin-DeepVariant article is useful for internal evaluation, but its OA package reports `license="none"`; treat it as external-only until its reuse terms are reviewed.

## Why the current drop is not enough

The current [`testdata/papers/README.md`](../../testdata/papers/README.md) is a good seed, but the fixtures are short prose summaries rather than source-complete benchmark cases.

| Domain | Present coverage | Missing reconstruction pressure |
|---|---|---|
| Bulk RNA-seq | Love, Pertea, nf-core/rnaseq | Per-sample scatter, cross-sample transcript merge, optional preprocessing, and competing transcript/gene DE branches |
| Short-read variants | GATK germline | Tumour-normal semantics, parallel SNV/indel/SV/CNV callers, scatter/gather, and annotation joins |
| Long-read variants | None | Phasing feedback, small versus structural variants, cohort merge, mosaic mode |
| Assembly | hifiasm, VGP | Many alternative pipelines in one Methods section, repeated subgraphs, and technology-conditioned branches |
| Metagenomics | Kraken2 classification | Assembly versus co-assembly, hybrid assembly, binning, abundance, quality gates, and MAG taxonomy |
| Single-cell | None | Per-sample fan-out, optional ambient-RNA correction, doublet removal, integration, clustering, and HTO mode |
| Evidence | Paraphrased text extracts | JATS section structure, figures, tables, supplements, exact parameters, article version, license, and graph gold |

## Phase-one gold papers

All seven rows below returned `license="CC BY"` from the official [PMC OA Web Service](https://www.ncbi.nlm.nih.gov/pmc/tools/oa-service/) on the date checked. A PMC OA article package contains the full-text and metadata XML, PDF when available, figures/media, and supplements; license terms still have to be recorded per article ([PMC Open Access Subset documentation](https://pmc.ncbi.nlm.nih.gov/tools/openftlist/)). Use the OA service to resolve the current package URL rather than hard-coding its FTP path.

### 1. Bulk RNA-seq: Kyritsis et al. 2023

**Paper:** *Development of high-throughput sequencing analysis pipelines in compliance with FAIR principles* — [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC10662043/), [PDF](https://pmc.ncbi.nlm.nih.gov/articles/PMC10662043/pdf/fbinf-03-1275593.pdf), [OA/license record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC10662043), [author workflow source](https://github.com/BiodataAnalysisGroup/CWL_HTS_pipelines).

Expected RNA graph:

```text
FASTQ(s)
  -> FastQC
  -> [optional Trim Galore / FASTX trimming]
  -> HISAT2
  -> SAMtools sort/index
  -> branch A: StringTie per sample -> merged transcriptome -> StringTie quant -> Ballgown
  -> branch B: featureCounts per sample -> count-table gather -> DESeq2
```

This is the strongest paper-to-machine-graph case. The Methods explicitly describe optional QC/trimming, per-sample execution, a cross-sample StringTie merge, two differential-expression branches, CWL scatter, packaged execution environments, and selectable outputs. The accompanying MIT-licensed repository supplies the CWL graph and wrappers, so extraction can be compared with executable truth rather than a human paraphrase ([paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC10662043/), [source](https://github.com/BiodataAnalysisGroup/CWL_HTS_pipelines)).

**Labels to preserve:** optional preprocessing; scatter; gather; parallel analysis branches; experimental-design, contrast, threshold, and batch-effect parameters; packaged tool provenance; workflow outputs.

### 2. Short-read germline and somatic calling: Garcia et al. 2020

**Paper:** *Sarek: A portable workflow for whole-genome sequencing analysis of germline and somatic variants* — [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC7111497/), [PDF](https://pmc.ncbi.nlm.nih.gov/articles/PMC7111497/pdf/f1000research-9-27789.pdf), [OA/license record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC7111497), [archived publication release](https://doi.org/10.5281/zenodo.3579102).

Expected graph:

```text
FASTQ(s) -> BWA-MEM -> duplicate handling / BQSR
  -> germline:
       HaplotypeCaller + Strelka2
       Manta + TIDDIT
  -> tumour-normal somatic:
       Mutect2 + Strelka2
       Manta + ASCAT + Control-FREEC
  -> SnpEff / VEP annotation + QC/report outputs
```

The paper distinguishes germline and tumour-normal samples; SNV/indel, SV, CNV, purity, and ploidy outputs; multiple parallel callers; annotation; and genome scatter/gather. It also gives a pinned Nextflow invocation for Sarek 2.5.2. The archived publication release must be the benchmark truth, not current nf-core/sarek HEAD ([paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC7111497/), [archived release](https://doi.org/10.5281/zenodo.3579102)).

**Labels to preserve:** sample role; caller/output class; parallel branch rather than sequence; scatter/gather; optional caller selection; tool version; annotation join.

### 3. Long-read small and structural variants: HPRC 2023

**Paper:** *A draft human pangenome reference* — [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC10172123/), [PDF](https://pmc.ncbi.nlm.nih.gov/articles/PMC10172123/pdf/41586_2023_Article_5896.pdf), [OA/license record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC10172123).

The Methods provide an unusually rich long-read case: Winnowmap2 v2.03 alignment with explicit flags (`-x map-pb -a -Y -L --eqx --cs`), SAMtools MD-tag generation, two DeepVariant passes with WhatsHap phasing between them, and separate pbsv, Sniffles, SVIM, and Iris structural-variant paths. The same paper also contains multiple pangenome-construction workflows, so the benchmark annotation must identify the variant-calling subworkflow rather than flattening every method into one DAG ([paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC10172123/)).

**Labels to preserve:** exact argv; phasing feedback; pass number; small-variant versus SV branch; alternate caller; subworkflow boundary; held-out evaluation path versus production method.

### 4. Long-read population and mosaic SVs: Smolka et al. 2024

**Paper:** *Detection of mosaic and population-level structural variants with Sniffles2* — [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC11217151/), [PDF](https://pmc.ncbi.nlm.nih.gov/articles/PMC11217151/pdf/41587_2023_Article_2024.pdf), [OA/license record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC11217151), [MIT source](https://github.com/fritzsedlazeck/Sniffles), [author protocol](https://www.protocols.io/view/sniffles2-methods-c2rxyd7n.pdf).

Expected population graph:

```text
aligned long reads per sample
  -> Sniffles2 call -> sample VCF + serialized candidate file
  -> gather serialized files
  -> Sniffles2 merge -> fully genotyped cohort VCF
```

The Methods also expose germline, population/family, and mosaic modes; a default 100-bp high-resolution candidate bin; coverage-adaptive filtering; and repeat-aware clustering. This case tests whether the extractor represents modes and an `N -> 1` cohort gather rather than hallucinating pairwise sample dependencies. The serialized candidate side output is especially useful for testing typed multi-output nodes ([paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC11217151/), [source](https://github.com/fritzsedlazeck/Sniffles)).

**Labels to preserve:** mutually exclusive mode; per-sample scatter; VCF plus sidecar output; cohort gather; incremental `n+1` merge semantics; default versus user-set parameter.

### 5. Genome assembly challenge: Jarvis et al. 2022

**Paper:** *Semi-automated assembly of high-quality diploid human reference genomes* — [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC9668749/), [PDF](https://pmc.ncbi.nlm.nih.gov/articles/PMC9668749/pdf/41586_2022_Article_5325.pdf), [OA/license record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC9668749).

This is the adversarial assembly case: the paper reports 23 pipelines involving Flye, HiCanu, hifiasm, Peregrine, FALCON-Unzip, Shasta, and MaSuRCA, with trio, Hi-C, Strand-seq, optical-map, and reference-assisted branches. Methods include command lines and exact parameters for several paths. It tests a critical distinction: alternatives compared in one paper are **separate candidate graphs**, not 23 stages of one graph ([paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC9668749/)).

**Labels to preserve:** pipeline identity; technology-conditioned branch; shared versus pipeline-specific subgraph; exact command; repeated evaluation join; manual/curation boundary; comparison edge is not a data edge.

Use the existing VGP extract and CC BY package as the smaller assembly regression case: [PMC8081667 full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC8081667/), [OA/license record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC8081667).

### 6. Metagenome assembly and binning: Krakau et al. 2022

**Paper:** *nf-core/mag: a best-practice pipeline for metagenome hybrid assembly and binning* — [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC8808542/), [PDF](https://pmc.ncbi.nlm.nih.gov/articles/PMC8808542/pdf/lqac007.pdf), [OA/license record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC8808542), [pipeline source](https://github.com/nf-core/mag).

Expected graph:

```text
short reads -> fastp ---------------------> Kraken2 read classification
                     \
long reads -----------+-> MEGAHIT / SPAdes / hybridSPAdes
                           -> per-sample assembly or grouped co-assembly
                           -> MetaBAT2 / MaxBin2 / CONCOCT binning
                           -> abundance + QUAST/BUSCO quality
                           -> quality gate -> GTDB-Tk taxonomy
```

The paper explicitly separates short-read, long-read, and hybrid paths; per-sample assembly from user-grouped co-assembly; multiple binning alternatives; quality assessment; and a GTDB-Tk gate based on completeness/contamination. This is a much stronger metagenomics reconstruction benchmark than Kraken2 alone because it forces branch, choice, merge, and gate semantics while retaining Kraken2 as an independent read-classification branch ([paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC8808542/), [source](https://github.com/nf-core/mag)).

**Labels to preserve:** read technology; alternative assembler/binner; grouped co-assembly; branch; quality metric; threshold gate; MAG versus read taxonomy; pipeline release/commit.

### 7. Single-cell RNA-seq: Thomas et al. 2024

**Paper:** *scRNAbox: a comprehensive and reproducible R-based single-cell RNA sequencing analysis pipeline* — [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC11443813/), [PDF](https://pmc.ncbi.nlm.nih.gov/articles/PMC11443813/pdf/12859_2024_Article_5935.pdf), [OA/license record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC11443813), [project/source](https://neurobioinfo.github.io/scrnabox/).

Expected standard-track graph:

```text
FASTQ per sample -> Cell Ranger
  -> [optional SoupX ambient-RNA correction]
  -> Seurat object + QC/filter/normalize/HVG/PCA
  -> DoubletFinder -> filtered per-sample object
  -> gather samples -> integrate or merge
  -> PCA -> neighbours -> clustering -> markers/annotation
```

The paper also defines a separate hashtag-oligo track. Its Methods supply concrete benchmark settings, including transcript and mitochondrial/ribosomal filters, PCA dimensions, neighbour counts, variable-feature counts, and clustering resolution. This is high value for distinguishing defaults, paper-specific settings, and user-configurable parameters. It also exposes a real ordering constraint: doublet detection consumes the earlier dimensional-reduction state before multi-sample integration ([paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC11443813/), [project](https://neurobioinfo.github.io/scrnabox/)).

**Labels to preserve:** top-level track; per-sample scatter; optional correction; threshold/filter; intermediate object; integration versus merge; parameter ownership; dependency that is not obvious from filenames.

## Acquisition and provenance contract

For every paper, record one manifest entry before extraction:

| Field | Requirement |
|---|---|
| Identity | PMCID, DOI, exact title, article version, publication year |
| Retrieval | Canonical PMC URL, OA API URL, resolved package URL, retrieval timestamp |
| Integrity | SHA-256 for the OA tarball and every extracted asset used |
| Rights | Machine-readable license plus the article's human-readable license statement |
| Assets | JATS/NXML, PDF, figures, tables, supplements, and captions |
| Workflow truth | Repository URL, release/tag/commit, archive DOI where available, source license |
| Benchmark truth | Annotator, annotation version, evidence spans, adjudication state |

Store PDFs only under the existing gitignored `testdata/papers/pdf/` convention. Do **not** assume that NXML, supplements, or workflow archives are ignored; settle their storage and manifest policy before downloading them into the repository. Prefer preserving the original OA package untouched outside the parsed cache, then derive normalized text with recorded hashes.

## Extraction and DAG benchmark contract

Each gold paper should have two linked products:

1. **Evidence ledger** — source asset, JATS section, paragraph/table/figure identifier, exact evidence span, and confidence.
2. **Graph gold** — nodes, typed inputs/outputs, parameters, edges, branches, and boundaries, each pointing back to evidence.

Minimum node labels:

- canonical tool and mentioned spelling;
- tool version and release when explicit;
- operation class (`qc`, `trim`, `align`, `quantify`, `call`, `assemble`, `bin`, `classify`, `filter`, `annotate`, `evaluate`);
- named inputs/outputs and artifact types;
- exact argv or parameter/value/unit when explicit;
- `explicit`, `inferred`, or `workflow-source-only` provenance.

Minimum edge/control labels:

- direct data dependency;
- scatter and gather key;
- optional;
- alternative/XOR;
- parallel branch;
- join;
- iteration/feedback;
- threshold gate;
- manual boundary;
- evaluation-only/comparison-only (explicitly **not** executable dataflow).

Score at least:

- tool/entity precision and recall;
- parameter name/value/unit accuracy;
- node and typed-edge precision/recall;
- ordering violations;
- branch, scatter/gather, optional, iteration, and gate accuracy;
- graph edit distance after canonical tool normalization;
- evidence-span support rate;
- workflow-source agreement and paper-only disagreement.

Do not force one graph per paper. Jarvis has many alternative assembly graphs; HPRC contains distinct assembly, pangenome, small-variant, and SV subworkflows; scRNAbox has standard and HTO tracks. The gold representation must be a set of named subworkflows with explicit relationships.

## Tool-stack implications

The acquisition changes imply a methods pipeline with the following order:

1. **Resolve and preserve:** DOI/PMCID resolution, OA/license check, immutable package, checksums, manifest.
2. **Parse JATS first:** section hierarchy, paragraphs, boxed procedures, tables, captions, cross-references, supplementary links. PDF layout extraction is a fallback and a page-coordinate source, not the canonical text when NXML exists.
3. **Recover evidence across modalities:** many actual DAGs live partly in a workflow figure/caption, table, supplementary protocol, or code release.
4. **Normalize entities without losing surface text:** tool aliases, versions, algorithms versus packages, wrappers versus underlying tools, and workflow release versus current repository HEAD.
5. **Classify method semantics before wiring:** executed step, optional step, alternative method, comparator, input preparation, evaluation, and manual curation.
6. **Construct evidence-bound subgraphs:** preserve branches, gates, scatter/gather keys, named multi-outputs, and uncertainty; never add an edge without an evidence pointer or an explicitly marked inference.
7. **Validate against source:** compile/inspect CWL and pinned workflow releases to compare extracted topology, while keeping paper claims distinct from code-only behavior.

The main architectural correction is simple: **PDF-to-linear-tool-list is not the task.** The task is package-to-evidence-ledger-to-named-subworkflow-set, with executable workflow source used as an independent topology oracle where available.

## Secondary cases, not phase-one blockers

- **Love et al. RNA-seq:** keep as a small linear/branching regression; [full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC4670015/), [CC BY OA record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC4670015).
- **Kraken2:** keep as the metagenomic single-tool boundary case; [full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC6883579/), [CC BY OA record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC6883579).
- **VGP:** keep as the assembly baseline; [full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC8081667/), [CC BY OA record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC8081667).
- **MIntO:** add later for three mutually exclusive metagenome/metatranscriptome modes and optional long-read paths; [full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC9580859/), [CC BY OA record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC9580859), [source](https://github.com/arumugamlab/MIntO).
- **PEPPER-Margin-DeepVariant:** scientifically valuable long-read small-variant case, but its [OA record](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC8571015) reports no machine-readable license. Use a linked external copy unless rights are cleared; [full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC8571015/).
- **Pertea, GATK Best Practices, hifiasm:** PMC full text is readable, but the OA service reports their PMCIDs outside the OA Subset ([Pertea](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC5032908), [GATK](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC4243306), [hifiasm](https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC7961889)). Keep excerpts and links; do not redistribute article packages without separate permission.

## Acceptance gate for the first corpus

The corpus is ready when all seven phase-one papers have:

- an immutable OA package and checksums;
- a rights and provenance manifest;
- preserved JATS, PDF, figures, and supplements;
- a pinned workflow source/archive where one exists;
- named gold subworkflows with evidence-bound nodes, parameters, and edges;
- at least one deliberately annotated negative case per paper where a comparator, alternative, or evaluation step must **not** become an executable edge;
- reconstruction tests that report errors separately for entity extraction, parameter binding, topology, and control flow.
