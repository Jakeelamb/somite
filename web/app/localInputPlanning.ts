export type LocalInputDescriptor = Readonly<{ name: string }>;

export type LocalInputPlanEntry =
  | Readonly<{ kind: "paired_fastq"; r1: number; r2: number; first: number }>
  | Readonly<{ kind: "fastq" | "fasta"; file: number; first: number }>;

export class LocalInputPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalInputPlanError";
  }
}

const FASTQ_EXTENSION = /\.(?:fastq|fq)(?:\.gz)?$/i;
const FASTA_EXTENSION = /\.(?:fasta|fa|fna)(?:\.gz)?$/i;
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
  const unsupported = files.filter((file) => !FASTQ_EXTENSION.test(file.name) && !FASTA_EXTENSION.test(file.name));
  if (unsupported.length) {
    const shown = unsupported.slice(0, 3).map((file) => file.name).join(", ");
    const remaining = unsupported.length > 3 ? ` and ${unsupported.length - 3} more` : "";
    throw new LocalInputPlanError(`Somite can place FASTQ and FASTA inputs automatically. Unsupported: ${shown}${remaining}. No files were imported.`);
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
    consumed.add(r1!);
    consumed.add(r2!);
    planned.push({ kind: "paired_fastq", r1: r1!, r2: r2!, first: Math.min(r1!, r2!) });
  }
  for (const [index, file] of files.entries()) {
    if (consumed.has(index)) continue;
    planned.push({ kind: FASTQ_EXTENSION.test(file.name) ? "fastq" : "fasta", file: index, first: index });
  }
  return planned.sort((left, right) => left.first - right.first);
}
