import type { EvidenceResult, RunNodeState, SomiteEdge } from "./types";
export { semanticGraphKey } from "@somite/workflow/workflow";

export function edgeLifecycleState(edge: SomiteEdge, states: Record<string, RunNodeState>): "idle" | RunNodeState {
  const source = states[edge.from_node];
  const target = states[edge.to_node];
  if (!source || !target) return "idle";
  if (source === "failed" || target === "failed") return "failed";
  if (source === "cancelled" || target === "cancelled") return "cancelled";
  if ([source, target].every((state) => state === "done" || state === "cached")) return "done";
  if (source === "running" || target === "running") return "running";
  if (source === "queued" || target === "queued") return "queued";
  return "skipped";
}

export function evidenceNodeState(result: EvidenceResult): RunNodeState {
  return result === "passed" ? "done" : result === "failed" ? "failed" : "skipped";
}
