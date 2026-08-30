import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

import { atomicWrite, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";
import { DEFAULT_PAPER_INTAKE_CONFIG, ocrLanguageCodes } from "./paperConfig.ts";
import { terminateProcessTree } from "./process.ts";
import { pixiPlatform } from "./system.ts";

export type PaperToolName = "pdfinfo" | "pdftoppm" | "tesseract";
export type PaperToolSource = "built_in" | "managed_pixi" | "project_pixi" | "system_path";

export type PaperToolReadiness = Readonly<{
  name: "PDF.js" | PaperToolName;
  available: boolean;
  source?: PaperToolSource;
  path?: string;
  package?: "poppler" | "tesseract";
  version?: string;
  identity?: string;
  detail: string;
}>;

export type PaperToolchainPreflight = Readonly<{
  native_pdf_text: true;
  scanned_pdf_ocr: boolean;
  tools: readonly PaperToolReadiness[];
  missing: readonly PaperToolName[];
}>;

export type ResolvedPaperOcrToolchain = Readonly<Record<PaperToolName, Readonly<{
  path: string;
  source: Exclude<PaperToolSource, "built_in">;
  identity: string;
  environment: NodeJS.ProcessEnv;
}>>>;

export type ManagedPaperToolchainInstall = Readonly<{
  manifest_path: string;
  lock_path: string;
  receipt_path: string;
  receipt_id: string;
  reused_lock: boolean;
  preflight: PaperToolchainPreflight;
}>;

export type PaperToolchainOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  operatingSystem?: NodeJS.Platform;
  architecture?: string;
  pixiPath?: string;
  ocrLanguages?: string;
}>;

export type PaperCommandOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs: number;
  maximumStdoutBytes: number;
  maximumStderrBytes: number;
  environment?: NodeJS.ProcessEnv;
}>;

export type PaperCommandResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

const requirements: Readonly<Record<PaperToolName, Readonly<{ package: "poppler" | "tesseract"; purpose: string }>>> = {
  pdfinfo: { package: "poppler", purpose: "Count PDF pages before bounded OCR" },
  pdftoppm: { package: "poppler", purpose: "Render PDF pages for OCR" },
  tesseract: { package: "tesseract", purpose: "Recognize text on scanned pages" },
};
const toolNames = Object.freeze(Object.keys(requirements) as PaperToolName[]);
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_INSTALL_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_POINTER_BYTES = 4 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 3_000;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1_000;
const RECEIPT_SCHEMA_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 1;
const moduleRequire = createRequire(import.meta.url);

type ToolProbe = Readonly<{ version: string; identity: string }>;
type ResolvedTool = Readonly<{
  path: string;
  source: Exclude<PaperToolSource, "built_in">;
  version: string;
  identity: string;
}>;
type ToolResolution = Readonly<{ resolved?: ResolvedTool; failures: readonly string[] }>;
type ReceiptTool = Readonly<{ version: string; identity: string }>;
type PaperToolReceipt = Readonly<{
  schema_version: 1;
  receipt_id: string;
  platform: string;
  manifest_sha256: string;
  lock_sha256: string;
  tools: Readonly<Record<PaperToolName, ReceiptTool>>;
}>;
type CurrentPointer = Readonly<{
  schema_version: 1;
  generation: string;
  receipt_id: string;
}>;
type PublishedInstallation = Readonly<{
  directory: string;
  manifestPath: string;
  lockPath: string;
  receiptPath: string;
  receipt: PaperToolReceipt;
  tools: Readonly<Record<PaperToolName, ResolvedTool>>;
}>;
type InstallLease = Readonly<{ directory: string; nonce: string; stage: string }>;

export class PaperToolchainError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "PaperToolchainError";
    this.code = code;
    this.retryable = retryable;
  }
}

function executableSuffixes(operatingSystem: NodeJS.Platform, environment: Readonly<Record<string, string | undefined>>) {
  return operatingSystem === "win32"
    ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter((suffix) => /^\.[A-Za-z0-9]{1,12}$/.test(suffix)).slice(0, 16)
    : [""];
}

function environmentBins(environmentRoot: string, operatingSystem: NodeJS.Platform) {
  return operatingSystem === "win32"
    ? [environmentRoot, join(environmentRoot, "Scripts"), join(environmentRoot, "Library", "bin")]
    : [join(environmentRoot, "bin")];
}

async function canonicalDirectory(path: string, label: string) {
  const absolute = resolve(path);
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch {
    throw new PaperToolchainError("paper_directory_unavailable", `${label} is unavailable.`);
  }
  const metadata = await lstat(canonical);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PaperToolchainError("paper_directory_unavailable", `${label} must resolve to a regular directory.`);
  }
  return canonical;
}

async function canonicalExecutable(path: string) {
  if (!isAbsolute(path) || path.includes("\0")) return undefined;
  try {
    const canonical = await realpath(path);
    const metadata = await lstat(canonical);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    await access(canonical, fsConstants.X_OK);
    return canonical;
  } catch {
    return undefined;
  }
}

async function resolveInDirectories(
  name: string,
  directories: readonly string[],
  suffixes: readonly string[],
) {
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue;
    for (const suffix of suffixes) {
      const found = await canonicalExecutable(join(directory, `${name}${suffix}`));
      if (found) return found;
    }
  }
  return undefined;
}

function manifest(platform: string) {
  return `[workspace]\nname = "somite-paper-tools"\nchannels = ["conda-forge"]\nplatforms = ["${platform}"]\n\n[dependencies]\npoppler = "*"\ntesseract = "*"\n`;
}

async function installedPdfJsVersion() {
  try {
    const packagePath = moduleRequire.resolve("pdfjs-dist/package.json");
    const source = record(JSON.parse(new TextDecoder().decode(await regularFile(packagePath, MAX_MANIFEST_BYTES, "PDF.js package manifest"))));
    return typeof source?.version === "string" && /^[0-9A-Za-z.+-]{1,80}$/.test(source.version) ? source.version : undefined;
  } catch {
    return undefined;
  }
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function decoded(result: PaperCommandResult) {
  return `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;
}

function safeDiagnostic(result: PaperCommandResult) {
  return decoded(result)
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://<redacted>@")
    .replace(/\b(token|password|secret)=\S+/gi, "$1=<redacted>")
    .trim()
    .split(/\r?\n/)
    .findLast((line) => line.trim())
    ?.trim()
    .slice(0, 512);
}

function minimalEnvironment(environment: Readonly<Record<string, string | undefined>>, includeTessdata: boolean) {
  const allowed = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
    "TMP", "TEMP", "TMPDIR", "LOCALAPPDATA", "APPDATA", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "PIXI_CACHE_DIR", "RATTLER_CACHE_DIR", "LANG", "LC_ALL", "LC_CTYPE",
    ...(includeTessdata ? ["TESSDATA_PREFIX"] : []),
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase()))) as NodeJS.ProcessEnv;
}

function receiptMaterial(
  platform: string,
  manifestSha256: string,
  lockSha256: string,
  tools: Readonly<Record<PaperToolName, ReceiptTool>>,
) {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    platform,
    manifest_sha256: manifestSha256,
    lock_sha256: lockSha256,
    tools: Object.fromEntries(toolNames.map((name) => [name, tools[name]])) as Record<PaperToolName, ReceiptTool>,
  } as const;
}

function buildReceipt(
  platform: string,
  manifestBytes: Uint8Array,
  lockBytes: Uint8Array,
  tools: Readonly<Record<PaperToolName, ResolvedTool>>,
): PaperToolReceipt {
  const identities = Object.fromEntries(toolNames.map((name) => [name, {
    version: tools[name].version,
    identity: tools[name].identity,
  }])) as Record<PaperToolName, ReceiptTool>;
  const material = receiptMaterial(platform, sha256(manifestBytes), sha256(lockBytes), identities);
  return { ...material, receipt_id: sha256(JSON.stringify(material)) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decodeReceipt(bytes: Uint8Array): PaperToolReceipt | undefined {
  try {
    const source = record(JSON.parse(new TextDecoder().decode(bytes)));
    const tools = record(source?.tools);
    if (source?.schema_version !== RECEIPT_SCHEMA_VERSION
      || typeof source.receipt_id !== "string" || !/^[a-f0-9]{64}$/.test(source.receipt_id)
      || typeof source.platform !== "string"
      || typeof source.manifest_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.manifest_sha256)
      || typeof source.lock_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.lock_sha256)
      || !tools) return undefined;
    const decodedTools = {} as Record<PaperToolName, ReceiptTool>;
    for (const name of toolNames) {
      const tool = record(tools[name]);
      if (typeof tool?.version !== "string" || typeof tool.identity !== "string"
        || tool.version.length < 1 || tool.version.length > 160 || tool.identity.length < 1 || tool.identity.length > 200) return undefined;
      decodedTools[name] = { version: tool.version, identity: tool.identity };
    }
    const material = receiptMaterial(source.platform, source.manifest_sha256, source.lock_sha256, decodedTools);
    if (sha256(JSON.stringify(material)) !== source.receipt_id) return undefined;
    return { ...material, receipt_id: source.receipt_id };
  } catch {
    return undefined;
  }
}

function decodePointer(bytes: Uint8Array): CurrentPointer | undefined {
  try {
    const source = record(JSON.parse(new TextDecoder().decode(bytes)));
    if (source?.schema_version !== CURRENT_SCHEMA_VERSION
      || typeof source.generation !== "string" || !/^install-[a-f0-9]{32}$/.test(source.generation)
      || typeof source.receipt_id !== "string" || !/^[a-f0-9]{64}$/.test(source.receipt_id)) return undefined;
    return { schema_version: CURRENT_SCHEMA_VERSION, generation: source.generation, receipt_id: source.receipt_id };
  } catch {
    return undefined;
  }
}

function validCommandNumber(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new PaperToolchainError("paper_command_invalid", `${label} must be a positive integer.`);
}

/**
 * Run one exact executable without a shell. Output overflow, timeout, and
 * cancellation terminate the executable's complete process group on POSIX.
 */
export async function runPaperCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  options: PaperCommandOptions,
): Promise<PaperCommandResult> {
  validCommandNumber(options.timeoutMs, "Paper command timeout");
  validCommandNumber(options.maximumStdoutBytes, "Paper command stdout limit");
  validCommandNumber(options.maximumStderrBytes, "Paper command stderr limit");
  if (options.signal?.aborted) throw new PaperToolchainError("paper_command_cancelled", "Paper command was cancelled.", true);
  const executable = await canonicalExecutable(command);
  if (!executable) throw new PaperToolchainError("paper_tool_unavailable", `Paper executable ${command} is unavailable or unsafe.`);
  if (args.some((argument) => argument.includes("\0") || Buffer.byteLength(argument) > 64 * 1024)) {
    throw new PaperToolchainError("paper_command_invalid", "Paper command arguments are invalid.");
  }
  const canonicalCwd = await canonicalDirectory(cwd, "Paper command working directory");

  const child = spawn(executable, [...args], {
    cwd: canonicalCwd,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.environment ? { env: options.environment } : {}),
  });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow: "stdout" | "stderr" | undefined;
  let timedOut = false;
  let aborted = false;

  const stop = () => terminateProcessTree(child);
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > options.maximumStdoutBytes) {
      overflow ??= "stdout";
      stop();
    } else stdout.push(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > options.maximumStderrBytes) {
      overflow ??= "stderr";
      stop();
    } else stderr.push(chunk);
  });
  const abort = () => {
    aborted = true;
    stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  // AbortSignal does not replay an abort to a listener registered after it.
  // Re-check after registration to close the initial-check/spawn race.
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  timeout.unref();
  try {
    const completed = await completion;
    if (aborted || options.signal?.aborted) throw new PaperToolchainError("paper_command_cancelled", "Paper command was cancelled.", true);
    if (timedOut) throw new PaperToolchainError("paper_command_timeout", `Paper command exceeded its ${options.timeoutMs} ms timeout.`, true);
    if (overflow) throw new PaperToolchainError("paper_command_output_limit", `Paper command ${overflow} exceeded its byte limit.`);
    return {
      ...completed,
      stdout: new Uint8Array(Buffer.concat(stdout, stdoutBytes)),
      stderr: new Uint8Array(Buffer.concat(stderr, stderrBytes)),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function probeTool(
  name: PaperToolName,
  path: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  requiredOcrLanguages: readonly string[],
): Promise<{ probe?: ToolProbe; failure?: string }> {
  const invoke = async (args: readonly string[]) => runPaperCommand(path, args, cwd, {
    timeoutMs: PROBE_TIMEOUT_MS,
    maximumStdoutBytes: MAX_PROBE_OUTPUT_BYTES,
    maximumStderrBytes: MAX_PROBE_OUTPUT_BYTES,
    environment,
  });
  try {
    const result = await invoke(name === "tesseract" ? ["--version"] : ["-v"]);
    if (result.code !== 0) return { failure: `${name} identity probe exited with status ${result.code ?? result.signal ?? "unknown"}.` };
    const output = decoded(result);
    const pattern = name === "tesseract"
      ? /^tesseract\s+([^\s]+)\s*$/im
      : new RegExp(`^${name} version\\s+([^\\s]+)\\s*$`, "im");
    const version = pattern.exec(output)?.[1];
    if (!version || version.length > 160) return { failure: `${name} failed its executable identity probe.` };
    if (name === "tesseract") {
      const languages = await invoke(["--list-langs"]);
      if (languages.code !== 0) return { failure: "Tesseract could not inspect its trained data." };
      const installed = new Set(decoded(languages).split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
      const missing = requiredOcrLanguages.filter((language) => !installed.has(language));
      if (missing.length) return { failure: missing.length === 1 && missing[0] === "eng"
        ? "Tesseract has no usable English (eng) trained data. Install eng or set SOMITE_OCR_LANGS to available trained data."
        : `Tesseract is missing configured OCR trained data: ${missing.join(", ")}. Install those languages or set SOMITE_OCR_LANGS to available trained data.` };
      return { probe: { version, identity: `tesseract@${version}+${requiredOcrLanguages.join("+")}` } };
    }
    return { probe: { version, identity: `${name}@${version}` } };
  } catch (error) {
    if (error instanceof PaperToolchainError) {
      if (error.code === "paper_command_timeout") return { failure: `${name} capability probe timed out.` };
      if (error.code === "paper_command_output_limit") return { failure: `${name} capability probe exceeded its output limit.` };
    }
    return { failure: `${name} capability probe failed.` };
  }
}

async function resolveUsableTool(
  name: PaperToolName,
  source: Exclude<PaperToolSource, "built_in">,
  directories: readonly string[],
  suffixes: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  requiredOcrLanguages: readonly string[],
): Promise<ToolResolution> {
  const failures: string[] = [];
  for (const directory of directories.slice(0, 128)) {
    if (!isAbsolute(directory)) continue;
    for (const suffix of suffixes) {
      const path = await canonicalExecutable(join(directory, `${name}${suffix}`));
      if (!path) continue;
      const result = await probeTool(name, path, cwd, environment, requiredOcrLanguages);
      if (result.probe) return { resolved: { path, source, ...result.probe }, failures };
      if (result.failure) failures.push(result.failure);
    }
  }
  return { failures };
}

async function canonicalContainedDirectory(root: string, path: string) {
  const canonicalRoot = await realpath(root);
  const canonical = await canonicalDirectory(path, "Managed paper tool installation");
  const fromRoot = relative(canonicalRoot, canonical);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new PaperToolchainError("paper_tool_receipt_invalid", "Managed paper tool installation escapes its private root.");
  }
  return canonical;
}

async function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireInstallLease(toolsRoot: string): Promise<InstallLease> {
  const directory = join(toolsRoot, ".paper-install.lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonce = randomUUID().replaceAll("-", "");
    const stage = `install-${nonce}`;
    try {
      await mkdir(directory, { mode: 0o700 });
      await atomicWrite(join(directory, "owner.json"), `${JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        nonce,
        stage,
        started_at_unix_ms: Date.now(),
      })}\n`);
      return { directory, nonce, stage };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }

    const metadata = await lstat(directory).catch(() => undefined);
    if (!metadata) continue;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new PaperToolchainError("paper_tool_install_lock_unsafe", "Managed paper tool installation lock is not a regular directory.");
    }
    let owner: Record<string, unknown> | undefined;
    try {
      owner = record(JSON.parse(new TextDecoder().decode(await regularFile(join(directory, "owner.json"), MAX_POINTER_BYTES, "paper tool installation owner"))));
    } catch {
      if (Date.now() - metadata.mtimeMs < 5_000) {
        throw new PaperToolchainError("paper_tool_install_busy", "Another Somite process is preparing the managed paper tools.", true);
      }
    }
    const pid = owner?.pid;
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && await processAlive(pid)) {
      throw new PaperToolchainError("paper_tool_install_busy", "Another Somite process is installing the managed paper tools.", true);
    }
    const stale = join(toolsRoot, `.paper-install.lock.stale-${randomUUID()}`);
    try {
      await rename(directory, stale);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const staleStage = owner?.stage;
    await rm(stale, { recursive: true, force: true });
    if (typeof staleStage === "string" && /^install-[a-f0-9]{32}$/.test(staleStage)) {
      const current = await regularFile(join(toolsRoot, "paper", "current.json"), MAX_POINTER_BYTES, "managed paper current pointer")
        .then(decodePointer, () => undefined);
      if (current?.generation !== staleStage) {
        await rm(join(toolsRoot, ".paper-installations", staleStage), { recursive: true, force: true });
      }
    }
  }
  throw new PaperToolchainError("paper_tool_install_busy", "Another Somite process is installing the managed paper tools.", true);
}

async function releaseInstallLease(lease: InstallLease) {
  try {
    const owner = record(JSON.parse(new TextDecoder().decode(await regularFile(join(lease.directory, "owner.json"), MAX_POINTER_BYTES, "paper tool installation owner"))));
    if (owner?.nonce !== lease.nonce) return;
    await rm(lease.directory, { recursive: true, force: true });
  } catch {
    // A missing or replaced lease must never be deleted by this installer.
  }
}

/** Optional project-local OCR capability. Detection is cheap; install is explicit. */
export class PaperToolchain {
  readonly #root: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #operatingSystem: NodeJS.Platform;
  readonly #architecture: string;
  readonly #pixiPath?: string;
  readonly #ocrLanguages: readonly string[];
  #installation?: Promise<ManagedPaperToolchainInstall>;

  constructor(root: string, options: PaperToolchainOptions = {}) {
    this.#root = root;
    this.#environment = options.environment ?? process.env;
    this.#operatingSystem = options.operatingSystem ?? process.platform;
    this.#architecture = options.architecture ?? process.arch;
    this.#pixiPath = options.pixiPath;
    this.#ocrLanguages = ocrLanguageCodes(options.ocrLanguages ?? DEFAULT_PAPER_INTAKE_CONFIG.ocrLanguages);
  }

  async preflight(): Promise<PaperToolchainPreflight> {
    const root = await canonicalDirectory(this.#root, "Somite project directory");
    const suffixes = executableSuffixes(this.#operatingSystem, this.#environment);
    const expectedManifest = manifest(pixiPlatform(this.#operatingSystem, this.#architecture));
    const published = await this.#publishedInstallation(root, expectedManifest);
    const pdfjsVersion = await installedPdfJsVersion();
    const legacyManaged = environmentBins(join(root, ".somite", "tools", "paper", ".pixi", "envs", "default"), this.#operatingSystem);
    const project = environmentBins(join(root, ".pixi", "envs", "default"), this.#operatingSystem);
    const system = (this.#environment.PATH ?? "").split(delimiter).filter((path) => isAbsolute(path)).slice(0, 128);
    const native: PaperToolReadiness = {
      name: "PDF.js",
      available: true,
      source: "built_in",
      ...(pdfjsVersion ? { version: pdfjsVersion, identity: `pdfjs@${pdfjsVersion}` } : { identity: "pdfjs" }),
      detail: `Native PDF text is available in Somite's isolated PDF.js${pdfjsVersion ? ` ${pdfjsVersion}` : ""} extractor.`,
    };
    const probeEnvironment = minimalEnvironment(this.#environment, true);
    const managedEnvironment = minimalEnvironment(this.#environment, false);
    const detected = await Promise.all(toolNames.map(async (name): Promise<PaperToolReadiness> => {
      const failures: string[] = [];
      let resolved = published?.tools[name];
      if (!resolved) {
        const legacy = await resolveUsableTool(name, "managed_pixi", legacyManaged, suffixes, root, managedEnvironment, this.#ocrLanguages);
        resolved = legacy.resolved;
        failures.push(...legacy.failures);
      }
      if (!resolved) {
        const local = await resolveUsableTool(name, "project_pixi", project, suffixes, root, probeEnvironment, this.#ocrLanguages);
        resolved = local.resolved;
        failures.push(...local.failures);
      }
      if (!resolved) {
        const path = await resolveUsableTool(name, "system_path", system, suffixes, root, probeEnvironment, this.#ocrLanguages);
        resolved = path.resolved;
        failures.push(...path.failures);
      }
      if (resolved) {
        return {
          name,
          available: true,
          source: resolved.source,
          path: resolved.path,
          package: requirements[name].package,
          version: resolved.version,
          identity: resolved.identity,
          detail: `${requirements[name].purpose} is available from ${resolved.source} as ${resolved.identity}.`,
        };
      }
      return {
        name,
        available: false,
        package: requirements[name].package,
        detail: `${failures.slice(0, 2).join(" ")}${failures.length ? " " : ""}${requirements[name].purpose} needs a verified ${name} from conda-forge::${requirements[name].package}; install Somite's managed paper tools, add it to the project Pixi environment, or provide it on PATH.`,
      };
    }));
    const missing = toolNames.filter((_, index) => !detected[index]!.available);
    return { native_pdf_text: true, scanned_pdf_ocr: missing.length === 0, tools: [native, ...detected], missing };
  }

  async resolveOcr(): Promise<{ preflight: PaperToolchainPreflight; tools?: ResolvedPaperOcrToolchain }> {
    const preflight = await this.preflight();
    if (!preflight.scanned_pdf_ocr) return { preflight };
    const found = Object.fromEntries(preflight.tools
      .filter((tool): tool is PaperToolReadiness & { name: PaperToolName; path: string; source: Exclude<PaperToolSource, "built_in">; identity: string } => tool.name !== "PDF.js" && tool.available && Boolean(tool.path && tool.source && tool.source !== "built_in" && tool.identity))
      .map((tool) => [tool.name, {
        path: tool.path,
        source: tool.source,
        identity: tool.identity,
        environment: minimalEnvironment(this.#environment, tool.source !== "managed_pixi"),
      }])) as Record<PaperToolName, { path: string; source: Exclude<PaperToolSource, "built_in">; identity: string; environment: NodeJS.ProcessEnv }>;
    return { preflight, tools: found };
  }

  async installManaged(options: { signal?: AbortSignal; timeoutMs?: number; pixiPath?: string } = {}) {
    if (!this.#installation) {
      this.#installation = this.#installManaged(options).finally(() => { this.#installation = undefined; });
    }
    return this.#installation;
  }

  async #installManaged(options: { signal?: AbortSignal; timeoutMs?: number; pixiPath?: string }): Promise<ManagedPaperToolchainInstall> {
    const root = await canonicalDirectory(this.#root, "Somite project directory");
    const toolsRoot = await ensurePrivateDirectory(root, ".somite/tools");
    await chmod(toolsRoot, 0o700);
    const lease = await acquireInstallLease(toolsRoot);
    const expectedManifest = manifest(pixiPlatform(this.#operatingSystem, this.#architecture));
    let installationPath: string | undefined;
    let publishedPointer: { path: string; previous?: Uint8Array } | undefined;
    try {
      const published = await this.#publishedInstallation(root, expectedManifest);
      if (published) return await this.#installedResult(published, true);

      const requestedPixi = options.pixiPath ?? this.#pixiPath;
      const pixi = requestedPixi
        ? await canonicalExecutable(resolve(requestedPixi))
        : await this.#resolvePixi(root);
      if (!pixi) throw new PaperToolchainError("paper_pixi_unavailable", "Pixi is required to install Somite's managed paper OCR tools. Install Pixi or provide its executable path.", true);

      const priorLock = await this.#priorLock(root, expectedManifest);
      const reusedLock = Boolean(priorLock);
      const installations = await ensurePrivateDirectory(root, ".somite/tools/.paper-installations");
      installationPath = join(installations, lease.stage);
      await mkdir(installationPath, { mode: 0o700 });
      const manifestPath = join(installationPath, "pixi.toml");
      const lockPath = join(installationPath, "pixi.lock");
      await atomicWrite(manifestPath, expectedManifest);
      if (priorLock) await atomicWrite(lockPath, priorLock);

      const result = await runPaperCommand(pixi, [
        "install",
        "--manifest-path", manifestPath,
        ...(reusedLock ? ["--frozen"] : []),
        "--no-progress",
        "--color", "never",
      ], installationPath, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
        maximumStdoutBytes: MAX_INSTALL_OUTPUT_BYTES,
        maximumStderrBytes: MAX_INSTALL_OUTPUT_BYTES,
        environment: minimalEnvironment(this.#environment, false),
      });
      if (result.code !== 0) {
        const detail = safeDiagnostic(result);
        throw new PaperToolchainError("paper_tool_install_failed", `Pixi could not install the managed paper tools${detail ? `: ${detail}` : "."}`, true);
      }
      const installedManifest = await regularFile(manifestPath, MAX_MANIFEST_BYTES, "managed paper Pixi manifest");
      if (!Buffer.from(installedManifest).equals(Buffer.from(expectedManifest))) {
        throw new PaperToolchainError("paper_tool_manifest_changed", "Pixi changed the managed paper manifest unexpectedly.");
      }
      const installedLock = await regularFile(lockPath, MAX_LOCK_BYTES, "managed paper Pixi lock");
      if (priorLock && !Buffer.from(priorLock).equals(Buffer.from(installedLock))) {
        throw new PaperToolchainError("paper_tool_lock_changed", "Frozen managed paper installation changed its lock unexpectedly.");
      }
      const tools = await this.#probeInstallation(installationPath);
      if (!tools) throw new PaperToolchainError("paper_tool_install_incomplete", "Pixi completed but the staged OCR tools failed their bounded capability checks.", true);
      const receipt = buildReceipt(pixiPlatform(this.#operatingSystem, this.#architecture), installedManifest, installedLock, tools);
      const receiptPath = join(installationPath, "receipt.json");
      await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      await Promise.all([chmod(manifestPath, 0o600), chmod(lockPath, 0o600), chmod(receiptPath, 0o600)]);

      const paperRoot = await ensurePrivateDirectory(root, ".somite/tools/paper");
      const pointer: CurrentPointer = { schema_version: CURRENT_SCHEMA_VERSION, generation: lease.stage, receipt_id: receipt.receipt_id };
      const pointerPath = join(paperRoot, "current.json");
      const previous = await regularFile(pointerPath, MAX_POINTER_BYTES, "managed paper current pointer").catch(() => undefined);
      await atomicWrite(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
      publishedPointer = { path: pointerPath, ...(previous ? { previous } : {}) };
      const verified = await this.#publishedInstallation(root, expectedManifest);
      if (!verified || verified.receipt.receipt_id !== receipt.receipt_id) {
        throw new PaperToolchainError("paper_tool_publication_failed", "The managed paper tools failed verification after publication.", true);
      }
      installationPath = undefined;
      return await this.#installedResult(verified, reusedLock);
    } catch (error) {
      if (publishedPointer) {
        if (publishedPointer.previous) await atomicWrite(publishedPointer.path, publishedPointer.previous).catch(() => undefined);
        else await rm(publishedPointer.path, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (installationPath) await rm(installationPath, { recursive: true, force: true }).catch(() => undefined);
      await releaseInstallLease(lease);
    }
  }

  async #installedResult(published: PublishedInstallation, reusedLock: boolean): Promise<ManagedPaperToolchainInstall> {
    const preflight = await this.preflight();
    if (!preflight.scanned_pdf_ocr || preflight.tools.some((tool) => tool.name !== "PDF.js" && tool.source !== "managed_pixi")) {
      throw new PaperToolchainError("paper_tool_install_incomplete", "The published managed OCR tools are no longer available.", true);
    }
    return {
      manifest_path: published.manifestPath,
      lock_path: published.lockPath,
      receipt_path: published.receiptPath,
      receipt_id: published.receipt.receipt_id,
      reused_lock: reusedLock,
      preflight,
    };
  }

  async #probeInstallation(directory: string): Promise<Readonly<Record<PaperToolName, ResolvedTool>> | undefined> {
    const suffixes = executableSuffixes(this.#operatingSystem, this.#environment);
    const bins = environmentBins(join(directory, ".pixi", "envs", "default"), this.#operatingSystem);
    const environment = minimalEnvironment(this.#environment, false);
    const results = await Promise.all(toolNames.map((name) => resolveUsableTool(name, "managed_pixi", bins, suffixes, directory, environment, this.#ocrLanguages)));
    if (results.some((result) => !result.resolved)) return undefined;
    return Object.fromEntries(toolNames.map((name, index) => [name, results[index]!.resolved!])) as Record<PaperToolName, ResolvedTool>;
  }

  async #publishedInstallation(root: string, expectedManifest: string): Promise<PublishedInstallation | undefined> {
    try {
      const toolsRoot = join(root, ".somite", "tools");
      const paperRoot = join(toolsRoot, "paper");
      const pointerPath = join(paperRoot, "current.json");
      if (!await pathExists(pointerPath)) return undefined;
      const pointer = decodePointer(await regularFile(pointerPath, MAX_POINTER_BYTES, "managed paper current pointer"));
      if (!pointer) return undefined;
      const installations = join(toolsRoot, ".paper-installations");
      const directory = await canonicalContainedDirectory(installations, join(installations, pointer.generation));
      const manifestPath = join(directory, "pixi.toml");
      const lockPath = join(directory, "pixi.lock");
      const receiptPath = join(directory, "receipt.json");
      const manifestBytes = await regularFile(manifestPath, MAX_MANIFEST_BYTES, "managed paper Pixi manifest");
      if (!Buffer.from(manifestBytes).equals(Buffer.from(expectedManifest))) return undefined;
      const lockBytes = await regularFile(lockPath, MAX_LOCK_BYTES, "managed paper Pixi lock");
      const receipt = decodeReceipt(await regularFile(receiptPath, MAX_RECEIPT_BYTES, "managed paper tool receipt"));
      if (!receipt || receipt.receipt_id !== pointer.receipt_id
        || receipt.platform !== pixiPlatform(this.#operatingSystem, this.#architecture)
        || receipt.manifest_sha256 !== sha256(manifestBytes)
        || receipt.lock_sha256 !== sha256(lockBytes)) return undefined;
      const tools = await this.#probeInstallation(directory);
      if (!tools || toolNames.some((name) => tools[name].version !== receipt.tools[name].version || tools[name].identity !== receipt.tools[name].identity)) return undefined;
      return { directory, manifestPath, lockPath, receiptPath, receipt, tools };
    } catch {
      return undefined;
    }
  }

  async #priorLock(root: string, expectedManifest: string) {
    const paperRoot = join(root, ".somite", "tools", "paper");
    const candidates: { manifest: string; lock: string }[] = [];
    const pointer = await regularFile(join(paperRoot, "current.json"), MAX_POINTER_BYTES, "managed paper current pointer")
      .then(decodePointer, () => undefined);
    if (pointer) {
      const installation = join(root, ".somite", "tools", ".paper-installations", pointer.generation);
      candidates.push({ manifest: join(installation, "pixi.toml"), lock: join(installation, "pixi.lock") });
    }
    candidates.push({ manifest: join(paperRoot, "pixi.toml"), lock: join(paperRoot, "pixi.lock") });
    for (const candidate of candidates) {
      try {
        const currentManifest = await regularFile(candidate.manifest, MAX_MANIFEST_BYTES, "managed paper Pixi manifest");
        if (!Buffer.from(currentManifest).equals(Buffer.from(expectedManifest))) continue;
        return await regularFile(candidate.lock, MAX_LOCK_BYTES, "managed paper Pixi lock");
      } catch {
        // Invalid or absent prior state is never reused as a frozen lock.
      }
    }
    return undefined;
  }

  async #resolvePixi(root: string) {
    const suffixes = executableSuffixes(this.#operatingSystem, this.#environment);
    const project = environmentBins(join(root, ".pixi", "envs", "default"), this.#operatingSystem);
    const system = (this.#environment.PATH ?? "").split(delimiter).filter((path) => isAbsolute(path));
    return await resolveInDirectories("pixi", project, suffixes) ?? await resolveInDirectories("pixi", system, suffixes);
  }
}
