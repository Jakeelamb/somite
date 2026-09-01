import { Box, CircleHelp, Database, FileInput, Waypoints } from "lucide-react";

export const portColor: Record<string, string> = {
  Sra: "#b77add",
  Fastq: "#ef7658",
  FastqGz: "#ef7658",
  Fasta: "#48b998",
  FastaGz: "#48b998",
  Gtf: "#d7a54b",
  GtfGz: "#d7a54b",
  Bam: "#6f91f1",
  ReadGroupedBam: "#6f91f1",
  GatkReadyBam: "#6f91f1",
  Bai: "#6f91f1",
  Fai: "#48b998",
  Dict: "#48b998",
  Vcf: "#e0ae55",
  VcfGz: "#e0ae55",
  Table: "#8e78e8",
  Directory: "#8b949b",
  Html: "#e77da7",
  Preview: "#3bb4c7",
  Image: "#3bb4c7",
  Zip: "#d4955b",
  Json: "#9a82e4",
  Text: "#9aa2a8",
};

export function OperatorGlyph({ operator, size = 15 }: { operator: string; size?: number }) {
  if (operator.startsWith("files.")) return <FileInput size={size} aria-hidden="true" />;
  if (operator.startsWith("sra.") || operator.startsWith("ncbi.") || operator.startsWith("ensembl.")) {
    return <Database size={size} aria-hidden="true" />;
  }
  if (operator.startsWith("nf.") || operator.startsWith("smk.")) {
    return <Waypoints size={size} aria-hidden="true" />;
  }
  if (operator.startsWith("gap.")) return <CircleHelp size={size} aria-hidden="true" />;
  return <Box size={size} aria-hidden="true" />;
}
