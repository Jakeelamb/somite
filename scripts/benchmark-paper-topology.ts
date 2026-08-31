import type { SomiteGraph } from "@somite/workflow/model";

export function matchingNodes(graph: SomiteGraph, selector: string) {
  if (selector.startsWith("gap:")) {
    const tool = selector.slice(4).toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
    return graph.nodes.filter((graphNode) => graphNode.operator === "gap.missing"
      && String(graphNode.params?.tool ?? "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "") === tool);
  }
  return graph.nodes.filter((graphNode) => graphNode.operator === selector);
}

function reachableMatches(graph: SomiteGraph, fromNodeIds: readonly string[], selector: string) {
  const destinations = new Map<string, string[]>();
  for (const edge of graph.edges) destinations.set(edge.from_node, [...(destinations.get(edge.from_node) ?? []), edge.to_node]);
  const pending = [...fromNodeIds];
  const targets = new Set(matchingNodes(graph, selector).map((graphNode) => graphNode.id));
  const seen = new Set<string>();
  const matches = new Set<string>();
  while (pending.length) {
    const current = pending.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (targets.has(current)) matches.add(current);
    pending.push(...(destinations.get(current) ?? []));
  }
  return matches;
}

export function hasOrderedPath(graph: SomiteGraph, selectors: readonly string[]) {
  if (!selectors.length) return false;
  let frontier = new Set(matchingNodes(graph, selectors[0]!).map((graphNode) => graphNode.id));
  for (const selector of selectors.slice(1)) {
    frontier = reachableMatches(graph, [...frontier], selector);
    if (!frontier.size) return false;
  }
  return frontier.size > 0;
}

export function hasSharedRootBranch(graph: SomiteGraph, root: string, arms: readonly string[]) {
  return matchingNodes(graph, root).some((rootNode) => arms.every((arm) => reachableMatches(graph, [rootNode.id], arm).size > 0));
}
