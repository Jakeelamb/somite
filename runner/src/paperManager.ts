import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import type { OperatorCatalog } from "@somite/workflow/catalog";
import { byteDigest, canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import { reconstructPaper, type PaperReview } from "@somite/workflow/paper";
import { atomicWrite, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";
import {
  extractPaper,
  extractPaperPath,
  paperExtractorIdentity,
  PaperExtractionError,
  type PaperExtraction,
  type PaperExtractionProgress,
  type PaperMediaKind,
} from "./paperExtractor.ts";
import { DEFAULT_PAPER_INTAKE_CONFIG, type PaperIntakeConfig } from "./paperConfig.ts";
import { PaperStore } from "./paperStore.ts";
import { PaperToolchain } from "./paperToolchain.ts";

export type PaperIntakePhase = "queued" | "extracting" | "locating_methods" | "recognizing_methods" | "assessing_drafts" | "completed" | "failed" | "cancelling" | "cancelled";

export type PaperIntakeFailure = Readonly<{ code: string; message: string; retryable: boolean }>;
export type PaperIntakeStatus = Readonly<{
  job_id: string;
  source_digest: string;
  phase: PaperIntakePhase;
  progress?: PaperExtractionProgress;
  durations_ms: Record<string, number>;
  cache: { extraction: boolean; reconstruction: boolean };
  result?: PaperReview;
  failure?: PaperIntakeFailure;
}>;

type MutableStatus = {
  job_id: string;
  source_digest: string;
  phase: PaperIntakePhase;
  progress?: PaperExtractionProgress;
  durations_ms: Record<string, number>;
  cache: { extraction: boolean; reconstruction: boolean };
  result?: PaperReview;
  failure?: PaperIntakeFailure;
};

type PaperJob = {
  status: MutableStatus;
  artifact: Awaited<ReturnType<PaperStore["resolveDigestPath"]>>;
  controller: AbortController;
  createdAt: number;
  revision: number;
  waiters: Set<() => void>;
};

type ExtractionCache = Readonly<{
  schema_version: 3;
  source_digest: string;
  extractor_revision: string;
  configuration_digest: string;
  extracted_via: "text" | "pdfjs" | "ocr";
  extractor_identity: string;
  text_digest: string;
  text: string;
  pages?: number;
}>;

const EXTRACTOR_REVISION = "pdfjs-ocr-v4";
const LEGACY_EXTRACTOR_REVISIONS = ["pdfjs-ocr-v2", "pdfjs-ocr-v3"] as const;
const RECONSTRUCTOR_REVISION = "typed-paper-v1";
const MAX_JOBS = 8;
const MAX_EXTRACTION_CACHE_BYTES = 72 * 1024 * 1024;
const MAX_RECONSTRUCTION_CACHE_ENTRIES = 16;
const MAX_RECONSTRUCTION_CACHE_BYTES = 16 * 1024 * 1024;
const terminal = new Set<PaperIntakePhase>(["completed", "failed", "cancelled"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function now() {
  return performance.now();
}

function elapsed(started: number) {
  return Math.max(0, Math.round(now() - started));
}

function validIdempotencyKey(value: string) {
  return value.length >= 1 && value.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function extractionCache(value: unknown, digest: string, configurationDigest: string): ExtractionCache | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== 3 || raw.source_digest !== digest || raw.extractor_revision !== EXTRACTOR_REVISION || raw.configuration_digest !== configurationDigest
    || (raw.extracted_via !== "text" && raw.extracted_via !== "pdfjs" && raw.extracted_via !== "ocr")
    || typeof raw.extractor_identity !== "string" || !/^blake3:[0-9a-f]{64}$/.test(raw.extractor_identity)
    || typeof raw.text_digest !== "string" || typeof raw.text !== "string") return undefined;
  if (byteDigest(encoder.encode(raw.text)) !== raw.text_digest) return undefined;
  if (raw.pages !== undefined && (!Number.isSafeInteger(raw.pages) || (raw.pages as number) < 1)) return undefined;
  return raw as ExtractionCache;
}

function phaseProgress(phase: PaperIntakePhase): PaperExtractionProgress | undefined {
  return ({
    queued: { completed: 0, message: "Waiting to read the paper" },
    extracting: { completed: 0, message: "Opening the paper" },
    locating_methods: { completed: 0, message: "Locating computational methods across the paper" },
    recognizing_methods: { completed: 0, message: "Matching methods to reviewed Somite contracts" },
    assessing_drafts: { completed: 0, message: "Checking typed workflow drafts and missing requirements" },
    cancelling: { completed: 0, message: "Stopping paper intake" },
  } as Partial<Record<PaperIntakePhase, PaperExtractionProgress>>)[phase];
}

export class PaperManager {
  readonly store: PaperStore;
  readonly paperTools: PaperToolchain;
  readonly configuration: PaperIntakeConfig;
  readonly #root: string;
  readonly #catalog: OperatorCatalog;
  readonly #catalogRevision: string;
  readonly #jobs = new Map<string, PaperJob>();
  readonly #replays = new Map<string, { digest: string; jobId: string }>();
  readonly #reconstructionCache = new Map<string, { review: PaperReview; bytes: number }>();
  readonly #pending: PaperJob[] = [];
  readonly #executions = new Set<Promise<void>>();
  readonly #extractionConfigurationDigest: string;
  #active = 0;
  #reconstructionCacheBytes = 0;

  constructor(root: string, catalog: OperatorCatalog, catalogRevision: string, configuration: PaperIntakeConfig = DEFAULT_PAPER_INTAKE_CONFIG) {
    this.#root = root;
    this.#catalog = catalog;
    this.#catalogRevision = catalogRevision;
    this.configuration = configuration;
    this.#extractionConfigurationDigest = canonicalJsonDigest({
      max_text_bytes: configuration.maxTextBytes,
      max_pdf_pages: configuration.maxPdfPages,
      max_ocr_pages: configuration.maxOcrPages,
      ocr_languages: configuration.ocrLanguages,
    });
    this.store = new PaperStore(root, configuration.maxUploadBytes);
    this.paperTools = new PaperToolchain(root, { ocrLanguages: configuration.ocrLanguages });
  }

  extract(bytes: Uint8Array, mediaKind: PaperMediaKind) {
    return extractPaper(bytes, mediaKind, this.#extractionOptions());
  }

  #extractionOptions() {
    return {
      maxSourceBytes: this.configuration.maxUploadBytes,
      maxTextBytes: this.configuration.maxTextBytes,
      maxPdfPages: this.configuration.maxPdfPages,
      ocr: {
        toolchain: this.paperTools,
        maxPages: this.configuration.maxOcrPages,
        maxTextBytes: this.configuration.maxTextBytes,
        languages: this.configuration.ocrLanguages,
      },
    } as const;
  }

  async start(digest: string, idempotencyKey?: string) {
    if (idempotencyKey && !validIdempotencyKey(idempotencyKey)) throw new Error("invalid paper idempotency key");
    if (idempotencyKey) {
      const replay = this.#replays.get(idempotencyKey);
      if (replay) {
        if (replay.digest !== digest) throw new Error("paper idempotency key was already used for another source");
        const job = this.#jobs.get(replay.jobId);
        if (job) return { job_id: job.status.job_id, source_digest: digest, phase: job.status.phase, replayed: true };
        this.#replays.delete(idempotencyKey);
      }
    }
    const artifact = await this.store.resolveDigestPath(digest);
    this.#prune();
    if (this.#jobs.size >= MAX_JOBS && ![...this.#jobs.values()].some((job) => terminal.has(job.status.phase))) throw new Error("paper intake capacity is busy");
    const jobId = `paper-${randomUUID()}`;
    const job: PaperJob = {
      status: {
        job_id: jobId,
        source_digest: digest,
        phase: "queued",
        progress: phaseProgress("queued"),
        durations_ms: {},
        cache: { extraction: false, reconstruction: false },
      },
      artifact,
      controller: new AbortController(),
      createdAt: now(),
      revision: 0,
      waiters: new Set(),
    };
    this.#jobs.set(jobId, job);
    if (idempotencyKey) this.#replays.set(idempotencyKey, { digest, jobId });
    this.#pending.push(job);
    queueMicrotask(() => this.#pump());
    return { job_id: jobId, source_digest: digest, phase: "queued" as const, replayed: false };
  }

  async status(jobId: string, waitMs = 0): Promise<PaperIntakeStatus> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`paper intake ${jobId} was not found`);
    const revision = job.revision;
    const bounded = Math.min(25_000, Math.max(0, waitMs));
    if (bounded && !terminal.has(job.status.phase)) {
      await new Promise<void>((resolvePromise) => {
        const done = () => {
          clearTimeout(timer);
          job.waiters.delete(done);
          resolvePromise();
        };
        const timer = setTimeout(done, bounded);
        job.waiters.add(done);
        if (job.revision !== revision) done();
      });
    }
    return structuredClone(job.status);
  }

  async cancel(jobId: string) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`paper intake ${jobId} was not found`);
    if (!terminal.has(job.status.phase)) {
      job.controller.abort();
      this.#update(job, "cancelling");
    }
    return structuredClone(job.status);
  }

  async shutdown() {
    for (const job of this.#pending.splice(0)) {
      job.controller.abort();
      if (!terminal.has(job.status.phase)) this.#finishCancelled(job);
    }
    for (const job of this.#jobs.values()) {
      if (!terminal.has(job.status.phase)) job.controller.abort();
    }
    await Promise.allSettled([...this.#executions]);
  }

  #prune() {
    while (this.#jobs.size >= MAX_JOBS) {
      const completed = [...this.#jobs.values()].find((job) => terminal.has(job.status.phase));
      if (!completed) break;
      this.#jobs.delete(completed.status.job_id);
      for (const [key, replay] of this.#replays) if (replay.jobId === completed.status.job_id) this.#replays.delete(key);
    }
  }

  #cachedReconstruction(key: string) {
    const entry = this.#reconstructionCache.get(key);
    if (!entry) return undefined;
    this.#reconstructionCache.delete(key);
    this.#reconstructionCache.set(key, entry);
    return entry.review;
  }

  #cacheReconstruction(key: string, review: PaperReview) {
    const bytes = Buffer.byteLength(JSON.stringify(review));
    if (bytes > MAX_RECONSTRUCTION_CACHE_BYTES) return;
    const replaced = this.#reconstructionCache.get(key);
    if (replaced) {
      this.#reconstructionCache.delete(key);
      this.#reconstructionCacheBytes -= replaced.bytes;
    }
    while (this.#reconstructionCache.size >= MAX_RECONSTRUCTION_CACHE_ENTRIES
      || this.#reconstructionCacheBytes + bytes > MAX_RECONSTRUCTION_CACHE_BYTES) {
      const oldest = this.#reconstructionCache.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.#reconstructionCache.get(oldest)!;
      this.#reconstructionCache.delete(oldest);
      this.#reconstructionCacheBytes -= removed.bytes;
    }
    this.#reconstructionCache.set(key, { review, bytes });
    this.#reconstructionCacheBytes += bytes;
  }

  #touch(job: PaperJob) {
    job.revision += 1;
    for (const waiter of [...job.waiters]) waiter();
  }

  #update(job: PaperJob, phase: PaperIntakePhase, progress = phaseProgress(phase)) {
    job.status.phase = phase;
    if (progress) job.status.progress = progress;
    else delete job.status.progress;
    this.#touch(job);
  }

  #pump() {
    while (this.#active < 2 && this.#pending.length) {
      const job = this.#pending.shift()!;
      this.#active += 1;
      const execution = this.#execute(job).finally(() => {
        this.#active -= 1;
        this.#pump();
      });
      this.#executions.add(execution);
      void execution.then(
        () => this.#executions.delete(execution),
        () => this.#executions.delete(execution),
      );
    }
  }

  async #loadExtraction(job: PaperJob): Promise<PaperExtraction> {
    const directory = await ensurePrivateDirectory(this.#root, ".somite/papers/cache/extracted");
    const cachePath = join(directory, `${job.status.source_digest.slice("blake3:".length)}-${EXTRACTOR_REVISION}.json`);
    if (await pathExists(cachePath)) {
      try {
        const bytes = await regularFile(cachePath, MAX_EXTRACTION_CACHE_BYTES, "paper extraction cache");
        const cached = extractionCache(JSON.parse(decoder.decode(bytes)), job.status.source_digest, this.#extractionConfigurationDigest);
        if (cached) {
          const preflight = cached.extracted_via === "text" ? undefined : await this.paperTools.preflight();
          const currentIdentity = paperExtractorIdentity(preflight, cached.extracted_via, this.configuration.ocrLanguages);
          if (!currentIdentity || currentIdentity === cached.extractor_identity) {
            job.status.cache.extraction = true;
            return {
              text: cached.text,
              extractedVia: cached.extracted_via,
              extractorIdentity: cached.extractor_identity,
              ...(cached.pages ? { pages: cached.pages } : {}),
            };
          }
        }
      } catch {
        // Generated cache corruption is recoverable; recompute from the verified source object.
      }
    }
    const extracted = await extractPaperPath({
      path: job.artifact.path,
      digest: job.status.source_digest,
      sizeBytes: job.artifact.metadata.size_bytes,
    }, job.artifact.metadata.media_kind, {
      ...this.#extractionOptions(),
      signal: job.controller.signal,
      onProgress: (progress) => {
        if (job.status.phase === "extracting") {
          job.status.progress = progress;
          this.#touch(job);
        }
      },
    });
    const cached: ExtractionCache = {
      schema_version: 3,
      source_digest: job.status.source_digest,
      extractor_revision: EXTRACTOR_REVISION,
      configuration_digest: this.#extractionConfigurationDigest,
      extracted_via: extracted.extractedVia,
      extractor_identity: extracted.extractorIdentity,
      text_digest: byteDigest(encoder.encode(extracted.text)),
      text: extracted.text,
      ...(extracted.pages ? { pages: extracted.pages } : {}),
    };
    const serialized = encoder.encode(`${JSON.stringify(cached)}\n`);
    if (serialized.byteLength <= MAX_EXTRACTION_CACHE_BYTES) {
      await atomicWrite(cachePath, serialized);
      await Promise.all(LEGACY_EXTRACTOR_REVISIONS.map((revision) => rm(
        join(directory, `${job.status.source_digest.slice("blake3:".length)}-${revision}.json`),
        { force: true },
      ).catch(() => undefined)));
    }
    return extracted;
  }

  async #yield() {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }

  async #execute(job: PaperJob) {
    if (job.controller.signal.aborted) {
      this.#finishCancelled(job);
      return;
    }
    try {
      this.#update(job, "extracting");
      const extractionStarted = now();
      const extracted = await this.#loadExtraction(job);
      job.status.durations_ms.extraction = elapsed(extractionStarted);
      if (job.controller.signal.aborted) throw new PaperExtractionError("paper_extraction_cancelled", "Paper extraction was cancelled.", true);

      this.#update(job, "locating_methods");
      await this.#yield();
      if (job.controller.signal.aborted) throw new PaperExtractionError("paper_extraction_cancelled", "Paper intake was cancelled.", true);
      this.#update(job, "recognizing_methods");
      await this.#yield();
      const reconstructionStarted = now();
      const textDigest = byteDigest(encoder.encode(extracted.text));
      const reconstructionKey = canonicalJsonDigest({ textDigest, catalogRevision: this.#catalogRevision, reconstructorRevision: RECONSTRUCTOR_REVISION });
      let review = this.#cachedReconstruction(reconstructionKey);
      if (review) job.status.cache.reconstruction = true;
      else {
        review = reconstructPaper(this.#catalog, extracted.text, extracted.extractedVia);
        this.#cacheReconstruction(reconstructionKey, review);
      }
      job.status.durations_ms.reconstruction = elapsed(reconstructionStarted);
      if (job.controller.signal.aborted) throw new PaperExtractionError("paper_extraction_cancelled", "Paper intake was cancelled.", true);
      this.#update(job, "assessing_drafts");
      await this.#yield();
      job.status.result = review;
      job.status.durations_ms.total = elapsed(job.createdAt);
      this.#update(job, "completed", undefined);
    } catch (error) {
      if (job.controller.signal.aborted || (error instanceof PaperExtractionError && error.code === "paper_extraction_cancelled")) {
        this.#finishCancelled(job);
        return;
      }
      const failure: PaperIntakeFailure = error instanceof PaperExtractionError
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : { code: "paper_reconstruction_failed", message: error instanceof Error ? error.message : String(error), retryable: true };
      job.status.failure = failure;
      job.status.durations_ms.total = elapsed(job.createdAt);
      this.#update(job, "failed", undefined);
    }
  }

  #finishCancelled(job: PaperJob) {
    job.status.durations_ms.total = elapsed(job.createdAt);
    this.#update(job, "cancelled", undefined);
  }
}
