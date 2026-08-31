import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { paperIntakeConfigFromEnvironment } from "../src/paperConfig.ts";
import { PaperManager } from "../src/paperManager.ts";
import { PaperStoreError } from "../src/paperStore.ts";
import { pdfWithText } from "./pdfFixture.ts";

const repository = path.resolve(import.meta.dirname, "../..");
const loaded = await loadOperatorCatalog(path.join(repository, "operators"));

function uploadRequest(filename: string, contents: BlobPart, type = "text/plain") {
  const form = new FormData();
  form.set("file", new File([contents], filename, { type }));
  return new Request("http://localhost/api/papers/uploads", { method: "POST", body: form });
}

async function fakeExecutable(target: string, body: string) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  await chmod(target, 0o700);
}

async function completed(manager: PaperManager, jobId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await manager.status(jobId, 250);
    if (["completed", "failed", "cancelled"].includes(status.phase)) return status;
  }
  throw new Error("paper job did not finish");
}

test("content-addressed paper intake is replayable, cached, and reconstructs typed drafts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-paper-manager-"));
  try {
    const manager = new PaperManager(root, loaded.catalog, loaded.revision);
    const methods = "Methods\nPaired-end RNA-seq reads (SRR12345678) were quality checked with FastQC, trimmed with fastp, aligned with STAR, counted with featureCounts, and analyzed with DESeq2.";
    const artifact = await manager.store.upload(uploadRequest("methods.txt", methods));
    assert.match(artifact.digest, /^blake3:[0-9a-f]{64}$/);
    assert.equal(artifact.reused, false);

    const duplicate = await manager.store.upload(uploadRequest("renamed-methods.txt", methods));
    assert.equal(duplicate.digest, artifact.digest);
    assert.equal(duplicate.reused, true);

    const [started, replay] = await Promise.all([
      manager.start(artifact.digest, "paper-test-one"),
      manager.start(artifact.digest, "paper-test-one"),
    ]);
    assert.equal(replay.job_id, started.job_id);
    assert.equal(replay.replayed, true);
    const status = await completed(manager, started.job_id);
    assert.equal(status.phase, "completed");
    assert.equal(status.result?.outcome, "drafts_ready");
    assert.ok(status.result?.candidates[0]?.graph.nodes.some((node) => node.operator === "sra.prefetch"));
    assert.equal(status.cache.extraction, false);

    const second = await manager.start(artifact.digest, "paper-test-two");
    const secondStatus = await completed(manager, second.job_id);
    assert.equal(secondStatus.phase, "completed");
    assert.deepEqual(secondStatus.cache, { extraction: true, reconstruction: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("content-addressed PDF intake extracts through the isolated worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-paper-pdf-manager-"));
  try {
    const manager = new PaperManager(root, loaded.catalog, loaded.revision);
    const methods = "Methods RNA-seq reads were quality checked with FastQC and aligned with STAR. ".repeat(20);
    const artifact = await manager.store.upload(uploadRequest("methods.pdf", pdfWithText(methods), "application/pdf"));
    const started = await manager.start(artifact.digest);
    const status = await completed(manager, started.job_id);
    assert.equal(status.phase, "completed");
    assert.equal(status.cache.extraction, false);
    assert.equal(status.result?.outcome, "drafts_ready");
    const cachePath = path.join(root, ".somite", "papers", "cache", "extracted", `${artifact.digest.slice("blake3:".length)}-pdfjs-ocr-v4.json`);
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as { schema_version: number; configuration_digest: string; extractor_identity: string };
    assert.equal(cache.schema_version, 3);
    assert.match(cache.configuration_digest, /^blake3:[0-9a-f]{64}$/);
    assert.match(cache.extractor_identity, /^blake3:[0-9a-f]{64}$/);
    await writeFile(cachePath, `${JSON.stringify({ ...cache, configuration_digest: `blake3:${"0".repeat(64)}` })}\n`);
    const rerun = await completed(manager, (await manager.start(artifact.digest)).job_id);
    assert.equal(rerun.phase, "completed");
    assert.equal(rerun.cache.extraction, false, "a cache from another intake policy must be recomputed");
    await manager.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paper intake automatically uses an available project-local OCR toolchain", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-paper-manager-ocr-"));
  try {
    const bin = path.join(root, ".somite", "tools", "paper", ".pixi", "envs", "default", "bin");
    await fakeExecutable(path.join(bin, "pdfinfo"), `
      if (process.argv.includes("-v")) process.stderr.write("pdfinfo version 25.01.0\\n");
      else process.stdout.write("Pages: 1\\n");
    `);
    await fakeExecutable(path.join(bin, "pdftoppm"), `
      if (process.argv.includes("-v")) process.stderr.write("pdftoppm version 25.01.0\\n");
      else {
        const fs = require("node:fs");
        fs.writeFileSync(process.argv.at(-1) + ".png", "fake raster");
      }
    `);
    await fakeExecutable(path.join(bin, "tesseract"), `
      if (process.argv.includes("--version")) process.stdout.write("tesseract 5.5.0\\n");
      else if (process.argv.includes("--list-langs")) process.stdout.write("List of available languages (1):\\neng\\n");
      else process.stdout.write("Methods RNA sequencing reads were checked with FastQC and aligned with STAR for expression analysis.\\n");
    `);
    const manager = new PaperManager(root, loaded.catalog, loaded.revision);
    const artifact = await manager.store.upload(uploadRequest("scan.pdf", pdfWithText(""), "application/pdf"));
    const status = await completed(manager, (await manager.start(artifact.digest)).job_id);
    assert.equal(status.phase, "completed");
    assert.equal(status.result?.extracted_via, "ocr");
    assert.equal(status.result?.outcome, "drafts_ready");
    await manager.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paper intake applies the configured active-job ceiling and extraction-command timeout", {
  skip: process.platform === "win32",
  timeout: 12_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-paper-manager-limits-"));
  let manager: PaperManager | undefined;
  const jobIds: string[] = [];
  try {
    const bin = path.join(root, ".somite", "tools", "paper", ".pixi", "envs", "default", "bin");
    await fakeExecutable(path.join(bin, "pdfinfo"), `
      if (process.argv.includes("-v")) process.stderr.write("pdfinfo version 25.01.0\\n");
      else process.stdout.write("Pages: 1\\n");
    `);
    await fakeExecutable(path.join(bin, "pdftoppm"), `
      if (process.argv.includes("-v")) process.stderr.write("pdftoppm version 25.01.0\\n");
      else require("node:fs").writeFileSync(process.argv.at(-1) + ".png", "fake raster");
    `);
    await fakeExecutable(path.join(bin, "tesseract"), `
      if (process.argv.includes("--version")) process.stdout.write("tesseract 5.5.0\\n");
      else if (process.argv.includes("--list-langs")) process.stdout.write("List of available languages (1):\\neng\\n");
      else setInterval(() => undefined, 1_000);
    `);
    const configuration = paperIntakeConfigFromEnvironment({
      SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS: "2",
      SOMITE_PAPER_MAX_ACTIVE_JOBS: "1",
    });
    manager = new PaperManager(root, loaded.catalog, loaded.revision, configuration);
    assert.equal(manager.configuration.paperCommandTimeoutMs, 2_000);
    assert.equal(manager.configuration.maxActiveJobs, 1);

    const artifact = await manager.store.upload(uploadRequest("scan.pdf", pdfWithText(""), "application/pdf"));
    const first = await manager.start(artifact.digest);
    const second = await manager.start(artifact.digest);
    jobIds.push(first.job_id, second.job_id);

    let firstStatus = await manager.status(first.job_id, 250);
    for (let attempt = 0; attempt < 8 && firstStatus.phase === "queued"; attempt += 1) {
      firstStatus = await manager.status(first.job_id, 250);
    }
    assert.equal(firstStatus.phase, "extracting");
    assert.equal((await manager.status(second.job_id)).phase, "queued", "the second job must wait behind the configured one-job ceiling");

    const firstCompleted = await completed(manager, first.job_id);
    assert.equal(firstCompleted.phase, "failed");
    assert.equal(firstCompleted.failure?.code, "paper_extraction_timeout");
    assert.match(firstCompleted.failure?.message ?? "", /tesseract.*SOMITE_PAPER_COMMAND_TIMEOUT_SECONDS/i);
    await manager.cancel(second.job_id);
    assert.equal((await completed(manager, second.job_id)).phase, "cancelled");
  } finally {
    if (manager) {
      await Promise.all(jobIds.map((jobId) => manager!.cancel(jobId).catch(() => undefined)));
      await manager.shutdown();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("paper intake verifies and invokes the configured OCR languages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-paper-manager-languages-"));
  const argumentsPath = path.join(root, "tesseract-arguments.json");
  try {
    const bin = path.join(root, ".somite", "tools", "paper", ".pixi", "envs", "default", "bin");
    await fakeExecutable(path.join(bin, "pdfinfo"), `if (process.argv.includes("-v")) process.stderr.write("pdfinfo version 25.01.0\\n"); else process.stdout.write("Pages: 1\\n");`);
    await fakeExecutable(path.join(bin, "pdftoppm"), `if (process.argv.includes("-v")) process.stderr.write("pdftoppm version 25.01.0\\n"); else require("node:fs").writeFileSync(process.argv.at(-1) + ".png", "fake raster");`);
    await fakeExecutable(path.join(bin, "tesseract"), `
      if (process.argv.includes("--version")) process.stdout.write("tesseract 5.5.0\\n");
      else if (process.argv.includes("--list-langs")) process.stdout.write("List of available languages (2):\\ndeu\\neng\\n");
      else {
        require("node:fs").writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));
        process.stdout.write("Methods RNA sequencing reads were checked with FastQC and aligned with STAR for expression analysis.\\n");
      }
    `);
    const configuration = paperIntakeConfigFromEnvironment({ SOMITE_OCR_LANGS: "deu+eng" });
    const manager = new PaperManager(root, loaded.catalog, loaded.revision, configuration);
    const artifact = await manager.store.upload(uploadRequest("scan.pdf", pdfWithText(""), "application/pdf"));
    const status = await completed(manager, (await manager.start(artifact.digest)).job_id);
    assert.equal(status.phase, "completed");
    const args = JSON.parse(await readFile(argumentsPath, "utf8")) as string[];
    assert.equal(args[args.indexOf("-l") + 1], "deu+eng");
    assert.equal((await manager.paperTools.preflight()).tools.find((tool) => tool.name === "tesseract")?.identity, "tesseract@5.5.0+deu+eng");
    await manager.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized extraction caches are ignored and replaced within the byte bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-paper-cache-bound-"));
  try {
    const manager = new PaperManager(root, loaded.catalog, loaded.revision);
    const methods = "Methods\nRNA-seq reads were quality checked with FastQC and aligned with STAR.";
    const artifact = await manager.store.upload(uploadRequest("methods.txt", methods));
    const cacheDirectory = path.join(root, ".somite", "papers", "cache", "extracted");
    await mkdir(cacheDirectory, { recursive: true });
    const cachePath = path.join(cacheDirectory, `${artifact.digest.slice("blake3:".length)}-pdfjs-ocr-v4.json`);
    await writeFile(cachePath, "");
    await truncate(cachePath, 72 * 1024 * 1024 + 1);

    const started = await manager.start(artifact.digest);
    const status = await completed(manager, started.job_id);
    assert.equal(status.phase, "completed");
    assert.equal(status.cache.extraction, false);
    assert.ok((await stat(cachePath)).size < 72 * 1024 * 1024);
    await manager.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconstruction cache prunes least-recent entries instead of growing without bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-paper-reconstruction-cache-"));
  try {
    const manager = new PaperManager(root, loaded.catalog, loaded.revision);
    const digests: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const methods = `Methods\nSample ${index} RNA-seq reads were quality checked with FastQC and aligned with STAR.`;
      const artifact = await manager.store.upload(uploadRequest(`methods-${index}.txt`, methods));
      digests.push(artifact.digest);
      const status = await completed(manager, (await manager.start(artifact.digest)).job_id);
      assert.equal(status.phase, "completed");
      assert.equal(status.cache.reconstruction, false);
    }

    const first = await completed(manager, (await manager.start(digests[0]!)).job_id);
    assert.deepEqual(first.cache, { extraction: true, reconstruction: false });
    const newest = await completed(manager, (await manager.start(digests.at(-1)!)).job_id);
    assert.deepEqual(newest.cache, { extraction: true, reconstruction: true });
    await manager.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paper cancellation reaches a terminal observable state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-paper-cancel-"));
  try {
    const manager = new PaperManager(root, loaded.catalog, loaded.revision);
    const artifact = await manager.store.upload(uploadRequest("paper.txt", "Methods\n" + "FastQC reads. ".repeat(2_000)));
    const started = await manager.start(artifact.digest);
    const cancelling = await manager.cancel(started.job_id);
    assert.ok(cancelling.phase === "cancelling" || cancelling.phase === "cancelled");
    const status = await completed(manager, started.job_id);
    assert.equal(status.phase, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paper upload rejects disguised and unsupported files before storage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "somite-paper-upload-"));
  try {
    const manager = new PaperManager(root, loaded.catalog, loaded.revision, paperIntakeConfigFromEnvironment({
      SOMITE_PAPER_MAX_UPLOAD_BYTES: String(64 * 1024 * 1024),
    }));
    await assert.rejects(
      () => manager.store.upload(uploadRequest("fake.pdf", "not a PDF", "application/pdf")),
      (error: unknown) => error instanceof PaperStoreError && error.code === "paper_pdf_invalid",
    );
    await assert.rejects(
      () => manager.store.upload(uploadRequest("paper.csv", "a,b\n1,2", "text/csv")),
      (error: unknown) => error instanceof PaperStoreError && error.code === "paper_media_unsupported",
    );
    await assert.rejects(
      () => manager.store.upload(uploadRequest("disguised.txt", "%PDF-1.7\n", "text/plain")),
      (error: unknown) => error instanceof PaperStoreError && error.code === "paper_media_unsupported",
    );
    const oversized = new Request("http://localhost/api/papers/uploads", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=somite-test",
        "content-length": String(65 * 1024 * 1024 + 1),
      },
      body: "--somite-test--\r\n",
    });
    await assert.rejects(
      () => manager.store.upload(oversized),
      (error: unknown) => error instanceof PaperStoreError && error.status === 413 && error.code === "paper_upload_too_large"
        && /SOMITE_PAPER_MAX_UPLOAD_BYTES/.test(error.message),
    );

    const boundary = "somite-unbounded-field";
    const megabyte = Buffer.alloc(1024 * 1024, "A");
    async function* oversizedChunkedBody() {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="notes"\r\n\r\n`);
      for (let index = 0; index < 66; index += 1) yield megabyte;
      yield Buffer.from(`\r\n--${boundary}--\r\n`);
    }
    const chunked = new Request("http://localhost/api/papers/uploads", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: Readable.toWeb(Readable.from(oversizedChunkedBody())),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await assert.rejects(
      () => manager.store.upload(chunked),
      (error: unknown) => error instanceof PaperStoreError && error.status === 413 && error.code === "paper_upload_too_large",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
