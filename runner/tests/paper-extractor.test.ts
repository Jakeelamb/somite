import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { byteDigest } from "@somite/workflow/contentIdentity";
import { extractPaper, extractPaperPath, PaperExtractionError, PDF_EXTRACTION_CONCURRENCY } from "../src/paperExtractor.ts";
import { pdfWithPages, pdfWithText } from "./pdfFixture.ts";

const execute = promisify(execFile);

test("PDF.js extraction is host-tool independent and reports page progress", async () => {
  const methods = "Methods RNA-seq reads were quality checked with FastQC and aligned with STAR. ".repeat(20);
  const progress: string[] = [];
  const extracted = await extractPaper(pdfWithText(methods), "pdf", { onProgress: (value) => progress.push(value.message) });
  assert.equal(extracted.extractedVia, "pdfjs");
  assert.equal(extracted.pages, 1);
  assert.match(extracted.text, /Methods RNA-seq/);
  assert.deepEqual(progress, ["Opening the PDF text layer", "Reading PDF page 1 of 1", "Read PDF page 1 of 1"]);
});

test("image-only PDFs stop with an explicit OCR capability message", async () => {
  await assert.rejects(
    () => extractPaper(pdfWithText(""), "pdf"),
    (error: unknown) => error instanceof PaperExtractionError
      && error.code === "paper_ocr_unavailable"
      && /page 1 needs OCR/i.test(error.message),
  );
});

test("mixed PDFs identify unreadable pages instead of silently accepting partial text", async () => {
  const readable = "Methods RNA-seq reads were quality checked with FastQC and aligned with STAR. ".repeat(20);
  await assert.rejects(
    () => extractPaper(pdfWithPages([readable, ""]), "pdf"),
    (error: unknown) => error instanceof PaperExtractionError
      && error.code === "paper_ocr_unavailable"
      && /page 2 needs OCR/i.test(error.message),
  );
});

test("text extraction validates UTF-8 and observes cancellation", async () => {
  await assert.rejects(() => extractPaper(Uint8Array.of(0xff), "text"), (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_text_invalid");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => extractPaper(new TextEncoder().encode("Methods"), "text", { signal: controller.signal }), (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_extraction_cancelled");
});

test("PDF path extraction verifies the content address inside the child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "somite-pdf-path-test-"));
  try {
    const bytes = pdfWithText("Methods FastQC and STAR were used. ".repeat(20));
    const path = join(directory, "payload.pdf");
    await writeFile(path, bytes);
    const source = { path, digest: byteDigest(bytes), sizeBytes: bytes.byteLength };
    const extracted = await extractPaperPath(source, "pdf");
    assert.match(extracted.text, /Methods FastQC/);
    await assert.rejects(
      () => extractPaperPath({ ...source, digest: `blake3:${"0".repeat(64)}` }, "pdf"),
      (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_source_invalid",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PDF child extraction is single-concurrency and cancellable through progress", async () => {
  assert.equal(PDF_EXTRACTION_CONCURRENCY, 1);
  const events: string[] = [];
  const bytes = pdfWithText("Methods FastQC and STAR were used. ".repeat(100));
  await Promise.all([
    extractPaper(bytes, "pdf", { onProgress: (progress) => events.push(`first:${progress.message}`) }),
    extractPaper(bytes, "pdf", { onProgress: (progress) => events.push(`second:${progress.message}`) }),
  ]);
  const groups = events.map((event) => event.split(":", 1)[0]).filter((label, index, labels) => index === 0 || label !== labels[index - 1]);
  assert.equal(groups.length, 2, `PDF progress interleaved across workers: ${events.join(", ")}`);

  const controller = new AbortController();
  await assert.rejects(
    () => extractPaper(bytes, "pdf", {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_extraction_cancelled",
  );
});

test("PDF child extraction has a wall-clock deadline", async () => {
  const bytes = pdfWithText("Methods FastQC and STAR were used. ".repeat(100));
  await assert.rejects(
    () => extractPaper(bytes, "pdf", { pdfTimeoutMs: 1 }),
    (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_extraction_timeout",
  );
});

test("importing the runner does not load PDF.js into the long-lived process", async () => {
  const server = new URL("../src/server.ts", import.meta.url).href;
  const blocker = `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.includes("pdfjs-dist") || specifier.includes("@napi-rs/canvas")) throw new Error("blocked eager PDF dependency: " + specifier);
      return nextResolve(specifier, context);
    }
  `)}`;
  const { stdout } = await execute(process.execPath, [
    "--experimental-loader",
    blocker,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(server)}); process.stdout.write(String(process.memoryUsage().rss));`,
  ], {
    maxBuffer: 1024 * 1024,
  });
  const rss = Number(stdout);
  assert.ok(Number.isSafeInteger(rss));
  assert.ok(rss < 256 * 1024 * 1024, `cold server import used ${(rss / 1024 / 1024).toFixed(1)} MiB RSS`);
});
