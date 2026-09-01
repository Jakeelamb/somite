import type { PaperCandidate, ReadinessItem, SomiteGraph, SomiteGraphNode } from "./types";
import { normalizeImportedNodeLayouts } from "./graphInteractions.ts";

export function paperAttentionItems(candidate: PaperCandidate | null | undefined) {
  return candidate?.assessment.items ?? [];
}

export function paperSupportedCount(candidate: PaperCandidate | null | undefined) {
  return candidate?.assessment.nodes.filter((node) => node.operator_id !== "gap.missing" && !node.requires_action).length ?? 0;
}

export function paperParameterValue(candidate: PaperCandidate, nodeId: string, field: string) {
  const value = candidate.graph.nodes.find((node) => node.id === nodeId)?.params?.[field];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

type PaperReadRole = "r1" | "r2";

type PaperReadSlotPlan = {
  outputPorts: Map<string, string>;
  additions: { outputPort: PaperReadRole; toNode: string; toPort: PaperReadRole }[];
};

function acceptsFastqRole(node: SomiteGraphNode | undefined, role: PaperReadRole) {
  const port = node?.ports.find((candidate) => candidate.dir === "in" && candidate.name === role);
  return Boolean(port && (port.ty === "Fastq" || port.union?.includes("Fastq")));
}

function paperReadSlotPlan(
  graph: SomiteGraph,
  slot: SomiteGraphNode,
  requestedLayout?: "single" | "paired",
): PaperReadSlotPlan | null {
  const layout = requestedLayout ?? (slot.operator === "files.import_paired" ? "paired" : "single");
  const outgoing = graph.edges.filter((edge) => edge.from_node === slot.id);
  if (slot.operator === "files.import_paired") {
    if (layout !== "paired" || outgoing.some((edge) => edge.from_port !== "r1" && edge.from_port !== "r2")) return null;
    return { outputPorts: new Map(outgoing.map((edge) => [edge.id, edge.from_port])), additions: [] };
  }
  if (slot.operator !== "files.import") return null;
  if (outgoing.some((edge) => edge.from_port !== "file")) return null;
  if (layout === "single") {
    if (outgoing.length > 1) return null;
    return { outputPorts: new Map(outgoing.map((edge) => [edge.id, "reads"])), additions: [] };
  }
  if (outgoing.length < 1 || outgoing.length > 2) return null;
  const target = outgoing[0]?.to_node;
  const targetNode = graph.nodes.find((node) => node.id === target);
  const roles = new Set(outgoing.map((edge) => edge.to_port));
  if (!target || outgoing.some((edge) => edge.to_node !== target)
    || roles.size !== outgoing.length
    || [...roles].some((role) => role !== "r1" && role !== "r2")
    || graph.edges.some((edge) => edge.from_node !== slot.id && edge.to_node === target && (edge.to_port === "r1" || edge.to_port === "r2"))
    || !acceptsFastqRole(targetNode, "r1")
    || !acceptsFastqRole(targetNode, "r2")) return null;
  const additions = (["r1", "r2"] as const)
    .filter((role) => !roles.has(role))
    .map((role) => ({ outputPort: role, toNode: target, toPort: role }));
  return {
    outputPorts: new Map(outgoing.map((edge) => [edge.id, edge.to_port])),
    additions,
  };
}

export function nextPaperReadSlot(candidate: PaperCandidate | null | undefined, readLayout?: "single" | "paired") {
  return candidate?.graph.nodes.find((node) => {
    if (node.operator === "files.import_paired") {
      return !String(node.params?.r1 ?? "").trim()
        && !String(node.params?.r2 ?? "").trim()
        && paperReadSlotPlan(candidate.graph, node, readLayout) !== null;
    }
    return node.operator === "files.import"
      && !String(node.params?.path ?? "").trim()
      && paperReadSlotPlan(candidate.graph, node, readLayout) !== null;
  }) ?? null;
}

export function paperResourceApplied(candidate: PaperCandidate | null | undefined, accession: string) {
  return candidate?.graph.nodes.some((node) => node.operator === "sra.prefetch" && node.params?.accession === accession) ?? false;
}

/** Install a paper draft as a complete document, never as a partial canvas overlay. */
export function paperCandidateDocument(candidate: PaperCandidate): SomiteGraph {
  return {
    ...candidate.graph,
    name: candidate.name,
    nodes: normalizeImportedNodeLayouts(candidate.graph.nodes),
    annotations: candidate.graph.annotations ?? [],
    variant_origin: candidate.graph.variant_origin,
  };
}

function sameGraphValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function paperCanvasOwnsCandidate(previous: SomiteGraph, canvas: SomiteGraph) {
  if (previous.nodes.length === 0 || canvas.nodes.some((node) => Boolean(node.source_workflow))) return false;
  const canvasNodes = new Map(canvas.nodes.map((node) => [node.id, node]));
  if (!previous.nodes.every((node) => {
    const current = canvasNodes.get(node.id);
    return current
      && !current.source_workflow
      && current.operator === node.operator
      && current.operator_revision === node.operator_revision
      && sameGraphValue(current.ports, node.ports);
  })) return false;

  const canvasEdges = new Map(canvas.edges.map((edge) => [edge.id, edge]));
  return previous.edges.every((edge) => {
    const current = canvasEdges.get(edge.id);
    return current
      && current.from_node === edge.from_node
      && current.from_port === edge.from_port
      && current.to_node === edge.to_node
      && current.to_port === edge.to_port;
  });
}

export function paperCanvasUpdate(
  appliedCandidate: number | null,
  candidateIndex: number,
  previous: SomiteGraph,
  updated: SomiteGraph,
  canvas: SomiteGraph,
) {
  if (appliedCandidate !== candidateIndex || !paperCanvasOwnsCandidate(previous, canvas)) return null;

  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const updatedNodeIds = new Set(updated.nodes.map((node) => node.id));
  const removedNodeIds = new Set(previous.nodes.filter((node) => !updatedNodeIds.has(node.id)).map((node) => node.id));
  const changedNodes = updated.nodes.filter((node) => {
    const prior = previousNodes.get(node.id);
    return !prior || !sameGraphValue(prior, node);
  });
  const changedNodeIds = new Set(changedNodes.map((node) => node.id));
  const canvasNodes = new Map(canvas.nodes.map((node) => [node.id, node]));
  const nodes = [
    ...canvas.nodes.filter((node) => !removedNodeIds.has(node.id) && !changedNodeIds.has(node.id)),
    ...changedNodes.map((node) => {
      const current = canvasNodes.get(node.id);
      return current ? { ...node, layout: current.layout, color: current.color ?? node.color } : node;
    }),
  ];

  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const updatedEdgeIds = new Set(updated.edges.map((edge) => edge.id));
  const changedEdges = updated.edges.filter((edge) => {
    const prior = previousEdges.get(edge.id);
    return !prior || !sameGraphValue(prior, edge);
  });
  const changedEdgeIds = new Set(changedEdges.map((edge) => edge.id));
  const removedEdgeIds = new Set(previous.edges.filter((edge) => !updatedEdgeIds.has(edge.id)).map((edge) => edge.id));
  const edges = [
    ...canvas.edges.filter((edge) => !removedEdgeIds.has(edge.id)
      && !changedEdgeIds.has(edge.id)
      && !removedNodeIds.has(edge.from_node)
      && !removedNodeIds.has(edge.to_node)),
    ...changedEdges,
  ];

  return { ...canvas, nodes, edges };
}

export function replacePaperReadSlot(
  graph: SomiteGraph,
  slotId: string,
  prefetch: SomiteGraphNode,
  fasterq: SomiteGraphNode,
) {
  const slot = graph.nodes.find((node) => node.id === slotId);
  if (!slot || !["files.import", "files.import_paired"].includes(slot.operator)) return graph;
  const single = fasterq.operator === "sra.fasterq_dump_single";
  const plan = paperReadSlotPlan(graph, slot, single ? "single" : "paired");
  if (!plan) return graph;
  const rewired = graph.edges
    .filter((edge) => edge.to_node !== slotId)
    .map((edge) => edge.from_node !== slotId ? edge : {
      ...edge,
      id: `e-${fasterq.id}-${plan.outputPorts.get(edge.id)}-${edge.to_node}-${edge.to_port}`,
      from_node: fasterq.id,
      from_port: plan.outputPorts.get(edge.id)!,
    });
  return {
    ...graph,
    nodes: [...graph.nodes.filter((node) => node.id !== slotId), prefetch, fasterq],
    edges: [
      ...rewired,
      ...plan.additions.map((addition) => ({
        id: `e-${fasterq.id}-${addition.outputPort}-${addition.toNode}-${addition.toPort}`,
        from_node: fasterq.id,
        from_port: addition.outputPort,
        to_node: addition.toNode,
        to_port: addition.toPort,
      })),
      {
        id: `e-${prefetch.id}-sra-${fasterq.id}-sra`,
        from_node: prefetch.id,
        from_port: "sra",
        to_node: fasterq.id,
        to_port: "sra",
      },
    ],
  };
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
