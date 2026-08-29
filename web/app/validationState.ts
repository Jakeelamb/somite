import type { EvidenceResult, RunNodeState, SomiteEdge, SomiteGraph } from "./types";

export function semanticGraphKey(graph: SomiteGraph) {
  return JSON.stringify({
    schema_version: graph.schema_version,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      operator: node.operator,
      operator_revision: node.operator_revision,
      ports: node.ports,
      params: node.params,
      source_workflow: node.source_workflow ? {
        schema_version: node.source_workflow.schema_version,
        workflow_revision: node.source_workflow.workflow_revision,
        source: node.source_workflow.source,
        profiles: node.source_workflow.profiles ?? [],
        parameters: node.source_workflow.parameters ?? [],
        bindings: Object.fromEntries(Object.entries(node.source_workflow.bindings ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      } : undefined,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

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
