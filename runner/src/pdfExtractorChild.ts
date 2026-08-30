import { lstat, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { byteDigest } from "@somite/workflow/contentIdentity";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { MAX_PAGES, MAX_PDF_BYTES, MAX_TEXT_BYTES, PaperExtractionError, type PaperExtractionProgress } from "./paperExtractor.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const require = createRequire(import.meta.url);
const pdfjsVersion = (require("pdfjs-dist/package.json") as { version?: unknown }).version;
const pdfjsIdentity = typeof pdfjsVersion === "string" && /^[0-9A-Za-z.+-]{1,80}$/.test(pdfjsVersion)
  ? `pdfjs@${pdfjsVersion}`
  : "pdfjs";

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

function pageNeedsOcr(text: string) {
  let letters = 0;
  for (const character of text) if (/\p{L}/u.test(character) && ++letters >= 20) return false;
  return true;
}

function progress(value: PaperExtractionProgress) {
  emit({ type: "progress", ...value });
}

function configuredLimit(value: string, maximum: number) {
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new PaperExtractionError("paper_extraction_failed", "The PDF extractor limits are invalid.");
  }
  return parsed;
}

async function verifiedPdf(path: string, digest: string, expectedSize: number, maxSourceBytes: number) {
  if (!/^blake3:[0-9a-f]{64}$/.test(digest) || !Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maxSourceBytes) {
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

async function extract(path: string, outputPath: string, digest: string, expectedSize: number, maxSourceBytes: number, maxPages: number, maxTextBytes: number) {
  const bytes = await verifiedPdf(path, digest, expectedSize, maxSourceBytes);
  progress({ completed: 0, unit: "pages", message: "Opening the PDF text layer" });
  let loading: ReturnType<typeof getDocument> | undefined;
  let document: Awaited<ReturnType<typeof getDocument>["promise"]> | undefined;
  try {
    loading = getDocument({ data: bytes, useSystemFonts: true, verbosity: 0 });
    document = await loading.promise;
    if (document.numPages > maxPages) throw new PaperExtractionError("paper_extraction_limit", `PDF has ${document.numPages} pages; the configured extraction limit is ${maxPages} (SOMITE_PAPER_MAX_PAGES).`);
    const pages: string[] = [];
    const pageTextBytes: number[] = [];
    const ocrPages: number[] = [];
    let accumulatedTextBytes = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      progress({ completed: pageNumber - 1, total: document.numPages, unit: "pages", message: `Reading PDF page ${pageNumber} of ${document.numPages}` });
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const pageText = normalizePage(content.items);
      page.cleanup();
      const pageBytes = encoder.encode(pageText).byteLength;
      const separatorBytes = pageNumber === 1 ? 0 : 3;
      accumulatedTextBytes += separatorBytes + pageBytes;
      if (accumulatedTextBytes > maxTextBytes) throw new PaperExtractionError("paper_extraction_limit", `Extracted PDF text exceeds the configured ${maxTextBytes}-byte limit (SOMITE_PAPER_MAX_TEXT_BYTES).`);
      pages.push(pageText);
      pageTextBytes.push(pageBytes);
      if (pageNeedsOcr(pageText)) ocrPages.push(pageNumber);
      progress({ completed: pageNumber, total: document.numPages, unit: "pages", message: `Read PDF page ${pageNumber} of ${document.numPages}` });
    }
    const text = pages.join("\n\f\n");
    const textBytes = encoder.encode(text);
    if (textBytes.byteLength > maxTextBytes) throw new PaperExtractionError("paper_extraction_limit", "Extracted PDF text exceeds the configured worker-output limit.");
    await writeFile(outputPath, textBytes, { flag: "wx", mode: 0o600 });
    emit({
      type: "result",
      pages: document.numPages,
      text_bytes: textBytes.byteLength,
      text_digest: byteDigest(textBytes),
      extractor_identity: pdfjsIdentity,
      page_text_bytes: pageTextBytes,
      ocr_pages: ocrPages,
    });
  } catch (error) {
    if (error instanceof PaperExtractionError) throw error;
    throw new PaperExtractionError("paper_extraction_failed", `PDF.js could not read this paper: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    await document?.cleanup().catch(() => undefined);
    await loading?.destroy().catch(() => undefined);
  }
}

const [sourcePath, outputPath, digest, rawSize, rawMaxSourceBytes, rawMaxPages, rawMaxTextBytes, extra] = process.argv.slice(2);
if (!sourcePath || !outputPath || !digest || !rawSize || !rawMaxSourceBytes || !rawMaxPages || !rawMaxTextBytes || extra !== undefined) {
  emit({ type: "error", code: "paper_extraction_failed", message: "The PDF extractor invocation is invalid.", retryable: false });
  process.exitCode = 1;
} else {
  try {
    await extract(
      sourcePath,
      outputPath,
      digest,
      Number(rawSize),
      configuredLimit(rawMaxSourceBytes, MAX_PDF_BYTES),
      configuredLimit(rawMaxPages, MAX_PAGES),
      configuredLimit(rawMaxTextBytes, MAX_TEXT_BYTES),
    );
  } catch (error) {
    const failure = error instanceof PaperExtractionError
      ? error
      : new PaperExtractionError("paper_extraction_failed", `PDF.js could not read this paper: ${error instanceof Error ? error.message : String(error)}`, true);
    emit({ type: "error", code: failure.code, message: failure.message.slice(0, 4_096), retryable: failure.retryable });
    process.exitCode = 1;
  }
}
