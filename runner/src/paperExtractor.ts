import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { byteDigest, canonicalJsonDigest, createByteDigester } from "@somite/workflow/contentIdentity";
import {
  DEFAULT_PAPER_INTAKE_CONFIG,
  MAX_CONFIGURED_PAPER_PAGES,
  MAX_CONFIGURED_PAPER_TEXT_BYTES,
  MAX_CONFIGURED_PAPER_UPLOAD_BYTES,
  ocrLanguageCodes,
} from "./paperConfig.ts";
import { terminateProcessTree } from "./process.ts";
import {
  PaperToolchain,
  PaperToolchainError,
  runPaperCommand,
  type PaperToolchainPreflight,
  type ResolvedPaperOcrToolchain,
} from "./paperToolchain.ts";

export type PaperMediaKind = "pdf" | "text";
export type PaperExtractionVia = "text" | "pdfjs" | "ocr";
export type PaperExtraction = Readonly<{ text: string; extractedVia: PaperExtractionVia; extractorIdentity: string; pages?: number }>;
export type PaperExtractionProgress = Readonly<{ completed: number; total?: number; unit?: string; message: string }>;
export type PaperPathSource = Readonly<{ path: string; digest: string; sizeBytes: number }>;
export type PaperOcrOptions = Readonly<{
  toolchain: PaperToolchain;
  maxPages?: number;
  maxTextBytes?: number;
  commandTimeoutMs?: number;
  totalTimeoutMs?: number;
  languages?: string;
}>;
export type PaperExtractionOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: PaperExtractionProgress) => void;
  pdfTimeoutMs?: number;
  maxSourceBytes?: number;
  maxTextBytes?: number;
  maxPdfPages?: number;
  ocr?: PaperOcrOptions;
}>;

export const MAX_PDF_BYTES = MAX_CONFIGURED_PAPER_UPLOAD_BYTES;
export const MAX_TEXT_BYTES = MAX_CONFIGURED_PAPER_TEXT_BYTES;
export const MAX_PAGES = MAX_CONFIGURED_PAPER_PAGES;
export const MAX_OCR_PAGES = MAX_CONFIGURED_PAPER_PAGES;
export const DEFAULT_OCR_PAGES = DEFAULT_PAPER_INTAKE_CONFIG.maxOcrPages;
export const DEFAULT_PAPER_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_PDF_TIMEOUT_MS = 120_000;
export const DEFAULT_OCR_TOTAL_TIMEOUT_MS = 15 * 60 * 1_000;
export const PDF_EXTRACTION_CONCURRENCY = 1;

const MAX_COMMAND_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_PAGE_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_PROTOCOL_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_PROTOCOL_MESSAGE_BYTES = 8 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const childEntry = fileURLToPath(new URL("./pdfExtractorChild.ts", import.meta.url));
const TEXT_EXTRACTOR_IDENTITY = canonicalJsonDigest({ engine: "utf8", contract: "somite-paper-text-v1" });
const PDFJS_CONTRACT = "somite-pdfjs-page-text-v2";
const OCR_CONTRACT = Object.freeze({
  contract: "somite-mixed-pdf-ocr-v3",
  raster_dpi: 300,
  tesseract_oem: 1,
  tesseract_psm: 3,
  preserve_interword_spaces: true,
});
type OcrIdentitySet = Readonly<Record<"pdfinfo" | "pdftoppm" | "tesseract", Readonly<{ identity: string }>>>;

function pdfJsExtractorIdentity(nativeIdentity: string) {
  return canonicalJsonDigest({ contract: PDFJS_CONTRACT, native_identity: nativeIdentity });
}

function ocrExtractorIdentity(
  nativeIdentity: string,
  tools: OcrIdentitySet,
  languages: string,
) {
  return canonicalJsonDigest({
    ...OCR_CONTRACT,
    native_identity: nativeIdentity,
    languages,
    tools: Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, tool.identity])),
  });
}

/** Current deterministic identity used to validate persistent extraction caches. */
export function paperExtractorIdentity(preflight: PaperToolchainPreflight | undefined, via: PaperExtractionVia, languages = DEFAULT_PAPER_INTAKE_CONFIG.ocrLanguages) {
  if (via === "text") return TEXT_EXTRACTOR_IDENTITY;
  const nativeIdentity = preflight?.tools.find((tool) => tool.name === "PDF.js")?.identity;
  if (!nativeIdentity) return undefined;
  const pdfjs = pdfJsExtractorIdentity(nativeIdentity);
  if (via === "pdfjs") return pdfjs;
  if (!preflight?.scanned_pdf_ocr) return undefined;
  const identities = Object.fromEntries(preflight.tools
    .filter((tool) => tool.name !== "PDF.js" && tool.available && tool.identity)
    .map((tool) => [tool.name, { identity: tool.identity! }]));
  const tools = identities as Partial<OcrIdentitySet>;
  if (!tools.pdfinfo || !tools.pdftoppm || !tools.tesseract) return undefined;
  return ocrExtractorIdentity(pdfjs, {
    pdfinfo: tools.pdfinfo,
    pdftoppm: tools.pdftoppm,
    tesseract: tools.tesseract,
  }, ocrLanguageCodes(languages).join("+"));
}

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

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string) {
  const configured = value ?? fallback;
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > maximum) {
    throw new PaperExtractionError("paper_extraction_limit", `${label} must be between 1 and ${maximum}.`);
  }
  return configured;
}

function boundedExtractionOptions(options: PaperExtractionOptions) {
  return {
    maxSourceBytes: boundedInteger(options.maxSourceBytes, DEFAULT_PAPER_INTAKE_CONFIG.maxUploadBytes, MAX_PDF_BYTES, "Paper source byte limit"),
    maxTextBytes: boundedInteger(options.maxTextBytes, DEFAULT_PAPER_INTAKE_CONFIG.maxTextBytes, MAX_TEXT_BYTES, "Paper text byte limit"),
    maxPdfPages: boundedInteger(options.maxPdfPages, DEFAULT_PAPER_INTAKE_CONFIG.maxPdfPages, MAX_PAGES, "PDF page limit"),
  };
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

async function copyVerifiedSource(source: PaperPathSource, maximumBytes: number, destination: string, signal?: AbortSignal) {
  await sourceMetadata(source, maximumBytes);
  const digester = createByteDigester();
  let size = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > maximumBytes) {
        callback(new PaperExtractionError("paper_extraction_limit", `Paper source exceeds the ${maximumBytes} byte limit.`));
        return;
      }
      digester.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(source.path),
      verifier,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      { signal },
    );
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    if (signal?.aborted) cancelled(signal);
    if (error instanceof PaperExtractionError) throw error;
    throw new PaperExtractionError("paper_source_invalid", "The stored paper source could not be copied for OCR.", true);
  }
  if (size !== source.sizeBytes || digester.digest() !== source.digest) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw new PaperExtractionError("paper_source_invalid", "The stored paper source does not match its content address.");
  }
}

function textExtraction(bytes: Uint8Array, maximumBytes: number, signal?: AbortSignal): PaperExtraction {
  cancelled(signal);
  if (!bytes.byteLength) throw new PaperExtractionError("paper_empty", "The paper file is empty.");
  if (bytes.byteLength > maximumBytes) throw new PaperExtractionError("paper_extraction_limit", `Text paper exceeds the configured ${maximumBytes}-byte limit. Raise SOMITE_PAPER_MAX_TEXT_BYTES and restart Somite, or use a smaller text source.`);
  try {
    return { text: decoder.decode(bytes), extractedVia: "text", extractorIdentity: TEXT_EXTRACTOR_IDENTITY };
  } catch {
    throw new PaperExtractionError("paper_text_invalid", "Text and Markdown papers must contain valid UTF-8 text.");
  }
}

type PdfResultMessage = Readonly<{
  type: "result";
  pages: number;
  text_bytes: number;
  text_digest: string;
  extractor_identity: string;
  page_text_bytes: readonly number[];
  ocr_pages: readonly number[];
}>;
type PdfErrorMessage = Readonly<{ type: "error"; code: string; message: string; retryable: boolean }>;
type NativePdfExtraction = Readonly<{
  text: string;
  extractedVia: "pdfjs";
  extractorIdentity: string;
  pages: number;
  pageTexts: readonly string[];
  ocrPages: readonly number[];
}>;

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

function resultMessage(value: unknown, maxPages: number, maxTextBytes: number): PdfResultMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "result" || !Number.isSafeInteger(raw.pages) || (raw.pages as number) < 1 || (raw.pages as number) > maxPages
    || !Number.isSafeInteger(raw.text_bytes) || (raw.text_bytes as number) < 0 || (raw.text_bytes as number) > maxTextBytes
    || typeof raw.text_digest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(raw.text_digest)
    || typeof raw.extractor_identity !== "string" || !/^[\x20-\x7e]{1,200}$/.test(raw.extractor_identity)) return undefined;
  if (!Array.isArray(raw.page_text_bytes) || raw.page_text_bytes.length !== raw.pages
    || raw.page_text_bytes.some((bytes) => !Number.isSafeInteger(bytes) || (bytes as number) < 0)
    || raw.page_text_bytes.reduce((total, bytes) => total + (bytes as number), Math.max(0, (raw.pages as number) - 1) * 3) !== raw.text_bytes) return undefined;
  if (!Array.isArray(raw.ocr_pages) || raw.ocr_pages.some((page, index, pages) => !Number.isSafeInteger(page)
    || (page as number) < 1 || (page as number) > (raw.pages as number)
    || (index > 0 && (pages[index - 1] as number) >= (page as number)))) return undefined;
  return raw as PdfResultMessage;
}

function errorMessage(value: unknown): PdfErrorMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "error" || typeof raw.code !== "string" || !/^[a-z0-9_]{1,80}$/.test(raw.code)
    || typeof raw.message !== "string" || Buffer.byteLength(raw.message) > 4_096 || typeof raw.retryable !== "boolean") return undefined;
  return raw as PdfErrorMessage;
}

function nativePageTexts(bytes: Uint8Array, result: PdfResultMessage) {
  const pages: string[] = [];
  let offset = 0;
  for (const [index, length] of result.page_text_bytes.entries()) {
    const end = offset + length;
    try {
      pages.push(decoder.decode(bytes.subarray(offset, end)));
    } catch {
      throw new PaperExtractionError("paper_extraction_failed", `The PDF extractor returned invalid UTF-8 on page ${index + 1}.`, true);
    }
    offset = end;
    if (index < result.page_text_bytes.length - 1) {
      if (bytes[offset] !== 10 || bytes[offset + 1] !== 12 || bytes[offset + 2] !== 10) {
        throw new PaperExtractionError("paper_extraction_failed", "The PDF extractor returned an invalid page boundary.", true);
      }
      offset += 3;
    }
  }
  if (offset !== bytes.byteLength) throw new PaperExtractionError("paper_extraction_failed", "The PDF extractor returned inconsistent page lengths.", true);
  return pages;
}

function boundedPdfTimeout(value: number | undefined) {
  const timeout = value ?? DEFAULT_PDF_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15 * 60 * 1_000) {
    throw new PaperExtractionError("paper_extraction_limit", "PDF extraction timeout must be between 1 ms and 15 minutes.");
  }
  return timeout;
}

async function extractPdfChild(source: PaperPathSource, options: PaperExtractionOptions): Promise<NativePdfExtraction> {
  cancelled(options.signal);
  const limits = boundedExtractionOptions(options);
  await sourceMetadata(source, limits.maxSourceBytes);
  const pdfTimeoutMs = boundedPdfTimeout(options.pdfTimeoutMs);

  const temporary = await mkdtemp(join(tmpdir(), "somite-pdf-extraction-"));
  const outputPath = join(temporary, "extracted.txt");
  try {
    const child = spawn(process.execPath, [
      "--experimental-strip-types", childEntry, source.path, outputPath, source.digest, String(source.sizeBytes),
      String(limits.maxSourceBytes), String(limits.maxPdfPages), String(limits.maxTextBytes),
    ], {
      detached: process.platform !== "win32",
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
    let timedOut = false;

    const stopChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      terminateProcessTree(child);
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
      const completed = resultMessage(parsed, limits.maxPdfPages, limits.maxTextBytes);
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
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, pdfTimeoutMs);
    timeout.unref();
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    }).finally(() => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    });
    if (protocolBuffer) handleLine(protocolBuffer);
    if (aborted || options.signal?.aborted) throw new PaperExtractionError("paper_extraction_cancelled", "Paper extraction was cancelled.", true);
    if (timedOut) throw new PaperExtractionError("paper_extraction_timeout", "PDF text extraction exceeded its bounded wall-clock timeout.", true);
    if (protocolFailure) throw protocolFailure;
    if (failure) throw new PaperExtractionError(failure.code, failure.message, failure.retryable);
    if (outcome.code !== 0 || !result) {
      const detail = diagnostics.trim().slice(0, 4_096);
      throw new PaperExtractionError("paper_extraction_failed", `PDF.js could not read this paper${detail ? `: ${detail}` : "."}`, true);
    }
    const output = await lstat(outputPath);
    if (output.isSymbolicLink() || !output.isFile() || output.size !== result.text_bytes || output.size > limits.maxTextBytes) {
      throw new PaperExtractionError("paper_extraction_failed", "The PDF extractor result exceeded its declared bounds.", true);
    }
    const textBytes = await readFile(outputPath);
    if (textBytes.byteLength !== result.text_bytes || byteDigest(textBytes) !== result.text_digest) {
      throw new PaperExtractionError("paper_extraction_failed", "The PDF extractor result failed its integrity check.", true);
    }
    const pageTexts = nativePageTexts(textBytes, result);
    return {
      text: pageTexts.join("\n\f\n"),
      extractedVia: "pdfjs",
      extractorIdentity: pdfJsExtractorIdentity(result.extractor_identity),
      pages: result.pages,
      pageTexts,
      ocrPages: result.ocr_pages,
    };
  } catch (error) {
    if (error instanceof PaperExtractionError) throw error;
    if (options.signal?.aborted) cancelled(options.signal);
    throw new PaperExtractionError("paper_extraction_failed", `PDF.js could not read this paper: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function boundedOcrOptions(options: PaperOcrOptions) {
  const maxPages = options.maxPages ?? DEFAULT_OCR_PAGES;
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_PAPER_INTAKE_CONFIG.maxTextBytes;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_PAPER_COMMAND_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_OCR_TOTAL_TIMEOUT_MS;
  let languages: string;
  try {
    languages = ocrLanguageCodes(options.languages ?? DEFAULT_PAPER_INTAKE_CONFIG.ocrLanguages).join("+");
  } catch {
    throw new PaperExtractionError("paper_ocr_configuration_invalid", "OCR languages must be a unique Tesseract language list such as eng or eng+deu; configure SOMITE_OCR_LANGS and restart Somite.");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_OCR_PAGES) {
    throw new PaperExtractionError("paper_extraction_limit", `OCR page limit must be between 1 and ${MAX_OCR_PAGES}; configure SOMITE_PAPER_MAX_OCR_PAGES within that range.`);
  }
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > MAX_TEXT_BYTES) {
    throw new PaperExtractionError("paper_extraction_limit", `OCR text limit must be between 1 and ${MAX_TEXT_BYTES} bytes.`);
  }
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 15 * 60 * 1_000) {
    throw new PaperExtractionError("paper_extraction_limit", "OCR command timeout must be between 1 ms and 15 minutes.");
  }
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 60 * 60 * 1_000) {
    throw new PaperExtractionError("paper_extraction_limit", "OCR total timeout must be between 1 ms and 60 minutes.");
  }
  return { maxPages, maxTextBytes, commandTimeoutMs, totalTimeoutMs, languages };
}

function commandDetail(stderr: Uint8Array) {
  try {
    return decoder.decode(stderr).trim().slice(0, 4_096);
  } catch {
    return "invalid UTF-8 diagnostics";
  }
}

function commandError(error: unknown, tool: string): PaperExtractionError {
  if (error instanceof PaperExtractionError) return error;
  if (error instanceof PaperToolchainError) {
    if (error.code === "paper_command_cancelled") return new PaperExtractionError("paper_extraction_cancelled", "Paper extraction was cancelled.", true);
    if (error.code === "paper_command_timeout") return new PaperExtractionError("paper_extraction_timeout", `${tool} exceeded the configured OCR command timeout.`, true);
    if (error.code === "paper_command_output_limit") return new PaperExtractionError("paper_extraction_limit", `${tool} exceeded its bounded output limit.`);
    if (error.code === "paper_tool_unavailable") return new PaperExtractionError("paper_ocr_unavailable", `${tool} disappeared after OCR preflight; refresh the paper toolchain and try again.`, true);
    return new PaperExtractionError("paper_ocr_failed", `${tool} could not run: ${error.message}`, error.retryable);
  }
  return new PaperExtractionError("paper_ocr_failed", `${tool} could not run: ${error instanceof Error ? error.message : String(error)}`, true);
}

async function paperCommand(
  tool: string,
  command: ResolvedPaperOcrToolchain[keyof ResolvedPaperOcrToolchain],
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maximumStdoutBytes: number,
) {
  try {
    return await runPaperCommand(command.path, args, cwd, {
      signal,
      timeoutMs,
      maximumStdoutBytes,
      maximumStderrBytes: MAX_COMMAND_DIAGNOSTIC_BYTES,
      environment: command.environment,
    });
  } catch (error) {
    throw commandError(error, tool);
  }
}

function pdfPageCount(bytes: Uint8Array) {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new PaperExtractionError("paper_ocr_failed", "pdfinfo returned invalid UTF-8 output.", true);
  }
  const line = text.split(/\r?\n/).find((candidate) => /^Pages:\s*\d+\s*$/.test(candidate));
  const pages = line ? Number(line.slice(line.indexOf(":") + 1).trim()) : 0;
  if (!Number.isSafeInteger(pages) || pages < 1) throw new PaperExtractionError("paper_ocr_failed", "pdfinfo did not report a valid page count.", true);
  return pages;
}

async function pageImage(path: string) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new PaperExtractionError("paper_ocr_failed", "pdftoppm did not produce the expected OCR page image.", true);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1 || metadata.size > MAX_PAGE_IMAGE_BYTES) {
    throw new PaperExtractionError("paper_extraction_limit", `The rasterized OCR page must be a regular file no larger than ${MAX_PAGE_IMAGE_BYTES} bytes.`);
  }
}

function reportProgress(options: PaperExtractionOptions, progress: PaperExtractionProgress) {
  try {
    options.onProgress?.(progress);
  } catch (error) {
    throw new PaperExtractionError("paper_extraction_failed", `The PDF extraction progress callback failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extractPdfOcr(
  source: PaperPathSource,
  tools: ResolvedPaperOcrToolchain,
  options: PaperExtractionOptions,
  native?: NativePdfExtraction,
): Promise<PaperExtraction> {
  const configured = boundedOcrOptions(options.ocr!);
  const deadline = Date.now() + configured.totalTimeoutMs;
  const nextTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining < 1) throw new PaperExtractionError("paper_extraction_timeout", `OCR exceeded its ${configured.totalTimeoutMs} ms total timeout.`, true);
    return Math.min(configured.commandTimeoutMs, remaining);
  };
  cancelled(options.signal);
  const temporary = await mkdtemp(join(tmpdir(), "somite-paper-ocr-"));
  try {
    const ocrSource = join(temporary, "source.pdf");
    const extractionLimits = boundedExtractionOptions(options);
    await copyVerifiedSource(source, extractionLimits.maxSourceBytes, ocrSource, options.signal);
    reportProgress(options, { completed: 0, unit: "pages", message: "Counting pages for bounded OCR" });
    const info = await paperCommand("pdfinfo", tools.pdfinfo, [ocrSource], temporary, options.signal, nextTimeout(), MAX_COMMAND_DIAGNOSTIC_BYTES);
    if (info.code !== 0) {
      const detail = commandDetail(info.stderr);
      throw new PaperExtractionError("paper_ocr_failed", `pdfinfo could not inspect this PDF${detail ? `: ${detail}` : "."}`, true);
    }
    const pages = pdfPageCount(info.stdout);
    if (pages > extractionLimits.maxPdfPages || (native?.pages !== undefined && native.pages !== pages)) {
      throw new PaperExtractionError("paper_extraction_limit", `PDF has ${pages} pages; the configured extraction limit is ${extractionLimits.maxPdfPages} (SOMITE_PAPER_MAX_PAGES).`);
    }
    const ocrPages = native?.ocrPages ?? Array.from({ length: pages }, (_, index) => index + 1);
    if (ocrPages.length > configured.maxPages) {
      throw new PaperExtractionError("paper_extraction_limit", `PDF requires OCR on ${ocrPages.length} pages; the configured OCR limit is ${configured.maxPages} pages (SOMITE_PAPER_MAX_OCR_PAGES, maximum ${MAX_OCR_PAGES}).`);
    }
    const chunks = native ? [...native.pageTexts] : Array.from({ length: pages }, () => "");
    let textBytes = chunks.reduce((total, value) => total + Buffer.byteLength(value), Math.max(0, pages - 1) * 3);
    for (const [ocrIndex, page] of ocrPages.entries()) {
      cancelled(options.signal);
      const prefix = join(temporary, `page-${page}`);
      const image = `${prefix}.png`;
      try {
        reportProgress(options, { completed: ocrIndex, total: ocrPages.length, unit: "pages", message: `Rasterizing PDF page ${page} of ${pages}` });
        const raster = await paperCommand("pdftoppm", tools.pdftoppm, [
          "-png", "-r", "300", "-f", String(page), "-l", String(page), "-singlefile", ocrSource, prefix,
        ], temporary, options.signal, nextTimeout(), MAX_COMMAND_DIAGNOSTIC_BYTES);
        if (raster.code !== 0) {
          const detail = commandDetail(raster.stderr);
          throw new PaperExtractionError("paper_ocr_failed", `pdftoppm could not render PDF page ${page}${detail ? `: ${detail}` : "."}`, true);
        }
        await pageImage(image);
        reportProgress(options, { completed: ocrIndex, total: ocrPages.length, unit: "pages", message: `Reading OCR page ${page} of ${pages}` });
        const existingBytes = Buffer.byteLength(chunks[page - 1] ?? "");
        const remaining = configured.maxTextBytes - textBytes + existingBytes;
        if (remaining < 1) throw new PaperExtractionError("paper_extraction_limit", `OCR text exceeds ${configured.maxTextBytes} bytes.`);
        const recognized = await paperCommand("tesseract", tools.tesseract, [
          image, "stdout", "--oem", "1", "--psm", "3", "-l", configured.languages,
          "--dpi", "300", "-c", "preserve_interword_spaces=1",
        ], temporary, options.signal, nextTimeout(), remaining);
        if (recognized.code !== 0) {
          const detail = commandDetail(recognized.stderr);
          throw new PaperExtractionError("paper_ocr_failed", `Tesseract could not read PDF page ${page}${detail ? `: ${detail}` : "."}`, true);
        }
        let pageText: string;
        try {
          pageText = decoder.decode(recognized.stdout).trim();
        } catch {
          throw new PaperExtractionError("paper_ocr_failed", `Tesseract returned invalid UTF-8 on PDF page ${page}.`, true);
        }
        chunks[page - 1] = pageText;
        textBytes = textBytes - existingBytes + Buffer.byteLength(pageText);
        if (textBytes > configured.maxTextBytes) throw new PaperExtractionError("paper_extraction_limit", `OCR text exceeds ${configured.maxTextBytes} bytes.`);
        reportProgress(options, { completed: ocrIndex + 1, total: ocrPages.length, unit: "pages", message: `Read OCR page ${page} of ${pages}` });
      } finally {
        await rm(image, { force: true }).catch(() => undefined);
      }
    }
    const text = chunks.join("\n\f\n");
    let letters = 0;
    for (const character of text) {
      if (/\p{L}/u.test(character) && ++letters >= 40) break;
    }
    if (letters < 40) {
      throw new PaperExtractionError("paper_ocr_failed", "Tesseract produced almost no readable text.", true);
    }
    if (Buffer.byteLength(text) > configured.maxTextBytes) throw new PaperExtractionError("paper_extraction_limit", `OCR text exceeds ${configured.maxTextBytes} bytes.`);
    return {
      text,
      extractedVia: "ocr",
      extractorIdentity: ocrExtractorIdentity(native?.extractorIdentity ?? "no-native-text", tools, configured.languages),
      pages,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function extractPdf(source: PaperPathSource, options: PaperExtractionOptions): Promise<PaperExtraction> {
  const native = await extractPdfChild(source, options);
  if (!native.ocrPages.length) return { text: native.text, extractedVia: "pdfjs", extractorIdentity: native.extractorIdentity, pages: native.pages };
  const pageLabel = native.ocrPages.length === 1
    ? `PDF page ${native.ocrPages[0]} needs`
    : `PDF pages ${native.ocrPages.join(", ")} need`;
  if (!options.ocr) {
    throw new PaperExtractionError("paper_ocr_unavailable", `${pageLabel} OCR before Somite can reconstruct the complete paper.`);
  }
  const resolved = await options.ocr.toolchain.resolveOcr();
  if (!resolved.tools) {
    throw new PaperExtractionError(
      "paper_ocr_unavailable",
      `${pageLabel} OCR; missing ${resolved.preflight.missing.join(", ")}. Enable Somite's managed paper tools or provide the missing executables in the project Pixi environment or PATH.`,
    );
  }
  return extractPdfOcr(source, resolved.tools, options, native);
}

export async function extractPaperPath(source: PaperPathSource, mediaKind: PaperMediaKind, options: PaperExtractionOptions = {}): Promise<PaperExtraction> {
  cancelled(options.signal);
  const limits = boundedExtractionOptions(options);
  if (mediaKind === "text") return textExtraction(await verifiedBytes(source, limits.maxTextBytes), limits.maxTextBytes, options.signal);
  return queuedPdfExtraction(() => extractPdf(source, options), options.signal);
}

export async function extractPaper(bytes: Uint8Array, mediaKind: PaperMediaKind, options: PaperExtractionOptions = {}): Promise<PaperExtraction> {
  cancelled(options.signal);
  const limits = boundedExtractionOptions(options);
  if (mediaKind === "text") return textExtraction(bytes, limits.maxTextBytes, options.signal);
  if (!bytes.byteLength) throw new PaperExtractionError("paper_empty", "The paper file is empty.");
  if (bytes.byteLength > limits.maxSourceBytes) throw new PaperExtractionError("paper_extraction_limit", `PDF exceeds the configured ${limits.maxSourceBytes}-byte limit. Raise SOMITE_PAPER_MAX_UPLOAD_BYTES and restart Somite, or use a smaller PDF.`);
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
