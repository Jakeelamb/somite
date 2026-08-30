import type { SomiteGraph, SomiteGraphNode } from "./types";

export type WorkflowCatalogLoadState = "idle" | "loading" | "loaded" | "failed";

const WORKFLOW_CATALOG_PATHS = ["/api/catalog/nfcore", "/api/catalog/snakemake"] as const;

export function workflowCatalogRequestPaths({
  sessionReady,
  libraryVisible,
  loadState,
}: {
  sessionReady: boolean;
  libraryVisible: boolean;
  loadState: WorkflowCatalogLoadState;
}): readonly [] | typeof WORKFLOW_CATALOG_PATHS {
  return sessionReady && libraryVisible && loadState === "idle" ? WORKFLOW_CATALOG_PATHS : [];
}

function representativeSourceParametersAreBindable(node: SomiteGraphNode) {
  if (node.operator === "files.import") return typeof node.params?.path === "string";
  if (node.operator === "files.import_paired") {
    return typeof node.params?.r1 === "string" && typeof node.params?.r2 === "string";
  }
  return false;
}

export function graphSupportsRepresentativeValidation(graph: SomiteGraph) {
  if (graph.nodes.length === 0) return false;
  if (graph.nodes.some((node) => node.operator === "workflow.source" || node.source_workflow)) return false;

  const roots = graph.nodes.filter((node) => {
    const hasInbound = graph.edges.some((edge) => edge.to_node === node.id);
    const hasInputPort = node.ports.some((port) => port.dir === "in");
    return !hasInbound && !hasInputPort;
  });
  return roots.length > 0 && roots.every(representativeSourceParametersAreBindable);
}

export function validationEvidenceRequestPath({
  sessionReady,
  activeIntent,
  workflowReady,
  graph,
}: {
  sessionReady: boolean;
  activeIntent: boolean;
  workflowReady: boolean;
  graph: SomiteGraph;
}) {
  return sessionReady && !activeIntent && workflowReady && graphSupportsRepresentativeValidation(graph)
    ? "/api/validations/status"
    : null;
}
