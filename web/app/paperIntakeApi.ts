import type { PaperIntakeStartResponse, PaperIntakeStatusResponse, SomiteClient } from "./api.ts";
import type {
  PaperIntakeProgress,
  PaperIntakeStage,
  PaperIntakeTransport,
  PaperReconstructionReceipt,
  PaperReconstructionSource,
} from "./paperIntake";
import { PaperIntakeFailureError } from "./paperIntake.ts";

export type PaperIntakeClient = Pick<SomiteClient,
  | "uploadPaper"
  | "startPaperIntake"
  | "paperIntakeStatus"
  | "cancelPaperIntake"
  | "reconstructBiorxiv"
  | "reconstructPaperPath"
>;

type PaperIntakeHttpTransportOptions = {
  pollRetryDelaysMs?: readonly number[];
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

type CancellationOutcome =
  | { acknowledged: true; status: PaperIntakeStatusResponse }
  | { acknowledged: false; error: unknown };

const activeStages = new Set<PaperIntakeStage>([
  "queued",
  "extracting",
  "locating_methods",
  "recognizing_methods",
  "assessing_drafts",
]);

function progressValue(progress: PaperIntakeStatusResponse["progress"]): PaperIntakeProgress | undefined {
  if (!progress) return undefined;
  return {
    completed: progress.completed,
    ...(typeof progress.total === "number" ? { total: progress.total } : {}),
    ...(progress.unit ? { unit: progress.unit } : {}),
    message: progress.message,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function abortError(message = "Paper intake cancelled") {
  return new DOMException(message, "AbortError");
}

function failureError(failure: PaperIntakeStatusResponse["failure"]) {
  return new PaperIntakeFailureError(failure ?? {
    code: "paper_intake_failed",
    message: "Paper intake failed without an error detail.",
    retryable: true,
  });
}

function cancellationUnconfirmed(error: unknown) {
  return new PaperIntakeFailureError({
    code: "paper_cancel_unconfirmed",
    message: `Somite could not confirm that the server stopped this paper. ${errorMessage(error)}`,
    retryable: true,
  });
}

function delayWithSignal(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function reconstructArtifact(
  client: PaperIntakeClient,
  source: Extract<PaperReconstructionSource, { kind: "artifact" }>,
  options: Parameters<PaperIntakeTransport["reconstruct"]>[1],
  transportOptions: Required<PaperIntakeHttpTransportOptions>,
): Promise<PaperReconstructionReceipt> {
  if (options.signal.aborted) throw abortError();
  let started: PaperIntakeStartResponse;
  try {
    started = await client.startPaperIntake(source.artifact.digest, options.attemptKey, options.signal);
  } catch (firstError) {
    try {
      started = await client.startPaperIntake(source.artifact.digest, options.attemptKey);
    } catch (replayError) {
      if (options.signal.aborted) throw cancellationUnconfirmed(replayError);
      throw new PaperIntakeFailureError({
        code: "paper_start_unavailable",
        message: `Somite could not confirm that paper intake started. ${errorMessage(replayError ?? firstError)}`,
        retryable: true,
      });
    }
  }
  let cancellation: Promise<CancellationOutcome> | null = null;
  const cancel = () => {
    cancellation ??= client.cancelPaperIntake(started.job_id)
      .then((status): CancellationOutcome => ({ acknowledged: true, status }))
      .catch((error): CancellationOutcome => ({ acknowledged: false, error }));
    return cancellation;
  };
  const requireCancellationAcknowledgement = async () => {
    const outcome = await cancel();
    if (!outcome.acknowledged) throw cancellationUnconfirmed(outcome.error);
    if (outcome.status.phase === "failed") throw failureError(outcome.status.failure);
    if (outcome.status.phase !== "cancelling" && outcome.status.phase !== "cancelled") {
      throw cancellationUnconfirmed(new Error(`server returned ${outcome.status.phase}`));
    }
  };
  const abortAfterAcknowledgement = async () => {
    await requireCancellationAcknowledgement();
    throw abortError("Paper intake cancellation acknowledged");
  };
  const onAbort = () => { void cancel(); };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  try {
    if (options.signal.aborted) await abortAfterAcknowledgement();
    let pollFailureCount = 0;
    while (true) {
      let status: PaperIntakeStatusResponse;
      try {
        status = await client.paperIntakeStatus(started.job_id, options.signal);
        pollFailureCount = 0;
      } catch (error) {
        if (options.signal.aborted) await abortAfterAcknowledgement();
        const retryDelay = transportOptions.pollRetryDelaysMs[pollFailureCount];
        if (retryDelay !== undefined) {
          pollFailureCount += 1;
          try {
            await transportOptions.sleep(retryDelay, options.signal);
          } catch (delayError) {
            if (options.signal.aborted) await abortAfterAcknowledgement();
            throw new PaperIntakeFailureError({
              code: "paper_status_unavailable",
              message: `Somite could not resume paper status checks. ${errorMessage(delayError)}`,
              retryable: true,
            });
          }
          continue;
        }
        await requireCancellationAcknowledgement();
        throw new PaperIntakeFailureError({
          code: "paper_status_unavailable",
          message: `Somite lost contact with this paper job after retrying its status check. ${errorMessage(error)}`,
          retryable: true,
        });
      }
      if (options.signal.aborted) await abortAfterAcknowledgement();
      if (activeStages.has(status.phase as PaperIntakeStage)) {
        options.onProgress(status.phase as PaperIntakeStage, progressValue(status.progress));
        continue;
      }
      if (status.phase === "cancelling") continue;
      if (status.phase === "cancelled") throw abortError("Paper intake was cancelled by the server");
      if (status.phase === "failed") throw failureError(status.failure);
      if (!status.result) {
        throw new PaperIntakeFailureError({
          code: "paper_result_missing",
          message: "Paper intake completed without a reconstruction result.",
          retryable: true,
        });
      }
      return {
        review: status.result,
        jobId: status.job_id,
        ...(status.durations_ms ? { durationsMs: status.durations_ms } : {}),
        ...(status.cache ? { cache: status.cache } : {}),
      };
    }
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

export function createPaperIntakeHttpTransport(client: PaperIntakeClient, options: PaperIntakeHttpTransportOptions = {}): PaperIntakeTransport {
  const transportOptions: Required<PaperIntakeHttpTransportOptions> = {
    pollRetryDelaysMs: options.pollRetryDelaysMs ?? [250, 750, 1_500],
    sleep: options.sleep ?? delayWithSignal,
  };
  return {
    upload: (file, signal) => client.uploadPaper(file, signal),
    async reconstruct(source, options) {
      if (source.kind === "artifact") return reconstructArtifact(client, source, options, transportOptions);
      options.onProgress("recognizing_methods", { completed: 0, message: source.kind === "biorxiv" ? "Fetching full text and recognizing methods" : "Recognizing methods" });
      const review = source.kind === "biorxiv"
        ? await client.reconstructBiorxiv(source.id, options.signal)
        : await client.reconstructPaperPath(source.path, options.signal);
      return { review };
    },
  };
}
