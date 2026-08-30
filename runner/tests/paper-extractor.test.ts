import assert from "node:assert/strict";
import test from "node:test";

import { extractPaper, PaperExtractionError } from "../src/paperExtractor.ts";

function pdfWithText(text: string) {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = escaped ? `BT /F1 10 Tf 36 740 Td (${escaped}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let raw = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(raw.length);
    raw += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = raw.length;
  raw += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  raw += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  raw += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(raw);
}

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
      && /OCR is not installed/i.test(error.message),
  );
});

test("text extraction validates UTF-8 and observes cancellation", async () => {
  await assert.rejects(() => extractPaper(Uint8Array.of(0xff), "text"), (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_text_invalid");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => extractPaper(new TextEncoder().encode("Methods"), "text", { signal: controller.signal }), (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_extraction_cancelled");
});
