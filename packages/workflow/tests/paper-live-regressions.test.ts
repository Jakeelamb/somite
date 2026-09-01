import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "../catalog.node.ts";
import { paperWorkflowCitations, reconstructPaper } from "../paper.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("retains explicit ARTIC and Freyja method evidence from an unseen paper", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Samples were sequenced using the ARTIC v5.3.2 workflow.",
    "Variant calling and lineage assignment were performed using Freyja.",
  ].join("\n"), "jats");

  assert.equal(review.outcome, "recognized_unsupported");
  assert.deepEqual(
    review.mentions.map((mention) => mention.normalized_name),
    ["artic", "freyja"],
  );
  assert.ok(review.mentions.every((mention) => mention.support === "unsupported"));
  assert.equal(review.candidates.length, 0, "unsupported methods must not become invented executable nodes");
});

test("retains the genome assembly track when a multi-assay paper uses ordinary assembly language", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Genomic DNA extraction, sequencing, and assembly",
    "Illumina and PacBio reads were used to construct the genome assembly.",
    "K-mer profiles were calculated with Jellyfish v2.3.0 and GenomeScope v2.0.",
    "Assembly was performed with MaSuRCA v4.1.0, followed by Redundans v0.14a, RagTag v2.1.0, and abyss-sealer from ABySS v2.3.7.",
    "Structural and functional annotation",
    "Repeats were masked with RepeatMasker v4.1.5. Gene models were produced with BRAKER3 v3.0.3, LiftOn v0.4.9, and AGAT v1.2.0.",
    "RNA-seq libraries were aligned with HISAT2 and counted with featureCounts.",
  ].join("\n"), "jats");

  assert.ok(review.candidates.some((candidate) => candidate.assay === "assembly"), "the genome assembly track disappeared");
  assert.ok(review.candidates.some((candidate) => candidate.assay === "rna_seq"), "the RNA-seq track disappeared");
  const retained = new Set(review.mentions.map((mention) => mention.normalized_name));
  for (const method of ["jellyfish", "masurca", "redundans", "ragtag", "abysssealer", "braker3", "lifton", "agat"]) {
    assert.ok(retained.has(method), `missing method evidence for ${method}`);
  }
  const assemblyTools = new Set(review.candidates
    .filter((candidate) => candidate.assay === "assembly")
    .flatMap((candidate) => candidate.graph.nodes)
    .filter((node) => node.operator === "gap.missing")
    .map((node) => String(node.params?.tool ?? "").toLocaleLowerCase("en-US")));
  assert.ok(assemblyTools.has("masurca"), "the primary assembler was not represented on the graph");
  assert.ok(assemblyTools.has("ragtag"), "the scaffolding step was not represented on the graph");
});

test("executable nodes cite the executable method occurrence, not an earlier comparison", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Introduction",
    "Previous evaluations compared STAR with several aligners.",
    "This background comparison is separate from the authors' executable workflow and is retained only as context for the study design.",
    "Methods",
    "Paired-end RNA-seq reads were aligned using STAR v2.7.11 and quantified with featureCounts.",
  ].join("\n"), "jats");

  const mention = review.mentions.find((candidate) => candidate.operator_id === "align.star");
  assert.match(mention?.evidence ?? "", /aligned using STAR/i);
  assert.doesNotMatch(mention?.evidence ?? "", /compared STAR/i);
});

test("cached method recognition resets occurrence state while preserving case and token boundaries", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const executable = reconstructPaper(catalog, [
    "Methods",
    "Previous evaluations compared STAR with other aligners.",
    "Paired-end RNA-seq reads were then aligned using STAR v2.7.11 and quantified with featureCounts.",
  ].join("\n"), "jats");
  const rejected = reconstructPaper(catalog, [
    "Methods",
    "Paired-end RNA-seq reads were aligned with HISAT2, selected over STAR, and quantified with featureCounts.",
  ].join("\n"), "jats");
  const falseBoundaries = reconstructPaper(catalog, [
    "Methods",
    "The lowercase label star, STAR_index, and STAR+suffix were metadata fields rather than executable tools.",
    "Paired-end RNA-seq reads were aligned with HISAT2 and quantified with featureCounts.",
  ].join("\n"), "jats");

  const executableStar = executable.mentions.find((mention) => mention.operator_id === "align.star");
  const rejectedStar = rejected.mentions.find((mention) => mention.operator_id === "align.star");
  assert.equal(executableStar?.executable, true);
  assert.match(executableStar?.evidence ?? "", /aligned using STAR/i);
  assert.equal(rejectedStar?.executable, false, "a prior cached scan leaked executable state into the next paper");
  assert.equal(falseBoundaries.mentions.some((mention) => mention.operator_id === "align.star"), false,
    "case-sensitive acronym or protected token boundaries changed while reusing the recognition plan");
});

test("negated synthetic assembly support methods remain evidence without becoming nodes", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "PacBio HiFi reads were assembled with hifiasm.",
    "The assembly was evaluated without GenomeScope because no short-read k-mers were available.",
  ].join("\n"), "jats");

  assert.ok(review.mentions.some((mention) => mention.operator_id === "asm.hifiasm"));
  assert.equal(review.candidates.flatMap((candidate) => candidate.graph.nodes)
    .some((node) => node.operator === "gap.missing" && String(node.params?.tool).toLocaleLowerCase("en-US") === "genomescope"), false);
});

test("retains a versioned executable method even when the paper has no repository statement", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end sequencing reads in FASTQ format were assembled with OrbitAssembler version 1.4.2 and the resulting assembly was written as FASTA.",
  ].join("\n"), "jats");

  const mention = review.mentions.find((candidate) => candidate.normalized_name === "orbitassembler");
  assert.equal(mention?.support, "unsupported");
  assert.equal(mention?.operation_class, "assemble");
  assert.equal(mention?.version, "1.4.2");
  assert.equal(mention?.core, true, "an unsupported primary assembler must remain core evidence");
  assert.ok(review.candidates.some((candidate) => candidate.assay === "assembly"));
  assert.ok(review.candidates.flatMap((candidate) => candidate.graph.nodes)
    .some((node) => node.operator === "gap.missing" && node.params?.tool === "OrbitAssembler"));
});

test("assembly prose cannot promote a non-assembly method to core", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Sequencing reads were assembled with STAR v2.7.11 and the resulting files were quantified with featureCounts.",
  ].join("\n"), "jats");

  const star = review.mentions.find((mention) => mention.operator_id === "align.star");
  assert.ok(star);
  assert.equal(star.operation_class, "read_alignment");
  assert.notEqual(star.core, true, "primary-assembler detection ran for a non-assembly method");
});

test("does not invent versioned document labels as executable software", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "FASTQ sequencing reads were aligned to the reference as illustrated in Figure v2.1, producing BAM files.",
    "The same alignment was summarized in Table v3.4, Supplement v1.2, and Document v1.5.",
  ].join("\n"), "jats");

  const names = new Set(review.mentions.map((mention) => mention.normalized_name));
  for (const documentLabel of ["figure", "table", "supplement", "document"]) {
    assert.equal(names.has(documentLabel), false, `invented software mention ${documentLabel}`);
  }
});

test("defers an exact SRA run until provider metadata establishes its read layout", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "RNA-seq reads from SRR8890201 were checked with FastQC and aligned with STAR.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "rna_seq");
  assert.ok(candidate);
  assert.equal(candidate.graph.nodes.some((node) => node.operator === "sra.prefetch"), false);
  const placeholder = candidate.graph.nodes.find((node) => node.operator.startsWith("files.import"));
  assert.match(placeholder?.note ?? "", /SRR8890201/);
  assert.match(placeholder?.note ?? "", /layout/i);
  const aligner = candidate.graph.nodes.find((node) => node.operator === "align.star");
  assert.equal(candidate.graph.edges.filter((edge) => edge.from_node === placeholder?.id && edge.to_node === aligner?.id).length, 1, "one unknown-layout read cannot impersonate both mates");
  const reference = candidate.graph.nodes.find((node) => node.operator === "files.import_fasta");
  const index = candidate.graph.nodes.find((node) => node.operator === "align.star_index");
  assert.ok(reference && index && aligner);
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === reference.id && edge.to_node === index.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === index.id && edge.to_node === aligner.id && edge.to_port === "genome"));
  assert.notEqual(candidate.assessment.state, "ready");
});

test("represents the required Hifiasm GFA to FASTA handoff instead of pretending its directory is a FASTA", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "PacBio HiFi reads were assembled with hifiasm, scaffolded with YaHS using Hi-C alignments, and assessed with BUSCO.",
  ].join("\n"), "jats");
  const candidate = review.candidates.find((item) => item.assay === "assembly");
  assert.ok(candidate);
  const hifiasm = candidate.graph.nodes.find((node) => node.operator === "asm.hifiasm");
  const conversion = candidate.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "Hifiasm GFA export");
  const yahs = candidate.graph.nodes.find((node) => node.operator === "asm.yahs");
  assert.ok(hifiasm && conversion && yahs);
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === hifiasm.id && edge.to_node === conversion.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === conversion.id && edge.to_node === yahs.id));
  assert.ok(candidate.assessment.items.some((item) => item.node_id === conversion.id && item.kind === "adapter"));
});

test("keeps RNA alignment in an RNA-derived variant workflow instead of splitting the executable path", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end RNA-seq reads were adapter trimmed with fastp v0.23.4.",
    "The trimmed reads were aligned to the reference genome with STAR in two-pass mode.",
    "Duplicate alignments were marked with Picard MarkDuplicates and variant calling was performed with GATK HaplotypeCaller.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "variants");
  assert.ok(candidate, "the RNA-derived variant track disappeared");
  assert.equal(review.candidates.some((item) => item.assay === "rna_seq"), false, "one sequential RNA-derived variant workflow must not be duplicated as parallel assays");
  const fastp = candidate.graph.nodes.find((node) => node.operator === "qc.fastp");
  const star = candidate.graph.nodes.find((node) => node.operator === "align.star");
  const picard = candidate.graph.nodes.find((node) => node.operator === "align.picard_mark_duplicates");
  const readGroups = candidate.graph.nodes.find((node) => node.operator === "align.gatk_add_read_groups");
  const sort = candidate.graph.nodes.find((node) => node.operator === "align.samtools_sort_gatk");
  const caller = candidate.graph.nodes.find((node) => node.operator === "var.haplotypecaller");
  assert.ok(fastp && star && picard && readGroups && sort && caller, "the evidence-backed read-to-variant path is incomplete");
  const r1Gunzip = candidate.graph.edges.find((edge) => edge.from_node === fastp.id && edge.from_port === "r1"
    && candidate.graph.nodes.find((node) => node.id === edge.to_node)?.operator === "archive.gunzip_fastq");
  const r2Gunzip = candidate.graph.edges.find((edge) => edge.from_node === fastp.id && edge.from_port === "r2"
    && candidate.graph.nodes.find((node) => node.id === edge.to_node)?.operator === "archive.gunzip_fastq");
  assert.ok(r1Gunzip && r2Gunzip);
  assert.notEqual(r1Gunzip.to_node, r2Gunzip.to_node, "each mate needs its own scalar decompression node");
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === r1Gunzip.to_node && edge.from_port === "fastq"
    && edge.to_node === star.id && edge.to_port === "r1"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === r2Gunzip.to_node && edge.from_port === "fastq"
    && edge.to_node === star.id && edge.to_port === "r2"));
  assert.equal(candidate.graph.edges.some((edge) => edge.to_node === star.id
    && candidate.graph.nodes.find((node) => node.id === edge.from_node)?.operator === "files.import_paired"), false,
  "raw reads must not bypass the paper's explicit fastp step");
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === star.id && edge.to_node === picard.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === picard.id && edge.to_node === readGroups.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === readGroups.id && edge.to_node === sort.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === sort.id && edge.to_node === caller.id));
});

test("keeps pseudobulk differential expression inside the single-cell workflow with an explicit aggregation boundary", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Single-cell RNA sequencing FASTQ files were counted with Cell Ranger and ambient RNA was corrected with SoupX.",
    "Seurat was used for filtering, integration, and clustering.",
    "For pseudobulk analysis, Seurat AggregateExpression summed counts for each sample before differential expression with DESeq2.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "single_cell");
  assert.ok(candidate);
  const seurat = candidate.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "Seurat");
  const aggregation = candidate.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "Seurat AggregateExpression");
  const differential = candidate.graph.nodes.find((node) => node.operator === "diff.deseq2");
  assert.ok(seurat && aggregation && differential, "the evidence-backed pseudobulk path is incomplete");
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === seurat.id && edge.to_node === aggregation.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === aggregation.id && edge.to_node === differential.id));
  assert.equal(review.candidates.some((item) => item.assay === "rna_seq"), false, "pseudobulk must not become a detached bulk RNA workflow");
});

test("does not wire an arbitrary analysis directory into an engine-specific index input", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end reads were characterized with GenomeScope before genome assembly with FALCON.",
    "The reads were aligned with BWA-MEM and the final assembly was evaluated with BUSCO.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "assembly");
  assert.ok(candidate, "a profile mismatch must not discard the entire evidence-backed draft");
  const genomeScope = candidate.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "Genomescope");
  const bwa = candidate.graph.nodes.find((node) => node.operator === "align.bwa");
  assert.ok(genomeScope && bwa);
  assert.equal(candidate.graph.edges.some((edge) => edge.from_node === genomeScope.id && edge.to_node === bwa.id && edge.to_port === "index"), false);
});

test("retains multiword software names without inventing article and suffix tools", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Optical maps were scaffolded using Bionano Solve. Solve v3.2.1 was used, following the v1.0 pipeline.",
    "Demographic history was inferred using Stairway Plot. Plot v2.1 was used for the final model.",
  ].join("\n"), "jats");

  const names = new Set(review.mentions.map((mention) => mention.normalized_name));
  assert.ok(names.has("bionanosolve"));
  assert.ok(names.has("stairwayplot"));
  for (const invented of ["solve", "plot", "the"]) assert.equal(names.has(invented), false, `invented software mention ${invented}`);
});

test("materializes a distinct transcriptome index path for Salmon", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end RNA-seq reads were quantified against the transcript sequences using Salmon.",
  ].join("\n"), "jats");
  const candidate = review.candidates.find((item) => item.assay === "rna_seq");
  assert.ok(candidate);
  const reference = candidate.graph.nodes.find((node) => node.operator === "files.import_fasta");
  const index = candidate.graph.nodes.find((node) => node.operator === "quant.salmon_index");
  const salmon = candidate.graph.nodes.find((node) => node.operator === "quant.salmon");
  assert.ok(reference && index && salmon);
  assert.match(reference.note ?? "", /transcript/i);
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === reference.id && edge.to_node === index.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === index.id && edge.to_node === salmon.id && edge.to_port === "index"));
});

test("uses the reviewed Bowtie2 operator and its exact index instead of retaining a false adapter gap", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end RNA-seq reads were aligned to the reference genome with Bowtie2 v2.5.4.",
  ].join("\n"), "jats");

  const mention = review.mentions.find((item) => item.normalized_name === "bowtie2");
  assert.equal(mention?.support, "operator");
  assert.equal(mention?.operator_id, "align.bowtie2");
  const candidate = review.candidates.find((item) => item.assay === "rna_seq");
  assert.ok(candidate);
  const builder = candidate.graph.nodes.find((node) => node.operator === "align.bowtie2_build");
  const aligner = candidate.graph.nodes.find((node) => node.operator === "align.bowtie2");
  assert.ok(builder && aligner);
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === builder.id && edge.to_node === aligner.id && edge.to_port === "index"));
  assert.equal(candidate.graph.nodes.some((node) => node.operator === "gap.missing" && node.params?.tool === "Bowtie2"), false);
});

test("keeps distinct profiled indexes attached to their matching paper aligners", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end RNA-seq reads were aligned independently with Bowtie2 and HISAT2.",
    "The HISAT2 alignments were converted to BAM and assembled with StringTie.",
    "Differential expression was tested with Ballgown.",
  ].join("\n"), "jats");

  assert.equal(review.outcome, "drafts_ready");
  const candidate = review.candidates.find((item) => item.assay === "rna_seq");
  assert.ok(candidate);
  const bowtieIndex = candidate.graph.nodes.find((node) => node.operator === "align.bowtie2_build");
  const bowtie = candidate.graph.nodes.find((node) => node.operator === "align.bowtie2");
  const hisatIndex = candidate.graph.nodes.find((node) => node.operator === "align.hisat2_index");
  const hisat = candidate.graph.nodes.find((node) => node.operator === "align.hisat2");
  assert.ok(bowtieIndex && bowtie && hisatIndex && hisat);
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === bowtieIndex.id
    && edge.to_node === bowtie.id
    && edge.to_port === "index"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === hisatIndex.id
    && edge.to_node === hisat.id
    && edge.to_port === "index"));
  assert.equal(candidate.graph.edges.some((edge) => edge.from_node === hisatIndex.id && edge.to_node === bowtie.id), false);
  assert.equal(candidate.graph.edges.some((edge) => edge.from_node === bowtieIndex.id && edge.to_node === hisat.id), false);
});

test("uses a typed local annotation source when a paper requires GTF without naming a genome", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end RNA-seq reads were aligned with STAR and assigned to genes with featureCounts using a GTF annotation.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "rna_seq");
  assert.ok(candidate);
  const annotation = candidate.graph.nodes.find((node) => node.operator === "files.import_gtf");
  const counts = candidate.graph.nodes.find((node) => node.operator === "quant.featurecounts");
  assert.ok(annotation && counts, "the required local GTF source and featureCounts node must both be visible");
  assert.ok(candidate.graph.edges.some((item) => item.from_node === annotation.id
    && item.from_port === "gtf"
    && item.to_node === counts.id
    && item.to_port === "gtf"));
  assert.ok(candidate.assessment.items.some((item) => item.node_id === annotation.id && item.kind === "parameter" && item.field === "path"));
  assert.equal(candidate.assessment.items.some((item) => item.node_id === counts.id && item.field === "gtf"), false);
});

test("normalizes a named Ensembl compressed reference before paper index builders", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end human RNA-seq reads were aligned to GRCh38 with STAR.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "rna_seq");
  assert.ok(candidate);
  const reference = candidate.graph.nodes.find((node) => node.operator === "ensembl.fasta");
  const decompress = candidate.graph.nodes.find((node) => node.operator === "archive.gunzip_fasta");
  const index = candidate.graph.nodes.find((node) => node.operator === "align.star_index");
  assert.ok(reference && decompress && index);
  assert.ok(candidate.graph.edges.some((item) => item.from_node === reference.id && item.to_node === decompress.id));
  assert.ok(candidate.graph.edges.some((item) => item.from_node === decompress.id && item.to_node === index.id));
  assert.equal(candidate.graph.edges.some((item) => item.from_node === reference.id && item.to_node === index.id), false);
});

test("distinguishes cited methods from inferred workflow plumbing", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end human RNA-seq reads were aligned to GRCh38 with STAR v2.7.11.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "rna_seq");
  assert.ok(candidate);
  const method = candidate.graph.nodes.find((node) => node.operator === "align.star");
  const index = candidate.graph.nodes.find((node) => node.operator === "align.star_index");
  const reference = candidate.graph.nodes.find((node) => node.operator === "ensembl.fasta");
  const decompress = candidate.graph.nodes.find((node) => node.operator === "archive.gunzip_fasta");
  assert.ok(method && index && reference && decompress);
  assert.equal(candidate.evidence.find((item) => item.target_id === method.id)?.status, "explicit");
  for (const inferred of [index, reference, decompress]) {
    assert.equal(candidate.evidence.find((item) => item.target_id === inferred.id)?.status, "inferred", inferred.operator);
  }
});

test("does not collapse an amplicon variant workflow into FastQC-only quality control", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end sequencing reads were assessed with FastQC v0.12.1 and trimmed using Trim Galore v0.6.10.",
    "The reads were aligned to the viral reference genome and variants were called using FreeBayes v1.3.8 and filtered with BCFtools v1.21.",
    "Process_gvcf from ARTIC was used during consensus genome generation.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "variants");
  assert.ok(candidate, "the downstream scientific assay was lost behind a QC pre-step");
  assert.equal(review.candidates.some((item) => item.assay === "qc"), false);
  const tools = new Set(candidate.graph.nodes
    .filter((node) => node.operator === "gap.missing")
    .map((node) => String(node.params?.tool)));
  for (const tool of ["Trim Galore", "FreeBayes", "BCFtools"]) assert.ok(tools.has(tool), `missing ${tool}`);
  assert.ok(review.mentions.some((mention) => mention.normalized_name === "artic"));
});

test("keeps untyped executable method evidence visible without inventing ports", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "PacBio HiFi reads were assembled with hifiasm.",
    "RNA-seq reads were aligned with HISAT2 and assembled with StringTie.",
    "Contaminants were screened with FCS Adaptor v0.5.0 and FCS-GX v0.5.0.",
    "Another Gtf/Gff Analysis Toolkit v1.5.0 (AGAT) was used to summarize the genome annotation.",
    "NovelPostprocess v1.2.3 was used to summarize the final results.",
  ].join("\n"), "jats");

  const mentions = new Map(review.mentions.map((mention) => [mention.normalized_name, mention]));
  assert.equal(mentions.get("fcsadaptor")?.display_name, "FCS Adaptor");
  assert.equal(mentions.get("fcsadaptor")?.version, "0.5.0");
  assert.equal(mentions.get("agat")?.display_name, "Another Gtf/Gff Analysis Toolkit");
  assert.equal(mentions.get("agat")?.version, "1.5.0");
  assert.equal(mentions.has("adaptor"), false);
  assert.equal(mentions.has("toolkit"), false);
  assert.ok(review.candidates.some((item) => item.assay === "assembly"));
  assert.ok(review.candidates.some((item) => item.assay === "rna_seq"));
  const retainedTools = ["FCS Adaptor", "AGAT", "NovelPostprocess"];
  const evidenceNodes = review.candidates.flatMap((candidate) => candidate.graph.nodes
    .filter((node) => node.operator === "gap.missing" && retainedTools.includes(String(node.params?.tool)))
    .map((node) => ({ candidate, node })));
  assert.deepEqual(new Set(evidenceNodes.map(({ node }) => node.params?.tool)), new Set(retainedTools));
  for (const tool of retainedTools) assert.equal(evidenceNodes.filter(({ node }) => node.params?.tool === tool).length, 1, `${tool} was copied across assay drafts`);
  assert.ok(evidenceNodes.every(({ node }) => node.ports.length === 0), "unknown contracts must stay portless");
  assert.ok(evidenceNodes.every(({ candidate, node }) => candidate.graph.edges.every((edge) => edge.from_node !== node.id && edge.to_node !== node.id)),
    "retained evidence must not invent a data handoff");
  assert.equal(review.outcome, "drafts_ready", "retained evidence must not erase the supported draft");
  assert.ok(evidenceNodes.every(({ candidate, node }) => {
    const assessment = candidate.assessment.nodes.find((item) => item.node_id === node.id);
    return assessment?.kind === "adapter" && assessment.label === "Evidence retained" && !assessment.requires_action;
  }));
  assert.ok(evidenceNodes.every(({ candidate, node }) => candidate.assessment.items.every((item) => item.node_id !== node.id)),
    "evidence-only methods are not missing runtime inputs or guided setup steps");
});

test("maps evidenced SAMtools commands and retains unresolved suite work", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "PacBio HiFi reads were assembled with hifiasm.",
    "Illumina reads were aligned with BWA-MEM against the reference genome.",
    "SAMtools was used to convert SAM to BAM format, sort and deduplicate reads, and subsequently call SNPs.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "assembly");
  assert.ok(candidate);
  const bwa = candidate.graph.nodes.find((node) => node.operator === "align.bwa");
  const view = candidate.graph.nodes.find((node) => node.operator === "align.samtools_view");
  const sort = candidate.graph.nodes.find((node) => node.operator === "align.samtools_sort");
  const unresolved = candidate.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "SAMtools");
  assert.ok(bwa && view && sort && unresolved, "supported commands and residual suite work must all remain visible");
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === bwa.id && edge.to_node === view.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === view.id && edge.to_node === sort.id));

  const vague = reconstructPaper(catalog, [
    "Methods",
    "PacBio HiFi reads were assembled with hifiasm.",
    "SAMtools was used to process the resulting alignments.",
  ].join("\n"), "jats");
  const vagueCandidate = vague.candidates.find((item) => item.assay === "assembly");
  assert.ok(vagueCandidate);
  assert.equal(vagueCandidate.graph.nodes.some((node) => node.operator === "align.samtools_view" || node.operator === "align.samtools_sort"), false,
    "a suite name without command evidence must not select a command-specific operator");
  assert.ok(vagueCandidate.graph.nodes.some((node) => node.operator === "gap.missing" && node.params?.tool === "SAMtools"));

  const fullyMapped = reconstructPaper(catalog, [
    "Methods",
    "PacBio HiFi reads were assembled with hifiasm.",
    "Illumina reads were aligned with BWA-MEM against the reference genome.",
    "SAMtools was used to convert SAM to BAM format and sort the resulting alignments.",
  ].join("\n"), "jats");
  const mappedCandidate = fullyMapped.candidates.find((item) => item.assay === "assembly");
  assert.ok(mappedCandidate);
  assert.ok(mappedCandidate.graph.nodes.some((node) => node.operator === "align.samtools_view"));
  assert.ok(mappedCandidate.graph.nodes.some((node) => node.operator === "align.samtools_sort"));
  assert.equal(mappedCandidate.graph.nodes.some((node) => node.operator === "gap.missing" && node.params?.tool === "SAMtools"), false,
    "a fully represented suite sentence must not leave a false adapter gap");
});

test("keeps assembly and Hi-C libraries distinct through a typed BWA-MEM2 SAMtools YaHS handoff", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "PacBio HiFi reads were assembled using hifiasm v0.19.6.",
    "Hi-C mapping scaffolding used BWA-MEM2 v2.2.1, SAMtools v1.19, and YaHS v1.0.",
    "The chromosome assembly was assessed with BUSCO.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "assembly");
  assert.ok(candidate);
  const longReads = candidate.graph.nodes.find((node) => node.operator === "files.import");
  const hiCReads = candidate.graph.nodes.find((node) => node.operator === "files.import_paired");
  const hifiasm = candidate.graph.nodes.find((node) => node.operator === "asm.hifiasm");
  const conversion = candidate.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "Hifiasm GFA export");
  const bwaMem2 = candidate.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "BWA-MEM2");
  const samtools = candidate.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "SAMtools");
  const yahs = candidate.graph.nodes.find((node) => node.operator === "asm.yahs");
  assert.ok(longReads && hiCReads && hifiasm && conversion && bwaMem2 && samtools && yahs);
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === longReads.id && edge.to_node === hifiasm.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === hiCReads.id && edge.to_node === bwaMem2.id && edge.to_port === "r1"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === conversion.id && edge.to_node === bwaMem2.id && edge.to_port === "ref"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === bwaMem2.id && edge.to_node === samtools.id));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === samtools.id && edge.to_node === yahs.id && edge.to_port === "hic"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === conversion.id && edge.to_node === yahs.id && edge.to_port === "contigs"));
  assert.equal(candidate.graph.edges.some((edge) => edge.from_node === longReads.id && edge.to_node === bwaMem2.id), false,
    "long-read assembly data must not silently impersonate the separate Hi-C library");
});

test("connects a named Parabricks fq2bam handoff through typed GATK preparation without substituting classic BWA", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end Illumina reads were trimmed with fastp v0.23.4.",
    "NVIDIA Parabricks v4.3.2 fq2bam integrated BWA-MEM2 mapping and duplicate marking against the reference FASTA.",
    "Variants were called from the resulting BAM using GATK HaplotypeCaller.",
  ].join("\n"), "jats");

  const candidate = review.candidates.find((item) => item.assay === "variants");
  assert.ok(candidate);
  const reference = candidate.graph.nodes.find((node) => node.operator === "files.import_fasta");
  const fq2bam = candidate.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "Parabricks fq2bam");
  const readGroups = candidate.graph.nodes.find((node) => node.operator === "align.gatk_add_read_groups");
  const sort = candidate.graph.nodes.find((node) => node.operator === "align.samtools_sort_gatk");
  const bamIndex = candidate.graph.nodes.find((node) => node.operator === "align.samtools_index");
  const caller = candidate.graph.nodes.find((node) => node.operator === "var.haplotypecaller");
  assert.ok(reference && fq2bam && readGroups && sort && bamIndex && caller);
  assert.ok(candidate.graph.edges.some((edge) => edge.to_node === fq2bam.id && edge.to_port === "r1"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === reference.id && edge.to_node === fq2bam.id && edge.to_port === "ref"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === fq2bam.id && edge.to_node === readGroups.id && edge.to_port === "bam"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === readGroups.id && edge.to_node === sort.id && edge.to_port === "bam"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === sort.id && edge.to_node === bamIndex.id && edge.to_port === "bam"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === sort.id && edge.to_node === caller.id && edge.to_port === "bam"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === bamIndex.id && edge.to_node === caller.id && edge.to_port === "bai"));
  assert.ok(candidate.graph.edges.some((edge) => edge.from_node === reference.id && edge.to_node === caller.id && edge.to_port === "ref"));
  assert.equal(candidate.graph.nodes.some((node) => node.operator === "align.bwa"), false);
  assert.equal(candidate.graph.nodes.some((node) => node.operator === "gap.missing" && node.params?.tool === "BWA-MEM2"), false,
    "fq2bam already represents the paper's composite BWA-MEM2 and duplicate-marking module");
});

test("does not turn an explicitly rejected aligner comparison into a workflow branch", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Paired-end RNA-seq reads were aligned with HISAT2, selected over STAR, and quantified with featureCounts.",
  ].join("\n"), "jats");

  const hisat2 = review.mentions.find((mention) => mention.operator_id === "align.hisat2");
  const star = review.mentions.find((mention) => mention.operator_id === "align.star");
  assert.equal(hisat2?.executable, true);
  assert.equal(star?.executable, false);
  assert.ok(review.candidates.some((candidate) => candidate.graph.nodes.some((node) => node.operator === "align.hisat2")));
  assert.equal(review.candidates.some((candidate) => candidate.graph.nodes.some((node) => node.operator === "align.star")), false);
});

test("retains named single-cell allelic methods while keeping rejected comparisons non-executable", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Single-cell RNA-seq reads were aligned with HISAT2 and deduplicated using UMI-tools.",
    "Reference-mapping bias was corrected using WASP and allelic imbalance was modeled with MIXALIME.",
    "cellsnp-lite, DAESC, and scDALI were benchmarked but not selected.",
  ].join("\n"), "jats");

  const mentions = new Map(review.mentions.map((mention) => [mention.normalized_name, mention]));
  for (const method of ["umitools", "wasp", "mixalime"]) assert.equal(mentions.get(method)?.executable, true, method);
  for (const method of ["cellsnplite", "daesc", "scdali"]) assert.equal(mentions.get(method)?.executable, false, method);
  const nodes = review.candidates.flatMap((candidate) => candidate.graph.nodes);
  assert.ok(nodes.some((node) => node.operator === "gap.missing" && node.params?.tool === "UMI-tools"));
  assert.ok(nodes.some((node) => node.operator === "gap.missing" && node.params?.tool === "WASP"));
  assert.ok(nodes.some((node) => node.operator === "gap.missing" && node.params?.tool === "MIXALIME"));
  assert.equal(nodes.some((node) => ["cellsnp-lite", "DAESC", "scDALI"].includes(String(node.params?.tool))), false);
});

test("retains a paper's exact cited GitHub workflow instead of treating every repository as a pipeline", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "The NEXT-scASV Nextflow pipeline is available at https://github.com/MedvedevaLab/NEXT-scASV.",
    "General plotting utilities are at https://github.com/example/plot-colors.",
    "Reads were aligned with HISAT2 and variants were filtered with bcftools.",
  ].join("\n"), "jats");

  assert.equal(review.workflow_sources?.length, 1);
  assert.equal(review.workflow_sources?.[0]?.provider, "github");
  assert.equal(review.workflow_sources?.[0]?.repository, "https://github.com/MedvedevaLab/NEXT-scASV");
  assert.match(review.workflow_sources?.[0]?.context ?? "", /Nextflow pipeline is available/i);
});

test("retains the NEXT-scASV project homepage when its source-code availability section supplies the evidence", () => {
  const citations = paperWorkflowCitations([
    "Availability of source code and requirements",
    "Project name: NEXT-scASV",
    "Project homepage: https://github.com/MedvedevaLab/NEXT-scASV",
    "License: MIT license",
  ].join("\n"), "jats");

  assert.deepEqual(citations.map((citation) => citation.repository), [
    "https://github.com/MedvedevaLab/NEXT-scASV",
  ]);
});

test("retains an explicit source-code availability citation without requiring a workflow keyword", () => {
  const citations = paperWorkflowCitations(
    "The source code is available from https://github.com/example/reproducible-analysis.",
    "jats",
  );

  assert.deepEqual(citations.map((citation) => citation.repository), [
    "https://github.com/example/reproducible-analysis",
  ]);
});

test("does not label generic project homepages or implementation repositories as cited workflows", () => {
  const citations = paperWorkflowCitations([
    "Project homepage: https://github.com/example/statistics-package",
    "The visualization was implemented in R at https://github.com/example/plotting-utilities.",
    "The trained model implementation is hosted at https://github.com/example/model-weights.",
    "Analysis code: https://github.com/example/figure-scripts.",
    "Code is freely available at https://github.com/example/general-code.",
  ].join("\n"), "jats");

  assert.deepEqual(citations, []);
});

test("keeps the longest branded executable name and places it only in its evidenced assay", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Genome assembly",
    "PacBio reads were processed into HiFi reads with SMRT Link v13.1 and genome size was estimated with GenomeScope v2.0.",
    "The HiFi reads were assembled with hifiasm.",
    "RNA sequencing",
    "RNA-seq reads were aligned with STAR and quantified with featureCounts.",
  ].join("\n"), "jats");

  const mentions = new Map(review.mentions.map((mention) => [mention.normalized_name, mention]));
  assert.equal(mentions.get("smrtlink")?.display_name, "SMRT Link");
  assert.equal(mentions.has("link"), false, "a suffix of the branded executable became a method");
  const assembly = review.candidates.find((candidate) => candidate.assay === "assembly");
  const rna = review.candidates.find((candidate) => candidate.assay === "rna_seq");
  assert.ok(assembly && rna);
  const tools = (candidate: typeof assembly) => new Set(candidate.graph.nodes
    .filter((node) => node.operator === "gap.missing")
    .map((node) => String(node.params?.tool).replaceAll(/[^A-Za-z0-9]/g, "").toLocaleLowerCase("en-US")));
  assert.ok(tools(assembly).has("smrtlink"));
  assert.ok(tools(assembly).has("genomescope"));
  assert.equal(tools(rna).has("smrtlink"), false);
  assert.equal(tools(rna).has("genomescope"), false, "method placement fell back to another assay");
});

test("classifies viewers, comparators, and internal components before graph projection", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Long reads were assembled with Canu v2.2 and annotated with BRAKER3 v3.0.8, which used AUGUSTUS as an internal component.",
    "FigTree v1.4.4 was used only to view the resulting phylogeny.",
    "RNA-MosaicHunter identified RNA mosaic variants; MuTect v1.1.7 was evaluated only as a comparator and was not part of the workflow.",
  ].join("\n"), "jats");

  const mentions = new Map(review.mentions.map((mention) => [mention.normalized_name, mention]));
  assert.equal(mentions.get("figtree")?.executable, false);
  assert.equal(mentions.get("augustus")?.executable, false);
  assert.equal(mentions.get("mutect")?.executable, false);
  assert.equal(mentions.has("mutect2"), false, "MuTect comparator evidence was rewritten as Mutect2");
  const projected = review.candidates.flatMap((candidate) => candidate.graph.nodes);
  for (const forbidden of ["FigTree", "AUGUSTUS", "MuTect", "Mutect2"]) {
    assert.equal(projected.some((node) => node.operator === "gap.missing" && node.params?.tool === forbidden), false, forbidden);
  }
});

test("a named core workflow cannot disappear behind supporting-tool nodes", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "RNA-MosaicHunter was the core workflow used to identify RNA mosaic variants.",
    "The RNA-MosaicHunter source code is available at https://github.com/example/RNA-MosaicHunter.",
    "STAR aligned the RNA-seq reads before the workflow was run.",
  ].join("\n"), "jats");

  const core = review.mentions.find((mention) => mention.normalized_name === "rnamosaichunter");
  assert.ok(core, "the named core workflow was not retained as method evidence");
  const represented = review.candidates.some((candidate) => candidate.graph.nodes.some((node) => (
    node.operator === core.operator_id
    || (node.operator === "gap.missing"
      && String(node.params?.tool).replaceAll(/[^A-Za-z0-9]/g, "").toLocaleLowerCase("en-US") === "rnamosaichunter")
  )));
  assert.ok(
    represented || (review.outcome === "recognized_unsupported" && review.candidates.length === 0),
    "supporting STAR nodes produced a misleading draft after the core workflow disappeared",
  );
});

test("Picard SamToFastq remains action-specific unsupported evidence", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, [
    "Methods",
    "Picard SamToFastq v3.1.1 converted aligned BAM files into paired FASTQ reads.",
    "STAR then aligned those RNA-seq reads to the reference genome.",
  ].join("\n"), "jats");

  const picard = review.mentions.find((mention) => /Picard/i.test(mention.display_name));
  assert.ok(picard);
  assert.match(picard.evidence, /SamToFastq/i);
  assert.equal(picard.operator_id, undefined);
  const nodes = review.candidates.flatMap((candidate) => candidate.graph.nodes);
  assert.equal(nodes.some((node) => node.operator === "align.picard_mark_duplicates"), false);
  const retained = nodes.find((node) => node.operator === "gap.missing" && /Picard/i.test(String(node.params?.tool)));
  assert.ok(retained, "the unsupported action evidence disappeared");
  assert.equal(retained.ports.length, 0, "an unknown action acquired a generic Bam-to-Bam contract");
});
