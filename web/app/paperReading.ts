import type { PaperExtractionPreflight, PaperExtractionToolReadiness, PaperToolSource } from "./types";

const PAPER_TOOL_SOURCE_LABELS: Record<PaperToolSource, string> = {
  managed_pixi: "Somite managed Pixi",
  project_pixi: "Project Pixi",
  system_path: "System PATH",
};

export type PaperReadingPresentation = {
  capabilities: Array<{
    key: "native_pdf_text" | "scanned_pdf_ocr";
    label: string;
    ready: boolean;
    status: "Ready" | "Needs setup";
  }>;
  tools: Array<Omit<PaperExtractionToolReadiness, "source"> & {
    source: string;
    status: "Ready" | "Missing";
  }>;
  readyToolCount: number;
  missingToolNames: string[];
  guidance: string | null;
};

function readableList(values: string[]) {
  if (values.length < 2) return values[0] ?? "one or more local tools";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function missingGuidance(preflight: PaperExtractionPreflight, missingToolNames: string[]) {
  if (preflight.native_pdf_text && preflight.scanned_pdf_ocr) return null;
  const capability = !preflight.native_pdf_text && !preflight.scanned_pdf_ocr
    ? "Native and scanned PDFs"
    : preflight.native_pdf_text
      ? "Scanned PDFs"
      : "Native PDFs";
  return `${capability} need ${readableList(missingToolNames)}. Install the missing tools in Somite's managed or project Pixi environment, or provide them on PATH. Restart Somite to recheck.`;
}

export function paperReadingPresentation(preflight: PaperExtractionPreflight): PaperReadingPresentation {
  const missingToolNames = preflight.tools.filter((tool) => !tool.available).map((tool) => tool.name);
  return {
    capabilities: [
      {
        key: "native_pdf_text",
        label: "Native PDF text",
        ready: preflight.native_pdf_text,
        status: preflight.native_pdf_text ? "Ready" : "Needs setup",
      },
      {
        key: "scanned_pdf_ocr",
        label: "Scanned PDF OCR",
        ready: preflight.scanned_pdf_ocr,
        status: preflight.scanned_pdf_ocr ? "Ready" : "Needs setup",
      },
    ],
    tools: preflight.tools.map((tool) => ({
      ...tool,
      source: tool.available
        ? tool.source ? PAPER_TOOL_SOURCE_LABELS[tool.source] : "Detected locally"
        : "Missing",
      status: tool.available ? "Ready" : "Missing",
    })),
    readyToolCount: preflight.tools.filter((tool) => tool.available).length,
    missingToolNames,
    guidance: missingGuidance(preflight, missingToolNames),
  };
}
