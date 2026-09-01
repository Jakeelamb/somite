import { assessWorkflow, type WorkflowAssessment } from "./assessment.ts";
import { OperatorCatalog, operatorPorts, type PinnedOperator } from "./catalog.ts";
import { MAX_PAPER_RESOURCE_CITATIONS, MAX_PAPER_REVIEW_BYTES } from "./limits.ts";
import type { ParamValue, PortType, SomiteGraph, SomiteGraphNode, SomitePort } from "./model.ts";
import { compatiblePortTypes, validateGraph } from "./workflow.ts";

export type PaperExtractVia = "text" | "pdfjs" | "ocr" | "jats";
export type PaperReconstructionOutcome = "drafts_ready" | "recognized_unsupported" | "no_reconstructable_methods";

export type PaperEvidence = {
  target_kind: "node" | "edge";
  target_id: string;
  status: "explicit" | "inferred" | "needs_adapter";
  detail: string;
  resolution_kind?: "input_required" | "managed_tool" | "source_workflow" | "built_in" | "system_tool" | "manual_checkpoint" | "method_details" | "legacy_source" | "adapter";
  resolution_label?: string;
  resolution_detail?: string;
  resolution_required?: boolean;
  source_location?: string;
};

export type PaperMethodMention = {
  display_name: string;
  normalized_name: string;
  operation_class?: string;
  version?: string;
  evidence: string;
  support: "operator" | "unsupported";
  executable?: boolean;
  core?: boolean;
  operator_id?: string;
  source_location?: string;
};

export type PaperResourceCitation = {
  accession: string;
  kind: "sra_study" | "sra_sample" | "sra_experiment" | "sra_run" | "bioproject" | "biosample" | "assembly" | "ensembl";
  role: "reads" | "reference" | "annotation" | "sample_metadata" | "unknown";
  context: string;
  source_location?: string;
};

export type PaperWorkflowCitation = {
  provider: "github";
  repository: string;
  context: string;
  source_location?: string;
};

export type PaperCandidate = {
  name: string;
  role: "primary" | "parallel" | "alternative";
  assay: string;
  graph: SomiteGraph;
  warnings: string[];
  evidence: PaperEvidence[];
  assessment: WorkflowAssessment;
};

export type PaperReview = {
  extracted_via: PaperExtractVia;
  outcome: PaperReconstructionOutcome;
  warnings: string[];
  mentions: PaperMethodMention[];
  resources: PaperResourceCitation[];
  workflow_sources?: PaperWorkflowCitation[];
  candidates: PaperCandidate[];
};

export class PaperReviewLimitError extends Error {
  readonly code = "paper_reconstruction_limit";
  readonly retryable = false;
  readonly sizeBytes: number;
  readonly maximumBytes: number;

  constructor(sizeBytes: number, maximumBytes: number) {
    super(`Paper reconstruction is ${sizeBytes} bytes; the limit is ${maximumBytes} bytes.`);
    this.name = "PaperReviewLimitError";
    this.sizeBytes = sizeBytes;
    this.maximumBytes = maximumBytes;
  }
}

type Assay = "assembly" | "rna_seq" | "variants" | "metagenome" | "single_cell" | "qc" | "unknown";

type UnsupportedMethodPorts = Readonly<{
  input: PortType;
  inputUnion?: readonly PortType[];
  inputs?: readonly Readonly<{
    name: string;
    type: PortType;
    union?: readonly PortType[];
    optional?: boolean;
  }>[];
  output: PortType;
  outputName?: string;
}>;

type UnsupportedMethod = Readonly<{
  displayName: string;
  normalizedName: string;
  operationClass: string;
  aliases: readonly string[];
  assays?: readonly Assay[];
  ports?: UnsupportedMethodPorts;
}>;

type LocatedMention = PaperMethodMention & {
  offset: number;
  end: number;
  executable: boolean;
  aliases: readonly string[];
  assays?: readonly Assay[];
  ports?: UnsupportedMethodPorts;
};

const unsupportedMethods: readonly UnsupportedMethod[] = [
  { displayName: "ARTIC", normalizedName: "artic", operationClass: "amplicon_sequencing", aliases: ["artic workflow", "artic pipeline", "artic"], assays: ["variants"] },
  { displayName: "Freyja", normalizedName: "freyja", operationClass: "variant_calling", aliases: ["freyja"], assays: ["variants"] },
  { displayName: "Ballgown", normalizedName: "ballgown", operationClass: "differential_expression", aliases: ["ballgown"], assays: ["rna_seq"], ports: { input: "Gtf", output: "Table" } },
  { displayName: "Kallisto", normalizedName: "kallisto", operationClass: "transcript_quantification", aliases: ["kallisto"], assays: ["rna_seq"], ports: { input: "Fastq", output: "Table" } },
  { displayName: "MultiQC", normalizedName: "multiqc", operationClass: "aggregate_qc", aliases: ["multiqc"], ports: { input: "Directory", output: "Html" } },
  { displayName: "Picard", normalizedName: "picard", operationClass: "bam_processing", aliases: ["picard", "markduplicates"], assays: ["rna_seq", "variants"] },
  { displayName: "Mutect2", normalizedName: "mutect2", operationClass: "variant_calling", aliases: ["mutect2"], assays: ["variants"], ports: { input: "Bam", output: "Vcf" } },
  { displayName: "MuTect", normalizedName: "mutect", operationClass: "variant_calling", aliases: ["mutect"], assays: ["variants"], ports: { input: "Bam", output: "Vcf" } },
  { displayName: "MetaBAT", normalizedName: "metabat", operationClass: "binning", aliases: ["metabat"], assays: ["metagenome"], ports: { input: "Bam", output: "Directory" } },
  { displayName: "SPAdes", normalizedName: "spades", operationClass: "assemble", aliases: ["spades"], assays: ["assembly", "metagenome"], ports: { input: "Fastq", output: "Directory" } },
  { displayName: "Cell Ranger", normalizedName: "cellranger", operationClass: "single_cell_preprocessing", aliases: ["cellranger", "cell ranger"], assays: ["single_cell"], ports: { input: "Fastq", output: "Directory" } },
  { displayName: "SoupX", normalizedName: "soupx", operationClass: "ambient_rna_correction", aliases: ["soupx"], assays: ["single_cell"], ports: { input: "Directory", output: "Directory" } },
  { displayName: "Seurat", normalizedName: "seurat", operationClass: "single_cell_analysis", aliases: ["seurat"], assays: ["single_cell"], ports: { input: "Directory", output: "Directory" } },
  { displayName: "Seurat AggregateExpression", normalizedName: "seurataggregateexpression", operationClass: "single_cell_aggregation", aliases: ["aggregateexpression"], assays: ["single_cell"], ports: { input: "Directory", output: "Table" } },
  { displayName: "DoubletFinder", normalizedName: "doubletfinder", operationClass: "doublet_detection", aliases: ["doubletfinder", "doublet finder"], assays: ["single_cell"], ports: { input: "Directory", output: "Directory" } },
  { displayName: "Cutadapt", normalizedName: "cutadapt", operationClass: "trim", aliases: ["cutadapt"] },
  { displayName: "Trimmomatic", normalizedName: "trimmomatic", operationClass: "trim", aliases: ["trimmomatic"] },
  { displayName: "Trim Galore", normalizedName: "trimgalore", operationClass: "trim", aliases: ["trim galore", "trimgalore"], assays: ["assembly", "rna_seq", "variants", "metagenome"], ports: { input: "Fastq", inputUnion: ["FastqGz"], output: "FastqGz" } },
  { displayName: "Porechop", normalizedName: "porechop", operationClass: "trim", aliases: ["porechop"], assays: ["assembly"] },
  { displayName: "dnaPipeTE", normalizedName: "dnapipete", operationClass: "repeat_discovery", aliases: ["dnapipete", "dna pipe te"], assays: ["assembly"] },
  { displayName: "PiRATE", normalizedName: "pirate", operationClass: "repeat_annotation", aliases: ["pirate"], assays: ["assembly"] },
  { displayName: "dipSPAdes", normalizedName: "dipspades", operationClass: "assemble", aliases: ["dipspades"], assays: ["assembly"] },
  { displayName: "RepeatModeler", normalizedName: "repeatmodeler", operationClass: "repeat_discovery", aliases: ["repeatmodeler"], assays: ["assembly"] },
  { displayName: "seqkit", normalizedName: "seqkit", operationClass: "sequence_processing", aliases: ["seqkit"] },
  { displayName: "parseRM.pl", normalizedName: "parsermpl", operationClass: "repeat_summary", aliases: ["parserm.pl"], assays: ["assembly"] },
  { displayName: "LTRpred", normalizedName: "ltrpred", operationClass: "ltr_annotation", aliases: ["ltrpred"], assays: ["assembly"] },
  { displayName: "Trinotate", normalizedName: "trinotate", operationClass: "transcript_annotation", aliases: ["trinotate"], assays: ["rna_seq", "assembly"] },
  { displayName: "CD-HIT-est", normalizedName: "cdhitest", operationClass: "sequence_clustering", aliases: ["cd-hit-est"], assays: ["rna_seq", "assembly"] },
  { displayName: "Trinity", normalizedName: "trinity", operationClass: "assemble", aliases: ["trinity"], assays: ["rna_seq", "assembly"] },
  { displayName: "FALCON", normalizedName: "falcon", operationClass: "assemble", aliases: ["falcon-unzip", "falcon unzip", "falcon"], assays: ["assembly"], ports: { input: "Fastq", output: "Fasta" } },
  { displayName: "Flye", normalizedName: "flye", operationClass: "assemble", aliases: ["flye"], assays: ["assembly"], ports: { input: "Fastq", output: "Fasta" } },
  { displayName: "Purge_Dups", normalizedName: "purgedups", operationClass: "purge_haplotigs", aliases: ["purge_dups", "purge dups", "purge_haplotigs", "purge haplotigs"], assays: ["assembly"], ports: { input: "Fasta", output: "Fasta" } },
  { displayName: "Salsa", normalizedName: "salsa", operationClass: "scaffold", aliases: ["salsa"], assays: ["assembly"], ports: { input: "Fasta", output: "Fasta" } },
  { displayName: "RepeatMasker", normalizedName: "repeatmasker", operationClass: "repeat_annotation", aliases: ["repeatmasker", "repeat masker"], assays: ["assembly"] },
  { displayName: "Jellyfish", normalizedName: "jellyfish", operationClass: "kmer_counting", aliases: ["jellyfish"], assays: ["assembly"], ports: { input: "Fastq", inputUnion: ["FastqGz"], output: "Table" } },
  { displayName: "MaSuRCA", normalizedName: "masurca", operationClass: "assemble", aliases: ["masurca"], assays: ["assembly"], ports: { input: "Fastq", inputUnion: ["FastqGz"], output: "Fasta" } },
  { displayName: "Redundans", normalizedName: "redundans", operationClass: "scaffold", aliases: ["redundans"], assays: ["assembly"], ports: { input: "Fasta", inputUnion: ["FastaGz"], output: "Fasta" } },
  { displayName: "RagTag", normalizedName: "ragtag", operationClass: "scaffold", aliases: ["ragtag"], assays: ["assembly"], ports: { input: "Fasta", inputUnion: ["FastaGz"], output: "Fasta" } },
  { displayName: "ABySS Sealer", normalizedName: "abysssealer", operationClass: "gap_closing", aliases: ["abyss-sealer", "abyss sealer"], assays: ["assembly"], ports: { input: "Fasta", inputUnion: ["FastaGz"], output: "Fasta" } },
  { displayName: "BRAKER3", normalizedName: "braker3", operationClass: "genome_annotation", aliases: ["braker3", "braker"], assays: ["assembly"] },
  { displayName: "AUGUSTUS", normalizedName: "augustus", operationClass: "gene_prediction", aliases: ["augustus"], assays: ["assembly"] },
  { displayName: "LiftOn", normalizedName: "lifton", operationClass: "annotation_liftover", aliases: ["lifton"], assays: ["assembly"] },
  { displayName: "FCS Adaptor", normalizedName: "fcsadaptor", operationClass: "contamination_screening", aliases: ["fcs adaptor", "fcs-adaptor"], assays: ["assembly"] },
  { displayName: "FCS-GX", normalizedName: "fcsgx", operationClass: "contamination_screening", aliases: ["fcs-gx", "fcs gx"], assays: ["assembly"] },
  {
    displayName: "BWA-MEM2",
    normalizedName: "bwamem2",
    operationClass: "read_alignment",
    aliases: ["bwa-mem2", "bwa mem2"],
    assays: ["assembly", "variants"],
    ports: {
      input: "Fastq",
      inputs: [
        { name: "r1", type: "Fastq", union: ["FastqGz"] },
        { name: "r2", type: "Fastq", union: ["FastqGz"], optional: true },
        { name: "ref", type: "Fasta", union: ["FastaGz"] },
      ],
      output: "Sam",
      outputName: "sam",
    },
  },
  { displayName: "SAMtools", normalizedName: "samtools", operationClass: "bam_processing", aliases: ["samtools"], assays: ["assembly", "variants"] },
  { displayName: "NVIDIA Parabricks", normalizedName: "nvidiaparabricks", operationClass: "accelerated_genomics_suite", aliases: ["nvidia parabricks"], assays: ["variants"] },
  {
    displayName: "Parabricks fq2bam",
    normalizedName: "parabricksfq2bam",
    operationClass: "read_alignment",
    aliases: ["fq2bam"],
    assays: ["variants"],
    ports: {
      input: "Fastq",
      inputs: [
        { name: "r1", type: "Fastq", union: ["FastqGz"] },
        { name: "r2", type: "Fastq", union: ["FastqGz"], optional: true },
        { name: "ref", type: "Fasta", union: ["FastaGz"] },
      ],
      output: "Bam",
      outputName: "bam",
    },
  },
  { displayName: "Another Gtf/Gff Analysis Toolkit (AGAT)", normalizedName: "agat", operationClass: "annotation_processing", aliases: ["another gtf/gff analysis toolkit", "agat"], assays: ["assembly"] },
  { displayName: "FreeBayes", normalizedName: "freebayes", operationClass: "variant_calling", aliases: ["freebayes"], assays: ["variants"], ports: { input: "Bam", output: "Vcf" } },
  { displayName: "BCFtools", normalizedName: "bcftools", operationClass: "variant_filtering", aliases: ["bcftools"], assays: ["variants"], ports: { input: "Vcf", output: "Vcf" } },
  { displayName: "UMI-tools", normalizedName: "umitools", operationClass: "deduplication", aliases: ["umi-tools", "umi_tools", "umi tools"], assays: ["rna_seq", "single_cell", "variants"], ports: { input: "Bam", output: "Bam" } },
  { displayName: "WASP", normalizedName: "wasp", operationClass: "reference_bias_correction", aliases: ["wasp"], assays: ["rna_seq", "single_cell", "variants"], ports: { input: "Bam", output: "Bam" } },
  { displayName: "MIXALIME", normalizedName: "mixalime", operationClass: "allelic_imbalance_modeling", aliases: ["mixalime"], assays: ["rna_seq", "single_cell", "variants"] },
  { displayName: "cellsnp-lite", normalizedName: "cellsnplite", operationClass: "single_cell_variant_calling", aliases: ["cellsnp-lite", "cellsnp lite", "cellsnp_lite"], assays: ["single_cell", "variants"] },
  { displayName: "DAESC", normalizedName: "daesc", operationClass: "allele_specific_expression", aliases: ["daesc"], assays: ["single_cell", "rna_seq"] },
  { displayName: "scDALI", normalizedName: "scdali", operationClass: "allele_specific_expression", aliases: ["scdali", "sc-dali"], assays: ["single_cell", "rna_seq"] },
  { displayName: "Bionano Solve", normalizedName: "bionanosolve", operationClass: "optical_map_scaffolding", aliases: ["bionano solve"], assays: ["assembly"] },
  { displayName: "Stairway Plot", normalizedName: "stairwayplot", operationClass: "demographic_modeling", aliases: ["stairway plot"] },
  { displayName: "phytools", normalizedName: "phytools", operationClass: "phylogenetic_analysis", aliases: ["r package phytools", "phytools"] },
  { displayName: "OUwie", normalizedName: "ouwie", operationClass: "phylogenetic_modeling", aliases: ["ouwie"] },
  { displayName: "R", normalizedName: "r", operationClass: "statistical_analysis", aliases: ["r statistical computing environment", "r statistical environment", "using r version"] },
  { displayName: "Custom script", normalizedName: "custom-script", operationClass: "custom_analysis", aliases: ["custom perl script", "custom python script", "custom script"] },
];

const startHeadings = ["materials and methods", "materials & methods", "online methods", "experimental procedures", "computational methods", "methods", "method"];
const endHeadings = ["results", "discussion", "data availability", "code availability", "acknowledgements", "acknowledgments", "author contributions", "competing interests", "references", "bibliography"];
const rnaCovers = new Set(["align.star", "align.hisat2", "qc.multiqc", "quant.salmon", "quant.featurecounts", "quant.stringtie"]);
const variantCovers = new Set(["align.bwa", "align.picard_mark_duplicates", "var.haplotypecaller"]);
const metagenomeCovers = new Set(["class.kraken2"]);

function normalizedName(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "").toLocaleLowerCase("en-US");
}

function headingOffset(text: string, headings: readonly string[], from = 0) {
  let offset = from;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const nextOffset = newline < 0 ? text.length : newline + 1;
    const line = text.slice(offset, nextOffset);
    const content = line.replace(/[\s\f]+$/g, "").toLocaleLowerCase("en-US");
    const first = content.search(/[^\s\f]/);
    if (first >= 0) {
      const rest = content.slice(first);
      for (const heading of headings) {
        if (rest.startsWith(heading)) {
          const suffix = rest.slice(heading.length);
          if (!suffix || /^[.:\f]/.test(suffix) || /^\s{4,}\S/.test(suffix)) return offset + first;
        }
        if (rest.endsWith(heading)) {
          const at = content.length - heading.length;
          if (/\s{4,}$/.test(content.slice(0, at))) return offset + at;
        }
      }
    }
    offset = nextOffset;
  }
  return undefined;
}

/** Evidence window only; extraction always reads the complete document first. */
export function paperMethodsWindow(text: string) {
  const front = text.slice(0, 2_048).toLocaleLowerCase("en-US");
  if (front.includes("type methods") || (front.includes("subjects:") && front.includes("bioinformatics, methods"))) {
    const end = headingOffset(text, ["references", "bibliography"]) ?? text.length;
    return { text: text.slice(0, end), offset: 0 };
  }
  const start = headingOffset(text, startHeadings);
  if (start !== undefined && start * 10 < text.length * 9) {
    const nextLine = text.indexOf("\n", start);
    const searchFrom = nextLine < 0 ? start : nextLine + 1;
    const end = headingOffset(text, endHeadings, searchFrom) ?? text.length;
    const pageStart = text.lastIndexOf("\f", start - 1) + 1;
    const slice = text.slice(pageStart, end);
    if (slice.length >= 40) return { text: slice, offset: pageStart };
  }
  const end = headingOffset(text, ["references", "bibliography"]) ?? text.length;
  return { text: text.slice(0, end), offset: 0 };
}

function escapedAlias(alias: string) {
  return alias.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
}

type CompiledAliasMatcher = Readonly<{
  expression: RegExp;
}>;

type CatalogRecognitionPlanEntry = Readonly<{
  operator: PinnedOperator;
  paper: NonNullable<PinnedOperator["paper"]>;
  aliases: readonly CompiledAliasMatcher[];
}>;

type UnsupportedRecognitionPlanEntry = Readonly<{
  spec: UnsupportedMethod;
  aliases: readonly CompiledAliasMatcher[];
}>;

function compileAliasMatchers(aliases: readonly string[]) {
  return Object.freeze(aliases.map((alias): CompiledAliasMatcher => {
    const exactCase = alias.length <= 4 && /^[A-Z]+$/.test(alias);
    return Object.freeze({
      expression: new RegExp(`(^|[^A-Za-z0-9_+-])(${escapedAlias(alias)})(?=$|[^A-Za-z0-9_+-])`, exactCase ? "g" : "gi"),
    });
  }));
}

const unsupportedRecognitionPlan: readonly UnsupportedRecognitionPlanEntry[] = Object.freeze(unsupportedMethods.map((spec) => Object.freeze({
  spec,
  aliases: compileAliasMatchers(spec.aliases),
})));
const catalogRecognitionPlans = new WeakMap<OperatorCatalog, readonly CatalogRecognitionPlanEntry[]>();

function catalogRecognitionPlan(catalog: OperatorCatalog) {
  const cached = catalogRecognitionPlans.get(catalog);
  if (cached) return cached;
  const plan: CatalogRecognitionPlanEntry[] = [];
  for (const operator of catalog.values()) {
    if (!operator.paper) continue;
    plan.push(Object.freeze({ operator, paper: operator.paper, aliases: compileAliasMatchers(operator.paper.aliases) }));
  }
  const immutable = Object.freeze(plan);
  catalogRecognitionPlans.set(catalog, immutable);
  return immutable;
}

function aliasMatchSummary(text: string, aliases: readonly CompiledAliasMatcher[]) {
  let first: { start: number; end: number } | undefined;
  let firstExecutable: { start: number; end: number } | undefined;
  for (const { expression } of aliases) {
    const classifyExecutable = executableMatchClassifier(text);
    expression.lastIndex = 0;
    try {
      for (let match = expression.exec(text); match; match = expression.exec(text)) {
        const prefix = match[1] ?? "";
        const surface = match[2] ?? "";
        const start = (match.index ?? 0) + prefix.length;
        const end = start + surface.length;
        if (!first || start < first.start) first = { start, end };
        if (classifyExecutable(start, end)) {
          if (!firstExecutable || start < firstExecutable.start) firstExecutable = { start, end };
          break;
        }
        if (match[0].length === 0) expression.lastIndex += 1;
      }
    } finally {
      expression.lastIndex = 0;
    }
  }
  return first ? { first, firstExecutable } : undefined;
}

function dynamicAliasMatchSummary(text: string, aliases: readonly string[]) {
  return aliasMatchSummary(text, compileAliasMatchers(aliases));
}

function detectedVersion(text: string, end: number) {
  const matched = text.slice(end, Math.min(text.length, end + 48))
    .match(/^\s*(?:\(\s*)?(?:version\s*)?v?([0-9]+(?:\.[0-9]+)+(?:[-._]?[A-Za-z0-9]+)?)/i);
  return matched?.[1];
}

const NON_EXECUTABLE_BEFORE = [
  "without",
  "did not use",
  "not using",
  "rather than",
  "instead of",
  "over",
  "compared",
  "comparing",
  "benchmarked",
  "evaluated",
] as const;
const NON_EXECUTABLE_AFTER = ["not used", "not selected", "not retained"] as const;

function asciiLower(code: number) {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

function asciiEqualAt(text: string, offset: number, expected: string, end: number) {
  if (offset < 0 || offset + expected.length > end) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (asciiLower(text.charCodeAt(offset + index)) !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function trimWhitespace(code: number) {
  return (code >= 0x09 && code <= 0x0d)
    || code === 0x20
    || code === 0xa0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff;
}

function trimmedEnd(text: string, left: number, end: number) {
  let trimmedEnd = end;
  while (trimmedEnd > left && trimWhitespace(text.charCodeAt(trimmedEnd - 1))) trimmedEnd -= 1;
  return trimmedEnd;
}

function endsWithAsciiMarker(text: string, left: number, end: number, marker: string) {
  const markerStart = end - marker.length;
  return markerStart >= left && asciiEqualAt(text, markerStart, marker, end);
}

function boundedClause(text: string, start: number, end: number) {
  const boundary = (offset: number) => {
    const value = text[offset];
    if (value === ";" || value === "\n") return true;
    if (value !== ".") return false;
    return !(/\d/.test(text[offset - 1] ?? "") && /\d/.test(text[offset + 1] ?? ""));
  };
  const maximumLeft = Math.max(0, start - 512);
  let left = start;
  while (left > maximumLeft && !boundary(left - 1)) left -= 1;
  const maximumRight = Math.min(text.length, end + 512);
  let right = end;
  while (right < maximumRight && !boundary(right)) right += 1;
  return {
    before: text.slice(left, start).replace(/\s+/g, " ").trim(),
    after: text.slice(end, right).replace(/\s+/g, " ").trim(),
    text: text.slice(left, right).replace(/\s+/g, " ").trim(),
  };
}

function semanticNonExecutableContext(text: string, start: number, end: number) {
  const clause = boundedClause(text, start, end);
  const roleWindow = text.slice(Math.max(0, start - 512), Math.min(text.length, end + 512)).replace(/\s+/g, " ");
  if (/\b(?:view(?:ed|ing)?|visuali[sz](?:ed|ing)?|display(?:ed|ing)?|inspect(?:ed|ing)?|edit(?:ed|ing)?|manual(?:ly)?\s+curat(?:ed|ing))\b(?:\s+and\s+[A-Za-z-]+){0,2}\s+(?:with|using)\s*$/i.test(clause.before)) {
    return true;
  }
  if (/^\s*(?:\[[^\]]+\]\s*)?(?:was|were|is|are)?\s*(?:used\s+)?only\s+as\s+(?:a\s+)?comparator\b/i.test(clause.after)
    || /\b(?:not\s+part\s+of|not\s+used\s+in)\s+(?:the\s+)?(?:workflow|pipeline|analysis)\b/i.test(clause.after)) {
    return true;
  }
  if (/^\s*(?:\(?(?:version\s*)?v\.?\s*\d+(?:\.\d+)+(?:[-._]?[A-Za-z0-9]+)?\)?\s*)?(?:was|were|is|are)\s+used\s+only\s+to\s+(?:view|visuali[sz]e|display|inspect|edit)\b/i.test(clause.after)) {
    return true;
  }
  if (/\b(?:as\s+(?:its|an?|the)\s+)?(?:internal\s+)?(?:component|module|backbone)\b/i.test(clause.after)
    || (/\b(?:integrates?|incorporates?)\b/i.test(clause.before)
      && /^(?:(?:\s*\[[^\]]+\]|\s*\(\s*[^)]{1,24}\s*\)|\s*\d+))*\s+to\b/i.test(clause.after))) {
    return true;
  }
  if (/\b(?:compar(?:e|ed|ing|ison)|benchmark(?:ed|ing)?|evaluat(?:e|ed|ing|ion))\b/i.test(clause.text)
    && /\b(?:comparator|previous\s+(?:tool|method)|call\s+set|performance|outperform)/i.test(clause.text)) {
    return true;
  }
  if (/\b(?:sensitivity|specificity|benchmark|comparison)\b/i.test(clause.text)
    && /\b(?:variants?|calls?|sites?)\s+(?:reported|called|detected)\s+by\s*$/i.test(clause.before)) {
    return true;
  }
  if (/\b(?:sensitivity|specificity|precision|benchmark|comparison|reference\s+set|recaptured|confirmed|missed)\b/i.test(roleWindow)
    && /\b(?:reported|called|detected|missed|confirmed)\s+by\s*$/i.test(clause.before)) {
    return true;
  }
  if (/\b(?:calls?|results?|outputs?)\b/i.test(clause.before)
    && /\b(?:downloaded|obtained)\b/i.test(clause.after)) {
    return true;
  }
  return false;
}

function executableMatchClassifier(text: string) {
  let left = 0;
  let scannedTo = 0;
  let right = -1;
  let lastAfter = -1;
  return (start: number, end: number) => {
    for (let offset = scannedTo; offset < start; offset += 1) {
      const code = text.charCodeAt(offset);
      if (code === 0x2e || code === 0x3b || code === 0x0a) left = offset + 1;
    }
    scannedTo = start;
    if (end > right) {
      right = text.length;
      lastAfter = -1;
      for (let offset = end; offset < text.length; offset += 1) {
        const code = text.charCodeAt(offset);
        if (code === 0x2e || code === 0x3b || code === 0x0a) {
          right = offset;
          break;
        }
        if (asciiLower(code) !== 0x6e) continue;
        for (const marker of NON_EXECUTABLE_AFTER) {
          if (asciiEqualAt(text, offset, marker, text.length)) {
            lastAfter = offset;
            break;
          }
        }
      }
    }
    const beforeEnd = trimmedEnd(text, left, start);
    for (const marker of NON_EXECUTABLE_BEFORE) {
      if (endsWithAsciiMarker(text, left, beforeEnd, marker)) return false;
    }
    return lastAfter < end && !semanticNonExecutableContext(text, start, end);
  };
}

function executableMatch(text: string, start: number, end: number) {
  return executableMatchClassifier(text)(start, end);
}

function evidenceSnippet(text: string, start: number, end: number) {
  return text.slice(Math.max(0, start - 72), Math.min(text.length, end + 96)).replace(/\s+/g, " ").trim();
}

function directPrimaryAssemblyUse(text: string, mention: LocatedMention) {
  const clause = boundedClause(text, mention.offset, mention.end).text;
  const name = escapedAlias(mention.display_name);
  return new RegExp(
    `\\b(?:reads?|sequencing\\s+data)[^;\\n]{0,384}\\bassembled\\s+(?:with|using|by)\\s+${name}\\b|\\b${name}\\b[^;\\n]{0,128}\\b(?:used\\s+to\\s+)?assembl(?:e|ed|ing)\\b`,
    "i",
  ).test(clause);
}

function canBePrimaryAssemblyMethod(mention: LocatedMention) {
  return mention.operation_class === "assemble" || mention.operator_id === "asm.hifiasm";
}

function inferredNovelToolContract(methods: string, methodName?: string) {
  const lower = methods.toLocaleLowerCase("en-US");
  const named = methodName ? escapedAlias(methodName) : "[A-Za-z][A-Za-z0-9_.+-]*";
  const directlyPerforms = (action: string) => new RegExp(
    `(?:${action})[^.;\\n]{0,96}(?:with|using|by)\\s+${named}\\b|\\b${named}\\b[^.;\\n]{0,96}(?:${action})`,
    "i",
  ).test(methods);
  if (directlyPerforms("(?:variant|snp)\\s*call(?:ed|ing)?") && /\bbam\s+files?\b/i.test(methods) && /\bvcf\s+files?\b/i.test(methods)) {
    return { operationClass: "variant_calling", ports: { input: "Bam" as const, output: "Vcf" as const } };
  }
  if (directlyPerforms("(?:(?:genome|metagenome)\\s+assembl(?:ed|y|ing)?|assembled|assembler)")
    && /\b(?:fastq|sequencing reads?|long reads?|short reads?)\b/i.test(methods)
    && /\b(?:fasta|assembl(?:y|ies))\b/i.test(methods)) {
    return { operationClass: "assemble", ports: { input: "Fastq" as const, inputUnion: ["FastqGz" as const], output: "Fasta" as const } };
  }
  if (directlyPerforms("(?:align|mapp)(?:ed|ing|ment)?") && /\b(?:fastq|sequencing reads?)\b/i.test(methods) && /\bbam\b/i.test(methods)) {
    return { operationClass: "align", ports: { input: "Fastq" as const, inputUnion: ["FastqGz" as const], output: "Bam" as const } };
  }
  if (directlyPerforms("(?:quantif(?:ied|y|ication)|count(?:ed|ing)?)")
    && lower.includes("count matrix") && /\b(?:fastq|bam)\b/i.test(methods)) {
    return { operationClass: "quantification", ports: { input: lower.includes("bam") ? "Bam" as const : "Fastq" as const, output: "Table" as const } };
  }
  return undefined;
}

/**
 * Discover a paper's own named software conservatively from an explicit public
 * repository statement. This creates an evidence-backed gap, never an
 * executable contract; command and package details still require proof.
 */
function discoveredNovelMethods(fullText: string, methods: ReturnType<typeof paperMethodsWindow>): LocatedMention[] {
  const names = new Map<string, { displayName: string; core: boolean }>();
  const proseMethods = methods.text.replace(/https?:\/\/[^\s)\]}]+/gi, (value) => " ".repeat(value.length));
  const genericNames = new Set(["code", "sourcecode", "workflow", "pipeline", "implementation", "software", "package"]);
  const availability = /\b([A-Za-z][A-Za-z0-9_.+-]{2,40})(?:\s+v\.?\s*\d+(?:\.\d+)+)?\s+is\s+(?:freely\s+)?available\s+(?:at|on)\s+(?:https?:\/\/)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/gi;
  for (const match of fullText.matchAll(availability)) {
    const displayName = match[1]!;
    const normalized = normalizedName(displayName);
    if (normalized.length >= 3 && !/^v\d/i.test(normalized) && !genericNames.has(normalized)) names.set(normalized, { displayName, core: true });
  }
  const repository = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+)/gi;
  for (const match of fullText.matchAll(repository)) {
    const rawName = match[1]!.replace(/\.git$/i, "").replace(/[.,;:]+$/, "");
    const normalized = normalizedName(rawName);
    if (normalized.length < 3) continue;
    const start = Math.max(0, (match.index ?? 0) - 256);
    const end = Math.min(fullText.length, (match.index ?? 0) + match[0].length + 96);
    const context = fullText.slice(start, end);
    const beforeRepository = fullText.slice(start, match.index ?? 0);
    if (!/\b(?:source\s+code|workflows?|pipelines?|analysis\s+code|implementation|project\s+home\s*page)\b[^.\n]{0,192}\b(?:available|hosted|repository|github|page)\b[^.\n]{0,96}(?:\(?\s*)?$/i.test(beforeRepository)) continue;
    if (!dynamicAliasMatchSummary(proseMethods, [rawName])) continue;
    names.set(normalized, { displayName: rawName, core: true });
  }
  return [...names].flatMap(([normalized, { displayName, core }]): LocatedMention[] => {
    const matched = dynamicAliasMatchSummary(methods.text, [displayName]);
    if (!matched) return [];
    const selected = matched.firstExecutable ?? matched.first;
    const offset = methods.offset + selected.start;
    const end = methods.offset + selected.end;
    const version = detectedVersion(methods.text, selected.end);
    const contract = inferredNovelToolContract(methods.text, displayName);
    return [{
      display_name: displayName,
      normalized_name: normalized,
      ...(contract ? { operation_class: contract.operationClass, ports: contract.ports } : { operation_class: "novel_software" }),
      ...(version ? { version } : {}),
      evidence: evidenceSnippet(fullText, offset, end),
      support: "unsupported",
      offset,
      end,
      executable: matched.firstExecutable !== undefined,
      core,
      aliases: [displayName],
    }];
  });
}

const VERSIONED_METHOD_STOP_WORDS = new Set([
  "algorithm", "analysis", "assembly", "data", "document", "figure", "genome", "method", "methods", "our", "package", "pipeline", "program", "reads", "sample", "samples", "software", "suite", "supplement", "table", "the", "this", "tool", "version", "workflow",
]);

const VERSIONED_BRAND_BOUNDARIES = new Set([
  "a", "an", "and", "another", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "our", "the", "then", "to", "using", "was", "were", "with",
]);

function precedingVersionedBrand(text: string, markerStart: number) {
  let cursor = markerStart;
  while (cursor > 0 && /\s/.test(text[cursor - 1]!)) cursor -= 1;
  if (cursor > 0 && text[cursor - 1] === "(") {
    cursor -= 1;
    while (cursor > 0 && /\s/.test(text[cursor - 1]!)) cursor -= 1;
  }
  const end = cursor;
  const tokens: Array<{ value: string; start: number }> = [];
  while (tokens.length < 4 && cursor > 0) {
    const sliceStart = Math.max(0, cursor - 48);
    const tail = text.slice(sliceStart, cursor);
    const matched = tail.match(/([A-Za-z][A-Za-z0-9_.+\/-]{1,40})$/);
    if (!matched?.[1]) break;
    const value = matched[1];
    const normalized = normalizedName(value);
    const start = sliceStart + tail.length - value.length;
    if (VERSIONED_METHOD_STOP_WORDS.has(normalized) || VERSIONED_BRAND_BOUNDARIES.has(normalized)) break;
    if (tokens.length > 0 && !(/^[A-Z]/.test(value) || /[A-Z].*[A-Z0-9]|[0-9_.+\/-]/.test(value))) break;
    tokens.unshift({ value, start });
    cursor = start;
    while (cursor > 0 && /[ \t]/.test(text[cursor - 1]!)) cursor -= 1;
  }
  if (!tokens.length) return undefined;
  const start = tokens[0]!.start;
  const displayName = text.slice(start, end).replace(/\s+/g, " ").trim();
  const normalized = normalizedName(displayName);
  if (normalized.length < 3 || VERSIONED_METHOD_STOP_WORDS.has(normalized)) return undefined;
  return { displayName, normalized, start, end };
}

function inferredOperationClass(context: string) {
  if (/\b(?:scaffold|gap[- ]?clos|order(?:ed|ing)? and orient)/i.test(context)) return "scaffold";
  if (/\b(?:genome|metagenome)?\s*assembl|\bassembled\b|\bassembler\b/i.test(context)) return "assemble";
  if (/\b(?:annotat|gene model|gene predict|repeat mask)/i.test(context)) return "genome_annotation";
  if (/\b(?:align|mapp)(?:ed|ing|ment)?\b/i.test(context)) return "align";
  if (/\b(?:quantif|count matrix|feature count)/i.test(context)) return "quantification";
  if (/\b(?:trim|adapter remov|quality control)/i.test(context)) return "quality_control";
  return "novel_software";
}

/**
 * Retain versioned software used in executable method prose even when the
 * authors did not include a repository-availability sentence. Unknown tools
 * remain non-executable gaps; a typed gap is created only when the surrounding
 * sentence states enough input/output semantics for a conservative contract.
 */
function discoveredVersionedMethods(fullText: string, methods: ReturnType<typeof paperMethodsWindow>): LocatedMention[] {
  const found: LocatedMention[] = [];
  const versioned = /(^|[^A-Za-z0-9])((?:\(\s*)?(?:(?:version)\s*|v\.?\s*)([0-9]+(?:\.[0-9]+)+(?:[-._]?[A-Za-z0-9]+)?)(?:\s*\))?)/gi;
  for (const match of methods.text.matchAll(versioned)) {
    const prefix = match[1] ?? "";
    const markerStart = (match.index ?? 0) + prefix.length;
    const brand = precedingVersionedBrand(methods.text, markerStart);
    if (!brand) continue;
    const { displayName, normalized, start: localStart, end: localEnd } = brand;
    const executable = executableMatch(methods.text, localStart, localEnd);
    const lineStart = methods.text.lastIndexOf("\n", localStart - 1) + 1;
    const nextLine = methods.text.indexOf("\n", localEnd);
    const lineEnd = nextLine < 0 ? methods.text.length : nextLine;
    const context = methods.text.slice(Math.max(lineStart, localStart - 192), Math.min(lineEnd, localEnd + 256));
    const contract = executable ? inferredNovelToolContract(context, displayName) : undefined;
    const offset = methods.offset + localStart;
    const end = methods.offset + localEnd;
    found.push({
      display_name: displayName,
      normalized_name: normalized,
      operation_class: contract?.operationClass ?? inferredOperationClass(context),
      version: match[3]!,
      evidence: evidenceSnippet(fullText, offset, end),
      support: "unsupported",
      offset,
      end,
      executable,
      aliases: [displayName],
      ...(contract ? { ports: contract.ports } : {}),
    });
  }
  return found;
}

function location(extractedVia: PaperExtractVia, page: number) {
  return extractedVia === "pdfjs" || extractedVia === "ocr" ? `PDF page ${page}` : undefined;
}

function applyContextualMethodContracts(fullText: string, mentions: LocatedMention[]) {
  const bwaMem2 = mentions.find((mention) => mention.normalized_name === "bwamem2" && mention.executable);
  const samtools = mentions.find((mention) => mention.normalized_name === "samtools" && mention.executable);
  const yahs = mentions.find((mention) => mention.operator_id === "asm.yahs" && mention.executable);
  if (!bwaMem2 || !samtools || !yahs || !(bwaMem2.offset < samtools.offset && samtools.offset < yahs.offset)) return;
  if (yahs.end - bwaMem2.offset > 768) return;
  const context = fullText.slice(Math.max(0, bwaMem2.offset - 160), Math.min(fullText.length, yahs.end + 160));
  if (!/\bhi-c\b/i.test(context) || !/\bmapp(?:ed|ing)?\b/i.test(context) || !/\bscaffold/i.test(context)) return;

  // Plain "SAMtools" is too broad to type on its own. In the explicit
  // BWA-MEM2 -> SAMtools -> YaHS Hi-C chain, however, the format handoff is
  // constrained: BWA-MEM2 emits SAM and YaHS consumes a Hi-C BAM alignment.
  samtools.ports = { input: "Sam", output: "Bam", outputName: "bam" };
  samtools.assays = ["assembly"];
}

type SuiteCommand = Readonly<{
  suite: string;
  operatorId: string;
  action: RegExp;
  assays: readonly Assay[];
}>;

const suiteCommands: readonly SuiteCommand[] = [
  {
    suite: "picard",
    operatorId: "align.picard_mark_duplicates",
    action: /\bpicard\s+markduplicates\b|\bmarkduplicates\b|\b(?:deduplicat(?:e|ed|es|ing|ion)|mark(?:ed|ing)?\s+(?:pcr\s+)?duplicates?)\b/i,
    assays: ["rna_seq", "variants"],
  },
  {
    suite: "samtools",
    operatorId: "align.samtools_view",
    action: /\bsamtools\s+view\b|\bconvert(?:ed|ing)?\s+SAM(?:\s+files?)?\s+to\s+BAM\b/i,
    assays: ["assembly", "variants"],
  },
  {
    suite: "samtools",
    operatorId: "align.samtools_sort",
    action: /\bsamtools\s+sort\b|\bsort(?:ed|ing)?\b/i,
    assays: ["assembly", "variants"],
  },
];

const unresolvedSuiteActions = new Map<string, RegExp>([
  ["picard", /\b(?:addorreplace(?:readgroups)?|collect\w*metrics|sortsam|mergesamfiles|fixmateinformation|samtofastq|buildbamindex)\b/i],
  ["samtools", /\b(?:deduplicat\w*|mark(?:ed|ing)?\s+duplicates?|call(?:ed|ing)?\s+(?:SNPs?|variants?)|mpileup|index(?:ed|ing)?|merge(?:d|ing)?|fixmate|flagstat|depth|coverage|stats|reheader|calmd|collate)\b/i],
]);

function methodSentence(fullText: string, mention: LocatedMention) {
  const maximumStart = Math.max(0, mention.offset - 768);
  const prefix = fullText.slice(maximumStart, mention.offset);
  const boundary = /(?:[.!?]["')\]]*|\n)\s+(?=[A-Z])/g;
  let start = maximumStart;
  for (const match of prefix.matchAll(boundary)) start = maximumStart + (match.index ?? 0) + match[0].length;
  const tail = fullText.slice(start, Math.min(fullText.length, mention.end + 1_024));
  boundary.lastIndex = Math.max(0, mention.end - start);
  const endBoundary = boundary.exec(tail);
  const end = endBoundary ? (endBoundary.index ?? tail.length) + 1 : tail.length;
  return { text: tail.slice(0, end), offset: start };
}

/**
 * A suite name is not an executable command contract. Expand only actions that
 * the sentence names precisely enough to match an existing reviewed Operator;
 * retain the broad suite evidence whenever the same sentence still describes
 * unsupported work.
 */
function applyCommandSpecificSuiteMentions(catalog: OperatorCatalog, fullText: string, mentions: LocatedMention[]) {
  for (const suite of new Set(suiteCommands.map((command) => command.suite))) {
    const broadIndex = mentions.findIndex((mention) => mention.normalized_name === suite && mention.support === "unsupported" && mention.executable);
    if (broadIndex < 0) continue;
    const broad = mentions[broadIndex]!;
    const sentence = methodSentence(fullText, broad);
    let mapped = 0;
    for (const command of suiteCommands.filter((candidate) => candidate.suite === suite)) {
      const operator = catalog.get(command.operatorId);
      const matched = sentence.text.match(command.action);
      if (!operator || !matched) continue;
      const offset = sentence.offset + (matched.index ?? 0);
      if (!mentions.some((mention) => mention.operator_id === operator.id)) {
        mentions.push({
          display_name: operator.title,
          normalized_name: normalizedName(operator.title),
          operation_class: "bam_processing",
          ...(broad.version ? { version: broad.version } : {}),
          evidence: evidenceSnippet(fullText, offset, offset + matched[0].length),
          support: "operator",
          operator_id: operator.id,
          offset,
          end: offset + matched[0].length,
          executable: true,
          aliases: operator.paper?.aliases ?? [operator.title],
          assays: command.assays,
        });
      }
      mapped += 1;
    }
    if (mapped > 0 && !unresolvedSuiteActions.get(suite)?.test(sentence.text)) mentions.splice(broadIndex, 1);
  }
}

function applyReadLayoutSpecificOperators(fullText: string, mentions: LocatedMention[]) {
  const kallisto = mentions.find((mention) => mention.operator_id === "quant.kallisto" && mention.executable);
  if (!kallisto) return;
  const methods = paperMethodsWindow(fullText).text;
  const singleEnd = /\bsingle[- ]end(?:ed)?\b/i.test(methods);
  const pairedEnd = /\bpaired[- ]end(?:ed)?\b/i.test(methods);
  if (!singleEnd || pairedEnd) return;
  kallisto.operator_id = "quant.kallisto_single";
  kallisto.assays = ["rna_seq"];
}

function recognizedMethods(catalog: OperatorCatalog, fullText: string, extractedVia: PaperExtractVia): LocatedMention[] {
  const window = paperMethodsWindow(fullText);
  const found: LocatedMention[] = [];
  for (const { operator, paper, aliases } of catalogRecognitionPlan(catalog)) {
    const matched = aliasMatchSummary(window.text, aliases);
    if (!matched) continue;
    const selected = matched.firstExecutable ?? matched.first;
    const offset = window.offset + selected.start;
    const end = window.offset + selected.end;
    const version = detectedVersion(window.text, selected.end);
    found.push({
      display_name: window.text.slice(selected.start, selected.end).replace(/\s+/g, " ").trim(),
      normalized_name: normalizedName(operator.title),
      ...(paper.operation_class ? { operation_class: paper.operation_class } : {}),
      ...(version ? { version } : {}),
      evidence: evidenceSnippet(fullText, offset, end),
      support: "operator",
      operator_id: operator.id,
      offset,
      end,
      executable: matched.firstExecutable !== undefined,
      aliases: paper.aliases,
    });
  }
  for (const { spec, aliases } of unsupportedRecognitionPlan) {
    const matched = aliasMatchSummary(window.text, aliases);
    if (!matched) continue;
    const selected = matched.firstExecutable ?? matched.first;
    const offset = window.offset + selected.start;
    const end = window.offset + selected.end;
    const version = detectedVersion(window.text, selected.end);
    found.push({
      display_name: window.text.slice(selected.start, selected.end).replace(/\s+/g, " ").trim() || spec.displayName,
      normalized_name: spec.normalizedName,
      operation_class: spec.operationClass,
      ...(version ? { version } : {}),
      evidence: evidenceSnippet(fullText, offset, end),
      support: "unsupported",
      offset,
      end,
      executable: matched.firstExecutable !== undefined,
      aliases: spec.aliases,
      ...(spec.assays ? { assays: spec.assays } : {}),
      ...(spec.ports ? { ports: spec.ports } : {}),
    });
  }
  applyContextualMethodContracts(fullText, found);
  applyCommandSpecificSuiteMentions(catalog, fullText, found);
  applyReadLayoutSpecificOperators(fullText, found);
  const alreadyNamed = new Set(found.map((mention) => mention.normalized_name));
  for (const mention of [...discoveredNovelMethods(fullText, window), ...discoveredVersionedMethods(fullText, window)]) {
    if (found.some((existing) => mention.offset < existing.end && existing.offset < mention.end)) continue;
    if (found.some((existing) => existing.normalized_name !== mention.normalized_name && existing.normalized_name.endsWith(mention.normalized_name))) continue;
    if (!alreadyNamed.has(mention.normalized_name)) found.push(mention);
    alreadyNamed.add(mention.normalized_name);
  }
  const unique = new Map<string, LocatedMention>();
  for (const mention of found.sort((left, right) => left.offset - right.offset || left.normalized_name.localeCompare(right.normalized_name))) {
    if (!unique.has(mention.normalized_name)) unique.set(mention.normalized_name, mention);
  }
  const mentions = [...unique.values()].map((mention): LocatedMention => (
    mention.executable && (mention.core || (canBePrimaryAssemblyMethod(mention) && directPrimaryAssemblyUse(fullText, mention)))
      ? { ...mention, core: true }
      : mention
  ));
  if (extractedVia !== "pdfjs" && extractedVia !== "ocr") return mentions;
  let page = 1;
  let nextPageBreak = fullText.indexOf("\f");
  return mentions.map((mention) => {
    while (nextPageBreak >= 0 && nextPageBreak < mention.offset) {
      page += 1;
      nextPageBreak = fullText.indexOf("\f", nextPageBreak + 1);
    }
    return { ...mention, source_location: `PDF page ${page}` };
  });
}

export function paperAccessionKind(accession: string): PaperResourceCitation["kind"] | undefined {
  if (/^(?:SRR|ERR|DRR)\d{6,18}$/.test(accession)) return "sra_run";
  if (/^(?:SRP|ERP|DRP)\d{6,18}$/.test(accession)) return "sra_study";
  if (/^(?:SRX|ERX|DRX)\d{6,18}$/.test(accession)) return "sra_experiment";
  if (/^(?:SRS|ERS|DRS)\d{6,18}$/.test(accession)) return "sra_sample";
  if (/^(?:PRJNA|PRJEB|PRJDB)\d{6,18}$/.test(accession)) return "bioproject";
  if (/^(?:SAMN|SAMEA|SAMD)\d{6,18}$/.test(accession)) return "biosample";
  if (/^(?:GCA_|GCF_)\d{1,18}(?:\.\d{1,6})?$/.test(accession)) return "assembly";
  if (/^ENS[A-Z]{0,16}[GTP]\d{6,18}(?:\.\d{1,6})?$/.test(accession)) return "ensembl";
  return undefined;
}

function resourceRole(kind: PaperResourceCitation["kind"], context: string): PaperResourceCitation["role"] {
  const lower = context.toLocaleLowerCase("en-US");
  if (kind === "assembly" || ["genome assembly", "reference genome", "genomic reference"].some((value) => lower.includes(value))) return "reference";
  if (kind === "ensembl" || ["annotation", "gene model", "gtf", "gff"].some((value) => lower.includes(value))) return "annotation";
  if (["sra_study", "sra_sample", "sra_experiment", "sra_run"].includes(kind) || ["rna-seq", "dna-seq", "wgs", "paired-end", "sequence data", "sequencing reads", "sra accession"].some((value) => lower.includes(value))) return "reads";
  if (kind === "biosample") return "sample_metadata";
  return "unknown";
}

function scanPaperResourceCitations(text: string, extractedVia: PaperExtractVia) {
  const pattern = /\b(?:SR[RPXS]|ER[RPXS]|DR[RPXS])\d{6,18}\b|\b(?:PRJNA|PRJEB|PRJDB)\d{6,18}\b|\b(?:SAMN|SAMEA|SAMD)\d{6,18}\b|\b(?:GCA_|GCF_)\d{1,18}(?:\.\d{1,6})?\b|\bENS[A-Z]{0,16}[GTP]\d{6,18}(?:\.\d{1,6})?\b/gi;
  const citations = new Map<string, PaperResourceCitation>();
  let truncated = false;
  let page = 1;
  let nextPageBreak = extractedVia === "pdfjs" || extractedVia === "ocr" ? text.indexOf("\f") : -1;
  for (const match of text.matchAll(pattern)) {
    const accession = match[0]!.toUpperCase();
    const kind = paperAccessionKind(accession);
    if (!kind) continue;
    if (!citations.has(accession) && citations.size >= MAX_PAPER_RESOURCE_CITATIONS) {
      truncated = true;
      break;
    }
    const offset = match.index ?? 0;
    while (nextPageBreak >= 0 && nextPageBreak < offset) {
      page += 1;
      nextPageBreak = text.indexOf("\f", nextPageBreak + 1);
    }
    const context = evidenceSnippet(text, offset, offset + accession.length);
    const sourceLocation = location(extractedVia, page);
    const citation: PaperResourceCitation = {
      accession,
      kind,
      role: resourceRole(kind, context),
      context,
      ...(sourceLocation ? { source_location: sourceLocation } : {}),
    };
    const existing = citations.get(accession);
    const priority = { unknown: 0, sample_metadata: 1, annotation: 2, reads: 3, reference: 4 } as const;
    if (!existing || priority[citation.role] > priority[existing.role]) citations.set(accession, citation);
  }
  return { resources: [...citations.values()], truncated };
}

export function paperResourceCitations(text: string, extractedVia: PaperExtractVia): PaperResourceCitation[] {
  return scanPaperResourceCitations(text, extractedVia).resources;
}

function hasWorkflowCitationEvidence(statement: string, precedingContext: string) {
  if (/\b(?:nextflow|pipeline|workflow)\b/i.test(statement)) return true;

  const namesSourceCode = /\bsource\s+code\b/i.test(statement);
  const statesAvailability = /\b(?:availab(?:le|ility)|accessible|deposited|hosted|provided|published|released|repository)\b/i.test(statement);
  if (namesSourceCode && statesAvailability) return true;
  if (/\bsource\s+code\s*:\s*https?:\/\/github\.com\//i.test(statement)) return true;

  return /\bproject\s+homepage\s*:/i.test(statement)
    && /\b(?:availability\s+of\s+(?:the\s+)?source\s+code|source\s+code\s+availability|code\s+availability)\b/i.test(precedingContext);
}

function scanPaperWorkflowCitations(text: string, extractedVia: PaperExtractVia) {
  const pattern = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})/gi;
  const citations = new Map<string, PaperWorkflowCitation>();
  let truncated = false;
  let page = 1;
  let nextPageBreak = extractedVia === "pdfjs" || extractedVia === "ocr" ? text.indexOf("\f") : -1;
  for (const match of text.matchAll(pattern)) {
    const owner = match[1]!;
    const repositoryName = match[2]!.replace(/\.git$/i, "").replace(/[.,;:]+$/, "");
    if (!repositoryName) continue;
    const offset = match.index ?? 0;
    const priorBoundaries = [text.lastIndexOf("\n", offset - 1), text.lastIndexOf(".", offset - 1), text.lastIndexOf(";", offset - 1)];
    const classificationStart = Math.max(...priorBoundaries) + 1;
    const followingBoundaries = [text.indexOf("\n", offset + match[0]!.length), text.indexOf(".", offset + match[0]!.length), text.indexOf(";", offset + match[0]!.length)]
      .filter((boundary) => boundary >= 0);
    const classificationEnd = followingBoundaries.length ? Math.min(...followingBoundaries) : text.length;
    const classificationContext = text.slice(classificationStart, classificationEnd);
    const precedingContext = text.slice(Math.max(0, classificationStart - 320), classificationStart);
    const context = text.slice(Math.max(0, offset - 240), Math.min(text.length, offset + match[0]!.length + 240))
      .replace(/\s+/g, " ")
      .trim();
    if (!hasWorkflowCitationEvidence(classificationContext, precedingContext)) continue;
    const repository = `https://github.com/${owner}/${repositoryName}`;
    const identity = repository.toLocaleLowerCase("en-US");
    if (!citations.has(identity) && citations.size >= 8) {
      truncated = true;
      break;
    }
    while (nextPageBreak >= 0 && nextPageBreak < offset) {
      page += 1;
      nextPageBreak = text.indexOf("\f", nextPageBreak + 1);
    }
    citations.set(identity, {
      provider: "github",
      repository,
      context,
      ...(location(extractedVia, page) ? { source_location: location(extractedVia, page) } : {}),
    });
  }
  return { workflow_sources: [...citations.values()], truncated };
}

export function paperWorkflowCitations(text: string, extractedVia: PaperExtractVia): PaperWorkflowCitation[] {
  return scanPaperWorkflowCitations(text, extractedVia).workflow_sources;
}

export function enforcePaperReviewSize(review: PaperReview, maximumBytes = MAX_PAPER_REVIEW_BYTES): PaperReview {
  const sizeBytes = new TextEncoder().encode(JSON.stringify(review)).byteLength;
  if (sizeBytes > maximumBytes) throw new PaperReviewLimitError(sizeBytes, maximumBytes);
  return review;
}

function assayScores(lowerText: string) {
  const score = (cues: readonly [string, number][]) => cues.reduce((total, [cue, weight]) => total + (lowerText.includes(cue) ? weight : 0), 0);
  return new Map<Assay, number>([
    ["assembly", score([["genome assembly", 5], ["de novo assembl", 4], ["assembly was performed", 3], ["hifiasm", 5], ["masurca", 4], ["ragtag", 3], ["redundans", 3], ["abyss", 3], ["yahs", 4], ["genomescope", 3], ["chromosome-scale assembl", 4], ["haplotype assembl", 4], ["pacbio hifi", 2], ["falcon", 4], ["purge_dups", 4], ["purge haplotigs", 4], ["vertebrate genome project", 5]])],
    ["rna_seq", score([["nf-core/rnaseq", 6], ["hisat2", 4], ["stringtie", 4], ["rna-seq", 6], ["rna seq", 6], ["rnaseq", 6], ["differential expression", 3]])],
    ["variants", score([["gatk best practices", 6], ["haplotypecaller", 5], ["variant call", 4], ["mutect", 4], ["sarek", 5], ["somatic", 3], ["germline", 3], ["whole genome sequenc", 2]])],
    ["metagenome", score([["kraken 2", 6], ["kraken2", 6], ["nf-core/mag", 6], ["nf-core/taxprofiler", 6], ["metagenom", 4], ["metabat", 4]])],
    ["single_cell", score([["single-cell rna", 6], ["single cell rna", 6], ["scrna", 5], ["cellranger", 5], ["cell ranger", 5], ["seurat", 4], ["doubletfinder", 4], ["soupx", 4]])],
  ]);
}

function relevantAssays(lowerText: string): Assay[] {
  if (lowerText.includes("allmaps") && (lowerText.includes("linkage map") || lowerText.includes("ordering and orientation"))) return ["assembly"];
  const scores = [...assayScores(lowerText)].filter(([, value]) => value >= 6).sort((left, right) => right[1] - left[1]);
  if (scores.length) return scores.map(([assay]) => assay);
  return lowerText.includes("fastqc") ? ["qc"] : ["unknown"];
}

function assayFromMethodEvidence(mentions: readonly LocatedMention[]): Assay | undefined {
  const classes = new Set(mentions.filter((mention) => mention.executable).map((mention) => mention.operation_class));
  if ([...classes].some((value) => value?.includes("variant"))) return "variants";
  if ([...classes].some((value) => value?.includes("assembl"))) return "assembly";
  if ([...classes].some((value) => value?.includes("single_cell"))) return "single_cell";
  if ([...classes].some((value) => value?.includes("quantif") || value?.includes("differential_expression"))) return "rna_seq";
  if ([...classes].some((value) => value?.includes("classif") || value?.includes("binning"))) return "metagenome";
  return undefined;
}

function operatorAssay(operator: PinnedOperator, assay: Assay) {
  const label = assay === "rna_seq" ? "rna-seq" : assay === "single_cell" ? "single-cell" : assay;
  return !operator.paper?.assays.length || operator.paper.assays.includes(label) || assay === "unknown" || assay === "qc";
}

function defaultParameters(operator: PinnedOperator) {
  const values: Record<string, ParamValue> = {};
  for (const [name, spec] of Object.entries(operator.params)) if (spec.default !== undefined) values[name] = spec.default;
  return values;
}

function nodeId(graph: SomiteGraph, operator: string, suffix?: string) {
  const base = (suffix || operator).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLocaleLowerCase("en-US") || "step";
  let id = base;
  let index = 2;
  while (graph.nodes.some((node) => node.id === id)) id = `${base}-${index++}`;
  return id;
}

function addOperatorNode(graph: SomiteGraph, catalog: OperatorCatalog, operatorId: string, note?: string, params: Record<string, ParamValue> = {}) {
  const operator = catalog.get(operatorId);
  if (!operator) return undefined;
  const id = nodeId(graph, operatorId);
  const node: SomiteGraphNode = {
    id,
    operator: operator.id,
    operator_revision: operator.revision,
    ports: operatorPorts(operator),
    params: { ...defaultParameters(operator), ...params },
    layout: { x: 0, y: 0 },
    ...(note ? { note } : {}),
  };
  graph.nodes.push(node);
  return node;
}

function methodToolLabel(mention: LocatedMention) {
  const method = unsupportedMethods.find((candidate) => candidate.normalizedName === mention.normalized_name);
  const labels = [method?.displayName, mention.display_name].filter((label): label is string => Boolean(label?.trim()));
  for (const label of labels) {
    if (normalizedName(label) === mention.normalized_name) return label;
    for (const parenthetical of label.matchAll(/\(([A-Za-z][A-Za-z0-9_.+-]*)\)/g)) {
      if (normalizedName(parenthetical[1] ?? "") === mention.normalized_name) return parenthetical[1]!;
    }
  }
  return method?.displayName ?? mention.display_name;
}

function addGapNode(graph: SomiteGraph, catalog: OperatorCatalog, mention: LocatedMention) {
  const tool = methodToolLabel(mention);
  const node = addOperatorNode(graph, catalog, "gap.missing", mention.evidence, { tool, quote: mention.evidence });
  if (!node) return undefined;
  if (!mention.ports) {
    node.ports = [];
    return node;
  }
  const inputs = mention.ports.inputs?.map((input): SomitePort => ({
    name: input.name,
    dir: "in",
    ty: input.type,
    ...(input.union?.length ? { union: [...input.union] } : {}),
    ...(input.optional ? { optional: true } : {}),
  })) ?? [{
    name: "in",
    dir: "in" as const,
    ty: mention.ports.input,
    ...(mention.ports.inputUnion?.length ? { union: [...mention.ports.inputUnion] } : {}),
  }];
  node.ports = [...inputs, { name: mention.ports.outputName ?? "out", dir: "out", ty: mention.ports.output }];
  return node;
}

function addEdge(graph: SomiteGraph, from: SomiteGraphNode, fromPort: SomitePort, to: SomiteGraphNode, toPort: SomitePort) {
  if (graph.edges.some((edge) => edge.to_node === to.id && edge.to_port === toPort.name)) return;
  let id = `${from.id}-${fromPort.name}-to-${to.id}-${toPort.name}`;
  let index = 2;
  while (graph.edges.some((edge) => edge.id === id)) id = `${from.id}-${fromPort.name}-to-${to.id}-${toPort.name}-${index++}`;
  graph.edges.push({ id, from_node: from.id, from_port: fromPort.name, to_node: to.id, to_port: toPort.name });
}

function connectSpecific(graph: SomiteGraph, from: SomiteGraphNode | undefined, to: SomiteGraphNode | undefined) {
  if (!from || !to) return;
  const occupied = new Set(graph.edges.filter((edge) => edge.to_node === to.id).map((edge) => edge.to_port));
  for (const input of to.ports.filter((port) => port.dir === "in" && !occupied.has(port.name))) {
    const output = from.ports.find((port) => port.dir === "out" && compatiblePortTypes(port.ty, input.ty, input.union));
    if (output) addEdge(graph, from, output, to, input);
  }
}

function connectReplacing(graph: SomiteGraph, from: SomiteGraphNode | undefined, to: SomiteGraphNode | undefined, inputName?: string) {
  if (!from || !to) return;
  const input = to.ports.find((port) => port.dir === "in" && (!inputName || port.name === inputName)
    && from.ports.some((output) => output.dir === "out" && compatiblePortTypes(output.ty, port.ty, port.union)));
  if (!input) return;
  const output = from.ports.find((port) => port.dir === "out" && port.name === input.name && compatiblePortTypes(port.ty, input.ty, input.union))
    ?? from.ports.find((port) => port.dir === "out" && compatiblePortTypes(port.ty, input.ty, input.union));
  if (!output) return;
  graph.edges = graph.edges.filter((edge) => edge.to_node !== to.id || edge.to_port !== input.name);
  addEdge(graph, from, output, to, input);
}

function gapWithTool(nodes: readonly SomiteGraphNode[], tool: string) {
  const normalized = normalizedName(tool);
  return nodes.find((node) => node.operator === "gap.missing" && normalizedName(String(node.params?.tool ?? "")) === normalized);
}

function enforceAssemblyFlow(graph: SomiteGraph, catalog: OperatorCatalog) {
  const hifiasm = graph.nodes.find((node) => node.operator === "asm.hifiasm");
  const assembler = hifiasm
    ?? graph.nodes.find((node) => node.operator === "gap.missing" && ["falcon", "flye", "hicanu", "canu", "peregrine", "shasta", "masurca"].includes(normalizedName(String(node.params?.tool ?? ""))));
  let assemblyOutput = assembler;
  if (hifiasm) {
    const conversion = addGapNode(graph, catalog, {
      display_name: "Hifiasm GFA export",
      normalized_name: "hifiasmgfaexport",
      operation_class: "assembly_format_conversion",
      evidence: "hifiasm emits GFA output; a reviewed GFA-to-FASTA conversion is required before FASTA consumers.",
      support: "unsupported",
      offset: 0,
      end: 0,
      executable: true,
      aliases: [],
      assays: ["assembly"],
      ports: { input: "Directory", output: "Fasta" },
    });
    if (conversion) {
      graph.nodes.splice(graph.nodes.indexOf(conversion), 1);
      graph.nodes.splice(graph.nodes.indexOf(hifiasm) + 1, 0, conversion);
      connectReplacing(graph, hifiasm, conversion);
      assemblyOutput = conversion;
    }
  }
  const hiCAligner = gapWithTool(graph.nodes, "BWA-MEM2");
  connectReplacing(graph, assemblyOutput, hiCAligner, "ref");
  const purge = gapWithTool(graph.nodes, "Purge_Dups");
  const scaffold = graph.nodes.find((node) => node.operator === "asm.yahs") ?? gapWithTool(graph.nodes, "Salsa");
  const blob = gapWithTool(graph.nodes, "Blobtools");
  const busco = graph.nodes.find((node) => node.operator === "qc.busco");
  let tail = assemblyOutput;
  for (const next of [purge, scaffold, blob]) {
    if (next) {
      connectReplacing(graph, tail, next);
      tail = next;
    }
  }
  connectReplacing(graph, tail, busco);
  const minimap = graph.nodes.find((node) => node.operator === "align.minimap2");
  connectReplacing(graph, assemblyOutput, minimap, "ref");
  connectReplacing(graph, minimap, gapWithTool(graph.nodes, "Augustus"));
}

function enforceLinkageFlow(graph: SomiteGraph, catalog: OperatorCatalog) {
  const startingAssembly = graph.nodes.find((node) => node.operator === "files.import_fasta");
  const dnaReads = graph.nodes.find((node) => node.operator === "files.import_paired");
  const dnaBwa = graph.nodes.find((node) => node.operator === "align.bwa");
  const dnaView = graph.nodes.find((node) => node.operator === "align.samtools_view");
  connectReplacing(graph, dnaReads, dnaBwa, "r1");
  connectReplacing(graph, startingAssembly, dnaBwa, "ref");
  connectReplacing(graph, dnaBwa, dnaView);
  connectReplacing(graph, dnaView, graph.nodes.find((node) => node.operator === "method.gatk3_unspecified"), "bam");
  connectReplacing(graph, startingAssembly, graph.nodes.find((node) => node.operator === "method.gatk3_unspecified"), "ref");

  const rnaReads = addOperatorNode(graph, catalog, "files.import_paired", "Paired RNA-seq reads provide independent scaffold connections; use the paper's cited BioProjects or attach the exact R1/R2 files.");
  const rnaBwa = addOperatorNode(graph, catalog, "align.bwa", "Map the paper's RNA-seq reads to the named starting assembly for RNA-guided scaffolding.");
  const rnaView = addOperatorNode(graph, catalog, "align.samtools_view", "Convert RNA-seq BWA-MEM output to BAM for RNA-guided scaffolding.", { exclude_flags: 4 });
  const rnaSort = addOperatorNode(graph, catalog, "align.samtools_sort", "Rascaf consumes coordinate-sorted alignments.");
  connectReplacing(graph, rnaReads, rnaBwa, "r1");
  connectReplacing(graph, rnaReads, rnaBwa, "r2");
  connectReplacing(graph, startingAssembly, rnaBwa, "ref");
  connectReplacing(graph, rnaBwa, rnaView);
  connectReplacing(graph, rnaView, rnaSort);
  for (const target of [graph.nodes.find((node) => node.operator === "asm.rascaf"), graph.nodes.find((node) => node.operator === "legacy.agouti")]) {
    connectReplacing(graph, rnaSort, target, "alignments");
    connectReplacing(graph, startingAssembly, target, "assembly");
  }
  connectReplacing(graph, startingAssembly, graph.nodes.find((node) => node.operator === "asm.allmaps"), "assembly");
}

function connectByTypes(graph: SomiteGraph, catalog: OperatorCatalog) {
  const nodes = [...graph.nodes];
  for (let targetIndex = 0; targetIndex < nodes.length; targetIndex += 1) {
    const target = nodes[targetIndex]!;
    const occupied = new Set(graph.edges.filter((edge) => edge.to_node === target.id).map((edge) => edge.to_port));
    const usedOutputs = new Set<string>();
    for (const input of target.ports.filter((port) => port.dir === "in" && !occupied.has(port.name))) {
      let selected: { node: SomiteGraphNode; port: SomitePort } | undefined;
      for (let sourceIndex = targetIndex - 1; sourceIndex >= 0; sourceIndex -= 1) {
        const source = nodes[sourceIndex]!;
        const requiredProfile = catalog.get(target.operator)?.ports.in.find((port) => port.name === input.name)?.resource?.profile;
        const compatible = source.ports.filter((port) => {
          if (port.dir !== "out" || !compatiblePortTypes(port.ty, input.ty, input.union)) return false;
          if (!requiredProfile) return true;
          const providedProfile = catalog.get(source.operator)?.ports.out.find((output) => output.name === port.name)?.resource_profile;
          return providedProfile === requiredProfile;
        });
        const port = compatible.find((candidate) => candidate.name === input.name && !usedOutputs.has(`${source.id}\0${candidate.name}`))
          ?? compatible.find((candidate) => !usedOutputs.has(`${source.id}\0${candidate.name}`));
        if (port) {
          selected = { node: source, port };
          break;
        }
      }
      if (selected) {
        usedOutputs.add(`${selected.node.id}\0${selected.port.name}`);
        addEdge(graph, selected.node, selected.port, target, input);
      }
    }
  }
}

function layoutGraph(graph: SomiteGraph) {
  const levels = new Map<string, number>();
  for (const node of graph.nodes) {
    const predecessors = graph.edges.filter((edge) => edge.to_node === node.id).map((edge) => levels.get(edge.from_node) ?? 0);
    levels.set(node.id, predecessors.length ? Math.max(...predecessors) + 1 : 0);
  }
  const rows = new Map<number, number>();
  for (const node of graph.nodes) {
    const column = levels.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    node.layout = { x: 80 + column * 280, y: 80 + row * 170 };
    rows.set(column, row + 1);
  }
}

function knownGenome(lowerText: string) {
  for (const [needle, name] of [["grch38", "GRCh38"], ["hg38", "GRCh38"], ["grch37", "GRCh37"], ["hg19", "GRCh37"], ["grcm39", "GRCm39"], ["mm39", "GRCm39"], ["mm10", "GRCm38"], ["t2t", "T2T-CHM13"]] as const) {
    if (lowerText.includes(needle)) return name;
  }
  return undefined;
}

function exactReadRuns(resources: readonly PaperResourceCitation[]) {
  return resources
    .filter((resource) => resource.kind === "sra_run" && resource.role === "reads")
    .map((resource) => resource.accession);
}

function unresolvedReadNote(runs: readonly string[], independentReadSlots: number) {
  if (runs.length > 1) {
    const design = independentReadSlots > 1
      ? ` across ${independentReadSlots} independent read roles`
      : " in the biological sample design";
    return `The paper cites multiple exact SRA runs (${runs.join(", ")}). Assign every run${design} before adding fetch nodes; no run was selected automatically.`;
  }
  if (runs.length === 1 && independentReadSlots > 1) {
    return `The paper cites exact SRA run ${runs[0]}, but this reconstruction has ${independentReadSlots} independent read roles. Choose which role the run belongs to before adding a fetch node; no run was selected automatically.`;
  }
  if (runs.length === 1) {
    return `The paper cites exact SRA run ${runs[0]}. Check its single-end or paired-end layout, then use the cited-data action to replace this input with the matching fetch nodes.`;
  }
  return "Reads are described, but no exact run accession was selected. Choose local reads or use a cited online resource.";
}

function graphEvidence(graph: SomiteGraph, extractedVia: PaperExtractVia, explicitNodeIds: ReadonlySet<string>): PaperEvidence[] {
  const evidence: PaperEvidence[] = [];
  for (const node of graph.nodes) {
    const needsAdapter = node.operator === "gap.missing";
    evidence.push({
      target_kind: "node",
      target_id: node.id,
      status: needsAdapter ? "needs_adapter" : explicitNodeIds.has(node.id) ? "explicit" : "inferred",
      detail: node.note ?? (needsAdapter ? "Recognized method needs a reviewed contract." : "Required by typed workflow wiring."),
      ...(node.note && (extractedVia === "pdfjs" || extractedVia === "ocr") ? { source_location: undefined } : {}),
    });
  }
  for (const edge of graph.edges) evidence.push({ target_kind: "edge", target_id: edge.id, status: "inferred", detail: "Connected by compatible reviewed channel types; confirm the paper's exact handoff." });
  return evidence;
}

function candidateName(assay: Assay) {
  return ({ assembly: "Assembly methods", rna_seq: "RNA-seq methods", variants: "Variant methods", metagenome: "Metagenome methods", single_cell: "Single-cell methods", qc: "Quality-control methods", unknown: "Recognized methods" } as const)[assay];
}

function isAssemblyMethod(mention: LocatedMention) {
  return mention.operator_id === "asm.hifiasm"
    || (mention.operation_class === "assemble" && mention.ports?.output === "Fasta");
}

function syntheticAssemblySteps(text: string, lowerText: string): LocatedMention[] {
  const steps: Array<Readonly<{ needles: readonly string[]; displayName: string; input: PortType; inputUnion?: readonly PortType[]; output: PortType }>> = [
    { needles: ["genomescope"], displayName: "Genomescope", input: "Fastq", inputUnion: ["FastqGz"], output: "Directory" },
    { needles: ["blobtools", "blobtoolkit"], displayName: "Blobtools", input: "Fasta", inputUnion: ["FastaGz", "Directory"], output: "Directory" },
    { needles: ["augustus"], displayName: "Augustus", input: "Bam", output: "Directory" },
    { needles: ["merqury"], displayName: "Merqury", input: "Fasta", inputUnion: ["FastaGz", "Directory"], output: "Directory" },
    { needles: ["mitohifi"], displayName: "MitoHiFi", input: "Fastq", inputUnion: ["FastqGz"], output: "Directory" },
    { needles: ["bakta"], displayName: "Bakta", input: "Fasta", inputUnion: ["FastaGz", "Directory"], output: "Directory" },
  ];
  return steps.flatMap((step): LocatedMention[] => {
    const located = step.needles
      .map((needle) => ({ needle, offset: lowerText.indexOf(needle) }))
      .filter((candidate) => candidate.offset >= 0)
      .sort((left, right) => left.offset - right.offset)[0];
    if (!located) return [];
    const end = located.offset + located.needle.length;
    return [{
      display_name: step.displayName,
      normalized_name: normalizedName(step.displayName),
      operation_class: "assembly_support",
      evidence: evidenceSnippet(text, located.offset, end),
      support: "unsupported",
      offset: located.offset,
      end,
      executable: executableMatch(text, located.offset, end),
      aliases: step.needles,
      ports: { input: step.input, ...(step.inputUnion ? { inputUnion: step.inputUnion } : {}), output: step.output },
    }];
  });
}

function methodRank(mention: LocatedMention) {
  if (mention.normalized_name === "genomescope") return 10;
  if (mention.normalized_name === "jellyfish") return 10;
  if (mention.normalized_name === "blobtools") return 45;
  if (mention.normalized_name === "augustus" || mention.normalized_name === "merqury" || mention.normalized_name === "bakta") return 55;
  if (mention.normalized_name === "mitohifi") return 30;
  if (mention.operator_id === "asm.allmaps") return 80;
  if (mention.operator_id === "manual.allmaps_evidence") return 70;
  return ({
    quality_control: 10,
    read_trimming: 20,
    trim: 20,
    genome_assembly: 30,
    assemble: 30,
    read_alignment: 30,
    align: 30,
    taxonomic_classification: 30,
    single_cell_preprocessing: 30,
    bam_processing: 35,
    purge_haplotigs: 35,
    genome_scaffolding: 40,
    scaffold: 40,
    transcript_assembly: 40,
    transcript_quantification: 40,
    read_quantification: 40,
    compound_workflow: 40,
    ambient_rna_correction: 40,
    single_cell_analysis: 45,
    single_cell_aggregation: 48,
    doublet_detection: 45,
    differential_expression: 50,
    variant_calling: 50,
    variant_filtering: 55,
    linkage_mapping: 60,
    scaffolding_evidence: 70,
    assembly_quality_control: 50,
    aggregate_qc: 60,
  } as Record<string, number>)[mention.operation_class ?? ""] ?? 40;
}

function requiredIndexBuilders(catalog: OperatorCatalog, mentions: readonly LocatedMention[]) {
  const profiles = new Set<string>();
  for (const mention of mentions) {
    if (mention.support !== "operator") continue;
    for (const input of catalog.get(mention.operator_id!)?.ports.in ?? []) {
      if (input.resource?.profile) profiles.add(input.resource.profile);
    }
  }
  return [...profiles].flatMap((profile) => {
    const builder = [...catalog.values()].find((operator) => operator.ports.out.some((output) => output.resource_profile === profile)
      && operator.ports.in.some((input) => input.type === "Fasta" || input.union?.includes("Fasta")));
    return builder ? [{ profile, builder }] : [];
  });
}

const TRANSCRIPT_INDEX_PROFILES = new Set(["salmon-index", "kallisto-transcriptome-index"]);

function isTranscriptIndexProfile(profile: string) {
  return TRANSCRIPT_INDEX_PROFILES.has(profile);
}

const PAPER_PREPARATION_TYPES = new Set<PortType>([
  "ReadGroupedBam",
  "GatkReadyBam",
  "Bai",
  "Fai",
  "Dict",
]);

const PAPER_PLAIN_TYPE = new Map<PortType, PortType>([
  ["FastqGz", "Fastq"],
  ["FastaGz", "Fasta"],
  ["GtfGz", "Gtf"],
]);

/**
 * Preserve named scalar roles across an exact one-hop decompression. This is
 * deliberately port-driven: paired r1/r2 artifacts each receive their own
 * converter, and an earlier raw source cannot bypass an explicitly selected
 * compressed-producing method.
 */
function connectNamedMethodHandoffs(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  targets: readonly SomiteGraphNode[],
) {
  for (const target of targets) {
    for (const input of target.ports.filter((port) => port.dir === "in")) {
      if (graph.edges.some((edge) => edge.to_node === target.id && edge.to_port === input.name)) continue;
      const targetIndex = graph.nodes.indexOf(target);
      if (targetIndex < 0) continue;
      const requiredProfile = catalog.get(target.operator)?.ports.in.find((port) => port.name === input.name)?.resource?.profile;
      let source: { node: SomiteGraphNode; port: SomitePort } | undefined;
      for (let index = targetIndex - 1; index >= 0; index -= 1) {
        const node = graph.nodes[index]!;
        const output = node.ports.find((port) => {
          if (port.dir !== "out" || port.name !== input.name) return false;
          if (!requiredProfile) return true;
          return catalog.get(node.operator)?.ports.out.find((candidate) => candidate.name === port.name)?.resource_profile === requiredProfile;
        });
        if (output) {
          source = { node, port: output };
          break;
        }
      }
      if (!source) continue;
      if (compatiblePortTypes(source.port.ty, input.ty, input.union)) {
        addEdge(graph, source.node, source.port, target, input);
        continue;
      }
      if (PAPER_PLAIN_TYPE.get(source.port.ty) !== input.ty) continue;

      const converters = [...catalog.values()].filter((operator) => operator.kind === "external"
        && operator.ports.in.length === 1
        && operator.ports.out.length === 1
        && compatiblePortTypes(source!.port.ty, operator.ports.in[0]!.type, operator.ports.in[0]!.union)
        && compatiblePortTypes(operator.ports.out[0]!.type, input.ty, input.union));
      if (converters.length !== 1) continue;
      const converterOperator = converters[0]!;
      const converter = addOperatorNode(
        graph,
        catalog,
        converterOperator.id,
        `Normalize ${source.port.name} from ${source.port.ty} to ${input.ty} for ${catalog.get(target.operator)?.title ?? target.operator}.`,
      );
      if (!converter) continue;
      graph.nodes.splice(graph.nodes.indexOf(converter), 1);
      graph.nodes.splice(graph.nodes.indexOf(target), 0, converter);
      const converterInput = converter.ports.find((port) => port.dir === "in")!;
      const converterOutput = converter.ports.find((port) => port.dir === "out")!;
      addEdge(graph, source.node, source.port, converter, converterInput);
      addEdge(graph, converter, converterOutput, target, input);
    }
  }
}

/**
 * Insert only uniquely reviewed producers for typed preparation artifacts.
 * Ambiguous or unavailable preparation stays as an unbound input instead of
 * guessing a tool. Producers are placed before their consumer so the ordinary
 * type connector can wire the complete visible chain in one pass.
 */
function insertTypedPreparation(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  target: SomiteGraphNode,
  visiting = new Set<string>(),
) {
  const targetIndex = graph.nodes.indexOf(target);
  if (targetIndex < 0) return;
  for (const input of target.ports.filter((port) => port.dir === "in" && PAPER_PREPARATION_TYPES.has(port.ty))) {
    if (graph.edges.some((edge) => edge.to_node === target.id && edge.to_port === input.name)) continue;
    const priorProducer = graph.nodes.slice(0, graph.nodes.indexOf(target)).some((candidate) => candidate.ports.some((port) => (
      port.dir === "out" && compatiblePortTypes(port.ty, input.ty, input.union)
    )));
    if (priorProducer) continue;

    const producers = [...catalog.values()].filter((operator) => operator.kind === "external"
      && operator.ports.out.some((output) => compatiblePortTypes(output.type, input.ty, input.union)));
    if (producers.length !== 1) continue;
    const producer = producers[0]!;
    const visitKey = `${producer.id}\0${input.ty}`;
    if (visiting.has(visitKey)) continue;

    const node = addOperatorNode(
      graph,
      catalog,
      producer.id,
      `Prepare the typed ${input.ty} artifact required by ${catalog.get(target.operator)?.title ?? target.operator}.`,
    );
    if (!node) continue;
    graph.nodes.splice(graph.nodes.indexOf(node), 1);
    graph.nodes.splice(graph.nodes.indexOf(target), 0, node);
    visiting.add(visitKey);
    insertTypedPreparation(graph, catalog, node, visiting);
    visiting.delete(visitKey);
  }
}

function insertProfilePreparation(graph: SomiteGraph, catalog: OperatorCatalog, target: SomiteGraphNode) {
  const targetIndex = graph.nodes.indexOf(target);
  const targetOperator = catalog.get(target.operator);
  if (targetIndex < 0 || !targetOperator) return;
  for (const input of target.ports.filter((port) => port.dir === "in")) {
    if (graph.edges.some((edge) => edge.to_node === target.id && edge.to_port === input.name)) continue;
    const requiredProfile = targetOperator.ports.in.find((candidate) => candidate.name === input.name)?.resource?.profile;
    if (!requiredProfile) continue;
    const priorProducer = graph.nodes.slice(0, targetIndex).some((candidate) => (
      candidate.ports.some((port) => port.dir === "out"
        && compatiblePortTypes(port.ty, input.ty, input.union)
        && catalog.get(candidate.operator)?.ports.out.find((output) => output.name === port.name)?.resource_profile === requiredProfile)
    ));
    if (priorProducer) continue;
    const builders = [...catalog.values()].filter((operator) => operator.kind === "external"
      && operator.id !== target.operator
      && operator.ports.out.some((output) => output.resource_profile === requiredProfile
        && compatiblePortTypes(output.type, input.ty, input.union))
      && operator.ports.in.some((builderInput) => compatiblePortTypes(input.ty, builderInput.type, builderInput.union)));
    if (builders.length !== 1) continue;
    const builder = addOperatorNode(
      graph,
      catalog,
      builders[0]!.id,
      `Prepare the ${requiredProfile} artifact required by ${targetOperator.title}.`,
    );
    if (!builder) continue;
    graph.nodes.splice(graph.nodes.indexOf(builder), 1);
    graph.nodes.splice(graph.nodes.indexOf(target), 0, builder);
  }
}

function buildCandidate(
  catalog: OperatorCatalog,
  text: string,
  lowerText: string,
  resources: readonly PaperResourceCitation[],
  mentions: readonly LocatedMention[],
  assay: Assay,
  extractedVia: PaperExtractVia,
  role: PaperCandidate["role"],
  assemblyChoice?: LocatedMention,
) {
  const graph: SomiteGraph = { schema_version: 3, name: candidateName(assay), nodes: [], edges: [] };
  const linkageWorkflow = assay === "assembly"
    && lowerText.includes("allmaps")
    && (lowerText.includes("linkage map") || lowerText.includes("ordering and orientation"));
  const rnaDerivedVariantWorkflow = assay === "variants" && /\brna[- ]?seq\b/i.test(text);
  const firstVariantMethod = assay === "variants"
    ? mentions
      .filter((mention) => mention.executable && mention.operation_class === "variant_calling")
      .sort((left, right) => left.offset - right.offset)[0]
    : undefined;
  const variantUpstreamAligner = firstVariantMethod
    ? mentions
      .filter((mention) => mention.executable
        && (mention.operation_class === "read_alignment" || mention.operation_class === "align")
        && mention.offset < firstVariantMethod.offset
        && firstVariantMethod.offset - mention.end <= 4_096)
      .sort((left, right) => right.offset - left.offset)[0]
    : undefined;
  const selected = mentions.filter((mention) => {
    if (!mention.executable) return false;
    if (assemblyChoice && isAssemblyMethod(mention) && mention.normalized_name !== assemblyChoice.normalized_name) return false;
    if (mention.support === "unsupported") {
      if (mention.assays?.length && !mention.assays.includes(assay)) return false;
      return !(linkageWorkflow && mention.normalized_name === "picard");
    }
    if (mention.assays?.length && !mention.assays.includes(assay)) return false;
    const operator = catalog.get(mention.operator_id!);
    return Boolean(operator && (operatorAssay(operator, assay)
      || mention === variantUpstreamAligner
      || (rnaDerivedVariantWorkflow && (mention.operation_class === "read_alignment" || mention.operation_class === "align"))));
  });
  const compounds = new Set(selected.filter((mention) => mention.support === "operator" && mention.operator_id?.startsWith("nf.")).map((mention) => mention.operator_id));
  const filtered = selected.filter((mention) => {
    if (mention.normalized_name === "bwamem2" && selected.some((other) => other.normalized_name === "parabricksfq2bam")) return false;
    if (mention.support !== "operator") return true;
    if (compounds.has("nf.rnaseq") && rnaCovers.has(mention.operator_id!)) return false;
    if (compounds.has("nf.sarek") && variantCovers.has(mention.operator_id!)) return false;
    if ((compounds.has("nf.mag") || compounds.has("nf.taxprofiler")) && metagenomeCovers.has(mention.operator_id!)) return false;
    if (mention.operator_id === "diff.deseq2" && !selected.some((other) => ["quant.featurecounts", "quant.salmon"].includes(other.operator_id ?? "") || other.normalized_name === "seurataggregateexpression")) return false;
    return true;
  });
  const indexBuilders = requiredIndexBuilders(catalog, filtered);
  const genomeIndexBuilders = indexBuilders.filter(({ profile }) => !isTranscriptIndexProfile(profile));
  const transcriptIndexBuilders = indexBuilders.filter(({ profile }) => isTranscriptIndexProfile(profile));
  if (assay === "assembly") {
    for (const synthetic of syntheticAssemblySteps(text, lowerText).filter((mention) => mention.executable)) {
      const existing = filtered.findIndex((mention) => mention.normalized_name === synthetic.normalized_name);
      if (existing < 0) filtered.push(synthetic);
      else if (filtered[existing]!.support === "unsupported" && !filtered[existing]!.ports) filtered[existing] = synthetic;
    }
  }
  const needsFastq = (mention: LocatedMention) => {
    if (mention.support === "unsupported") return mention.ports?.input === "Fastq";
    return catalog.get(mention.operator_id!)?.ports.in.some((port) => port.type === "Fastq" || port.union?.includes("Fastq") || port.type === "FastqGz") ?? false;
  };
  const hiCMappingChain = assay === "assembly"
    && filtered.some((mention) => mention.operator_id === "asm.yahs")
    && filtered.some((mention) => mention.normalized_name === "bwamem2" && mention.ports?.output === "Sam")
    && filtered.some((mention) => mention.normalized_name === "samtools" && mention.ports?.input === "Sam" && mention.ports.output === "Bam");
  const needsPrimaryReads = filtered.some((mention) => needsFastq(mention) && !(hiCMappingChain && mention.normalized_name === "bwamem2"));
  const runs = exactReadRuns(resources);
  const independentReadSlots = Number(needsPrimaryReads) + Number(hiCMappingChain) + Number(linkageWorkflow);
  const readResolutionWarning = independentReadSlots > 0 && runs.length > 1
    ? `The paper cites ${runs.length} exact SRA runs; assign every run to its biological sample or read role before adding fetch nodes.`
    : runs.length === 1 && independentReadSlots > 1
      ? `The paper cites ${runs[0]} for a design with ${independentReadSlots} independent read roles; choose its role before adding a fetch node.`
      : runs.length === 1
        ? `Confirm whether ${runs[0]} is single-end or paired-end before adding its fetch nodes.`
      : undefined;
  let reads: SomiteGraphNode | undefined;
  if (needsPrimaryReads) {
    const longReadAssembly = assay === "assembly" && filtered.some((mention) => isAssemblyMethod(mention));
    const paired = !longReadAssembly && (lowerText.includes("paired-end") || lowerText.includes("paired end") || lowerText.includes("paired reads"));
    reads = addOperatorNode(graph, catalog, paired ? "files.import_paired" : "files.import", unresolvedReadNote(runs, independentReadSlots));
  }
  const hiCReads = hiCMappingChain
    ? addOperatorNode(graph, catalog, "files.import_paired", "Attach the paper's distinct paired Hi-C reads. Keep this library separate from the long reads used for contig assembly.")
    : undefined;
  const genome = knownGenome(lowerText);
  const needsReference = (assay !== "assembly" && filtered.some((mention) => mention.support === "operator"
    ? catalog.get(mention.operator_id!)?.ports.in.some((port) => port.type === "Fasta" || port.type === "FastaGz")
    : mention.ports?.input === "Fasta" || mention.ports?.inputs?.some((port) => port.type === "Fasta" || port.type === "FastaGz")))
    || genomeIndexBuilders.length > 0;
  const requiredAnnotationTypes = new Set<PortType>();
  for (const mention of filtered) {
    if (mention.support === "unsupported") {
      if (["Gtf", "GtfGz", "Gff3"].includes(mention.ports?.input ?? "")) requiredAnnotationTypes.add(mention.ports!.input);
      continue;
    }
    for (const port of catalog.get(mention.operator_id!)?.ports.in ?? []) {
      if (!port.optional && ["Gtf", "GtfGz", "Gff3"].includes(port.type)) requiredAnnotationTypes.add(port.type);
    }
  }
  let reference: SomiteGraphNode | undefined;
  if (linkageWorkflow) reference = addOperatorNode(graph, catalog, "files.import_fasta", "The paper scaffolds a named starting assembly; attach that exact FASTA or replace this with its cited online assembly.");
  else if (genome && needsReference) reference = addOperatorNode(graph, catalog, "ensembl.fasta", `The paper identifies ${genome}; select the exact Ensembl or NCBI assembly before running.`);
  else if (needsReference) reference = addOperatorNode(graph, catalog, "files.import_fasta", genome
    ? `The paper identifies ${genome}; attach its uncompressed reference FASTA or replace this with a matching cited online assembly.`
    : "The paper uses a reference or starting assembly; attach that exact FASTA or replace this with a cited online assembly.");
  const transcriptReference = transcriptIndexBuilders.length
    ? addOperatorNode(graph, catalog, "files.import_fasta", "Attach the transcript FASTA quantified by the paper; this is distinct from a genomic reference FASTA.")
    : undefined;
  let genomeIndexReference = reference;
  if (reference && genomeIndexBuilders.length > 0 && reference.ports.some((port) => port.dir === "out" && port.ty === "FastaGz")) {
    const decompress = addOperatorNode(graph, catalog, "archive.gunzip_fasta", "Decompress the selected public reference into the plain FASTA required by these index builders.");
    connectSpecific(graph, reference, decompress);
    genomeIndexReference = decompress;
  }
  if (requiredAnnotationTypes.has("Gtf") || requiredAnnotationTypes.has("GtfGz")) {
    addOperatorNode(graph, catalog, genome ? "ensembl.gtf" : "files.import_gtf", genome
      ? `The paper identifies ${genome}; select matching gene annotation before running.`
      : "The paper requires a gene annotation; attach the exact GTF used by the study.");
  }
  if (requiredAnnotationTypes.has("Gff3")) {
    addOperatorNode(graph, catalog, "files.import_gff3", "The paper requires a genome annotation; attach the exact GFF3 used by the study.");
  }
  if (filtered.some((mention) => mention.operator_id === "nf.rnaseq")) {
    const sheet = addOperatorNode(graph, catalog, "sheet.rnaseq", "Build the nf-core samplesheet from the cited or selected reads.");
    connectSpecific(graph, reads, sheet);
  }
  const methodNodes: SomiteGraphNode[] = [];
  const explicitNodeIds = new Set<string>();
  for (const { profile, builder } of indexBuilders) {
    const node = addOperatorNode(graph, catalog, builder.id, `Build the ${isTranscriptIndexProfile(profile) ? "transcriptome" : "reference genome"} index required by the paper's selected tool.`);
    if (node) {
      methodNodes.push(node);
      connectSpecific(graph, isTranscriptIndexProfile(profile) ? transcriptReference : genomeIndexReference, node);
    }
  }
  for (const mention of filtered.sort((left, right) => methodRank(left) - methodRank(right) || left.offset - right.offset)) {
    const node = mention.support === "operator"
      ? addOperatorNode(graph, catalog, mention.operator_id!, mention.evidence)
      : addGapNode(graph, catalog, mention);
    if (node) {
      methodNodes.push(node);
      explicitNodeIds.add(node.id);
    }
  }
  connectSpecific(graph, reads, methodNodes.find((node) => node.operator === "asm.hifiasm"));
  connectSpecific(graph, hiCReads, gapWithTool(methodNodes, "BWA-MEM2"));
  for (const aligner of [...methodNodes]) {
    const alignerIndex = graph.nodes.indexOf(aligner);
    if (alignerIndex < 0 || !aligner.ports.some((port) => port.dir === "out" && port.ty === "Sam")) continue;
    if (graph.nodes.slice(alignerIndex + 1).some((node) => node.ports.some((port) => port.dir === "in" && port.ty === "Sam"))) continue;
    if (!graph.nodes.slice(alignerIndex + 1).some((node) => node.ports.some((port) => port.dir === "in" && port.ty === "Bam"))) continue;
    const converter = addOperatorNode(graph, catalog, "align.samtools_view", `${catalog.get(aligner.operator)?.title ?? aligner.operator} emits SAM; convert it to BAM for the named downstream method.`, { exclude_flags: 0 });
    if (!converter) continue;
    graph.nodes.splice(graph.nodes.indexOf(converter), 1);
    graph.nodes.splice(alignerIndex + 1, 0, converter);
  }
  connectNamedMethodHandoffs(graph, catalog, methodNodes);
  for (const target of [...methodNodes]) insertProfilePreparation(graph, catalog, target);
  for (const target of [...methodNodes]) insertTypedPreparation(graph, catalog, target);
  connectByTypes(graph, catalog);
  if (assay === "assembly") enforceAssemblyFlow(graph, catalog);
  if (linkageWorkflow) enforceLinkageFlow(graph, catalog);
  layoutGraph(graph);
  const reviewed = graph.nodes.some((node) => node.operator !== "gap.missing" && catalog.get(node.operator)?.paper);
  const evidenceBackedGap = graph.nodes.some((node) => node.operator === "gap.missing" && node.note && node.ports.some((port) => port.dir === "in") && node.ports.some((port) => port.dir === "out"));
  const coreEvidenceGap = filtered.some((mention) => mention.core
    && graph.nodes.some((node) => node.operator === "gap.missing"
      && normalizedName(String(node.params?.tool ?? "")) === mention.normalized_name));
  if (!reviewed && !evidenceBackedGap && !coreEvidenceGap) return undefined;
  const graphValidation = validateGraph(graph);
  const catalogValidation = catalog.verifyGraph(graph);
  if (!graphValidation.ok || !catalogValidation.ok) return undefined;
  const assessment = assessWorkflow(graph, catalog);
  const warnings = [
    ...(assessment.required_count
      ? [`Draft reconstructed from paper evidence; ${assessment.required_count} item${assessment.required_count === 1 ? "" : "s"} still ${assessment.required_count === 1 ? "needs" : "need"} review or input before it can run.`]
      : []),
    ...(readResolutionWarning ? [readResolutionWarning] : []),
  ];
  return {
    name: assemblyChoice ? `${assemblyChoice.display_name} assembly` : candidateName(assay),
    role,
    assay,
    graph,
    warnings,
    evidence: graphEvidence(graph, extractedVia, explicitNodeIds),
    assessment,
  } satisfies PaperCandidate;
}

function operationClassAssays(operationClass?: string): readonly Assay[] {
  if (!operationClass) return [];
  if (/single_cell/i.test(operationClass)) return ["single_cell"];
  if (/(?:metagenom|binning|taxonomic_classification)/i.test(operationClass)) return ["metagenome"];
  if (/(?:variant|somatic|germline)/i.test(operationClass)) return ["variants"];
  if (/(?:transcript|differential_expression|read_quantification)/i.test(operationClass)) return ["rna_seq"];
  if (/(?:^assemble$|assembly|scaffold|gap_closing|genome_annotation|repeat_|kmer|optical_map)/i.test(operationClass)) return ["assembly"];
  return [];
}

function localAssayScores(text: string, mention: LocatedMention) {
  const clause = `${boundedClause(text, mention.offset, mention.end).text} ${text.slice(Math.max(0, mention.offset - 384), Math.min(text.length, mention.end + 256))}`;
  const score = (cues: readonly [RegExp, number][]) => cues.reduce((total, [cue, weight]) => total + (cue.test(clause) ? weight : 0), 0);
  return new Map<Assay, number>([
    ["assembly", score([
      [/\b(?:genome|de novo)\s+assembl|\bassembl(?:ed|er)\b/i, 5],
      [/\b(?:pacbio|hifi|ccs|long reads?|genome size|k[- ]?mer)\b/i, 3],
      [/\b(?:contig|scaffold|genome annotation|gene prediction)\b/i, 3],
      [/\b(?:genomic dna|dna librar|mgi|dnbs?|proteome|protein-coding genes?)\b/i, 2],
    ])],
    ["rna_seq", score([
      [/\b(?:rna[- ]?seq|metatranscriptom\w*|transcriptom\w*|transcript|gene expression)\b/i, 5],
      [/\b(?:feature counts?|count matrix|differential expression)\b/i, 3],
      [/\brna\b/i, 1],
    ])],
    ["variants", score([
      [/\b(?:variant call|somatic|germline|mosaic variant|vcf)\b/i, 5],
      [/\bvariants?\b/i, 3],
      [/\bmosaic\b/i, 2],
    ])],
    ["metagenome", score([[/\b(?:metagenom|taxonomic|microbiome|binning)\b/i, 5]])],
    ["single_cell", score([[/\b(?:single[- ]cell|scrna|cell barcode|cellular barcode)\b/i, 8]])],
    ["qc", score([[/\b(?:quality control|quality assessment|qc report)\b/i, 4]])],
    ["unknown", 0],
  ]);
}

function uniqueLocalAssay(text: string, mention: LocatedMention, choices: readonly Assay[]) {
  const scores = localAssayScores(text, mention);
  const ranked = choices
    .map((assay) => ({ assay, score: scores.get(assay) ?? 0 }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length || ranked[0]!.score === ranked[1]?.score) return undefined;
  return ranked[0]!.assay;
}

function inferredMentionAssay(
  text: string,
  mention: LocatedMention,
  priorMentions: readonly LocatedMention[],
  assays: readonly Assay[],
) {
  const applicable = mention.assays?.length
    ? assays.filter((assay) => mention.assays!.includes(assay))
    : [...assays];
  const choices = applicable.length ? applicable : assays.length === 1 ? [...assays] : [];
  if (!choices.length) return undefined;
  const local = uniqueLocalAssay(text, mention, choices);
  if (local) return local;
  const semantic = operationClassAssays(mention.operation_class).filter((assay) => choices.includes(assay));
  if (semantic.length === 1) return semantic[0];
  const prior = [...priorMentions].reverse().find((candidate) => {
    if (!candidate.executable || mention.offset - candidate.end > 768) return false;
    return candidate.assays?.filter((assay) => choices.includes(assay)).length === 1;
  });
  const inherited = prior?.assays?.filter((assay) => choices.includes(assay));
  if (inherited?.length === 1) return inherited[0];
  return choices.length === 1 ? choices[0] : undefined;
}

/**
 * Unsupported evidence is projected only where the method sentence, semantic
 * operation, or an immediately preceding scoped method identifies its assay.
 * Ambiguous evidence stays in the review as unknown instead of falling onto
 * whichever detected assay happened to sort first.
 */
function scopeUnsupportedEvidence(text: string, mentions: readonly LocatedMention[], assays: readonly Assay[]) {
  if (!assays.length) return [...mentions];
  const scoped: LocatedMention[] = [];
  for (const mention of mentions) {
    if (mention.support !== "unsupported" || !mention.executable) {
      scoped.push(mention);
      continue;
    }
    const inferred = inferredMentionAssay(text, mention, scoped, assays);
    if (inferred) {
      if (mention.assays?.length && !mention.assays.includes(inferred)) {
        const { ports: _ports, ...evidenceOnly } = mention;
        scoped.push({ ...evidenceOnly, assays: [inferred] });
      } else {
        scoped.push({ ...mention, assays: [inferred] });
      }
      continue;
    }
    if (mention.core) {
      const applicable = mention.assays?.length
        ? assays.filter((assay) => mention.assays!.includes(assay))
        : [...assays];
      if (applicable.length) {
        scoped.push({ ...mention, assays: applicable });
        continue;
      }
    }
    const { ports: _ports, ...evidenceOnly } = mention;
    scoped.push({
      ...evidenceOnly,
      assays: ["unknown"],
    });
  }
  return scoped;
}

function candidateRepresentsMention(candidate: PaperCandidate, mention: LocatedMention) {
  if (mention.operator_id) return candidate.graph.nodes.some((node) => node.operator === mention.operator_id);
  return candidate.graph.nodes.some((node) => node.operator === "gap.missing"
    && normalizedName(String(node.params?.tool ?? "")) === mention.normalized_name);
}

export function reconstructPaper(catalog: OperatorCatalog, text: string, extractedVia: PaperExtractVia): PaperReview {
  const normalized = text.replace(/\r\n?/g, "\n");
  const mentions = recognizedMethods(catalog, normalized, extractedVia);
  const resourceScan = scanPaperResourceCitations(normalized, extractedVia);
  const resources = resourceScan.resources;
  const workflowSourceScan = scanPaperWorkflowCitations(normalized, extractedVia);
  const focus = paperMethodsWindow(normalized).text;
  const assayText = focus.length >= 200 ? focus : normalized;
  const assayLower = assayText.toLocaleLowerCase("en-US");
  const normalizedLower = assayText === normalized ? assayLower : normalized.toLocaleLowerCase("en-US");
  const scoredAssays = relevantAssays(assayLower);
  const evidenceAssay = scoredAssays.length === 1 && (scoredAssays[0] === "unknown" || scoredAssays[0] === "qc") ? assayFromMethodEvidence(mentions) : undefined;
  const detectedAssays = evidenceAssay ? [evidenceAssay] : scoredAssays;
  const hasRnaAnalysis = mentions.some((mention) => mention.executable && [
    "transcript_assembly",
    "transcript_quantification",
    "read_quantification",
    "differential_expression",
  ].includes(mention.operation_class ?? ""));
  const assays = detectedAssays.includes("rna_seq") && detectedAssays.includes("variants") && !hasRnaAnalysis
    ? detectedAssays.filter((assay) => assay !== "rna_seq")
    : detectedAssays;
  const candidateMentions = scopeUnsupportedEvidence(normalized, mentions, assays);
  const builtCandidates: PaperCandidate[] = [];
  for (const assay of assays) {
    const assemblers = assay === "assembly"
      ? candidateMentions.filter((mention) => mention.executable && isAssemblyMethod(mention))
      : [];
    if (assemblers.length > 1) {
      for (const assembler of assemblers) {
        const candidate = buildCandidate(catalog, normalized, normalizedLower, resources, candidateMentions, assay, extractedVia, "alternative", assembler);
        if (candidate) builtCandidates.push(candidate);
      }
    } else {
      const candidate = buildCandidate(catalog, normalized, normalizedLower, resources, candidateMentions, assay, extractedVia, assays.length > 1 ? "parallel" : "primary");
      if (candidate) builtCandidates.push(candidate);
    }
  }
  const unrepresentedCoreMethods = candidateMentions.filter((mention) => mention.core
    && mention.executable
    && !builtCandidates.some((candidate) => candidateRepresentsMention(candidate, mention)));
  const candidates = unrepresentedCoreMethods.length ? [] : builtCandidates;
  const outcome: PaperReconstructionOutcome = candidates.length
    ? "drafts_ready"
    : mentions.length
      ? "recognized_unsupported"
      : "no_reconstructable_methods";
  const outcomeWarnings = outcome === "drafts_ready"
    ? [...new Set(candidates.flatMap((candidate) => candidate.warnings))]
    : outcome === "recognized_unsupported"
      ? [
        "Somite found computational methods and retained their evidence, but no reviewed executable workflow could be assembled without guessing.",
        ...(unrepresentedCoreMethods.length
          ? [`Somite did not offer a supporting-tools-only draft because its named core method${unrepresentedCoreMethods.length === 1 ? "" : "s"} could not be placed honestly: ${unrepresentedCoreMethods.map((mention) => mention.display_name).join(", ")}.`]
          : []),
      ]
      : workflowSourceScan.workflow_sources.length
        ? ["Somite found the paper's cited workflow repository, but did not invent a separate workflow from insufficient prose evidence. Pin the cited source below to inspect it directly."]
        : ["Somite read the document but did not find enough computational-method evidence to propose a workflow."];
  const warnings = [
    ...outcomeWarnings,
    ...(resourceScan.truncated
      ? [`This paper cites more than ${MAX_PAPER_RESOURCE_CITATIONS.toLocaleString("en-US")} unique public-data accessions. Somite retained the first ${MAX_PAPER_RESOURCE_CITATIONS.toLocaleString("en-US")} and reported the omission explicitly.`]
      : []),
    ...(workflowSourceScan.truncated
      ? ["This paper cites more than 8 workflow repositories. Somite retained the first 8 and reported the omission explicitly."]
      : []),
  ];
  return enforcePaperReviewSize({
    extracted_via: extractedVia,
    outcome,
    warnings,
    mentions: mentions.map((mention): PaperMethodMention => ({
      display_name: mention.display_name,
      normalized_name: mention.normalized_name,
      ...(mention.operation_class ? { operation_class: mention.operation_class } : {}),
      ...(mention.version ? { version: mention.version } : {}),
      evidence: mention.evidence,
      support: mention.support,
      executable: mention.executable,
      ...(mention.core ? { core: true } : {}),
      ...(mention.operator_id ? { operator_id: mention.operator_id } : {}),
      ...(mention.source_location ? { source_location: mention.source_location } : {}),
    })),
    resources,
    workflow_sources: workflowSourceScan.workflow_sources,
    candidates,
  });
}
