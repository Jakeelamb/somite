export type LocalInputDescriptor = Readonly<{ name: string }>;

export type LocalInputPlanEntry =
  | Readonly<{ kind: "paired_fastq"; r1: number; r2: number; first: number }>
  | Readonly<{ kind: "paired_fastq_gz"; r1: number; r2: number; first: number }>
  | Readonly<{ kind: "fastq" | "fastq_gz" | "fasta" | "fasta_gz" | "gtf" | "gff3" | "bam"; file: number; first: number }>;

export function localInputOperatorId(entry: LocalInputPlanEntry) {
  if (entry.kind === "paired_fastq") return "files.import_paired" as const;
  if (entry.kind === "paired_fastq_gz") return "files.import_paired_gz" as const;
  if (entry.kind === "fastq_gz") return "files.import_fastq_gz" as const;
  if (entry.kind === "fasta_gz") return "files.import_fasta_gz" as const;
  if (entry.kind === "fasta") return "files.import_fasta" as const;
  if (entry.kind === "gtf") return "files.import_gtf" as const;
  if (entry.kind === "gff3") return "files.import_gff3" as const;
  if (entry.kind === "bam") return "files.import_bam" as const;
  return "files.import" as const;
}

/** Every visible operator needed to place one local input without disguising its bytes. */
export function localInputOperatorIds(entry: LocalInputPlanEntry) {
  const source = localInputOperatorId(entry);
  if (entry.kind === "fasta_gz") return [source, "archive.gunzip_fasta"] as const;
  return [source] as const;
}

export class LocalInputPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalInputPlanError";
  }
}

const FASTQ_EXTENSION = /\.(?:fastq|fq)(?:\.gz)?$/i;
const FASTQ_GZ_EXTENSION = /\.(?:fastq|fq)\.gz$/i;
const FASTA_EXTENSION = /\.(?:fasta|fa|fna)$/i;
const FASTA_GZ_EXTENSION = /\.(?:fasta|fa|fna)\.gz$/i;
const GTF_EXTENSION = /\.gtf$/i;
const GFF3_EXTENSION = /\.gff3$/i;
const BAM_EXTENSION = /\.bam$/i;
const READ_TOKEN = /(^|[._-])R?([12])(?=([._-]|$))/i;
const MAX_LOCAL_INPUTS = 256;

function fastqPairIdentity(name: string) {
  const stem = name.replace(FASTQ_EXTENSION, "");
  const match = READ_TOKEN.exec(stem);
  if (!match || match.index === undefined) return undefined;
  const tokenStart = match.index + match[1]!.length;
  const tokenEnd = tokenStart + match[0]!.length - match[1]!.length;
  return {
    role: Number(match[2]) as 1 | 2,
    key: `${stem.slice(0, tokenStart)}{read}${stem.slice(tokenEnd)}`.toLowerCase(),
  };
}

/** Plan every selected local file before any upload or canvas mutation. */
export function planLocalInputs(files: readonly LocalInputDescriptor[]): LocalInputPlanEntry[] {
  if (files.length < 1) throw new LocalInputPlanError("Choose at least one local input file.");
  if (files.length > MAX_LOCAL_INPUTS) {
    throw new LocalInputPlanError(`Choose at most ${MAX_LOCAL_INPUTS} local inputs at once; no files were imported.`);
  }
  const supported = (name: string) => FASTQ_EXTENSION.test(name)
    || FASTA_EXTENSION.test(name)
    || FASTA_GZ_EXTENSION.test(name)
    || GTF_EXTENSION.test(name)
    || GFF3_EXTENSION.test(name)
    || BAM_EXTENSION.test(name);
  const unsupported = files.filter((file) => !supported(file.name));
  if (unsupported.length) {
    const shown = unsupported.slice(0, 3).map((file) => file.name).join(", ");
    const remaining = unsupported.length > 3 ? ` and ${unsupported.length - 3} more` : "";
    throw new LocalInputPlanError(`Somite can place FASTQ, FASTA, BAM, GTF, and GFF3 inputs automatically. Unsupported: ${shown}${remaining}. No files were imported.`);
  }

  const pairs = new Map<string, { r1: number[]; r2: number[] }>();
  for (const [index, file] of files.entries()) {
    if (!FASTQ_EXTENSION.test(file.name)) continue;
    const identity = fastqPairIdentity(file.name);
    if (!identity) continue;
    const group = pairs.get(identity.key) ?? { r1: [], r2: [] };
    group[identity.role === 1 ? "r1" : "r2"].push(index);
    pairs.set(identity.key, group);
  }

  const consumed = new Set<number>();
  const planned: LocalInputPlanEntry[] = [];
  for (const group of pairs.values()) {
    if (group.r1.length !== 1 || group.r2.length !== 1) continue;
    const [r1] = group.r1;
    const [r2] = group.r2;
    const r1Compressed = FASTQ_GZ_EXTENSION.test(files[r1!]!.name);
    const r2Compressed = FASTQ_GZ_EXTENSION.test(files[r2!]!.name);
    if (r1Compressed !== r2Compressed) {
      throw new LocalInputPlanError(
        `${files[r1!]!.name} and ${files[r2!]!.name} are a read pair but do not use the same compression format. No files were imported.`,
      );
    }
    consumed.add(r1!);
    consumed.add(r2!);
    planned.push({
      kind: r1Compressed ? "paired_fastq_gz" : "paired_fastq",
      r1: r1!,
      r2: r2!,
      first: Math.min(r1!, r2!),
    });
  }
  for (const [index, file] of files.entries()) {
    if (consumed.has(index)) continue;
    const kind = FASTQ_GZ_EXTENSION.test(file.name)
      ? "fastq_gz" as const
      : FASTQ_EXTENSION.test(file.name)
        ? "fastq" as const
      : FASTA_GZ_EXTENSION.test(file.name)
        ? "fasta_gz" as const
        : FASTA_EXTENSION.test(file.name)
          ? "fasta" as const
          : GTF_EXTENSION.test(file.name)
            ? "gtf" as const
            : GFF3_EXTENSION.test(file.name)
              ? "gff3" as const
              : "bam" as const;
    planned.push({ kind, file: index, first: index });
  }
  return planned.sort((left, right) => left.first - right.first);
}
