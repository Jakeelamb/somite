import { assessWorkflow, type WorkflowAssessment } from "./assessment.ts";
import { OperatorCatalog, operatorPorts, type PinnedOperator } from "./catalog.ts";
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
  evidence: string;
  support: "operator" | "unsupported";
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
  candidates: PaperCandidate[];
};

type Assay = "assembly" | "rna_seq" | "variants" | "metagenome" | "single_cell" | "qc" | "unknown";

type UnsupportedMethod = Readonly<{
  displayName: string;
  normalizedName: string;
  operationClass: string;
  aliases: readonly string[];
  ports?: Readonly<{ input: PortType; inputUnion?: readonly PortType[]; output: PortType }>;
}>;

type LocatedMention = PaperMethodMention & {
  offset: number;
  end: number;
  executable: boolean;
  aliases: readonly string[];
  ports?: Readonly<{ input: PortType; inputUnion?: readonly PortType[]; output: PortType }>;
};

const unsupportedMethods: readonly UnsupportedMethod[] = [
  { displayName: "Ballgown", normalizedName: "ballgown", operationClass: "differential_expression", aliases: ["ballgown"], ports: { input: "Gtf", output: "Table" } },
  { displayName: "Kallisto", normalizedName: "kallisto", operationClass: "transcript_quantification", aliases: ["kallisto"], ports: { input: "Fastq", output: "Table" } },
  { displayName: "MultiQC", normalizedName: "multiqc", operationClass: "aggregate_qc", aliases: ["multiqc"], ports: { input: "Directory", output: "Html" } },
  { displayName: "Picard", normalizedName: "picard", operationClass: "bam_processing", aliases: ["picard", "markduplicates"], ports: { input: "Bam", output: "Bam" } },
  { displayName: "Mutect2", normalizedName: "mutect2", operationClass: "variant_calling", aliases: ["mutect2", "mutect"], ports: { input: "Bam", output: "Vcf" } },
  { displayName: "MetaBAT", normalizedName: "metabat", operationClass: "binning", aliases: ["metabat"], ports: { input: "Bam", output: "Directory" } },
  { displayName: "SPAdes", normalizedName: "spades", operationClass: "assemble", aliases: ["spades"], ports: { input: "Fastq", output: "Directory" } },
  { displayName: "Cell Ranger", normalizedName: "cellranger", operationClass: "single_cell_preprocessing", aliases: ["cellranger", "cell ranger"], ports: { input: "Fastq", output: "Directory" } },
  { displayName: "SoupX", normalizedName: "soupx", operationClass: "ambient_rna_correction", aliases: ["soupx"], ports: { input: "Directory", output: "Directory" } },
  { displayName: "Seurat", normalizedName: "seurat", operationClass: "single_cell_analysis", aliases: ["seurat"], ports: { input: "Directory", output: "Directory" } },
  { displayName: "DoubletFinder", normalizedName: "doubletfinder", operationClass: "doublet_detection", aliases: ["doubletfinder", "doublet finder"], ports: { input: "Directory", output: "Directory" } },
  { displayName: "Cutadapt", normalizedName: "cutadapt", operationClass: "trim", aliases: ["cutadapt"] },
  { displayName: "Trimmomatic", normalizedName: "trimmomatic", operationClass: "trim", aliases: ["trimmomatic"] },
  { displayName: "Trim Galore", normalizedName: "trimgalore", operationClass: "trim", aliases: ["trim galore", "trimgalore"] },
  { displayName: "Porechop", normalizedName: "porechop", operationClass: "trim", aliases: ["porechop"] },
  { displayName: "dnaPipeTE", normalizedName: "dnapipete", operationClass: "repeat_discovery", aliases: ["dnapipete", "dna pipe te"] },
  { displayName: "PiRATE", normalizedName: "pirate", operationClass: "repeat_annotation", aliases: ["pirate"] },
  { displayName: "dipSPAdes", normalizedName: "dipspades", operationClass: "assemble", aliases: ["dipspades"] },
  { displayName: "RepeatModeler", normalizedName: "repeatmodeler", operationClass: "repeat_discovery", aliases: ["repeatmodeler"] },
  { displayName: "Bowtie2", normalizedName: "bowtie2", operationClass: "align", aliases: ["bowtie2"] },
  { displayName: "seqkit", normalizedName: "seqkit", operationClass: "sequence_processing", aliases: ["seqkit"] },
  { displayName: "parseRM.pl", normalizedName: "parsermpl", operationClass: "repeat_summary", aliases: ["parserm.pl"] },
  { displayName: "LTRpred", normalizedName: "ltrpred", operationClass: "ltr_annotation", aliases: ["ltrpred"] },
  { displayName: "Trinotate", normalizedName: "trinotate", operationClass: "transcript_annotation", aliases: ["trinotate"] },
  { displayName: "CD-HIT-est", normalizedName: "cdhitest", operationClass: "sequence_clustering", aliases: ["cd-hit-est"] },
  { displayName: "Trinity", normalizedName: "trinity", operationClass: "assemble", aliases: ["trinity"] },
  { displayName: "FALCON", normalizedName: "falcon", operationClass: "assemble", aliases: ["falcon-unzip", "falcon unzip", "falcon"], ports: { input: "Fastq", output: "Fasta" } },
  { displayName: "Flye", normalizedName: "flye", operationClass: "assemble", aliases: ["flye"], ports: { input: "Fastq", output: "Fasta" } },
  { displayName: "Purge_Dups", normalizedName: "purgedups", operationClass: "purge_haplotigs", aliases: ["purge_dups", "purge dups", "purge_haplotigs", "purge haplotigs"], ports: { input: "Fasta", output: "Fasta" } },
  { displayName: "Salsa", normalizedName: "salsa", operationClass: "scaffold", aliases: ["salsa"], ports: { input: "Fasta", output: "Fasta" } },
  { displayName: "RepeatMasker", normalizedName: "repeatmasker", operationClass: "repeat_annotation", aliases: ["repeatmasker", "repeat masker"] },
  { displayName: "phytools", normalizedName: "phytools", operationClass: "phylogenetic_analysis", aliases: ["r package phytools", "phytools"] },
  { displayName: "OUwie", normalizedName: "ouwie", operationClass: "phylogenetic_modeling", aliases: ["ouwie"] },
  { displayName: "R", normalizedName: "r", operationClass: "statistical_analysis", aliases: ["r statistical computing environment", "r statistical environment", "using r version"] },
  { displayName: "Custom script", normalizedName: "custom-script", operationClass: "custom_analysis", aliases: ["custom perl script", "custom python script", "custom script"] },
];

const startHeadings = ["materials and methods", "materials & methods", "online methods", "experimental procedures", "computational methods", "methods", "method"];
const endHeadings = ["results", "discussion", "data availability", "code availability", "acknowledgements", "acknowledgments", "author contributions", "competing interests", "references", "bibliography"];
const rnaCovers = new Set(["align.star", "align.hisat2", "quant.salmon", "quant.featurecounts", "quant.stringtie"]);
const variantCovers = new Set(["align.bwa", "var.haplotypecaller"]);
const metagenomeCovers = new Set(["class.kraken2"]);

function normalizedName(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "").toLocaleLowerCase("en-US");
}

function headingOffset(text: string, headings: readonly string[], from = 0) {
  let offset = from;
  for (const line of text.slice(from).split(/(?<=\n)/)) {
    const content = line.replace(/[\s\f]+$/g, "").toLocaleLowerCase("en-US");
    const first = content.search(/[^\s\f]/);
    if (first >= 0) {
      for (const heading of headings) {
        const rest = content.slice(first);
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
    offset += line.length;
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

function aliasMatches(text: string, alias: string) {
  const exactCase = alias.length <= 4 && /^[A-Z]+$/.test(alias);
  const expression = new RegExp(`(^|[^A-Za-z0-9])(${escapedAlias(alias)})(?=$|[^A-Za-z0-9])`, exactCase ? "g" : "gi");
  const matches: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(expression)) {
    const prefix = match[1] ?? "";
    const surface = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    matches.push({ start, end: start + surface.length });
  }
  return matches;
}

function clause(text: string, start: number, end: number) {
  const left = Math.max(text.lastIndexOf(".", start - 1), text.lastIndexOf(";", start - 1), text.lastIndexOf("\n", start - 1)) + 1;
  const candidates = [text.indexOf(".", end), text.indexOf(";", end), text.indexOf("\n", end)].filter((value) => value >= 0);
  const right = candidates.length ? Math.min(...candidates) : text.length;
  return { before: text.slice(left, start).trim().toLocaleLowerCase("en-US"), after: text.slice(end, right).trim().toLocaleLowerCase("en-US") };
}

function executableMatch(text: string, start: number, end: number) {
  const current = clause(text, start, end);
  if (["without", "did not use", "not using", "rather than", "instead of"].some((value) => current.before.endsWith(value))) return false;
  if (["not used", "not selected", "not retained"].some((value) => current.after.includes(value))) return false;
  if (["compared", "comparing", "benchmarked", "evaluated"].some((value) => current.before.endsWith(value))) return false;
  return true;
}

function evidenceSnippet(text: string, start: number, end: number) {
  return text.slice(Math.max(0, start - 72), Math.min(text.length, end + 96)).replace(/\s+/g, " ").trim();
}

function pageAt(text: string, offset: number) {
  return text.slice(0, offset).split("\f").length;
}

function location(extractedVia: PaperExtractVia, page: number) {
  return extractedVia === "pdfjs" || extractedVia === "ocr" ? `PDF page ${page}` : undefined;
}

function recognizedMethods(catalog: OperatorCatalog, fullText: string, extractedVia: PaperExtractVia): LocatedMention[] {
  const window = paperMethodsWindow(fullText);
  const found: LocatedMention[] = [];
  for (const operator of catalog.values()) {
    if (!operator.paper) continue;
    const matches = operator.paper.aliases.flatMap((alias) => aliasMatches(window.text, alias).map((match) => ({ alias, ...match })));
    const first = matches.sort((left, right) => left.start - right.start)[0];
    if (!first) continue;
    const offset = window.offset + first.start;
    const end = window.offset + first.end;
    const page = pageAt(fullText, offset);
    found.push({
      display_name: window.text.slice(first.start, first.end).replace(/\s+/g, " ").trim(),
      normalized_name: normalizedName(operator.title),
      ...(operator.paper.operation_class ? { operation_class: operator.paper.operation_class } : {}),
      evidence: evidenceSnippet(fullText, offset, end),
      support: "operator",
      operator_id: operator.id,
      ...(location(extractedVia, page) ? { source_location: location(extractedVia, page) } : {}),
      offset,
      end,
      executable: matches.some((match) => executableMatch(window.text, match.start, match.end)),
      aliases: operator.paper.aliases,
    });
  }
  for (const spec of unsupportedMethods) {
    const matches = spec.aliases.flatMap((alias) => aliasMatches(window.text, alias).map((match) => ({ alias, ...match })));
    const first = matches.sort((left, right) => left.start - right.start)[0];
    if (!first) continue;
    const offset = window.offset + first.start;
    const end = window.offset + first.end;
    const page = pageAt(fullText, offset);
    found.push({
      display_name: window.text.slice(first.start, first.end).replace(/\s+/g, " ").trim() || spec.displayName,
      normalized_name: spec.normalizedName,
      operation_class: spec.operationClass,
      evidence: evidenceSnippet(fullText, offset, end),
      support: "unsupported",
      ...(location(extractedVia, page) ? { source_location: location(extractedVia, page) } : {}),
      offset,
      end,
      executable: matches.some((match) => executableMatch(window.text, match.start, match.end)),
      aliases: spec.aliases,
      ...(spec.ports ? { ports: spec.ports } : {}),
    });
  }
  const unique = new Map<string, LocatedMention>();
  for (const mention of found.sort((left, right) => left.offset - right.offset || left.normalized_name.localeCompare(right.normalized_name))) {
    if (!unique.has(mention.normalized_name)) unique.set(mention.normalized_name, mention);
  }
  return [...unique.values()];
}

export function paperAccessionKind(accession: string): PaperResourceCitation["kind"] | undefined {
  if (/^(?:SRR|ERR|DRR)\d{6,}$/.test(accession)) return "sra_run";
  if (/^(?:SRP|ERP|DRP)\d{6,}$/.test(accession)) return "sra_study";
  if (/^(?:SRX|ERX|DRX)\d{6,}$/.test(accession)) return "sra_experiment";
  if (/^(?:SRS|ERS|DRS)\d{6,}$/.test(accession)) return "sra_sample";
  if (/^(?:PRJNA|PRJEB|PRJDB)\d{6,}$/.test(accession)) return "bioproject";
  if (/^(?:SAMN|SAMEA|SAMD)\d{6,}$/.test(accession)) return "biosample";
  if (/^(?:GCA_|GCF_)\d+(?:\.\d+)?$/.test(accession)) return "assembly";
  if (/^ENS[A-Z]*[GTP]\d{6,}(?:\.\d+)?$/.test(accession)) return "ensembl";
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

export function paperResourceCitations(text: string, extractedVia: PaperExtractVia): PaperResourceCitation[] {
  const pattern = /\b(?:SR[RPXS]|ER[RPXS]|DR[RPXS])\d{6,}\b|\b(?:PRJNA|PRJEB|PRJDB)\d{6,}\b|\b(?:SAMN|SAMEA|SAMD)\d{6,}\b|\b(?:GCA_|GCF_)\d+(?:\.\d+)?\b|\bENS[A-Z]*[GTP]\d{6,}(?:\.\d+)?\b/gi;
  const citations = new Map<string, PaperResourceCitation>();
  for (const match of text.matchAll(pattern)) {
    const accession = match[0]!.toUpperCase();
    const kind = paperAccessionKind(accession);
    if (!kind) continue;
    const offset = match.index ?? 0;
    const context = evidenceSnippet(text, offset, offset + accession.length);
    const citation: PaperResourceCitation = {
      accession,
      kind,
      role: resourceRole(kind, context),
      context,
      ...(location(extractedVia, pageAt(text, offset)) ? { source_location: location(extractedVia, pageAt(text, offset)) } : {}),
    };
    const existing = citations.get(accession);
    const priority = { unknown: 0, sample_metadata: 1, annotation: 2, reads: 3, reference: 4 } as const;
    if (!existing || priority[citation.role] > priority[existing.role]) citations.set(accession, citation);
  }
  return [...citations.values()];
}

function assayScores(text: string) {
  const lower = text.toLocaleLowerCase("en-US");
  const score = (cues: readonly [string, number][]) => cues.reduce((total, [cue, weight]) => total + (lower.includes(cue) ? weight : 0), 0);
  return new Map<Assay, number>([
    ["assembly", score([["hifiasm", 5], ["yahs", 4], ["genomescope", 3], ["chromosome-scale assembl", 4], ["haplotype assembl", 4], ["pacbio hifi", 2], ["falcon", 4], ["purge_dups", 4], ["purge haplotigs", 4], ["vertebrate genome project", 5]])],
    ["rna_seq", score([["nf-core/rnaseq", 6], ["hisat2", 4], ["stringtie", 4], ["rna-seq", 6], ["rna seq", 6], ["rnaseq", 6], ["differential expression", 3]])],
    ["variants", score([["gatk best practices", 6], ["haplotypecaller", 5], ["variant call", 4], ["mutect", 4], ["sarek", 5], ["somatic", 3], ["germline", 3], ["whole genome sequenc", 2]])],
    ["metagenome", score([["kraken 2", 6], ["kraken2", 6], ["nf-core/mag", 6], ["nf-core/taxprofiler", 6], ["metagenom", 4], ["metabat", 4]])],
    ["single_cell", score([["single-cell rna", 6], ["single cell rna", 6], ["scrna", 5], ["cellranger", 5], ["cell ranger", 5], ["seurat", 4], ["doubletfinder", 4], ["soupx", 4]])],
  ]);
}

function relevantAssays(text: string): Assay[] {
  const lower = text.toLocaleLowerCase("en-US");
  if (lower.includes("allmaps") && (lower.includes("linkage map") || lower.includes("ordering and orientation"))) return ["assembly"];
  const scores = [...assayScores(text)].filter(([, value]) => value >= 6).sort((left, right) => right[1] - left[1]);
  if (scores.length) return scores.map(([assay]) => assay);
  return lower.includes("fastqc") ? ["qc"] : ["unknown"];
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

function addGapNode(graph: SomiteGraph, catalog: OperatorCatalog, mention: LocatedMention) {
  if (!mention.ports) return undefined;
  const tool = unsupportedMethods.find((method) => method.normalizedName === mention.normalized_name)?.displayName ?? mention.display_name;
  const node = addOperatorNode(graph, catalog, "gap.missing", mention.evidence, { tool, quote: mention.evidence });
  if (!node) return undefined;
  node.ports = [
    { name: "in", dir: "in", ty: mention.ports.input, ...(mention.ports.inputUnion?.length ? { union: [...mention.ports.inputUnion] } : {}) },
    { name: "out", dir: "out", ty: mention.ports.output },
  ];
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

function enforceAssemblyFlow(graph: SomiteGraph) {
  const assembler = graph.nodes.find((node) => node.operator === "asm.hifiasm")
    ?? graph.nodes.find((node) => node.operator === "gap.missing" && ["falcon", "flye", "hicanu", "canu", "peregrine", "shasta", "masurca"].includes(normalizedName(String(node.params?.tool ?? ""))));
  const purge = gapWithTool(graph.nodes, "Purge_Dups");
  const scaffold = graph.nodes.find((node) => node.operator === "asm.yahs") ?? gapWithTool(graph.nodes, "Salsa");
  const blob = gapWithTool(graph.nodes, "Blobtools");
  const busco = graph.nodes.find((node) => node.operator === "qc.busco");
  let tail = assembler;
  for (const next of [purge, scaffold, blob]) {
    if (next) {
      connectReplacing(graph, tail, next);
      tail = next;
    }
  }
  connectReplacing(graph, tail, busco);
  const minimap = graph.nodes.find((node) => node.operator === "align.minimap2");
  connectReplacing(graph, assembler, minimap, "ref");
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

function connectByTypes(graph: SomiteGraph) {
  const nodes = [...graph.nodes];
  for (let targetIndex = 0; targetIndex < nodes.length; targetIndex += 1) {
    const target = nodes[targetIndex]!;
    const occupied = new Set(graph.edges.filter((edge) => edge.to_node === target.id).map((edge) => edge.to_port));
    const usedOutputs = new Set<string>();
    for (const input of target.ports.filter((port) => port.dir === "in" && !occupied.has(port.name))) {
      let selected: { node: SomiteGraphNode; port: SomitePort } | undefined;
      for (let sourceIndex = targetIndex - 1; sourceIndex >= 0; sourceIndex -= 1) {
        const source = nodes[sourceIndex]!;
        const compatible = source.ports.filter((port) => port.dir === "out" && compatiblePortTypes(port.ty, input.ty, input.union));
        const port = compatible.find((candidate) => candidate.name === input.name && !usedOutputs.has(`${source.id}\0${candidate.name}`))
          ?? compatible.find((candidate) => !usedOutputs.has(`${source.id}\0${candidate.name}`))
          ?? compatible[0];
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

function knownGenome(text: string) {
  const lower = text.toLocaleLowerCase("en-US");
  for (const [needle, name] of [["grch38", "GRCh38"], ["hg38", "GRCh38"], ["grch37", "GRCh37"], ["hg19", "GRCh37"], ["grcm39", "GRCm39"], ["mm39", "GRCm39"], ["mm10", "GRCm38"], ["t2t", "T2T-CHM13"]] as const) {
    if (lower.includes(needle)) return name;
  }
  return undefined;
}

function exactRun(resources: readonly PaperResourceCitation[]) {
  return resources.find((resource) => resource.kind === "sra_run")?.accession;
}

function graphEvidence(graph: SomiteGraph, extractedVia: PaperExtractVia): PaperEvidence[] {
  const evidence: PaperEvidence[] = [];
  for (const node of graph.nodes) {
    const needsAdapter = node.operator === "gap.missing";
    evidence.push({
      target_kind: "node",
      target_id: node.id,
      status: needsAdapter ? "needs_adapter" : node.note ? "explicit" : "inferred",
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

function syntheticAssemblySteps(text: string): LocatedMention[] {
  const steps: Array<Readonly<{ needles: readonly string[]; displayName: string; input: PortType; inputUnion?: readonly PortType[]; output: PortType }>> = [
    { needles: ["genomescope"], displayName: "Genomescope", input: "Fastq", inputUnion: ["FastqGz"], output: "Directory" },
    { needles: ["blobtools", "blobtoolkit"], displayName: "Blobtools", input: "Fasta", inputUnion: ["FastaGz", "Directory"], output: "Directory" },
    { needles: ["augustus"], displayName: "Augustus", input: "Bam", output: "Directory" },
    { needles: ["merqury"], displayName: "Merqury", input: "Fasta", inputUnion: ["FastaGz", "Directory"], output: "Directory" },
    { needles: ["mitohifi"], displayName: "MitoHiFi", input: "Fastq", inputUnion: ["FastqGz"], output: "Directory" },
    { needles: ["bakta"], displayName: "Bakta", input: "Fasta", inputUnion: ["FastaGz", "Directory"], output: "Directory" },
  ];
  const lower = text.toLocaleLowerCase("en-US");
  return steps.flatMap((step): LocatedMention[] => {
    const located = step.needles
      .map((needle) => ({ needle, offset: lower.indexOf(needle) }))
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

function buildCandidate(
  catalog: OperatorCatalog,
  text: string,
  resources: readonly PaperResourceCitation[],
  mentions: readonly LocatedMention[],
  assay: Assay,
  extractedVia: PaperExtractVia,
  role: PaperCandidate["role"],
  assemblyChoice?: LocatedMention,
) {
  const graph: SomiteGraph = { schema_version: 3, name: candidateName(assay), nodes: [], edges: [] };
  const linkageWorkflow = assay === "assembly" && /allmaps/i.test(text) && /linkage map|ordering and orientation/i.test(text);
  const selected = mentions.filter((mention) => {
    if (!mention.executable) return false;
    if (assemblyChoice && isAssemblyMethod(mention) && mention.normalized_name !== assemblyChoice.normalized_name) return false;
    if (mention.support === "unsupported") return Boolean(mention.ports) && !(linkageWorkflow && mention.normalized_name === "picard");
    const operator = catalog.get(mention.operator_id!);
    return Boolean(operator && operatorAssay(operator, assay));
  });
  const compounds = new Set(selected.filter((mention) => mention.support === "operator" && mention.operator_id?.startsWith("nf.")).map((mention) => mention.operator_id));
  const filtered = selected.filter((mention) => {
    if (mention.support !== "operator") return true;
    if (compounds.has("nf.rnaseq") && rnaCovers.has(mention.operator_id!)) return false;
    if (compounds.has("nf.sarek") && variantCovers.has(mention.operator_id!)) return false;
    if ((compounds.has("nf.mag") || compounds.has("nf.taxprofiler")) && metagenomeCovers.has(mention.operator_id!)) return false;
    if (mention.operator_id === "diff.deseq2" && !selected.some((other) => ["quant.featurecounts", "quant.salmon"].includes(other.operator_id ?? ""))) return false;
    return true;
  });
  if (assay === "assembly") filtered.push(...syntheticAssemblySteps(text));
  const needsReads = filtered.some((mention) => {
    if (mention.support === "unsupported") return mention.ports?.input === "Fastq";
    return catalog.get(mention.operator_id!)?.ports.in.some((port) => port.type === "Fastq" || port.union?.includes("Fastq") || port.type === "FastqGz") ?? false;
  });
  const run = exactRun(resources);
  let reads: SomiteGraphNode | undefined;
  if (needsReads && run) {
    const prefetch = addOperatorNode(graph, catalog, "sra.prefetch", `Exact run cited in the paper: ${run}`, { accession: run });
    reads = addOperatorNode(graph, catalog, "sra.fasterq_dump", "Convert the cited SRA run into FASTQ streams.");
    connectSpecific(graph, prefetch, reads);
  } else if (needsReads) {
    const paired = /paired[- ]end|paired reads/i.test(text);
    reads = addOperatorNode(graph, catalog, paired ? "files.import_paired" : "files.import", "Reads are described, but no exact run accession was selected. Choose local reads or use a cited online resource.");
  }
  const genome = knownGenome(text);
  const needsReference = filtered.some((mention) => mention.support === "operator" && catalog.get(mention.operator_id!)?.ports.in.some((port) => port.type === "Fasta" || port.type === "FastaGz"));
  const needsAnnotation = filtered.some((mention) => mention.support === "operator" && catalog.get(mention.operator_id!)?.ports.in.some((port) => port.type === "Gtf" || port.type === "GtfGz"));
  if (needsReference && linkageWorkflow) addOperatorNode(graph, catalog, "files.import_fasta", "The paper scaffolds a named starting assembly; attach that exact FASTA or replace this with its cited online assembly.");
  else if (genome && needsReference) addOperatorNode(graph, catalog, "ensembl.fasta", `The paper identifies ${genome}; select the exact Ensembl or NCBI assembly before running.`);
  else if (needsReference) addOperatorNode(graph, catalog, "files.import_fasta", "The paper uses a reference or starting assembly; attach that exact FASTA or replace this with a cited online assembly.");
  if (genome && needsAnnotation) addOperatorNode(graph, catalog, "ensembl.gtf", `The paper identifies ${genome}; select matching gene annotation before running.`);
  if (filtered.some((mention) => mention.operator_id === "nf.rnaseq")) {
    const sheet = addOperatorNode(graph, catalog, "sheet.rnaseq", "Build the nf-core samplesheet from the cited or selected reads.");
    connectSpecific(graph, reads, sheet);
  }
  const methodNodes: SomiteGraphNode[] = [];
  for (const mention of filtered.sort((left, right) => methodRank(left) - methodRank(right) || left.offset - right.offset)) {
    const node = mention.support === "operator"
      ? addOperatorNode(graph, catalog, mention.operator_id!, mention.evidence)
      : addGapNode(graph, catalog, mention);
    if (node) methodNodes.push(node);
  }
  const bwa = methodNodes.find((node) => node.operator === "align.bwa");
  const bwaIndex = bwa ? graph.nodes.indexOf(bwa) : -1;
  if (bwa && !methodNodes.some((node) => node.operator === "align.samtools_view")
    && graph.nodes.slice(bwaIndex + 1).some((node) => node.ports.some((port) => port.dir === "in" && port.ty === "Bam"))) {
    const converter = addOperatorNode(graph, catalog, "align.samtools_view", "BWA-MEM emits SAM; convert it to BAM for the named downstream method.", { exclude_flags: 0 });
    if (converter) {
      graph.nodes.splice(graph.nodes.indexOf(converter), 1);
      graph.nodes.splice(bwaIndex + 1, 0, converter);
    }
  }
  connectByTypes(graph);
  if (assay === "assembly") enforceAssemblyFlow(graph);
  if (linkageWorkflow) enforceLinkageFlow(graph, catalog);
  layoutGraph(graph);
  const reviewed = graph.nodes.some((node) => node.operator !== "gap.missing" && catalog.get(node.operator)?.paper);
  if (!reviewed) return undefined;
  const graphValidation = validateGraph(graph);
  const catalogValidation = catalog.verifyGraph(graph);
  if (!graphValidation.ok || !catalogValidation.ok) return undefined;
  const assessment = assessWorkflow(graph, catalog);
  const warnings = assessment.required_count
    ? [`Draft reconstructed from paper evidence; ${assessment.required_count} item${assessment.required_count === 1 ? "" : "s"} still need review or input before it can run.`]
    : [];
  return {
    name: assemblyChoice ? `${assemblyChoice.display_name} assembly` : candidateName(assay),
    role,
    assay,
    graph,
    warnings,
    evidence: graphEvidence(graph, extractedVia),
    assessment,
  } satisfies PaperCandidate;
}

export function reconstructPaper(catalog: OperatorCatalog, text: string, extractedVia: PaperExtractVia): PaperReview {
  const normalized = text.replace(/\r\n?/g, "\n");
  const mentions = recognizedMethods(catalog, normalized, extractedVia);
  const resources = paperResourceCitations(normalized, extractedVia);
  const focus = paperMethodsWindow(normalized).text;
  const assays = relevantAssays(focus.length >= 200 ? focus : normalized);
  const candidates: PaperCandidate[] = [];
  for (const assay of assays) {
    const assemblers = assay === "assembly"
      ? mentions.filter((mention) => mention.executable && isAssemblyMethod(mention))
      : [];
    if (assemblers.length > 1) {
      for (const assembler of assemblers) {
        const candidate = buildCandidate(catalog, normalized, resources, mentions, assay, extractedVia, "alternative", assembler);
        if (candidate) candidates.push(candidate);
      }
    } else {
      const candidate = buildCandidate(catalog, normalized, resources, mentions, assay, extractedVia, assays.length > 1 ? "parallel" : "primary");
      if (candidate) candidates.push(candidate);
    }
  }
  const outcome: PaperReconstructionOutcome = candidates.length
    ? "drafts_ready"
    : mentions.length
      ? "recognized_unsupported"
      : "no_reconstructable_methods";
  const warnings = outcome === "drafts_ready"
    ? [...new Set(candidates.flatMap((candidate) => candidate.warnings))]
    : outcome === "recognized_unsupported"
      ? ["Somite found computational methods and retained their evidence, but no reviewed executable workflow could be assembled without guessing."]
      : ["Somite read the document but did not find enough computational-method evidence to propose a workflow."];
  return {
    extracted_via: extractedVia,
    outcome,
    warnings,
    mentions: mentions.map((mention): PaperMethodMention => ({
      display_name: mention.display_name,
      normalized_name: mention.normalized_name,
      ...(mention.operation_class ? { operation_class: mention.operation_class } : {}),
      evidence: mention.evidence,
      support: mention.support,
      ...(mention.operator_id ? { operator_id: mention.operator_id } : {}),
      ...(mention.source_location ? { source_location: mention.source_location } : {}),
    })),
    resources,
    candidates,
  };
}
