export type SourceKind = "sra" | "assembly" | "ensembl-gene" | "ensembl-transcript" | "ensembl-protein";

export type SourceRequest = {
  kind: SourceKind;
  value: string;
  provider: string;
  result: string;
  action: string;
  operator_ids?: readonly string[];
  sequenceType?: "genomic" | "cdna" | "protein";
  sequence_type?: "genomic" | "cdna" | "protein";
  read_layout?: "single" | "paired";
};

export type SourceSearchResult = {
  key: string;
  title: string;
  accession: string;
  description: string;
  provider: string;
  data_kind: string;
  tags: string[];
  request: SourceRequest;
};

export type SourceSearchResponse = {
  query: string;
  provider: "ncbi" | "ensembl";
  results: SourceSearchResult[];
};

const SRA_PATTERN = /^(?:SRR|ERR|DRR)\d+$/;
const ASSEMBLY_PATTERN = /^(?:GCA_|GCF_)\d+(?:\.\d+)?$/;
const ENSEMBL_PATTERN = /^(ENS[A-Z]*)([GTP])(\d{6,})(?:\.\d+)?$/;

function candidate(value: string): SourceRequest | null {
  if (SRA_PATTERN.test(value)) {
    // SRA layout is provider metadata, not an accession-string property. Wait
    // for the live result so the canvas never invents paired outputs.
    return null;
  }
  if (ASSEMBLY_PATTERN.test(value)) {
    return {
      kind: "assembly",
      value,
      provider: "NCBI Datasets",
      result: "Typed genome FASTA, GFF3 / GTF annotations & metadata",
      action: "Add Assembly",
    };
  }
  const ensembl = value.match(ENSEMBL_PATTERN);
  if (!ensembl) return null;
  if (value.includes(".")) return null;
  if (ensembl[2] === "G") {
    return {
      kind: "ensembl-gene",
      value,
      provider: "Ensembl REST",
      result: "Genomic FASTA sequence",
      action: "Add Sequence",
      sequenceType: "genomic",
    };
  }
  if (ensembl[2] === "T") {
    return {
      kind: "ensembl-transcript",
      value,
      provider: "Ensembl REST",
      result: "Transcript cDNA FASTA sequence",
      action: "Add Sequence",
      sequenceType: "cdna",
    };
  }
  return {
    kind: "ensembl-protein",
    value,
    provider: "Ensembl REST",
    result: "Protein FASTA sequence",
    action: "Add Sequence",
    sequenceType: "protein",
  };
}

export function classifySource(input: string): SourceRequest | null {
  const values = input
    .trim()
    .toUpperCase()
    .split(/[^A-Z0-9_.]+/)
    .map(candidate)
    .filter((value): value is SourceRequest => value !== null);
  const unique = new Map(values.map((value) => [value.value, value]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}
