import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { byteDigest } from "@somite/workflow/contentIdentity";

export type PaperMediaKind = "pdf" | "text";
export type PaperExtraction = Readonly<{ text: string; extractedVia: "text" | "pdfjs"; pages?: number }>;
export type PaperExtractionProgress = Readonly<{ completed: number; total?: number; unit?: string; message: string }>;
export type PaperPathSource = Readonly<{ path: string; digest: string; sizeBytes: number }>;

export const MAX_PDF_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_BYTES = 64 * 1024 * 1024;
export const MAX_PAGES = 200;
export const PDF_EXTRACTION_CONCURRENCY = 1;

const MAX_PDF_RESULT_BYTES = MAX_TEXT_BYTES * 4;
const MAX_PROTOCOL_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_PROTOCOL_MESSAGE_BYTES = 8 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const childEntry = fileURLToPath(new URL("./pdfExtractorChild.ts", import.meta.url));

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

export function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new PaperExtractionError("paper_extraction_cancelled", "Paper extraction was cancelled.", true);
}

type ExtractionOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: PaperExtractionProgress) => void;
};

type PdfQueueEntry = {
  signal?: AbortSignal;
  run: () => Promise<PaperExtraction>;
  resolve: (value: PaperExtraction) => void;
  reject: (error: unknown) => void;
  queuedAbort?: () => void;
};

const pdfQueue: PdfQueueEntry[] = [];
let activePdfExtractions = 0;

function pumpPdfQueue() {
  if (activePdfExtractions >= PDF_EXTRACTION_CONCURRENCY) return;
  const entry = pdfQueue.shift();
  if (!entry) return;
  if (entry.queuedAbort) entry.signal?.removeEventListener("abort", entry.queuedAbort);
  if (entry.signal?.aborted) {
    entry.reject(new PaperExtractionError("paper_extraction_cancelled", "Paper extraction was cancelled.", true));
    queueMicrotask(pumpPdfQueue);
    return;
  }
  activePdfExtractions += 1;
  void entry.run().then(entry.resolve, entry.reject).finally(() => {
    activePdfExtractions -= 1;
    pumpPdfQueue();
  });
}

function queuedPdfExtraction(run: () => Promise<PaperExtraction>, signal?: AbortSignal) {
  cancelled(signal);
  return new Promise<PaperExtraction>((resolvePromise, rejectPromise) => {
    const entry: PdfQueueEntry = { signal, run, resolve: resolvePromise, reject: rejectPromise };
    const queuedAbort = () => {
      const index = pdfQueue.indexOf(entry);
      if (index < 0) return;
      pdfQueue.splice(index, 1);
      rejectPromise(new PaperExtractionError("paper_extraction_cancelled", "Paper extraction was cancelled.", true));
    };
    entry.queuedAbort = queuedAbort;
    pdfQueue.push(entry);
    signal?.addEventListener("abort", queuedAbort, { once: true });
    if (signal?.aborted) queuedAbort();
    else pumpPdfQueue();
  });
}

function validateSource(source: PaperPathSource, maximumBytes: number) {
  if (!/^blake3:[0-9a-f]{64}$/.test(source.digest)) throw new PaperExtractionError("paper_source_invalid", "The paper source digest is malformed.");
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > maximumBytes) {
    throw new PaperExtractionError("paper_extraction_limit", `Paper source exceeds the ${maximumBytes} byte limit.`);
  }
}

async function sourceMetadata(source: PaperPathSource, maximumBytes: number) {
  validateSource(source, maximumBytes);
  let metadata;
  try {
    metadata = await lstat(source.path);
  } catch {
    throw new PaperExtractionError("paper_source_invalid", "The stored paper source is unavailable.");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== source.sizeBytes) {
    throw new PaperExtractionError("paper_source_invalid", "The stored paper source is not the expected regular file.");
  }
  return metadata;
}

async function verifiedBytes(source: PaperPathSource, maximumBytes: number) {
  await sourceMetadata(source, maximumBytes);
  let bytes;
  try {
    bytes = await readFile(source.path);
  } catch {
    throw new PaperExtractionError("paper_source_invalid", "The stored paper source is unavailable.");
  }
  if (bytes.byteLength !== source.sizeBytes || byteDigest(bytes) !== source.digest) {
    throw new PaperExtractionError("paper_source_invalid", "The stored paper source does not match its content address.");
  }
  return bytes;
}

function textExtraction(bytes: Uint8Array, signal?: AbortSignal): PaperExtraction {
  cancelled(signal);
  if (!bytes.byteLength) throw new PaperExtractionError("paper_empty", "The paper file is empty.");
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new PaperExtractionError("paper_extraction_limit", `Text paper exceeds the ${MAX_TEXT_BYTES} byte limit.`);
  try {
    return { text: decoder.decode(bytes), extractedVia: "text" };
  } catch {
    throw new PaperExtractionError("paper_text_invalid", "Text and Markdown papers must contain valid UTF-8 text.");
  }
}

type PdfResultMessage = Readonly<{ type: "result"; pages: number; text_bytes: number; text_digest: string }>;
type PdfErrorMessage = Readonly<{ type: "error"; code: string; message: string; retryable: boolean }>;

function progressMessage(value: unknown): PaperExtractionProgress | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "progress" || !Number.isSafeInteger(raw.completed) || (raw.completed as number) < 0
    || typeof raw.message !== "string" || Buffer.byteLength(raw.message) > 512
    || (raw.total !== undefined && (!Number.isSafeInteger(raw.total) || (raw.total as number) < 1))
    || (raw.unit !== undefined && (typeof raw.unit !== "string" || Buffer.byteLength(raw.unit) > 64))) return undefined;
  return {
    completed: raw.completed as number,
    ...(raw.total === undefined ? {} : { total: raw.total as number }),
    ...(raw.unit === undefined ? {} : { unit: raw.unit as string }),
    message: raw.message,
  };
}

function resultMessage(value: unknown): PdfResultMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "result" || !Number.isSafeInteger(raw.pages) || (raw.pages as number) < 1 || (raw.pages as number) > MAX_PAGES
    || !Number.isSafeInteger(raw.text_bytes) || (raw.text_bytes as number) < 1 || (raw.text_bytes as number) > MAX_PDF_RESULT_BYTES
    || typeof raw.text_digest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(raw.text_digest)) return undefined;
  return raw as PdfResultMessage;
}

function errorMessage(value: unknown): PdfErrorMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "error" || typeof raw.code !== "string" || !/^[a-z0-9_]{1,80}$/.test(raw.code)
    || typeof raw.message !== "string" || Buffer.byteLength(raw.message) > 4_096 || typeof raw.retryable !== "boolean") return undefined;
  return raw as PdfErrorMessage;
}

async function extractPdfChild(source: PaperPathSource, options: ExtractionOptions): Promise<PaperExtraction> {
  cancelled(options.signal);
  await sourceMetadata(source, MAX_PDF_BYTES);

  const temporary = await mkdtemp(join(tmpdir(), "somite-pdf-extraction-"));
  const outputPath = join(temporary, "extracted.txt");
  let forceTimer: NodeJS.Timeout | undefined;
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", childEntry, source.path, outputPath, source.digest, String(source.sizeBytes)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let protocolBuffer = "";
    let protocolBytes = 0;
    let diagnosticBytes = 0;
    let diagnostics = "";
    let result: PdfResultMessage | undefined;
    let failure: PdfErrorMessage | undefined;
    let protocolFailure: PaperExtractionError | undefined;
    let aborted = false;

    const stopChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      forceTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      forceTimer.unref();
    };
    const failProtocol = (message: string) => {
      protocolFailure ??= new PaperExtractionError("paper_extraction_failed", message, true);
      stopChild();
    };
    const handleLine = (line: string) => {
      if (!line) return;
      if (Buffer.byteLength(line) > MAX_PROTOCOL_MESSAGE_BYTES) return failProtocol("The PDF extractor returned an oversized control message.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return failProtocol("The PDF extractor returned invalid control data.");
      }
      const progress = progressMessage(parsed);
      if (progress) {
        try {
          options.onProgress?.(progress);
        } catch (error) {
          failProtocol(`The PDF extraction progress callback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      const completed = resultMessage(parsed);
      if (completed && !result && !failure) {
        result = completed;
        return;
      }
      const reported = errorMessage(parsed);
      if (reported && !result && !failure) {
        failure = reported;
        return;
      }
      failProtocol("The PDF extractor returned an unexpected control message.");
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      protocolBytes += Buffer.byteLength(chunk);
      if (protocolBytes > MAX_PROTOCOL_BYTES) return failProtocol("The PDF extractor exceeded its control-output limit.");
      protocolBuffer += chunk;
      let newline = protocolBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = protocolBuffer.slice(0, newline);
        protocolBuffer = protocolBuffer.slice(newline + 1);
        handleLine(line);
        newline = protocolBuffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnosticBytes += Buffer.byteLength(chunk);
      if (Buffer.byteLength(diagnostics) < MAX_DIAGNOSTIC_BYTES) diagnostics += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(diagnostics));
      if (diagnosticBytes > MAX_DIAGNOSTIC_BYTES) failProtocol("The PDF extractor exceeded its diagnostic-output limit.");
    });
    const abort = () => {
      aborted = true;
      stopChild();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    }).finally(() => options.signal?.removeEventListener("abort", abort));
    if (protocolBuffer) handleLine(protocolBuffer);
    if (aborted || options.signal?.aborted) throw new PaperExtractionError("paper_extraction_cancelled", "Paper extraction was cancelled.", true);
    if (protocolFailure) throw protocolFailure;
    if (failure) throw new PaperExtractionError(failure.code, failure.message, failure.retryable);
    if (outcome.code !== 0 || !result) {
      const detail = diagnostics.trim().slice(0, 4_096);
      throw new PaperExtractionError("paper_extraction_failed", `PDF.js could not read this paper${detail ? `: ${detail}` : "."}`, true);
    }
    const output = await lstat(outputPath);
    if (output.isSymbolicLink() || !output.isFile() || output.size !== result.text_bytes || output.size > MAX_PDF_RESULT_BYTES) {
      throw new PaperExtractionError("paper_extraction_failed", "The PDF extractor result exceeded its declared bounds.", true);
    }
    const textBytes = await readFile(outputPath);
    if (textBytes.byteLength !== result.text_bytes || byteDigest(textBytes) !== result.text_digest) {
      throw new PaperExtractionError("paper_extraction_failed", "The PDF extractor result failed its integrity check.", true);
    }
    let text: string;
    try {
      text = decoder.decode(textBytes);
    } catch {
      throw new PaperExtractionError("paper_extraction_failed", "The PDF extractor returned invalid UTF-8 text.", true);
    }
    return { text, extractedVia: "pdfjs", pages: result.pages };
  } catch (error) {
    if (error instanceof PaperExtractionError) throw error;
    if (options.signal?.aborted) cancelled(options.signal);
    throw new PaperExtractionError("paper_extraction_failed", `PDF.js could not read this paper: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function extractPaperPath(source: PaperPathSource, mediaKind: PaperMediaKind, options: ExtractionOptions = {}): Promise<PaperExtraction> {
  cancelled(options.signal);
  if (mediaKind === "text") return textExtraction(await verifiedBytes(source, MAX_TEXT_BYTES), options.signal);
  return queuedPdfExtraction(() => extractPdfChild(source, options), options.signal);
}

export async function extractPaper(bytes: Uint8Array, mediaKind: PaperMediaKind, options: ExtractionOptions = {}): Promise<PaperExtraction> {
  cancelled(options.signal);
  if (mediaKind === "text") return textExtraction(bytes, options.signal);
  if (!bytes.byteLength) throw new PaperExtractionError("paper_empty", "The paper file is empty.");
  if (bytes.byteLength > MAX_PDF_BYTES) throw new PaperExtractionError("paper_extraction_limit", `PDF exceeds the ${MAX_PDF_BYTES} byte limit.`);
  if (bytes.byteLength < 5 || decoder.decode(bytes.subarray(0, 5)) !== "%PDF-") throw new PaperExtractionError("paper_pdf_invalid", "The uploaded file does not contain a PDF header.");

  const temporary = await mkdtemp(join(tmpdir(), "somite-pdf-source-"));
  const path = join(temporary, "payload.pdf");
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return await extractPaperPath({ path, digest: byteDigest(bytes), sizeBytes: bytes.byteLength }, "pdf", options);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
