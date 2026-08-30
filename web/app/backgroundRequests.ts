import type { SomiteGraph } from "./types";
import { representativeValidationCapability } from "@somite/workflow/fixtures";

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

export function graphSupportsRepresentativeValidation(graph: SomiteGraph) {
  return representativeValidationCapability(graph).supported;
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
