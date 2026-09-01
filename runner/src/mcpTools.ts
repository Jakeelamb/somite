/** Canonical tool identities for Somite's capability-scoped stdio MCP boundary. */
export const SOMITE_MCP_TOOL = Object.freeze({
  workflowGet: "somite.workflow.get",
  readinessGet: "somite.readiness.get",
  catalogSearch: "somite.catalog.search",
  sourceWorkflowSearchNfcore: "somite.source_workflow.search_nfcore",
  sourceWorkflowResolveNfcore: "somite.source_workflow.resolve_nfcore",
  sourceWorkflowResolveGithub: "somite.source_workflow.resolve_github",
  sourceWorkflowEdit: "somite.source_workflow.edit",
  sourceWorkflowPromote: "somite.source_workflow.promote",
  sourceSearch: "somite.source.search",
  operatorCandidateDraft: "somite.operator_candidate.draft",
  operatorCandidateProve: "somite.operator_candidate.prove",
  operatorProofStatus: "somite.operator_proof.status",
  resource: "somite.resource",
  graphApplyTransaction: "somite.graph.apply_transaction",
  workflowCompile: "somite.workflow.compile",
  runStart: "somite.run.start",
  validationStart: "somite.validation.start",
  runStatus: "somite.run.status",
  runCancel: "somite.run.cancel",
  evidenceLookup: "somite.evidence.lookup",
} as const);

export type SomiteMcpToolName = typeof SOMITE_MCP_TOOL[keyof typeof SOMITE_MCP_TOOL];

/** Exact names advertised by `tools/list`; consumers must not infer by prefix. */
export const SOMITE_MCP_TOOL_NAMES: readonly SomiteMcpToolName[] = Object.freeze(Object.values(SOMITE_MCP_TOOL));

const SOMITE_MCP_TOOL_NAME_SET: ReadonlySet<string> = new Set(SOMITE_MCP_TOOL_NAMES);

export function isSomiteMcpToolName(value: unknown): value is SomiteMcpToolName {
  return typeof value === "string" && SOMITE_MCP_TOOL_NAME_SET.has(value);
}
