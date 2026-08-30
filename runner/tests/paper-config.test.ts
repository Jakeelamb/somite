import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_PAPER_INTAKE_CONFIG,
  PaperConfigurationError,
  paperIntakeConfigFromEnvironment,
} from "../src/paperConfig.ts";

test("paper intake defaults retain the production paper contract", () => {
  assert.deepEqual(DEFAULT_PAPER_INTAKE_CONFIG, {
    maxUploadBytes: 100 * 1024 * 1024,
    maxTextBytes: 64 * 1024 * 1024,
    maxPdfPages: 200,
    maxOcrPages: 200,
    paperCommandTimeoutMs: 120_000,
    maxActiveJobs: 2,
    ocrLanguages: "eng",
  });
});

test("paper intake configuration accepts bounded deployment overrides and the legacy OCR fallback", () => {
  assert.deepEqual(paperIntakeConfigFromEnvironment({
    SOMITE_PAPER_MAX_UPLOAD_BYTES: "120000000",
    SOMITE_PAPER_MAX_TEXT_BYTES: "32000000",
    SOMITE_PAPER_MAX_PAGES: "400",
    SOMITE_PAPER_MAX_OCR_PAGES: "32",
    SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS: "45",
    SOMITE_PAPER_MAX_ACTIVE_JOBS: "3",
    SOMITE_OCR_LANGS: "deu+eng",
    OMARCHY_OCR_LANGS: "fra",
  }), {
    maxUploadBytes: 120_000_000,
    maxTextBytes: 32_000_000,
    maxPdfPages: 400,
    maxOcrPages: 32,
    paperCommandTimeoutMs: 45_000,
    maxActiveJobs: 3,
    ocrLanguages: "deu+eng",
  });
  assert.equal(paperIntakeConfigFromEnvironment({ OMARCHY_OCR_LANGS: "fra" }).ocrLanguages, "fra");
});

test("paper intake configuration rejects invalid limits with an actionable variable-specific error", () => {
  for (const [environment, expected] of [
    [{ SOMITE_PAPER_MAX_UPLOAD_BYTES: "0" }, /SOMITE_PAPER_MAX_UPLOAD_BYTES.*1.*1073741824.*remove/i],
    [{ SOMITE_PAPER_MAX_TEXT_BYTES: "1.5" }, /SOMITE_PAPER_MAX_TEXT_BYTES.*integer/i],
    [{ SOMITE_PAPER_MAX_PAGES: "10001" }, /SOMITE_PAPER_MAX_PAGES.*10000/i],
    [{ SOMITE_PAPER_MAX_PAGES: "20", SOMITE_PAPER_MAX_OCR_PAGES: "21" }, /SOMITE_PAPER_MAX_OCR_PAGES.*cannot exceed.*SOMITE_PAPER_MAX_PAGES/i],
    [{ SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS: "3601" }, /SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS.*3600/i],
    [{ SOMITE_PAPER_MAX_ACTIVE_JOBS: "0" }, /SOMITE_PAPER_MAX_ACTIVE_JOBS.*1.*32.*remove/i],
    [{ SOMITE_OCR_LANGS: "eng;touch /tmp/nope" }, /SOMITE_OCR_LANGS.*eng\+deu/i],
  ] as const) {
    assert.throws(
      () => paperIntakeConfigFromEnvironment(environment),
      (error: unknown) => error instanceof PaperConfigurationError
        && error.code === "paper_configuration_invalid"
        && expected.test(error.message),
    );
  }
});

test("the production runner rejects invalid command and concurrency settings before opening a project", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-invalid-paper-config-"));
  try {
    for (const [variable, value, expected] of [
      ["SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS", "3601", /SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS must be from 1 to 3600/],
      ["SOMITE_PAPER_MAX_ACTIVE_JOBS", "0", /SOMITE_PAPER_MAX_ACTIVE_JOBS must be from 1 to 32/],
    ] as const) {
      const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
        env: { ...process.env, SOMITE_PROJECT_ROOT: root, [variable]: value },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let diagnostics = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-16 * 1024); });
      const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("close", resolvePromise);
      });
      assert.equal(code, 1);
      assert.match(diagnostics, expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
