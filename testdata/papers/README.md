# Paper corpus

This corpus has two layers:

- Small, curated methods fixtures are committed for fast unit tests.
- Full primary-source papers are downloaded into gitignored `pdf/` and `raw/`
  directories for end-to-end extraction and reconstruction tests.

Run `scripts/fetch-paper-corpus` from anywhere in the checkout. Downloads are
pinned by SHA-256. A checksum failure stops before replacing an existing paper.
This is deliberate: two early corpus files had valid PDFs with the wrong papers.

## Full-paper acceptance corpus

| local asset | authoritative source | license/access | required reconstruction |
|---|---|---|---|
| `pdf/love_f1000.pdf` | [PMC4670015](https://pmc.ncbi.nlm.nih.gov/articles/PMC4670015/) | CC BY | STAR → featureCounts → DESeq2 |
| `raw/pertea_hisat.txt` | [PMC5032908](https://pmc.ncbi.nlm.nih.gov/articles/PMC5032908/) | PMC author manuscript, TDM text | HISAT2 → StringTie → Ballgown gap |
| `raw/gatk_best_practices.txt` | [PMC4243306](https://pmc.ncbi.nlm.nih.gov/articles/PMC4243306/) | PMC author manuscript, TDM text | BWA-MEM → Picard gap → HaplotypeCaller |
| `pdf/cheng_hifiasm.pdf` | [arXiv:2008.01237v1](https://arxiv.org/abs/2008.01237v1) | arXiv preprint | HiFi → hifiasm |
| `pdf/rhie_vgp.pdf` | [PMC8081667](https://pmc.ncbi.nlm.nih.gov/articles/PMC8081667/) | CC BY | FALCON → Purge_Dups → Salsa → BUSCO |
| `pdf/wood_kraken2.pdf` | [PMC6883579](https://pmc.ncbi.nlm.nih.gov/articles/PMC6883579/) | CC BY | reads → Kraken2, not minimap2 or nf-core/taxprofiler |
| `raw/cwl_workflows_pmc.txt` + PDF | [PMC10662043](https://pmc.ncbi.nlm.nih.gov/articles/PMC10662043/) | CC BY | separate HISAT2 RNA-seq and BWA/GATK germline branches |
| `raw/sarek_pmc.txt` + PDF | [PMC7111497](https://pmc.ncbi.nlm.nih.gov/articles/PMC7111497/) | PMC dataset | named Sarek compound, not duplicated internal bricks |
| `raw/minto_pmc.txt` + PDF | [PMC9580859](https://pmc.ncbi.nlm.nih.gov/articles/PMC9580859/) | CC BY | metagenome preprocessing, assembly and binning gaps |
| `raw/scrnabox_pmc.txt` + PDF | [PMC11443813](https://pmc.ncbi.nlm.nih.gov/articles/PMC11443813/) | CC BY | Cell Ranger → optional SoupX → Seurat → DoubletFinder |

The PMC assets come from the [current NLM PMC article dataset on
AWS](https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/), not scraped article pages.
For the complex cases, the official PMC plain text is the canonical extraction
input and the PDF remains the layout/OCR fallback. `downloaded_real_paper_corpus_reconstructs`
runs all ten full-text cases when the corpus is present and requires the corpus
to be complete once `pdf/` exists.

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
