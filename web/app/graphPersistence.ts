import type { GraphWriteResponse, SomiteGraph } from "./types";
import { validateGraph } from "@somite/workflow/workflow";

export type GraphWritePath = "/api/graph" | "/api/graph/autosave";
export type GraphWriteSnapshot = { graph: SomiteGraph; epoch: number; input_origin_id?: string };

export function captureGraphWrite(graph: SomiteGraph, epoch: number, inputOriginId?: string): GraphWriteSnapshot {
  return { graph, epoch, ...(inputOriginId ? { input_origin_id: inputOriginId } : {}) };
}

export function commitIfCanonicalEpochCurrent(
  requestEpoch: number,
  minimumEpoch: () => number,
  commit: () => void,
) {
  if (requestEpoch < minimumEpoch()) return false;
  commit();
  return true;
}

export type CanonicalRefreshDisposition = "replace" | "preserve_local" | "stale";

export function canonicalRefreshAccepted(disposition: CanonicalRefreshDisposition | "busy") {
  return disposition === "replace" || disposition === "preserve_local";
}

export function graphNodeSetChanged(previous: SomiteGraph, next: SomiteGraph) {
  if (previous.nodes.length !== next.nodes.length) return true;
  const previousIds = new Set(previous.nodes.map((node) => node.id));
  return next.nodes.some((node) => !previousIds.has(node.id));
}

export type CanonicalRefreshSnapshot = {
  canonicalEpoch: number;
  graphEpoch: number;
  stateRevision: string;
};

export function canonicalRefreshDisposition(
  requested: CanonicalRefreshSnapshot,
  current: CanonicalRefreshSnapshot,
): CanonicalRefreshDisposition {
  if (
    requested.canonicalEpoch < current.canonicalEpoch
    || requested.stateRevision !== current.stateRevision
  ) return "stale";
  if (requested.graphEpoch < current.graphEpoch) return "preserve_local";
  return "replace";
}

export function enqueueGraphWrite(
  queue: { current: Promise<void> },
  getRevision: () => string,
  setRevision: (revision: string) => void,
  transport: (path: GraphWritePath, request: { base_state_revision: string; graph: SomiteGraph; input_origin_id?: string }) => Promise<GraphWriteResponse>,
  path: GraphWritePath,
  snapshot: GraphWriteSnapshot,
  minimumEpoch: () => number = () => 0,
) {
  const operation = queue.current.then(async () => {
    if (snapshot.epoch < minimumEpoch()) return;
    const validation = validateGraph(snapshot.graph);
    if (!validation.ok) throw new Error(validation.issue.message);
    const response = await transport(path, {
      base_state_revision: getRevision(),
      graph: snapshot.graph,
      ...(snapshot.input_origin_id ? { input_origin_id: snapshot.input_origin_id } : {}),
    });
    commitIfCanonicalEpochCurrent(snapshot.epoch, minimumEpoch, () => {
      setRevision(response.state_revision);
    });
  });
  queue.current = operation.catch(() => undefined);
  return operation;
}
