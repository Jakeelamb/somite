import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type PaperMediaKind = "pdf" | "text";
export type PaperExtraction = Readonly<{ text: string; extractedVia: "text" | "pdfjs"; pages?: number }>;
export type PaperExtractionProgress = Readonly<{ completed: number; total?: number; unit?: string; message: string }>;

const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 200;
const decoder = new TextDecoder("utf-8", { fatal: true });

export class PaperExtractionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "PaperExtractionError";
    this.code = code;
    this.retryable = retryable;
  }
}

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new PaperExtractionError("paper_extraction_cancelled", "Paper extraction was cancelled.", true);
}

function normalizePage(items: readonly unknown[]) {
  let text = "";
  let previousY: number | undefined;
  let previousX: number | undefined;
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object" || !("str" in candidate) || typeof candidate.str !== "string") continue;
    const item = candidate as { str: string; transform?: readonly number[]; hasEOL?: boolean };
    const x = item.transform?.[4];
    const y = item.transform?.[5];
    if (text && typeof y === "number" && typeof previousY === "number") {
      const lineChanged = Math.abs(y - previousY) > 2;
      const wrapped = typeof x === "number" && typeof previousX === "number" && x + 2 < previousX;
      if ((lineChanged || wrapped) && !text.endsWith("\n")) text += "\n";
      else if (!/[\s\n]$/.test(text)) text += " ";
    } else if (text && !/[\s\n]$/.test(text)) {
      text += " ";
    }
    text += item.str;
    if (item.hasEOL && !text.endsWith("\n")) text += "\n";
    if (typeof x === "number") previousX = x;
    if (typeof y === "number") previousY = y;
  }
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function nativeTextIsReadable(text: string, pages: number) {
  const requiredLetters = Math.min(400, Math.max(40, pages * 40));
  let letters = 0;
  for (const character of text) if (/[A-Za-z]/.test(character) && ++letters >= requiredLetters) return true;
  return false;
}

export async function extractPaper(
  bytes: Uint8Array,
  mediaKind: PaperMediaKind,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: PaperExtractionProgress) => void;
  } = {},
): Promise<PaperExtraction> {
  cancelled(options.signal);
  if (!bytes.byteLength) throw new PaperExtractionError("paper_empty", "The paper file is empty.");
  if (mediaKind === "text") {
    if (bytes.byteLength > MAX_TEXT_BYTES) throw new PaperExtractionError("paper_extraction_limit", `Text paper exceeds the ${MAX_TEXT_BYTES} byte limit.`);
    try {
      return { text: decoder.decode(bytes), extractedVia: "text" };
    } catch {
      throw new PaperExtractionError("paper_text_invalid", "Text and Markdown papers must contain valid UTF-8 text.");
    }
  }
  if (bytes.byteLength > MAX_PDF_BYTES) throw new PaperExtractionError("paper_extraction_limit", `PDF exceeds the ${MAX_PDF_BYTES} byte limit.`);
  if (bytes.byteLength < 5 || decoder.decode(bytes.subarray(0, 5)) !== "%PDF-") throw new PaperExtractionError("paper_pdf_invalid", "The uploaded file does not contain a PDF header.");

  options.onProgress?.({ completed: 0, unit: "pages", message: "Opening the PDF text layer" });
  let loading: ReturnType<typeof getDocument> | undefined;
  let document: Awaited<ReturnType<typeof getDocument>["promise"]> | undefined;
  try {
    loading = getDocument({
      data: Uint8Array.from(bytes),
      useSystemFonts: true,
      verbosity: 0,
    });
    document = await loading.promise;
    if (document.numPages > MAX_PAGES) throw new PaperExtractionError("paper_extraction_limit", `PDF has ${document.numPages} pages; the limit is ${MAX_PAGES}.`);
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      cancelled(options.signal);
      options.onProgress?.({ completed: pageNumber - 1, total: document.numPages, unit: "pages", message: `Reading PDF page ${pageNumber} of ${document.numPages}` });
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      pages.push(normalizePage(content.items));
      page.cleanup();
      const currentBytes = pages.reduce((total, value) => total + value.length, 0);
      if (currentBytes > MAX_TEXT_BYTES) throw new PaperExtractionError("paper_extraction_limit", `Extracted PDF text exceeds the ${MAX_TEXT_BYTES} byte limit.`);
      options.onProgress?.({ completed: pageNumber, total: document.numPages, unit: "pages", message: `Read PDF page ${pageNumber} of ${document.numPages}` });
    }
    const text = pages.join("\n\f\n");
    if (!nativeTextIsReadable(text, document.numPages)) {
      throw new PaperExtractionError(
        "paper_ocr_unavailable",
        "This PDF appears to be scanned or has no readable text layer. OCR is not installed in this web runner yet; upload a text-accessible PDF or extracted text while the OCR adapter is added.",
      );
    }
    return { text, extractedVia: "pdfjs", pages: document.numPages };
  } catch (error) {
    if (error instanceof PaperExtractionError) throw error;
    if (options.signal?.aborted) cancelled(options.signal);
    throw new PaperExtractionError("paper_extraction_failed", `PDF.js could not read this paper: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    await document?.cleanup().catch(() => undefined);
    await loading?.destroy().catch(() => undefined);
  }
}
