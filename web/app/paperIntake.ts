import type { PaperCandidate, PaperReconstructionOutcome, PaperReview } from "./types";

export type PaperArtifact = {
  digest: string;
  path: string;
  filename: string;
  size_bytes: number;
  media_kind: string;
  reused: boolean;
};

export type PaperIntakeSource =
  | { kind: "local"; label: string; file: File }
  | { kind: "path"; label: string; path: string }
  | { kind: "biorxiv"; label: string; id: string };

export type PaperReconstructionSource =
  | { kind: "artifact"; artifact: PaperArtifact }
  | Extract<PaperIntakeSource, { kind: "path" | "biorxiv" }>;

export type PaperIntakeStage =
  | "uploading"
  | "queued"
  | "extracting"
  | "locating_methods"
  | "recognizing_methods"
  | "assessing_drafts";

export type PaperIntakeProgress = {
  completed: number;
  total?: number;
  unit?: string;
  message: string;
};

export type PaperReconstructionReceipt = {
  review: PaperReview;
  jobId?: string;
  durationsMs?: Record<string, number>;
  cache?: { extraction?: boolean; reconstruction?: boolean };
};

export type PaperIntakeFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export class PaperIntakeFailureError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(failure: PaperIntakeFailure) {
    super(failure.message);
    this.name = "PaperIntakeFailureError";
    this.code = failure.code;
    this.retryable = failure.retryable;
  }
}

export type PaperIntakeTransport = {
  upload(file: File, signal: AbortSignal): Promise<PaperArtifact>;
  reconstruct(
    source: PaperReconstructionSource,
    options: {
      signal: AbortSignal;
      attemptKey: string;
      onProgress: (stage: PaperIntakeStage, progress?: PaperIntakeProgress) => void;
    },
  ): Promise<PaperReconstructionReceipt>;
};

export type PaperIntakeResult = PaperReconstructionReceipt & {
  requestId: number;
  source: PaperIntakeSource;
  artifact?: PaperArtifact;
};

export type PaperIntakeActivity =
  | { status: "idle" }
  | { status: "running"; requestId: number; source: PaperIntakeSource; stage: PaperIntakeStage; startedAtMs: number; artifact?: PaperArtifact; progress?: PaperIntakeProgress }
  | { status: "cancelling"; requestId: number; source: PaperIntakeSource; startedAtMs: number; artifact?: PaperArtifact }
  | { status: "complete"; requestId: number; source: PaperIntakeSource; outcome: PaperReconstructionOutcome; artifact?: PaperArtifact; jobId?: string }
  | { status: "failed"; requestId: number; source: PaperIntakeSource; failedStage: "upload" | "reconstruct"; code: string; detail: string; retryable: boolean; artifact?: PaperArtifact; attemptKey?: string }
  | { status: "cancelled"; requestId: number; source: PaperIntakeSource; artifact?: PaperArtifact };

export type PaperIntakeState = {
  current: PaperIntakeResult | null;
  activity: PaperIntakeActivity;
};

export type PaperIntakeCoordinator = {
  getState(): PaperIntakeState;
  subscribe(listener: (state: PaperIntakeState) => void): () => void;
  start(source: PaperIntakeSource): Promise<PaperIntakeState>;
  retry(): Promise<PaperIntakeState>;
  cancel(): void;
  updateReview(update: (review: PaperReview) => PaperReview): void;
};

export type PaperIntakeCoordinatorOptions = {
  now?: () => number;
  createAttemptKey?: () => string;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isCancellation(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function cancellationError() {
  return new DOMException("Paper intake cancelled", "AbortError");
}

function intakeFailure(error: unknown, failedStage: "upload" | "reconstruct") {
  if (error instanceof PaperIntakeFailureError) {
    return { code: error.code, detail: error.message, retryable: error.retryable };
  }
  return {
    code: failedStage === "upload" ? "paper_upload_failed" : "paper_reconstruction_failed",
    detail: errorMessage(error),
    retryable: true,
  };
}

export function formatPaperElapsed(startedAtMs: number, nowMs: number) {
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

export function normalizedPaperReview(review: PaperReview): PaperReview {
  const candidates = review.candidates.filter((candidate) => candidate.graph.nodes.length > 0);
  if (candidates.length === review.candidates.length) return review;
  const outcome = review.outcome === "drafts_ready" && candidates.length === 0
    ? review.mentions.length > 0 ? "recognized_unsupported" : "no_reconstructable_methods"
    : review.outcome;
  return {
    ...review,
    outcome,
    candidates,
    warnings: [...review.warnings, "Somite ignored an empty workflow draft returned by an older reconstruction contract."],
  };
}

export function paperCandidateCanApply(review: PaperReview | null | undefined, candidate: PaperCandidate | null | undefined, busy: boolean) {
  return !busy && review?.outcome === "drafts_ready" && Boolean(candidate?.graph.nodes.length);
}

export function paperIntakeIsBusy(activity: PaperIntakeActivity) {
  return activity.status === "running" || activity.status === "cancelling";
}

export function paperUnsupportedMentions(review: PaperReview | null | undefined) {
  return review?.mentions.filter((mention) => mention.support === "unsupported") ?? [];
}

export type PaperIntakePresentation = {
  tone: "idle" | "working" | "ready" | "unsupported" | "empty" | "error" | "cancelled";
  badge: string;
  headline: string;
  detail: string;
  showingPrevious: boolean;
  progressPercent?: number;
};

const stageLabels: Record<PaperIntakeStage, string> = {
  uploading: "Copying paper into this project",
  queued: "Waiting to read the paper",
  extracting: "Extracting text",
  locating_methods: "Locating methods",
  recognizing_methods: "Recognizing methods",
  assessing_drafts: "Checking workflow drafts",
};

export function paperIntakePresentation(state: PaperIntakeState): PaperIntakePresentation {
  const { activity, current } = state;
  if (activity.status === "idle") {
    return { tone: "idle", badge: "Ready", headline: "Choose a paper", detail: "PDF, text, or Markdown", showingPrevious: false };
  }
  const showingPrevious = Boolean(current && current.requestId !== activity.requestId);
  if (activity.status === "running") {
    const progress = activity.progress;
    const progressPercent = progress?.total && progress.total > 0
      ? Math.max(0, Math.min(100, Math.round((progress.completed / progress.total) * 100)))
      : undefined;
    return {
      tone: "working",
      badge: "Working",
      headline: stageLabels[activity.stage],
      detail: progress?.message || activity.source.label,
      showingPrevious,
      ...(progressPercent === undefined ? {} : { progressPercent }),
    };
  }
  if (activity.status === "cancelling") {
    return {
      tone: "working",
      badge: "Stopping",
      headline: "Stopping paper intake",
      detail: "Waiting for the active paper work to stop.",
      showingPrevious,
    };
  }
  if (activity.status === "failed") {
    return {
      tone: "error",
      badge: "Stopped",
      headline: activity.failedStage === "upload" ? "Could not copy this paper" : "Could not read this paper",
      detail: activity.detail,
      showingPrevious,
    };
  }
  if (activity.status === "cancelled") {
    return { tone: "cancelled", badge: "Cancelled", headline: "Paper intake cancelled", detail: activity.source.label, showingPrevious };
  }
  if (activity.outcome === "recognized_unsupported") {
    return {
      tone: "unsupported",
      badge: "No draft",
      headline: "Methods found, but Somite cannot build a workflow yet",
      detail: "The method evidence is retained below without inventing executable steps.",
      showingPrevious: false,
    };
  }
  if (activity.outcome === "no_reconstructable_methods") {
    return {
      tone: "empty",
      badge: "No workflow",
      headline: "Paper read; no reconstructable workflow was found",
      detail: "No canvas changes were made.",
      showingPrevious: false,
    };
  }
  const drafts = current?.review.candidates.length ?? 0;
  return {
    tone: "ready",
    badge: "Ready",
    headline: `${drafts} workflow draft${drafts === 1 ? "" : "s"} ready to review`,
    detail: "Nothing was added to the canvas.",
    showingPrevious: false,
  };
}

export function createPaperIntakeCoordinator(transport: PaperIntakeTransport, options: PaperIntakeCoordinatorOptions = {}): PaperIntakeCoordinator {
  let state: PaperIntakeState = { current: null, activity: { status: "idle" } };
  let nextRequestId = 0;
  let active: { requestId: number; controller: AbortController } | null = null;
  const listeners = new Set<(state: PaperIntakeState) => void>();
  const now = options.now ?? Date.now;
  const createAttemptKey = options.createAttemptKey ?? (() => `paper-${globalThis.crypto.randomUUID()}`);

  const publish = (next: PaperIntakeState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  const isCurrent = (requestId: number) => active?.requestId === requestId;

  const run = async (source: PaperIntakeSource, retainedArtifact?: PaperArtifact, retainedAttemptKey?: string) => {
    const previous = active;
    const requestId = ++nextRequestId;
    const controller = new AbortController();
    const startedAtMs = now();
    const attemptKey = retainedAttemptKey ?? createAttemptKey();
    active = { requestId, controller };
    previous?.controller.abort();
    let artifact = retainedArtifact;
    let failedStage: "upload" | "reconstruct" = source.kind === "local" && !artifact ? "upload" : "reconstruct";
    publish({
      current: state.current,
      activity: {
        status: "running",
        requestId,
        source,
        stage: source.kind === "local" && !artifact ? "uploading" : artifact ? "queued" : "recognizing_methods",
        startedAtMs,
        ...(artifact ? { artifact } : {}),
      },
    });

    try {
      if (source.kind === "local" && !artifact) {
        artifact = await transport.upload(source.file, controller.signal);
        if (!isCurrent(requestId)) return state;
        if (controller.signal.aborted) throw cancellationError();
        failedStage = "reconstruct";
        publish({ current: state.current, activity: { status: "running", requestId, source, stage: "queued", startedAtMs, artifact } });
      }
      const reconstructionSource: PaperReconstructionSource = source.kind === "local"
        ? { kind: "artifact", artifact: artifact! }
        : source;
      const receipt = await transport.reconstruct(reconstructionSource, {
        signal: controller.signal,
        attemptKey,
        onProgress: (stage, progress) => {
          if (!isCurrent(requestId) || controller.signal.aborted) return;
          publish({ current: state.current, activity: { status: "running", requestId, source, stage, startedAtMs, artifact, ...(progress ? { progress } : {}) } });
        },
      });
      if (!isCurrent(requestId)) return state;
      if (controller.signal.aborted) throw cancellationError();
      const review = normalizedPaperReview(receipt.review);
      const result: PaperIntakeResult = { ...receipt, review, requestId, source, ...(artifact ? { artifact } : {}) };
      active = null;
      publish({
        current: result,
        activity: { status: "complete", requestId, source, outcome: review.outcome, ...(artifact ? { artifact } : {}), ...(receipt.jobId ? { jobId: receipt.jobId } : {}) },
      });
    } catch (error) {
      if (!isCurrent(requestId)) return state;
      active = null;
      if (isCancellation(error)) {
        publish({ current: state.current, activity: { status: "cancelled", requestId, source, ...(artifact ? { artifact } : {}) } });
      } else {
        const failure = intakeFailure(error, failedStage);
        const uncertainJob = failure.code === "paper_cancel_unconfirmed" || failure.code === "paper_start_unavailable";
        publish({ current: state.current, activity: { status: "failed", requestId, source, failedStage, ...failure, ...(artifact ? { artifact } : {}), ...(uncertainJob ? { attemptKey } : {}) } });
      }
    }
    return state;
  };

  const start = (source: PaperIntakeSource) => run(source);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    retry() {
      const activity = state.activity;
      if (activity.status !== "failed" && activity.status !== "cancelled") return Promise.resolve(state);
      if (activity.status === "failed" && !activity.retryable) return Promise.resolve(state);
      return run(activity.source, activity.artifact, activity.status === "failed" ? activity.attemptKey : undefined);
    },
    cancel() {
      const activity = state.activity;
      if (activity.status !== "running" || active?.requestId !== activity.requestId) return;
      const controller = active.controller;
      publish({
        current: state.current,
        activity: {
          status: "cancelling",
          requestId: activity.requestId,
          source: activity.source,
          startedAtMs: activity.startedAtMs,
          ...(activity.artifact ? { artifact: activity.artifact } : {}),
        },
      });
      controller.abort();
    },
    updateReview(update) {
      if (!state.current) return;
      publish({ ...state, current: { ...state.current, review: update(state.current.review) } });
    },
  };
}
