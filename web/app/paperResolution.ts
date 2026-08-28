import type { PaperCandidate, ReadinessItem } from "./types";

export function paperAttentionItems(candidate: PaperCandidate | null | undefined) {
  return candidate?.assessment.items ?? [];
}

export function paperSupportedCount(candidate: PaperCandidate | null | undefined) {
  return candidate?.assessment.nodes.filter((node) => !node.requires_action).length ?? 0;
}

export function paperParameterValue(candidate: PaperCandidate, nodeId: string, field: string) {
  const value = candidate.graph.nodes.find((node) => node.id === nodeId)?.params?.[field];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function paperResolutionAgentPrompt(candidate: PaperCandidate, item: ReadinessItem) {
  const evidence = candidate.evidence.find((entry) => entry.target_kind === "node" && entry.target_id === item.node_id);
  const choices = item.resolutions.map((resolution) => `- ${resolution.label}: ${resolution.detail}`).join("\n");
  const recipes = item.recipes.map((recipe) => [
    `- ${recipe.title} (recipe ${recipe.version}): ${recipe.summary}`,
    ...recipe.steps.map((step, index) => `  ${index + 1}. ${step}`),
  ].join("\n")).join("\n");
  return [
    "Help resolve this scientific ambiguity from a Somite paper reconstruction.",
    `Workflow: ${candidate.name}`,
    `Graph revision: ${candidate.assessment.graph_revision}`,
    `Requirement: ${item.id}`,
    `Node: ${item.node_id} (${item.operator_id})`,
    `Kind: ${item.kind}`,
    `Detail: ${item.detail}`,
    evidence ? `Paper evidence${evidence.source_location ? ` (${evidence.source_location})` : ""}: ${evidence.detail}` : "",
    choices ? `Known deterministic choices:\n${choices}` : "",
    recipes ? `Reviewed recipes:\n${recipes}` : "",
    "Use Somite tools immediately. Preserve the reported method, treat the assessment as final authority, and do not make an unsupported scientific substitution. Use web research only if the retained evidence and official recipe source are insufficient.",
  ].filter(Boolean).join("\n");
}
