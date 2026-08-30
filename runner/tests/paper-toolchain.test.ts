import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DEFAULT_OCR_PAGES, extractPaper, MAX_OCR_PAGES, PaperExtractionError } from "../src/paperExtractor.ts";
import { PaperToolchain } from "../src/paperToolchain.ts";
import { pdfWithPages, pdfWithText } from "./pdfFixture.ts";

async function executable(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function fakeOcrTools(bin: string, options: { pages?: number; tesseract?: string; prefixRecord?: string; languages?: readonly string[] } = {}) {
  await executable(join(bin, "pdfinfo"), `
    if (process.argv.includes("-v")) process.stderr.write("pdfinfo version 25.01.0\\n");
    else process.stdout.write("Pages: ${options.pages ?? 1}\\n");
  `);
  await executable(join(bin, "pdftoppm"), `
    if (process.argv.includes("-v")) process.stderr.write("pdftoppm version 25.01.0\\n");
    else {
      const fs = require("node:fs");
      const prefix = process.argv.at(-1);
      ${options.prefixRecord ? `fs.writeFileSync(${JSON.stringify(options.prefixRecord)}, prefix);` : ""}
      fs.writeFileSync(prefix + ".png", "fake raster image");
    }
  `);
  await executable(join(bin, "tesseract"), `
    if (process.argv.includes("--version")) process.stdout.write("tesseract 5.5.0\\n leptonica-1.85.0\\n");
    else if (process.argv.includes("--list-langs")) process.stdout.write("List of available languages in fake (1):\\n${(options.languages ?? ["eng"]).join("\\n")}\\n");
    else { ${options.tesseract ?? `process.stdout.write("Methods RNA sequencing reads were quality checked with FastQC and aligned with STAR before downstream analysis.\\n");`} }
  `);
}

async function processExited(pid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  return false;
}

async function recordedPids(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as { parent: number; child: number };
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error("fake OCR process did not start");
}

test("paper OCR detection honors managed, project, then PATH priority and reports missing requirements", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-tools-priority-"));
  try {
    const managed = join(root, ".somite", "tools", "paper", ".pixi", "envs", "default", "bin");
    const project = join(root, ".pixi", "envs", "default", "bin");
    const system = join(root, "system-bin");
    await Promise.all([fakeOcrTools(managed), fakeOcrTools(project), fakeOcrTools(system)]);
    const toolchain = new PaperToolchain(root, { environment: { PATH: system } });

    let preflight = await toolchain.preflight();
    assert.equal(preflight.native_pdf_text, true);
    assert.equal(preflight.scanned_pdf_ocr, true);
    assert.deepEqual(preflight.tools.slice(1).map((tool) => tool.source), ["managed_pixi", "managed_pixi", "managed_pixi"]);
    assert.ok(preflight.tools.slice(1).every((tool) => tool.path?.startsWith(managed)));
    assert.deepEqual(preflight.tools.slice(1).map((tool) => tool.version), ["25.01.0", "25.01.0", "5.5.0"]);
    assert.deepEqual(preflight.tools.slice(1).map((tool) => tool.identity), ["pdfinfo@25.01.0", "pdftoppm@25.01.0", "tesseract@5.5.0+eng"]);

    await rm(join(root, ".somite", "tools", "paper", ".pixi"), { recursive: true });
    preflight = await toolchain.preflight();
    assert.deepEqual(preflight.tools.slice(1).map((tool) => tool.source), ["project_pixi", "project_pixi", "project_pixi"]);

    await rm(join(root, ".pixi"), { recursive: true });
    preflight = await toolchain.preflight();
    assert.deepEqual(preflight.tools.slice(1).map((tool) => tool.source), ["system_path", "system_path", "system_path"]);

    await rm(join(system, "tesseract"));
    preflight = await toolchain.preflight();
    assert.equal(preflight.scanned_pdf_ocr, false);
    assert.deepEqual(preflight.missing, ["tesseract"]);
    assert.match(preflight.tools.find((tool) => tool.name === "tesseract")?.detail ?? "", /conda-forge::tesseract/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paper OCR preflight rejects executable-name impostors and Tesseract without usable English data", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-tools-capability-"));
  try {
    const managed = join(root, ".somite", "tools", "paper", ".pixi", "envs", "default", "bin");
    const project = join(root, ".pixi", "envs", "default", "bin");
    await fakeOcrTools(managed, { languages: ["deu"] });
    await executable(join(managed, "pdfinfo"), `process.stderr.write("not actually poppler 9.9\\n");`);
    await fakeOcrTools(project);

    const preflight = await new PaperToolchain(root, { environment: { PATH: "" } }).preflight();
    assert.equal(preflight.scanned_pdf_ocr, true);
    assert.equal(preflight.tools.find((tool) => tool.name === "pdfinfo")?.source, "project_pixi");
    assert.equal(preflight.tools.find((tool) => tool.name === "tesseract")?.source, "project_pixi");

    const german = await new PaperToolchain(root, { environment: { PATH: "" }, ocrLanguages: "deu" }).preflight();
    assert.equal(german.scanned_pdf_ocr, true);
    assert.equal(german.tools.find((tool) => tool.name === "tesseract")?.source, "managed_pixi");
    assert.equal(german.tools.find((tool) => tool.name === "tesseract")?.identity, "tesseract@5.5.0+deu");

    await rm(join(root, ".pixi"), { recursive: true });
    const unavailable = await new PaperToolchain(root, { environment: { PATH: "" } }).preflight();
    assert.equal(unavailable.scanned_pdf_ocr, false);
    assert.deepEqual(unavailable.missing, ["pdfinfo", "tesseract"]);
    assert.match(unavailable.tools.find((tool) => tool.name === "pdfinfo")?.detail ?? "", /identity probe/i);
    assert.match(unavailable.tools.find((tool) => tool.name === "tesseract")?.detail ?? "", /English.*trained data/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paper command closes an abort that races between the initial check and listener registration", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-command-abort-race-"));
  const command = join(root, "hang");
  const pidRecord = join(root, "pid.txt");
  try {
    await executable(command, `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(pidRecord)}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    let reads = 0;
    const racedSignal = {
      get aborted() { reads += 1; return reads > 1; },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    const started = Date.now();
    await assert.rejects(
      () => import("../src/paperToolchain.ts").then(({ runPaperCommand }) => runPaperCommand(command, [], root, {
        signal: racedSignal,
        timeoutMs: 1_000,
        maximumStdoutBytes: 1_024,
        maximumStderrBytes: 1_024,
      })),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "paper_command_cancelled",
    );
    assert.ok(Date.now() - started < 500, "raced abort waited for the command timeout");
    const pid = Number(await readFile(pidRecord, "utf8").catch(() => "0"));
    if (pid) assert.equal(await processExited(pid), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image-only PDF falls back to bounded OCR with determinate progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-ocr-success-"));
  try {
    const bin = join(root, ".somite", "tools", "paper", ".pixi", "envs", "default", "bin");
    await fakeOcrTools(bin, { pages: 2 });
    const progress: string[] = [];
    const extracted = await extractPaper(pdfWithPages(["", ""]), "pdf", {
      ocr: { toolchain: new PaperToolchain(root), maxPages: 2 },
      onProgress: (event) => progress.push(event.message),
    });
    assert.equal(extracted.extractedVia, "ocr");
    assert.equal(extracted.pages, 2);
    assert.match(extracted.text, /FastQC/);
    assert.match(extracted.text, /\f/);
    assert.ok(progress.includes("Counting pages for bounded OCR"));
    assert.ok(progress.includes("Rasterizing PDF page 1 of 2"));
    assert.ok(progress.includes("Reading OCR page 2 of 2"));
    assert.ok(progress.includes("Read OCR page 2 of 2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OCR defaults to the production page limit and rejects configured overflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-ocr-page-bound-"));
  try {
    const bin = join(root, ".somite", "tools", "paper", ".pixi", "envs", "default", "bin");
    await fakeOcrTools(bin, { pages: 2 });
    const toolchain = new PaperToolchain(root);
    assert.equal(DEFAULT_OCR_PAGES, 200);
    assert.equal(MAX_OCR_PAGES, 10_000);
    await assert.rejects(
      () => extractPaper(pdfWithPages(["", ""]), "pdf", { ocr: { toolchain, maxPages: 1 } }),
      (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_extraction_limit"
        && /configured OCR limit is 1.*SOMITE_PAPER_MAX_OCR_PAGES/.test(error.message),
    );
    await assert.rejects(
      () => extractPaper(pdfWithText(""), "pdf", { ocr: { toolchain, maxPages: 10_001 } }),
      (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_extraction_limit" && /between 1 and 10000/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OCR cancellation terminates the process tree and removes private raster workspace", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-ocr-cancel-"));
  const pidRecord = join(root, "pids.json");
  const prefixRecord = join(root, "prefix.txt");
  try {
    const bin = join(root, ".somite", "tools", "paper", ".pixi", "envs", "default", "bin");
    await fakeOcrTools(bin, {
      prefixRecord,
      tesseract: `
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        fs.writeFileSync(${JSON.stringify(pidRecord)}, JSON.stringify({ parent: process.pid, child: child.pid }));
        setInterval(() => {}, 1000);
      `,
    });
    const controller = new AbortController();
    const extraction = extractPaper(pdfWithText(""), "pdf", {
      signal: controller.signal,
      ocr: { toolchain: new PaperToolchain(root), commandTimeoutMs: 30_000 },
    });
    const pids = await recordedPids(pidRecord);
    controller.abort();
    await assert.rejects(extraction, (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_extraction_cancelled");
    assert.equal(await processExited(pids.parent), true, `OCR parent ${pids.parent} survived cancellation`);
    assert.equal(await processExited(pids.child), true, `OCR grandchild ${pids.child} survived cancellation`);
    const rasterPrefix = await readFile(prefixRecord, "utf8");
    await assert.rejects(() => lstat(dirname(rasterPrefix)), /ENOENT/);
    await assert.rejects(() => readFile(`${rasterPrefix}.png`), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OCR enforces a per-command timeout and kills the timed-out tool", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-ocr-timeout-"));
  const pidRecord = join(root, "pids.json");
  try {
    const bin = join(root, ".somite", "tools", "paper", ".pixi", "envs", "default", "bin");
    await fakeOcrTools(bin, {
      tesseract: `
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        fs.writeFileSync(${JSON.stringify(pidRecord)}, JSON.stringify({ parent: process.pid, child: child.pid }));
        setInterval(() => {}, 1000);
      `,
    });
    await assert.rejects(
      () => extractPaper(pdfWithText(""), "pdf", { ocr: { toolchain: new PaperToolchain(root), commandTimeoutMs: 100 } }),
      (error: unknown) => error instanceof PaperExtractionError && error.code === "paper_extraction_timeout",
    );
    const pids = await recordedPids(pidRecord);
    assert.equal(await processExited(pids.parent), true, `timed-out OCR parent ${pids.parent} survived`);
    assert.equal(await processExited(pids.child), true, `timed-out OCR grandchild ${pids.child} survived`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed Pixi install verifies a staged environment before atomically publishing its receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-pixi-install-"));
  const fakePixi = join(root, "fake-pixi");
  const calls = join(root, "pixi-calls.jsonl");
  try {
    await executable(fakePixi, `
      const fs = require("node:fs");
      const path = require("node:path");
      fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
      const args = process.argv.slice(2);
      const manifest = args[args.indexOf("--manifest-path") + 1];
      const directory = path.dirname(manifest);
      const lock = path.join(directory, "pixi.lock");
      if (!fs.existsSync(lock)) fs.writeFileSync(lock, "version = 1\\n");
      const bin = path.join(directory, ".pixi", "envs", "default", "bin");
      fs.mkdirSync(bin, { recursive: true });
      const tools = {
        pdfinfo: 'if (process.argv.includes("-v")) process.stderr.write("pdfinfo version 25.01.0\\\\n"); else process.stdout.write("Pages: 1\\\\n");',
        pdftoppm: 'if (process.argv.includes("-v")) process.stderr.write("pdftoppm version 25.01.0\\\\n");',
        tesseract: 'if (process.argv.includes("--version")) process.stdout.write("tesseract 5.5.0\\\\n"); else if (process.argv.includes("--list-langs")) process.stdout.write("List of available languages (1):\\\\neng\\\\n");',
      };
      for (const [name, body] of Object.entries(tools)) {
        const target = path.join(bin, name);
        fs.writeFileSync(target, "#!${process.execPath}\\n" + body + "\\n", { mode: 0o700 });
        fs.chmodSync(target, 0o700);
      }
    `);
    const toolchain = new PaperToolchain(root, { environment: { PATH: "" }, pixiPath: fakePixi });
    const first = await toolchain.installManaged({ timeoutMs: 5_000 });
    assert.equal(first.reused_lock, false);
    assert.equal(first.preflight.scanned_pdf_ocr, true);
    assert.ok(first.preflight.tools.slice(1).every((tool) => tool.source === "managed_pixi"));
    assert.match(first.receipt_id, /^[a-f0-9]{64}$/);
    const pointer = JSON.parse(await readFile(join(root, ".somite", "tools", "paper", "current.json"), "utf8")) as { receipt_id: string; generation: string };
    assert.equal(pointer.receipt_id, first.receipt_id);
    assert.ok(first.manifest_path.includes(join(".paper-installations", pointer.generation)));
    assert.equal(await readFile(first.receipt_path, "utf8").then((raw) => JSON.parse(raw).receipt_id), first.receipt_id);
    const manifest = await readFile(first.manifest_path, "utf8");
    assert.match(manifest, /channels = \["conda-forge"\]/);
    assert.match(manifest, /poppler = "\*"/);
    assert.match(manifest, /tesseract = "\*"/);
    const lock = await readFile(first.lock_path, "utf8");

    const second = await toolchain.installManaged({ timeoutMs: 5_000 });
    assert.equal(second.reused_lock, true);
    assert.equal(second.receipt_id, first.receipt_id);
    assert.equal(await readFile(second.lock_path, "utf8"), lock);
    const invocations = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.equal(invocations.length, 1, "a verified published receipt should not reinstall the same environment");
    assert.equal(invocations[0]!.includes("--frozen"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed Pixi install reuses an exact legacy lock in frozen mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-pixi-frozen-"));
  const fakePixi = join(root, "fake-pixi");
  const calls = join(root, "pixi-calls.jsonl");
  try {
    const legacy = join(root, ".somite", "tools", "paper");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "pixi.toml"), `[workspace]\nname = "somite-paper-tools"\nchannels = ["conda-forge"]\nplatforms = ["linux-64"]\n\n[dependencies]\npoppler = "*"\ntesseract = "*"\n`);
    await writeFile(join(legacy, "pixi.lock"), "version = 1\n");
    await executable(fakePixi, `
      const fs = require("node:fs");
      const path = require("node:path");
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
      const manifest = args[args.indexOf("--manifest-path") + 1];
      const directory = path.dirname(manifest);
      const bin = path.join(directory, ".pixi", "envs", "default", "bin");
      fs.mkdirSync(bin, { recursive: true });
      const bodies = {
        pdfinfo: 'process.stderr.write("pdfinfo version 25.01.0\\\\n");',
        pdftoppm: 'process.stderr.write("pdftoppm version 25.01.0\\\\n");',
        tesseract: 'if (process.argv.includes("--version")) process.stdout.write("tesseract 5.5.0\\\\n"); else process.stdout.write("List of available languages (1):\\\\neng\\\\n");',
      };
      for (const [name, body] of Object.entries(bodies)) {
        const target = path.join(bin, name);
        fs.writeFileSync(target, "#!${process.execPath}\\n" + body + "\\n", { mode: 0o700 });
        fs.chmodSync(target, 0o700);
      }
    `);
    const installed = await new PaperToolchain(root, {
      environment: { PATH: "" },
      operatingSystem: "linux",
      architecture: "x64",
      pixiPath: fakePixi,
    }).installManaged({ timeoutMs: 5_000 });
    assert.equal(installed.reused_lock, true);
    const invocation = JSON.parse((await readFile(calls, "utf8")).trim()) as string[];
    assert.equal(invocation.includes("--frozen"), true);
    assert.equal(await readFile(installed.lock_path, "utf8"), "version = 1\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed Pixi install is cross-process busy and never publishes a failed partial stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-pixi-atomic-"));
  const fakePixi = join(root, "fake-pixi");
  const started = join(root, "started");
  const release = join(root, "release");
  try {
    await executable(fakePixi, `
      const fs = require("node:fs");
      const path = require("node:path");
      const args = process.argv.slice(2);
      const manifest = args[args.indexOf("--manifest-path") + 1];
      const directory = path.dirname(manifest);
      fs.writeFileSync(path.join(directory, "pixi.lock"), "version = 1\\n");
      fs.writeFileSync(${JSON.stringify(started)}, "ready");
      const wait = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(wait);
        const bin = path.join(directory, ".pixi", "envs", "default", "bin");
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, "pdfinfo"), "partial");
        process.stderr.write("injected failure\\n");
        process.exit(19);
      }, 10);
    `);
    const first = new PaperToolchain(root, { environment: { PATH: "" }, pixiPath: fakePixi }).installManaged({ timeoutMs: 5_000 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await readFile(started).then(() => true, () => false)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await assert.rejects(
      () => new PaperToolchain(root, { environment: { PATH: "" }, pixiPath: fakePixi }).installManaged({ timeoutMs: 5_000 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "paper_tool_install_busy",
    );
    await writeFile(release, "go");
    await assert.rejects(first, (error: unknown) => error instanceof Error && "code" in error && error.code === "paper_tool_install_failed");
    await assert.rejects(() => readFile(join(root, ".somite", "tools", "paper", "current.json")), /ENOENT/);
    const toolsEntries = await readdir(join(root, ".somite", "tools"));
    assert.equal(toolsEntries.some((entry) => entry.startsWith(".paper-stage-")), false);
    assert.equal(toolsEntries.includes(".paper-install.lock"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed Pixi install rolls back a candidate that changes before publication verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-paper-pixi-publication-"));
  const fakePixi = join(root, "fake-pixi");
  try {
    await executable(fakePixi, `
      const fs = require("node:fs");
      const path = require("node:path");
      const args = process.argv.slice(2);
      const directory = path.dirname(args[args.indexOf("--manifest-path") + 1]);
      fs.writeFileSync(path.join(directory, "pixi.lock"), "version = 1\\n");
      const bin = path.join(directory, ".pixi", "envs", "default", "bin");
      fs.mkdirSync(bin, { recursive: true });
      const pdfinfo = path.join(bin, "pdfinfo");
      fs.writeFileSync(pdfinfo, '#!${process.execPath}\\nconst fs = require("node:fs"); const count = __filename + ".count"; const n = fs.existsSync(count) ? Number(fs.readFileSync(count, "utf8")) : 0; fs.writeFileSync(count, String(n + 1)); process.stderr.write(n === 0 ? "pdfinfo version 25.01.0\\\\n" : "changed after staging\\\\n");\\n', { mode: 0o700 });
      const tools = {
        pdftoppm: 'process.stderr.write("pdftoppm version 25.01.0\\\\n");',
        tesseract: 'if (process.argv.includes("--version")) process.stdout.write("tesseract 5.5.0\\\\n"); else process.stdout.write("List of available languages (1):\\\\neng\\\\n");',
      };
      for (const [name, body] of Object.entries(tools)) {
        const target = path.join(bin, name);
        fs.writeFileSync(target, "#!${process.execPath}\\n" + body + "\\n", { mode: 0o700 });
        fs.chmodSync(target, 0o700);
      }
    `);
    await assert.rejects(
      () => new PaperToolchain(root, { environment: { PATH: "" }, pixiPath: fakePixi }).installManaged({ timeoutMs: 5_000 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "paper_tool_publication_failed",
    );
    await assert.rejects(() => readFile(join(root, ".somite", "tools", "paper", "current.json")), /ENOENT/);
    assert.deepEqual(await readdir(join(root, ".somite", "tools", ".paper-installations")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
