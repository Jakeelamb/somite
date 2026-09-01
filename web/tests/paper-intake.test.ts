import assert from "node:assert/strict";
import test from "node:test";

import {
  createPaperIntakeCoordinator,
  formatPaperElapsed,
  paperCandidateCanApply,
  paperIntakeIsBusy,
  paperIntakePresentation,
  paperRetainedUnsupportedMentions,
  paperUnsupportedMentions,
  PaperIntakeFailureError,
  type PaperIntakeTransport,
  type PaperReconstructionSource,
} from "../app/paperIntake.ts";
import { createPaperIntakeHttpTransport, type PaperIntakeClient } from "../app/paperIntakeApi.ts";
import { paperSupportedCount } from "../app/paperResolution.ts";
import type { PaperReview } from "../app/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type TestPaperRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

function paperClient(request: TestPaperRequest): PaperIntakeClient {
  return {
    uploadPaper(file, signal) {
      const body = new FormData();
      body.append("file", file);
      return request("/api/papers/uploads", { method: "POST", body, signal });
    },
    startPaperIntake(digest, attemptKey, signal) {
      return request(`/api/papers/intakes?idempotency_key=${encodeURIComponent(attemptKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest }),
        ...(signal ? { signal } : {}),
      });
    },
    paperIntakeStatus(jobId, signal) {
      return request(`/api/papers/intakes/${encodeURIComponent(jobId)}?wait_ms=15000`, signal ? { signal } : undefined);
    },
    cancelPaperIntake(jobId) {
      return request(`/api/papers/intakes/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    },
    reconstructBiorxiv(id, signal) {
      return request("/api/papers/biorxiv/reconstruct", { method: "POST", body: JSON.stringify({ id }), signal });
    },
    reconstructPaperPath(path, signal) {
      return request("/api/paper", { method: "POST", body: JSON.stringify({ path }), signal });
    },
  };
}

function readyReview(name: string): PaperReview {
  return {
    extracted_via: "text",
    outcome: "drafts_ready",
    warnings: [],
    mentions: [],
    resources: [],
    candidates: [{
      name,
      role: "primary",
      assay: "test",
      warnings: [],
      evidence: [],
      graph: {
        schema_version: 3,
        nodes: [{ id: "step", operator: "test.step", operator_revision: "r1", ports: [], layout: { x: 0, y: 0 } }],
        edges: [],
      },
      assessment: { graph_revision: "blake3:test", state: "ready", required_count: 0, items: [], nodes: [] },
    }],
  };
}

test("the latest paper remains visible when an older request finishes last", async () => {
  const pending = new Map<string, ReturnType<typeof deferred<PaperReview>>>();
  const signals = new Map<string, AbortSignal>();
  const transport: PaperIntakeTransport = {
    upload: async () => { throw new Error("upload is not used by path sources"); },
    reconstruct: (source: PaperReconstructionSource, options) => {
      assert.equal(source.kind, "path");
      const request = deferred<PaperReview>();
      pending.set(source.path, request);
      signals.set(source.path, options.signal);
      return request.promise.then((review) => ({ review }));
    },
  };
  const intake = createPaperIntakeCoordinator(transport);

  const first = intake.start({ kind: "path", label: "first paper", path: "first.txt" });
  const second = intake.start({ kind: "path", label: "second paper", path: "second.txt" });
  assert.equal(signals.get("first.txt")?.aborted, true, "starting the second paper cancels the first request");

  pending.get("second.txt")?.resolve(readyReview("Second workflow"));
  await second;
  pending.get("first.txt")?.resolve(readyReview("First workflow"));
  await first;

  assert.equal(intake.getState().current?.source.label, "second paper");
  assert.equal(intake.getState().current?.review.candidates[0]?.name, "Second workflow");
  assert.equal(intake.getState().activity.status, "complete");
});

test("retry reuses a successful upload after reconstruction fails", async () => {
  let uploads = 0;
  let reconstructions = 0;
  const artifact = { digest: "sha256:paper", path: ".somite/papers/paper.pdf", filename: "paper.pdf", size_bytes: 42, media_kind: "pdf", reused: false };
  const transport: PaperIntakeTransport = {
    upload: async () => {
      uploads += 1;
      return artifact;
    },
    reconstruct: async (source) => {
      assert.equal(source.kind, "artifact");
      assert.equal(source.artifact.digest, artifact.digest);
      reconstructions += 1;
      if (reconstructions === 1) throw new Error("extractor stopped");
      return { review: readyReview("Recovered workflow") };
    },
  };
  const intake = createPaperIntakeCoordinator(transport);

  await intake.start({ kind: "local", label: "paper.pdf", file: { name: "paper.pdf" } as File });
  assert.equal(intake.getState().activity.status, "failed");
  await intake.retry();

  assert.equal(uploads, 1, "the retained artifact avoids another byte upload");
  assert.equal(reconstructions, 2);
  assert.equal(intake.getState().current?.review.candidates[0]?.name, "Recovered workflow");
});

test("an empty legacy candidate is never ready or safe to apply", async () => {
  const falseReady = readyReview("Empty workflow");
  falseReady.candidates[0] = { ...falseReady.candidates[0], graph: { schema_version: 3, nodes: [], edges: [] } };
  falseReady.mentions = [{
    display_name: "UnsupportedTool",
    normalized_name: "unsupportedtool",
    operation_class: "analysis",
    evidence: "Reads were processed with UnsupportedTool.",
    support: "unsupported",
    source_location: "PDF page 4",
  }];
  const transport: PaperIntakeTransport = {
    upload: async () => { throw new Error("not used"); },
    reconstruct: async () => ({ review: falseReady }),
  };
  const intake = createPaperIntakeCoordinator(transport);

  await intake.start({ kind: "path", label: "legacy response", path: "legacy.txt" });

  assert.equal(intake.getState().current?.review.outcome, "recognized_unsupported");
  assert.deepEqual(intake.getState().current?.review.candidates, []);
  assert.equal(paperCandidateCanApply(falseReady, falseReady.candidates[0], false), false);
});

test("unsupported mentions stay visible without blocking a supported draft", () => {
  const mixed = readyReview("Partial workflow");
  mixed.mentions = [
    { display_name: "SupportedTool", normalized_name: "supportedtool", evidence: "SupportedTool was used.", support: "operator", operator_id: "test.step" },
    { display_name: "NovelPostprocess", normalized_name: "novelpostprocess", operation_class: "postprocessing", evidence: "NovelPostprocess generated the final calls.", support: "unsupported", source_location: "PDF page 8" },
  ];

  assert.deepEqual(paperUnsupportedMentions(mixed).map((mention) => mention.display_name), ["NovelPostprocess"]);
  assert.equal(paperCandidateCanApply(mixed, mixed.candidates[0], false), true, "omitted methods warn without blocking the supported draft");
});

test("unsupported evidence is not called omitted after its adapter node is visible", () => {
  const represented = readyReview("Visible adapter evidence");
  represented.mentions = [{
    display_name: "NovelPostprocess",
    normalized_name: "novelpostprocess",
    operation_class: "postprocessing",
    evidence: "NovelPostprocess generated the final calls.",
    support: "unsupported",
    executable: true,
  }];
  represented.candidates[0]!.graph.nodes.push({
    id: "novel-postprocess",
    operator: "gap.missing",
    operator_revision: "gap-revision",
    ports: [],
    params: { tool: "Novel Postprocess", quote: "NovelPostprocess generated the final calls." },
    layout: { x: 0, y: 0 },
  });
  represented.candidates[0]!.assessment.nodes.push({
    node_id: "novel-postprocess",
    operator_id: "gap.missing",
    title: "Novel Postprocess",
    kind: "adapter",
    label: "Evidence retained",
    detail: "No typed contract was inferred.",
    requires_action: false,
    recipes: [],
  });

  assert.deepEqual(paperUnsupportedMentions(represented), []);
  assert.deepEqual(paperRetainedUnsupportedMentions(represented).map((mention) => mention.normalized_name), ["novelpostprocess"]);
  assert.equal(paperSupportedCount(represented.candidates[0]), 0, "retained evidence is not counted as supported execution");
});

test("cancel is immediately visible but terminal only after transport acknowledgement", async () => {
  let signal: AbortSignal | undefined;
  const transport: PaperIntakeTransport = {
    upload: async () => { throw new Error("not used"); },
    reconstruct: (_source, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("server acknowledged cancellation", "AbortError")), { once: true });
      });
    },
  };
  const intake = createPaperIntakeCoordinator(transport);

  const request = intake.start({ kind: "path", label: "slow paper", path: "slow.txt" });
  intake.cancel();
  assert.equal(signal?.aborted, true);
  assert.equal(intake.getState().activity.status, "cancelling");

  await request;
  assert.equal(intake.getState().activity.status, "cancelled");
  assert.equal(intake.getState().current, null);
});

test("the prior completed result stays visible while its replacement runs or fails", async () => {
  const replacement = deferred<PaperReview>();
  const transport: PaperIntakeTransport = {
    upload: async () => { throw new Error("not used"); },
    reconstruct: async (source) => {
      assert.equal(source.kind, "path");
      if (source.path === "first.txt") return { review: readyReview("First workflow") };
      return { review: await replacement.promise };
    },
  };
  const intake = createPaperIntakeCoordinator(transport);
  await intake.start({ kind: "path", label: "first paper", path: "first.txt" });

  const next = intake.start({ kind: "path", label: "replacement paper", path: "replacement.txt" });
  assert.equal(intake.getState().activity.status, "running");
  assert.equal(intake.getState().current?.review.candidates[0]?.name, "First workflow");

  replacement.reject(new Error("could not extract replacement"));
  await next;
  assert.equal(intake.getState().activity.status, "failed");
  assert.equal(intake.getState().current?.review.candidates[0]?.name, "First workflow");
});

test("paper intake presentation explains unsupported methods without calling them ready", async () => {
  const unsupported = readyReview("Unsupported workflow");
  unsupported.outcome = "recognized_unsupported";
  unsupported.candidates = [];
  unsupported.mentions = [{ display_name: "NovelTool", normalized_name: "noveltool", evidence: "NovelTool was used.", support: "unsupported" }];
  const transport: PaperIntakeTransport = {
    upload: async () => { throw new Error("not used"); },
    reconstruct: async () => ({ review: unsupported }),
  };
  const intake = createPaperIntakeCoordinator(transport);

  await intake.start({ kind: "path", label: "methods.txt", path: "methods.txt" });
  const presentation = paperIntakePresentation(intake.getState());
  assert.equal(presentation.tone, "unsupported");
  assert.match(presentation.headline, /Methods found/);
  assert.equal(presentation.badge, "No draft");
});

test("paper intake presentation distinguishes ready, no-workflow, and failure terminals", async () => {
  const reviews = [readyReview("Ready workflow"), { ...readyReview("No workflow"), outcome: "no_reconstructable_methods" as const, candidates: [] }];
  const transport: PaperIntakeTransport = {
    upload: async () => { throw new Error("not used"); },
    reconstruct: async () => {
      const review = reviews.shift();
      if (!review) throw new Error("extractor missing");
      return { review };
    },
  };
  const intake = createPaperIntakeCoordinator(transport);

  await intake.start({ kind: "path", label: "ready", path: "ready.txt" });
  assert.equal(paperIntakePresentation(intake.getState()).tone, "ready");
  await intake.start({ kind: "path", label: "no workflow", path: "empty.txt" });
  assert.equal(paperIntakePresentation(intake.getState()).tone, "empty");
  await intake.start({ kind: "path", label: "broken", path: "broken.txt" });
  assert.equal(paperIntakePresentation(intake.getState()).tone, "error");
  assert.equal(intake.getState().current?.source.label, "no workflow", "failure preserves the prior terminal result");
});

test("the HTTP adapter follows the digest job through measured phases", async () => {
  const paths: string[] = [];
  const statuses = [
    { job_id: "paper-7", source_digest: "blake3:abc", phase: "extracting", progress: { completed: 1, total: 4, unit: "stage", message: "Extracting text" }, durations_ms: {}, cache: { extraction: false, reconstruction: false } },
    { job_id: "paper-7", source_digest: "blake3:abc", phase: "completed", progress: { completed: 4, total: 4, unit: "stage", message: "Complete" }, durations_ms: { extraction: 12 }, cache: { extraction: false, reconstruction: true }, result: readyReview("Job workflow") },
  ];
  const request = async <T>(path: string): Promise<T> => {
    paths.push(path);
    if (path.startsWith("/api/papers/intakes?")) return { job_id: "paper-7", source_digest: "blake3:abc", phase: "queued", replayed: false } as T;
    return statuses.shift() as T;
  };
  const transport = createPaperIntakeHttpTransport(paperClient(request));
  const progress: string[] = [];

  const receipt = await transport.reconstruct({ kind: "artifact", artifact: { digest: "blake3:abc", path: ".somite/papers/abc/payload.pdf", filename: "paper.pdf", size_bytes: 42, media_kind: "pdf", reused: false } }, {
    signal: new AbortController().signal,
    attemptKey: "paper-attempt-0001",
    onProgress: (stage) => progress.push(stage),
  });

  assert.deepEqual(paths, ["/api/papers/intakes?idempotency_key=paper-attempt-0001", "/api/papers/intakes/paper-7?wait_ms=15000", "/api/papers/intakes/paper-7?wait_ms=15000"]);
  assert.deepEqual(progress, ["extracting"]);
  assert.equal(receipt.review.candidates[0]?.name, "Job workflow");
  assert.equal(receipt.cache?.reconstruction, true);
});

test("an abort that lands with the start response still cancels the created server job", async () => {
  const controller = new AbortController();
  const paths: string[] = [];
  const request = async <T>(path: string): Promise<T> => {
    paths.push(path);
    if (path.startsWith("/api/papers/intakes?")) {
      controller.abort();
      return { job_id: "paper-race", source_digest: "blake3:abc", phase: "queued", replayed: false } as T;
    }
    if (path.endsWith("/cancel")) {
      return { job_id: "paper-race", source_digest: "blake3:abc", phase: "cancelling", progress: { completed: 0, total: 4, unit: "stages", message: "Stopping" }, durations_ms: {}, cache: { extraction: false, reconstruction: false } } as T;
    }
    throw new Error(`unexpected request: ${path}`);
  };
  const transport = createPaperIntakeHttpTransport(paperClient(request));

  await assert.rejects(transport.reconstruct({ kind: "artifact", artifact: { digest: "blake3:abc", path: "payload.pdf", filename: "paper.pdf", size_bytes: 42, media_kind: "pdf", reused: false } }, {
    signal: controller.signal,
    attemptKey: "paper-abort-race",
    onProgress() {},
  }), (error: unknown) => error instanceof Error && error.name === "AbortError");

  assert.deepEqual(paths, [
    "/api/papers/intakes?idempotency_key=paper-abort-race",
    "/api/papers/intakes/paper-race/cancel",
  ]);
});

test("an ambiguous aborted start replays the same attempt key to recover and cancel the job", async () => {
  const controller = new AbortController();
  const starts: Array<{ path: string; signal?: AbortSignal | null }> = [];
  const paths: string[] = [];
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    paths.push(path);
    if (path.startsWith("/api/papers/intakes?")) {
      starts.push({ path, signal: init?.signal });
      if (starts.length === 1) {
        controller.abort();
        throw new DOMException("response was lost while aborting", "AbortError");
      }
      return { job_id: "paper-recovered", source_digest: "blake3:abc", phase: "queued", replayed: true } as T;
    }
    if (path.endsWith("/cancel")) {
      return { job_id: "paper-recovered", source_digest: "blake3:abc", phase: "cancelling", progress: { completed: 0, total: 4, unit: "stages", message: "Stopping" }, durations_ms: {}, cache: { extraction: false, reconstruction: false } } as T;
    }
    throw new Error(`unexpected request: ${path}`);
  };
  const transport = createPaperIntakeHttpTransport(paperClient(request));

  await assert.rejects(transport.reconstruct({ kind: "artifact", artifact: { digest: "blake3:abc", path: "payload.pdf", filename: "paper.pdf", size_bytes: 42, media_kind: "pdf", reused: false } }, {
    signal: controller.signal,
    attemptKey: "paper-ambiguous-start",
    onProgress() {},
  }), (error: unknown) => error instanceof Error && error.name === "AbortError");

  assert.deepEqual(starts.map(({ path }) => path), [
    "/api/papers/intakes?idempotency_key=paper-ambiguous-start",
    "/api/papers/intakes?idempotency_key=paper-ambiguous-start",
  ]);
  assert.equal(starts[0]?.signal, controller.signal);
  assert.equal(starts[1]?.signal, undefined, "recovery must not reuse the already-aborted signal");
  assert.equal(paths.at(-1), "/api/papers/intakes/paper-recovered/cancel");
});

test("a failed cancellation acknowledgement is not reported as cancelled", async () => {
  const controller = new AbortController();
  let statusSignal: AbortSignal | null | undefined;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (path.startsWith("/api/papers/intakes?")) {
      return { job_id: "paper-cancel-failure", source_digest: "blake3:abc", phase: "queued", replayed: false } as T;
    }
    if (path.endsWith("/cancel")) throw new Error("connection lost before acknowledgement");
    statusSignal = init?.signal;
    return new Promise<T>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("poll aborted", "AbortError")), { once: true });
    });
  };
  const transport = createPaperIntakeHttpTransport(paperClient(request));
  const reconstruction = transport.reconstruct({ kind: "artifact", artifact: { digest: "blake3:abc", path: "payload.pdf", filename: "paper.pdf", size_bytes: 42, media_kind: "pdf", reused: false } }, {
    signal: controller.signal,
    attemptKey: "paper-cancel-failure",
    onProgress() {},
  });
  await Promise.resolve();
  assert.equal(statusSignal, controller.signal);
  controller.abort();

  await assert.rejects(reconstruction, (error: unknown) => {
    assert.ok(error instanceof PaperIntakeFailureError);
    assert.equal(error.code, "paper_cancel_unconfirmed");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("a transient poll resumes the same job without creating another intake", async () => {
  let starts = 0;
  let polls = 0;
  const delays: number[] = [];
  const request = async <T>(path: string): Promise<T> => {
    if (path.startsWith("/api/papers/intakes?")) {
      starts += 1;
      return { job_id: "paper-resume", source_digest: "blake3:abc", phase: "queued", replayed: false } as T;
    }
    polls += 1;
    if (polls === 1) throw new Error("temporary gateway failure");
    return { job_id: "paper-resume", source_digest: "blake3:abc", phase: "completed", durations_ms: {}, cache: { extraction: true, reconstruction: false }, result: readyReview("Resumed workflow") } as T;
  };
  const transport = createPaperIntakeHttpTransport(paperClient(request), {
    pollRetryDelaysMs: [25],
    sleep: async (delayMs) => { delays.push(delayMs); },
  });

  const receipt = await transport.reconstruct({ kind: "artifact", artifact: { digest: "blake3:abc", path: "payload.pdf", filename: "paper.pdf", size_bytes: 42, media_kind: "pdf", reused: false } }, {
    signal: new AbortController().signal,
    attemptKey: "paper-poll-resume",
    onProgress() {},
  });

  assert.equal(receipt.review.candidates[0]?.name, "Resumed workflow");
  assert.equal(starts, 1);
  assert.equal(polls, 2);
  assert.deepEqual(delays, [25]);
});

test("server failure code and retryability survive transport and coordinator", async () => {
  const failure = { code: "paper_page_limit", message: "This PDF exceeds the configured page limit.", retryable: false };
  const request = async <T>(path: string): Promise<T> => {
    if (path.startsWith("/api/papers/intakes?")) {
      return { job_id: "paper-limit", source_digest: "blake3:abc", phase: "queued", replayed: false } as T;
    }
    return { job_id: "paper-limit", source_digest: "blake3:abc", phase: "failed", failure, durations_ms: {}, cache: { extraction: false, reconstruction: false } } as T;
  };
  const transport = createPaperIntakeHttpTransport(paperClient(request));
  const intake = createPaperIntakeCoordinator(transport, { createAttemptKey: () => "paper-limit-attempt" });
  const source = { kind: "local" as const, label: "large.pdf", file: { name: "large.pdf" } as File };
  const artifact = { digest: "blake3:abc", path: "payload.pdf", filename: "large.pdf", size_bytes: 42, media_kind: "pdf", reused: false };
  transport.upload = async () => artifact;

  await intake.start(source);
  const activity = intake.getState().activity;
  assert.equal(activity.status, "failed");
  if (activity.status !== "failed") return;
  assert.equal(activity.code, failure.code);
  assert.equal(activity.detail, failure.message);
  assert.equal(activity.retryable, false);
  const unchanged = await intake.retry();
  assert.equal(unchanged.activity.status, "failed");
  if (unchanged.activity.status === "failed") {
    assert.equal(unchanged.activity.requestId, activity.requestId, "a known permanent failure does not repeat unchanged work");
  }
});

test("retry after unconfirmed cancellation reuses the original attempt key", async () => {
  const attemptKeys: string[] = [];
  let generated = 0;
  const transport: PaperIntakeTransport = {
    upload: async () => { throw new Error("not used"); },
    reconstruct: async (_source, options) => {
      attemptKeys.push(options.attemptKey);
      if (attemptKeys.length === 1) {
        throw new PaperIntakeFailureError({
          code: "paper_cancel_unconfirmed",
          message: "Cancellation could not be confirmed.",
          retryable: true,
        });
      }
      return { review: readyReview("Recovered original job") };
    },
  };
  const intake = createPaperIntakeCoordinator(transport, { createAttemptKey: () => `paper-generated-${++generated}` });

  await intake.start({ kind: "path", label: "uncertain paper", path: "uncertain.txt" });
  assert.equal(intake.getState().activity.status, "failed");
  await intake.retry();

  assert.deepEqual(attemptKeys, ["paper-generated-1", "paper-generated-1"]);
  assert.equal(generated, 1, "retry must not admit a second server job behind a new key");
  assert.equal(intake.getState().activity.status, "complete");
});

test("elapsed time is deterministic and owned by the intake attempt", async () => {
  assert.equal(formatPaperElapsed(10_000, 10_000), "0s");
  assert.equal(formatPaperElapsed(10_000, 75_999), "1m 5s");
  assert.equal(formatPaperElapsed(10_000, 7_400_000), "2h 3m");

  const pending = deferred<PaperReview>();
  const seenStartedAt: number[] = [];
  const transport: PaperIntakeTransport = {
    upload: async () => { throw new Error("not used"); },
    reconstruct: async (_source, options) => {
      options.onProgress("extracting", { completed: 1, total: 3, unit: "pages", message: "Reading page 1" });
      return { review: await pending.promise };
    },
  };
  const intake = createPaperIntakeCoordinator(transport, { now: () => 12_345, createAttemptKey: () => "paper-timed" });
  const unsubscribe = intake.subscribe(({ activity }) => {
    if (activity.status === "running") seenStartedAt.push(activity.startedAtMs);
  });
  const request = intake.start({ kind: "path", label: "timed paper", path: "timed.txt" });

  assert.deepEqual(seenStartedAt, [12_345, 12_345]);
  pending.resolve(readyReview("Timed workflow"));
  await request;
  unsubscribe();
});

test("cancellation acknowledgement keeps paper actions busy", () => {
  const source = { kind: "path" as const, label: "slow paper", path: "slow.txt" };
  assert.equal(paperIntakeIsBusy({ status: "running", requestId: 1, source, stage: "extracting", startedAtMs: 10 }), true);
  assert.equal(paperIntakeIsBusy({ status: "cancelling", requestId: 1, source, startedAtMs: 10 }), true);
  assert.equal(paperIntakeIsBusy({ status: "cancelled", requestId: 1, source }), false);
});

test("a server-side cancellation is a cancelled terminal state, not a failure", async () => {
  const transport: PaperIntakeTransport = {
    upload: async () => { throw new Error("not used"); },
    reconstruct: async () => { throw new DOMException("cancelled by server", "AbortError"); },
  };
  const intake = createPaperIntakeCoordinator(transport);

  await intake.start({ kind: "path", label: "cancelled paper", path: "cancelled.txt" });

  assert.equal(intake.getState().activity.status, "cancelled");
});
