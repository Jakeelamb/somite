import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, realpath, rename, rm, statfs } from "node:fs/promises";
import { homedir, platform as operatingSystem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import { managedResourceReferenceId, type ManagedResourceAvailability, type WorkflowAssessmentContext } from "@somite/workflow/assessment";

import { atomicWrite, ensurePrivateDirectory, pathExists, regularDirectory, regularFile } from "./files.ts";
import { commandFailure, runCaptured } from "./process.ts";
import { executablePath } from "./system.ts";

const MINIMUM_FREE_MARGIN = 1024 ** 3;
const MAX_REDIRECTS = 3;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export type ManagedResourceProvider = Readonly<{
  id: string;
  profile: string;
  resolution: string;
  version: string;
  title: string;
  source_url: string;
  source_page: string;
  archive_md5: string;
  download_bytes: number;
  stored_bytes: number;
  scientific_effect: string;
  files: Readonly<Record<string, string>>;
}>;

export type ManagedResourceStatus = Readonly<{
  job_id: string;
  provider_id: string;
  profile: string;
  resolution: string;
  phase: "queued" | "downloading" | "verifying" | "extracting" | "completed" | "failed" | "cancelling" | "cancelled";
  progress: Readonly<{ completed: number; total: number; unit: "bytes"; message: string }>;
  path?: string;
  receipt_digest?: string;
  error?: string;
}>;

export const KRAKEN_STANDARD_8: ManagedResourceProvider = Object.freeze({
  id: "kraken2-standard-8-20260626",
  profile: "kraken2-database",
  resolution: "standard-8",
  version: "2026-06-26",
  title: "Kraken2 Standard-8",
  source_url: "https://genome-idx.s3.amazonaws.com/kraken/k2_standard_08_GB_20260626.tar.gz",
  source_page: "https://benlangmead.github.io/aws-indexes/k2",
  archive_md5: "7685f43cce057c2ca18511c925399b72",
  download_bytes: 5_500_000_000,
  stored_bytes: 7_500_000_000,
  scientific_effect: "Standard reference collection capped at 8 GB; lower memory use and reference sensitivity than the uncapped Standard database.",
  files: {
    "hash.k2d": "fb429676d739aaa4d27ac6955af2e4cc",
    "opts.k2d": "eebfd340c759d54c82c7769b40f7a50b",
    "taxo.k2d": "f5697f04a6e072bde8504ebc6c142a22",
  },
});

export function managedResourceReference(providerId: string) {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(providerId)) throw new Error("managed resource provider id is invalid");
  return `somite-resource:${providerId}`;
}

type MutableJob = {
  status: ManagedResourceStatus;
  controller: AbortController;
  settled: Promise<void>;
};

export function managedResourceCacheRoot(environment: NodeJS.ProcessEnv = process.env, system = operatingSystem(), home = homedir()) {
  const override = environment.SOMITE_RESOURCE_CACHE_DIR;
  if (override !== undefined) {
    if (!override || !isAbsolute(override)) throw new Error("SOMITE_RESOURCE_CACHE_DIR must be an absolute path");
    return resolve(override);
  }
  if (system === "darwin") return join(home, "Library", "Caches", "Somite", "resources");
  const xdg = environment.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".cache"), "somite", "resources");
}

async function privateRoot(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(path) !== resolve(path)) throw new Error(`managed resource cache ${path} must be a regular directory without symbolic links`);
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) throw new Error(`managed resource cache ${path} is not owned by this user`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
  }
  return path;
}

async function md5(path: string) {
  const digest = createHash("md5");
  await pipeline(createReadStream(path), digest);
  return digest.digest("hex");
}

async function download(url: string, destination: string, provider: ManagedResourceProvider, signal: AbortSignal, progress: (bytes: number) => void, fetcher: typeof fetch, redirects = 0): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("managed resource downloads require credential-free HTTPS URLs");
  const response = await fetcher(parsed, { signal, redirect: "manual", headers: { "User-Agent": "Somite managed resource installer" } });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= MAX_REDIRECTS) throw new Error("managed resource download exceeded the redirect limit");
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("managed resource download redirect omitted its destination");
    return download(new URL(location, parsed).toString(), destination, provider, signal, progress, fetcher, redirects + 1);
  }
  if (!response.ok || !response.body) throw new Error(`managed resource download failed with HTTP ${response.status}`);
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > provider.download_bytes * 1.1) throw new Error("managed resource archive is larger than the reviewed provider declaration");
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > provider.download_bytes * 1.1) return callback(new Error("managed resource archive exceeded its reviewed size bound"));
      progress(received);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
}

export class ManagedResourceManager {
  readonly #projectRoot: string;
  readonly #cacheRoot: string;
  readonly #providers: readonly ManagedResourceProvider[];
  readonly #fetch: typeof fetch;
  readonly #jobs = new Map<string, MutableJob>();
  readonly #active = new Map<string, string>();
  readonly #replays = new Map<string, { request: string; jobId: string }>();

  constructor(projectRoot: string, options: { cacheRoot?: string; providers?: readonly ManagedResourceProvider[]; fetcher?: typeof fetch } = {}) {
    this.#projectRoot = projectRoot;
    this.#cacheRoot = options.cacheRoot ?? managedResourceCacheRoot();
    this.#providers = options.providers ?? [KRAKEN_STANDARD_8];
    this.#fetch = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  providers() {
    return this.#providers;
  }

  async assessmentContext(): Promise<WorkflowAssessmentContext> {
    const managedResources = await Promise.all(this.#providers.map(async (provider): Promise<ManagedResourceAvailability> => {
      const reference = managedResourceReference(provider.id);
      const destination = this.#destination(provider);
      try {
        return {
          reference,
          provider_id: provider.id,
          profile: provider.profile,
          resolution: provider.resolution,
          title: provider.title,
          available: await this.#installed(destination, provider),
          detail: `Download the reviewed ${provider.title} archive and verify its archive and database-file checksums.`,
          download_bytes: provider.download_bytes,
          stored_bytes: provider.stored_bytes,
          scientific_effect: provider.scientific_effect,
          source_url: provider.source_page,
        };
      } catch (error) {
        return {
          reference,
          provider_id: provider.id,
          profile: provider.profile,
          resolution: provider.resolution,
          title: provider.title,
          available: false,
          detail: `Download the reviewed ${provider.title} archive and verify its archive and database-file checksums.`,
          download_bytes: provider.download_bytes,
          stored_bytes: provider.stored_bytes,
          scientific_effect: provider.scientific_effect,
          source_url: provider.source_page,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    return { managed_resources: managedResources };
  }

  async resolve(reference: string) {
    const providerId = managedResourceReferenceId(reference);
    const provider = providerId ? this.#providers.find((candidate) => candidate.id === providerId) : undefined;
    if (!provider) throw new Error(`managed resource reference ${reference} has no reviewed provider on this machine`);
    const destination = this.#destination(provider);
    if (!await this.#installed(destination, provider)) {
      throw new Error(`${provider.title} is not installed and verified on this machine; download it from workflow readiness`);
    }
    return destination;
  }

  async start(profile: string, resolution: string, idempotencyKey: string) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error("invalid managed resource idempotency key");
    const provider = this.#providers.find((item) => item.profile === profile && item.resolution === resolution);
    if (!provider) throw new Error(`no reviewed managed resource provider supports ${profile}/${resolution}`);
    const request = canonicalJsonDigest({ profile, resolution, provider: provider.id });
    const replay = this.#replays.get(idempotencyKey);
    if (replay) {
      if (replay.request !== request) throw new Error("managed resource idempotency key was already used for another request");
      return { ...this.#jobs.get(replay.jobId)!.status, replayed: true };
    }
    const activeId = this.#active.get(provider.id);
    if (activeId) {
      const active = this.#jobs.get(activeId)!;
      this.#replays.set(idempotencyKey, { request, jobId: activeId });
      return { ...active.status, replayed: true };
    }
    const jobId = `resource-${randomUUID()}`;
    const controller = new AbortController();
    const initial: ManagedResourceStatus = { job_id: jobId, provider_id: provider.id, profile: provider.profile, resolution: provider.resolution, phase: "queued", progress: { completed: 0, total: provider.download_bytes, unit: "bytes", message: "Checking local storage" } };
    const job: MutableJob = { status: initial, controller, settled: Promise.resolve() };
    this.#jobs.set(jobId, job);
    this.#active.set(provider.id, jobId);
    this.#replays.set(idempotencyKey, { request, jobId });
    job.settled = this.#install(job, provider).finally(() => this.#active.delete(provider.id));
    return { ...initial, replayed: false };
  }

  async status(jobId: string, waitMs = 0) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`managed resource job ${jobId} was not found`);
    if (waitMs > 0 && !TERMINAL.has(job.status.phase)) await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, Math.min(waitMs, 30_000));
      void job.settled.finally(() => { clearTimeout(timer); resolvePromise(); });
    });
    return job.status;
  }

  async cancel(jobId: string) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`managed resource job ${jobId} was not found`);
    if (!TERMINAL.has(job.status.phase)) {
      job.status = { ...job.status, phase: "cancelling", progress: { ...job.status.progress, message: "Stopping resource installation" } };
      job.controller.abort();
    }
    return job.status;
  }

  async shutdown() {
    for (const job of this.#jobs.values()) if (!TERMINAL.has(job.status.phase)) job.controller.abort();
    await Promise.allSettled([...this.#jobs.values()].map((job) => job.settled));
  }

  async #install(job: MutableJob, provider: ManagedResourceProvider) {
    let staging: string | undefined;
    try {
      const root = await privateRoot(this.#cacheRoot);
      const parent = await ensurePrivateDirectory(root, `${provider.profile}/${provider.resolution}`);
      const destination = this.#destination(provider);
      if (await this.#installed(destination, provider)) {
        job.status = { ...job.status, phase: "completed", path: destination, receipt_digest: canonicalJsonDigest(provider), progress: { completed: provider.download_bytes, total: provider.download_bytes, unit: "bytes", message: "Already installed and verified" } };
        return;
      }
      const disk = await statfs(parent);
      const free = disk.bavail * disk.bsize;
      const needed = provider.download_bytes + provider.stored_bytes + MINIMUM_FREE_MARGIN;
      if (free < needed) throw new Error(`Not enough free storage: ${Math.ceil(needed / 1e9)} GB is required while downloading and unpacking ${provider.title}, but ${Math.floor(free / 1e9)} GB is available`);
      staging = join(parent, `.${provider.version}.${randomUUID()}.partial`);
      await mkdir(staging, { mode: 0o700 });
      const archive = join(staging, "resource.tar.gz");
      job.status = { ...job.status, phase: "downloading", progress: { completed: 0, total: provider.download_bytes, unit: "bytes", message: `Downloading ${provider.title}` } };
      await download(provider.source_url, archive, provider, job.controller.signal, (completed) => {
        job.status = { ...job.status, progress: { ...job.status.progress, completed } };
      }, this.#fetch);
      job.status = { ...job.status, phase: "verifying", progress: { ...job.status.progress, message: "Verifying the pinned archive checksum" } };
      if (await md5(archive) !== provider.archive_md5) throw new Error("managed resource archive checksum did not match the reviewed provider");
      const tar = await executablePath(this.#projectRoot, "tar");
      if (!tar) throw new Error("A tar extractor is required to install this managed resource");
      job.status = { ...job.status, phase: "extracting", progress: { ...job.status.progress, message: "Extracting the reviewed Kraken2 database files" } };
      const extracted = await runCaptured(tar, ["-xzf", archive, "-C", staging, "--", ...Object.keys(provider.files)], staging, job.controller.signal);
      if (extracted.code !== 0) throw new Error(`managed resource extraction failed: ${commandFailure("tar", extracted)}`);
      await rm(archive, { force: true });
      const installedFiles: Record<string, { md5: string; size: number }> = {};
      for (const [name, expected] of Object.entries(provider.files)) {
        const path = join(staging, name);
        await regularDirectory(staging, "managed resource staging directory");
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`managed resource ${name} is not a regular file`);
        if (await md5(path) !== expected) throw new Error(`managed resource ${name} checksum did not match the provider manifest`);
        installedFiles[name] = { md5: expected, size: metadata.size };
      }
      const receipt = canonicalJsonDigest({ provider, files: provider.files });
      await atomicWrite(join(staging, "resource.json"), `${JSON.stringify({ schema_version: 1, provider, files: installedFiles, receipt_digest: receipt }, null, 2)}\n`);
      try {
        await rename(staging, destination);
        staging = undefined;
      } catch (error) {
        if (!await this.#installed(destination, provider)) throw error;
      }
      job.status = { ...job.status, phase: "completed", path: destination, receipt_digest: receipt, progress: { completed: provider.download_bytes, total: provider.download_bytes, unit: "bytes", message: `${provider.title} is ready` } };
    } catch (error) {
      const cancelled = job.controller.signal.aborted;
      job.status = { ...job.status, phase: cancelled ? "cancelled" : "failed", error: cancelled ? "Installation cancelled" : error instanceof Error ? error.message : String(error), progress: { ...job.status.progress, message: cancelled ? "Installation cancelled" : "Installation failed" } };
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  #destination(provider: ManagedResourceProvider) {
    return join(this.#cacheRoot, provider.profile, provider.resolution, provider.version);
  }

  async #installed(destination: string, provider: ManagedResourceProvider) {
    if (!await pathExists(destination)) return false;
    await regularDirectory(destination, "managed resource cache entry");
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(join(destination, "resource.json"), 64 * 1024, "managed resource receipt"))) as Record<string, unknown>;
    if (manifest.schema_version !== 1 || manifest.receipt_digest !== canonicalJsonDigest({ provider, files: provider.files })) {
      throw new Error(`cached ${provider.title} does not match its reviewed provider receipt`);
    }
    const files = manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files) ? manifest.files as Record<string, unknown> : {};
    for (const name of Object.keys(provider.files)) {
      const metadata = await lstat(join(destination, name));
      const recorded = files[name] && typeof files[name] === "object" && !Array.isArray(files[name]) ? files[name] as Record<string, unknown> : {};
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0 || recorded.md5 !== provider.files[name] || recorded.size !== metadata.size) throw new Error(`cached managed resource ${name} is invalid`);
    }
    return true;
  }
}
