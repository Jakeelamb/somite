# Paper corpus

This corpus has two layers:

- Small, curated methods fixtures are committed for the mandatory CI and
  source-release gate.
- Full primary-source papers are downloaded into gitignored `pdf/` and `raw/`
  directories for an optional, slower local extraction benchmark.

`gold.tsv` is the versioned, machine-readable contract for every committed text
fixture. Add or change a row only after reviewing the corresponding fixture;
recognizer output must never rewrite the gold expectations automatically.
Ordinary `npm test` and every source release fail if fewer than 12 committed
cases remain, RNA-seq, variant, assembly, and metagenome coverage is lost, a
negative outcome class disappears, a committed `.txt` fixture has no gold row,
an input cannot be extracted, a candidate is empty or invalid, or any annotated
expectation fails. The runner test sends every committed fixture through the
real UTF-8 extraction boundary before reconstruction; the web test enforces the
deeper evidence and topology gold.

## Gold schema and metrics

Schema version 2 has 18 tab-separated fields. Use `-` for no annotation,
commas for lists, semicolons for multiple assertions, `>` for ordered paths,
and `|` for branch arms or alternatives.

| field | assertion |
|---|---|
| `fixture` | committed text input relative to this directory |
| `extract_via` | required fixture extraction path (`utf8` for committed text fixtures) |
| `outcome` | exact reconstruction outcome |
| `tracks` | exact set of candidate assay tracks |
| `expected_entities` | exact normalized method-entity set used for recall and precision |
| `forbidden_entities` | explicit false-positive identities that must remain absent |
| `required_operators` | reviewed operators required across candidates |
| `forbidden_operators` | comparison, covered, or otherwise non-executable operators |
| `required_unsupported` | unsupported identities that must remain as evidence |
| `expected_candidates` | exact candidate count, including zero-outcome cases |
| `required_paths` | ordered reachability, for example `files.import>align.star` |
| `required_branches` | one root reaching every arm, for example `source>qc|align` |
| `separate_alternatives` | selectors that must each occur in a distinct candidate |
| `parameters` | exact `selector:name=value` expectations |
| `minimum_evidence_records` | lower bound across mentions and graph evidence |
| `minimum_evidence_support_pct` | required exact-span support percentage |
| `exact_runs` | exact SRA runs allowed to become read-source nodes |
| `forbid_collection_reads` | requires collection citations to remain citations until an exact run is selected |

Node selectors are operator IDs, except unsupported typed gaps use
`gap:<reviewed tool name>`. The evaluator reports extraction, classification,
entity recall, entity precision, operator support, candidates, nodes, typed
edges, topology, parameters, evidence spans, and cited-resource selection as
separate deterministic metrics. Run it with its concise corpus summary visible:

```bash
node --experimental-strip-types --test web/tests/paper-core.test.ts
```

Run `scripts/fetch-paper-corpus` from anywhere in the checkout. Downloads are
pinned by SHA-256. A checksum failure stops before replacing an existing paper.
This is deliberate: two early corpus files had valid PDFs with the wrong papers.

## Full-paper acceptance corpus

| local asset | authoritative source | license/access | required reconstruction |
|---|---|---|---|
| `pdf/love_f1000.pdf` | [PMC4670015](https://pmc.ncbi.nlm.nih.gov/articles/PMC4670015/) | CC BY | STAR → featureCounts → DESeq2 |
| `raw/pertea_hisat.txt` | [PMC5032908](https://pmc.ncbi.nlm.nih.gov/articles/PMC5032908/) | PMC author manuscript, TDM text | HISAT2 → StringTie → Ballgown gap |
| `raw/gatk_best_practices.txt` | [PMC4243306](https://pmc.ncbi.nlm.nih.gov/articles/PMC4243306/) | PMC author manuscript, TDM text | BWA-MEM → Picard MarkDuplicates → HaplotypeCaller |
| `pdf/cheng_hifiasm.pdf` | [arXiv:2008.01237v1](https://arxiv.org/abs/2008.01237v1) | arXiv preprint | HiFi → hifiasm |
| `pdf/rhie_vgp.pdf` | [PMC8081667](https://pmc.ncbi.nlm.nih.gov/articles/PMC8081667/) | CC BY | FALCON → Purge_Dups → Salsa → BUSCO |
| `pdf/wood_kraken2.pdf` | [PMC6883579](https://pmc.ncbi.nlm.nih.gov/articles/PMC6883579/) | CC BY | reads → Kraken2, not minimap2 or nf-core/taxprofiler |
| `raw/cwl_workflows_pmc.txt` + PDF | [PMC10662043](https://pmc.ncbi.nlm.nih.gov/articles/PMC10662043/) | CC BY | separate HISAT2 RNA-seq and BWA/GATK germline branches |
| `raw/sarek_pmc.txt` + PDF | [PMC7111497](https://pmc.ncbi.nlm.nih.gov/articles/PMC7111497/) | PMC dataset | named Sarek compound, not duplicated internal bricks |
| `raw/minto_pmc.txt` + PDF | [PMC9580859](https://pmc.ncbi.nlm.nih.gov/articles/PMC9580859/) | CC BY | retain unsupported preprocessing/assembly methods; no guessed executable draft |
| `raw/scrnabox_pmc.txt` + PDF | [PMC11443813](https://pmc.ncbi.nlm.nih.gov/articles/PMC11443813/) | CC BY | retain Cell Ranger, SoupX, Seurat, and DoubletFinder; no guessed executable draft |

The PMC assets come from the [current NLM PMC article dataset on
AWS](https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/), not scraped article pages.
For the complex cases, the official PMC plain text is the canonical extraction
input and the PDF remains the layout reference. The runner corpus test reports
the optional full-source layer as skipped in a clean checkout. It crosses real
PDF.js extraction for the PDF cases and all ten reconstructions when the corpus
is installed, and requires that layer to be complete once `pdf/` exists or
`SOMITE_PAPER_CORPUS=required` is set.

## Curated fixtures

| file | pipeline we must rebuild |
|---|---|
| `love_rnaseq_methods.txt` | SRA → STAR → featureCounts → DESeq2 |
| `pertea_hisat_methods.txt` | FastQC → HISAT2 → StringTie → Ballgown |
| `nfcore_rnaseq_methods.txt` | FastQC → nf-core/rnaseq compound |
| `gatk_methods.txt` | BWA-MEM → GATK HaplotypeCaller |
| `hifiasm_methods.txt` | HiFi → hifiasm |
| `vgp_assembly_methods.txt` | FALCON → Purge_Dups → Salsa → BUSCO |
| `kraken2_methods.txt` | reads → Kraken2 |
| `aphis_assembly_methods.txt` | HiFi + Hi-C → hifiasm → YaHS → BUSCO |
| `rnaseq_methods.txt` | FastQC → fastp → STAR → featureCounts → DESeq2 |
| `cited_resources_methods.txt` | cited BioProject/SRA collections → exact selectable runs |
| `comparison_only_methods.txt` | retain STAR comparison evidence, execute only HISAT2 |
| `assembly_alternatives_methods.txt` | hifiasm, FALCON, and Flye as separate candidates |
| `unsupported_te_methods.txt` | retain exact unsupported TE method identities without guessed nodes |
| `unsupported_statistics_methods.txt` | retain exact statistical methods without a fake draft |
| `no_reconstructable_methods.txt` | deterministic no-method outcome with zero candidates |

The committed release gate runs as part of ordinary tests:

```bash
node --experimental-strip-types --test runner/tests/paper-corpus.test.ts
```

The fetched full-source benchmark is intentionally explicit and
all-or-nothing:

```bash
scripts/fetch-paper-corpus
SOMITE_PAPER_CORPUS=required node --experimental-strip-types --test runner/tests/paper-corpus.test.ts
```
