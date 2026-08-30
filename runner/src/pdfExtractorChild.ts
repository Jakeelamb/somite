import { lstat, readFile, writeFile } from "node:fs/promises";

import { byteDigest } from "@somite/workflow/contentIdentity";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { MAX_PAGES, MAX_PDF_BYTES, MAX_TEXT_BYTES, PaperExtractionError, type PaperExtractionProgress } from "./paperExtractor.ts";

const MAX_PDF_RESULT_BYTES = MAX_TEXT_BYTES * 4;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function emit(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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

function progress(value: PaperExtractionProgress) {
  emit({ type: "progress", ...value });
}

async function verifiedPdf(path: string, digest: string, expectedSize: number) {
  if (!/^blake3:[0-9a-f]{64}$/.test(digest) || !Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_PDF_BYTES) {
    throw new PaperExtractionError("paper_source_invalid", "The stored paper source identity is invalid.");
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== expectedSize) {
    throw new PaperExtractionError("paper_source_invalid", "The stored paper source is not the expected regular file.");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== expectedSize || byteDigest(bytes) !== digest) {
    throw new PaperExtractionError("paper_source_invalid", "The stored paper source does not match its content address.");
  }
  if (bytes.byteLength < 5 || decoder.decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new PaperExtractionError("paper_pdf_invalid", "The uploaded file does not contain a PDF header.");
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function extract(path: string, outputPath: string, digest: string, expectedSize: number) {
  const bytes = await verifiedPdf(path, digest, expectedSize);
  progress({ completed: 0, unit: "pages", message: "Opening the PDF text layer" });
  let loading: ReturnType<typeof getDocument> | undefined;
  let document: Awaited<ReturnType<typeof getDocument>["promise"]> | undefined;
  try {
    loading = getDocument({ data: bytes, useSystemFonts: true, verbosity: 0 });
    document = await loading.promise;
    if (document.numPages > MAX_PAGES) throw new PaperExtractionError("paper_extraction_limit", `PDF has ${document.numPages} pages; the limit is ${MAX_PAGES}.`);
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      progress({ completed: pageNumber - 1, total: document.numPages, unit: "pages", message: `Reading PDF page ${pageNumber} of ${document.numPages}` });
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      pages.push(normalizePage(content.items));
      page.cleanup();
      const currentBytes = pages.reduce((total, value) => total + value.length, 0);
      if (currentBytes > MAX_TEXT_BYTES) throw new PaperExtractionError("paper_extraction_limit", `Extracted PDF text exceeds the ${MAX_TEXT_BYTES} byte limit.`);
      progress({ completed: pageNumber, total: document.numPages, unit: "pages", message: `Read PDF page ${pageNumber} of ${document.numPages}` });
    }
    const text = pages.join("\n\f\n");
    if (!nativeTextIsReadable(text, document.numPages)) {
      throw new PaperExtractionError(
        "paper_ocr_unavailable",
        "This PDF appears to be scanned or has no readable text layer. OCR is not installed in this web runner yet; upload a text-accessible PDF or extracted text while the OCR adapter is added.",
      );
    }
    const textBytes = encoder.encode(text);
    if (textBytes.byteLength > MAX_PDF_RESULT_BYTES) throw new PaperExtractionError("paper_extraction_limit", "Extracted PDF text exceeds the bounded worker-output limit.");
    await writeFile(outputPath, textBytes, { flag: "wx", mode: 0o600 });
    emit({ type: "result", pages: document.numPages, text_bytes: textBytes.byteLength, text_digest: byteDigest(textBytes) });
  } catch (error) {
    if (error instanceof PaperExtractionError) throw error;
    throw new PaperExtractionError("paper_extraction_failed", `PDF.js could not read this paper: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    await document?.cleanup().catch(() => undefined);
    await loading?.destroy().catch(() => undefined);
  }
}

const [sourcePath, outputPath, digest, rawSize, extra] = process.argv.slice(2);
if (!sourcePath || !outputPath || !digest || !rawSize || extra !== undefined) {
  emit({ type: "error", code: "paper_extraction_failed", message: "The PDF extractor invocation is invalid.", retryable: false });
  process.exitCode = 1;
} else {
  try {
    await extract(sourcePath, outputPath, digest, Number(rawSize));
  } catch (error) {
    const failure = error instanceof PaperExtractionError
      ? error
      : new PaperExtractionError("paper_extraction_failed", `PDF.js could not read this paper: ${error instanceof Error ? error.message : String(error)}`, true);
    emit({ type: "error", code: failure.code, message: failure.message.slice(0, 4_096), retryable: failure.retryable });
    process.exitCode = 1;
  }
}
