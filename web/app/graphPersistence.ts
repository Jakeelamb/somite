import type { GraphWriteResponse, SomiteGraph } from "./types";

export type GraphWritePath = "/api/graph" | "/api/graph/autosave";
export type GraphWriteSnapshot = { graph: SomiteGraph; epoch: number };

export function captureGraphWrite(graph: SomiteGraph, epoch: number): GraphWriteSnapshot {
  return { graph, epoch };
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
  transport: (path: GraphWritePath, request: { base_state_revision: string; graph: SomiteGraph }) => Promise<GraphWriteResponse>,
  path: GraphWritePath,
  snapshot: GraphWriteSnapshot,
  minimumEpoch: () => number = () => 0,
) {
  const operation = queue.current.then(async () => {
    if (snapshot.epoch < minimumEpoch()) return;
    const response = await transport(path, { base_state_revision: getRevision(), graph: snapshot.graph });
    commitIfCanonicalEpochCurrent(snapshot.epoch, minimumEpoch, () => {
      setRevision(response.state_revision);
    });
  });
  queue.current = operation.catch(() => undefined);
  return operation;
}
