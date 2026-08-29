import assert from "node:assert/strict";
import test from "node:test";

import { paperReadingPresentation } from "../app/paperReading.ts";
import type { PaperExtractionPreflight } from "../app/types.ts";

function readyPreflight(): PaperExtractionPreflight {
  return {
    native_pdf_text: true,
    scanned_pdf_ocr: true,
    tools: [
      { name: "pdftotext", available: true, path: "/managed/bin/pdftotext", source: "managed_pixi", detail: "Native PDF text extraction is available." },
      { name: "pdfinfo", available: true, path: "/project/bin/pdfinfo", source: "project_pixi", detail: "PDF page counting for bounded OCR is available." },
      { name: "pdftoppm", available: true, path: "/usr/bin/pdftoppm", source: "system_path", detail: "PDF page rendering for OCR is available." },
      { name: "tesseract", available: true, path: "/usr/bin/tesseract", source: "system_path", detail: "Scanned-page text recognition is available." },
    ],
  };
}

test("paper-reading readiness distinguishes native text and scanned OCR", () => {
  const presentation = paperReadingPresentation(readyPreflight());

  assert.deepEqual(presentation.capabilities, [
    { key: "native_pdf_text", label: "Native PDF text", ready: true, status: "Ready" },
    { key: "scanned_pdf_ocr", label: "Scanned PDF OCR", ready: true, status: "Ready" },
  ]);
  assert.equal(presentation.guidance, null);
  assert.equal(presentation.readyToolCount, 4);
});

test("paper-reading tool provenance is translated without losing server detail", () => {
  const presentation = paperReadingPresentation(readyPreflight());

  assert.deepEqual(presentation.tools.map((tool) => ({ name: tool.name, source: tool.source, detail: tool.detail })), [
    { name: "pdftotext", source: "Somite managed Pixi", detail: "Native PDF text extraction is available." },
    { name: "pdfinfo", source: "Project Pixi", detail: "PDF page counting for bounded OCR is available." },
    { name: "pdftoppm", source: "System PATH", detail: "PDF page rendering for OCR is available." },
    { name: "tesseract", source: "System PATH", detail: "Scanned-page text recognition is available." },
  ]);
});

test("missing paper tools produce deterministic, actionable guidance", () => {
  const preflight = readyPreflight();
  preflight.scanned_pdf_ocr = false;
  preflight.tools = preflight.tools.map((tool) => tool.name === "tesseract" ? {
    name: "tesseract",
    available: false,
    detail: "Scanned-page text recognition needs tesseract. Add conda-forge::tesseract to Somite's managed or project Pixi environment, or provide tesseract on PATH.",
  } : tool);

  const presentation = paperReadingPresentation(preflight);

  assert.equal(presentation.capabilities[0]?.status, "Ready");
  assert.equal(presentation.capabilities[1]?.status, "Needs setup");
  assert.deepEqual(presentation.missingToolNames, ["tesseract"]);
  assert.match(presentation.guidance ?? "", /Scanned PDFs need tesseract/);
  assert.match(presentation.guidance ?? "", /managed or project Pixi environment/);
  assert.match(presentation.guidance ?? "", /PATH/);
  assert.match(presentation.guidance ?? "", /Restart Somite to recheck/);
  assert.equal(presentation.tools.at(-1)?.source, "Missing");
  assert.match(presentation.tools.at(-1)?.detail ?? "", /conda-forge::tesseract/);
});
