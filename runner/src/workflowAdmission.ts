import { assessWorkflow, type WorkflowAssessment } from "@somite/workflow/assessment";
import type { OperatorCatalog } from "@somite/workflow/catalog";
import type { SomiteGraph } from "@somite/workflow/model";

export class WorkflowAdmissionError extends Error {
  readonly assessment: WorkflowAssessment;

  constructor(action: string, assessment: WorkflowAssessment) {
    const detail = assessment.state === "empty"
      ? "add at least one operator"
      : assessment.items.map((item) => `${item.title}: ${item.detail}`).join("; ")
        || `resolve ${assessment.required_count} required item${assessment.required_count === 1 ? "" : "s"}`;
    super(`workflow is not ready to ${action}: ${detail}`);
    this.name = "WorkflowAdmissionError";
    this.assessment = assessment;
  }
}

/** One honest execution/export admission boundary shared by every caller. */
export function requireReadyWorkflow(graph: SomiteGraph, catalog: OperatorCatalog, action: string) {
  const assessment = assessWorkflow(graph, catalog);
  if (assessment.state !== "ready") throw new WorkflowAdmissionError(action, assessment);
  return assessment;
}
