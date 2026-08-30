import type { SomiteEdge, SomiteGraph, SomiteGraphNode, SomitePort } from "./model.ts";
import { validateGraph } from "./workflow.ts";

type DotFlavor = "nextflow" | "snakemake";
type DotNode = { label: string; component: boolean };

function quotedAttribute(attributes: string, key: string) {
  const index = attributes.indexOf(key);
  if (index < 0) return undefined;
  let tail = attributes.slice(index + key.length).trimStart();
  if (!tail.startsWith("=")) return undefined;
  tail = tail.slice(1).trimStart();
  if (!tail.startsWith('"')) return undefined;
  let escaped = false;
  let value = "";
  for (const character of tail.slice(1)) {
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\") escaped = true;
    else if (character === '"') return value;
    else value += character;
  }
  return undefined;
}

function safeId(label: string) {
  const compact = [...label].map((character) => /[A-Za-z0-9]/.test(character) ? character.toLowerCase() : "-")
    .join("").split("-").filter(Boolean).join("-");
  return compact || "component";
}

function acceptsReads(label: string) {
  const component = (label.split(":").at(-1) ?? label).toUpperCase();
  return ["FASTQ", "FASTQC", "FASTP", "FQ_", "TRIMGALORE", "CUTADAPT", "BBSPLIT", "PORECHOP", "NANOPLOT", "FILTLONG", "CHOPPER", "UMITOOLS", "SEQKIT", "ALIGN"]
    .some((marker) => component.includes(marker));
}

function componentPorts(label: string, boundary: boolean, incomingCount: number): SomitePort[] {
  const inputs: SomitePort[] = boundary && acceptsReads(label)
    ? [
        { name: "r1", dir: "in", ty: "Fastq", union: ["FastqGz"] },
        { name: "r2", dir: "in", ty: "Fastq", union: ["FastqGz"], optional: true },
      ]
    : Array.from({ length: Math.max(1, incomingCount) }, (_, index) => ({
        name: index === 0 ? "in" : `in_${index + 1}`,
        dir: "in" as const,
        ty: "Directory" as const,
        optional: true,
      }));
  return [...inputs, { name: "out", dir: "out", ty: "Directory", optional: true }];
}

function adjacency(edges: readonly [string, string][]) {
  const adjacent = new Map<string, string[]>();
  for (const [source, target] of edges) adjacent.set(source, [...(adjacent.get(source) ?? []), target]);
  return adjacent;
}

function collapseIntermediates(components: ReadonlySet<string>, edges: readonly [string, string][]) {
  const adjacent = adjacency(edges);
  const collapsed = new Set<string>();
  for (const source of [...components].sort()) {
    const queue = [...(adjacent.get(source) ?? [])];
    const visited = new Set<string>();
    while (queue.length) {
      const next = queue.shift()!;
      if (visited.has(next)) continue;
      visited.add(next);
      if (components.has(next)) {
        if (next !== source) collapsed.add(`${source}\0${next}`);
      } else queue.push(...(adjacent.get(next) ?? []));
    }
  }
  return [...collapsed].sort().map((edge) => edge.split("\0") as [string, string]);
}

function ranks(nodes: ReadonlySet<string>, edges: readonly [string, string][]) {
  const adjacent = adjacency(edges);
  const indegree = new Map([...nodes].sort().map((node) => [node, 0]));
  for (const [, target] of edges) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  const queue = [...indegree].filter(([, count]) => count === 0).map(([node]) => node);
  const rank = new Map<string, number>();
  while (queue.length) {
    const node = queue.shift()!;
    const sourceRank = rank.get(node) ?? 0;
    for (const target of adjacent.get(node) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, sourceRank + 1));
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return rank;
}

/** Convert an engine-authored DOT outline into non-executable visual references. */
export function graphFromDot(
  flavor: DotFlavor,
  workflow: string,
  revision: string,
  referenceOperatorRevision: string,
  dot: string,
): SomiteGraph {
  const dotNodes = new Map<string, DotNode>();
  const dotEdges: [string, string][] = [];
  for (const rawLine of dot.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.includes("->")) {
      const [left, right = ""] = line.split("->", 2);
      const source = left.trim().replace(/^"|"$/g, "");
      const target = right.split(/[\[;]/, 1)[0]!.trim().replace(/^"|"$/g, "");
      if (source && target) dotEdges.push([source, target]);
      continue;
    }
    const open = line.indexOf("[");
    if (open < 0) continue;
    const id = line.slice(0, open).trim().replace(/^"|"$/g, "");
    const attributes = line.slice(open + 1).replace(/;$/, "").replace(/]$/, "");
    const label = quotedAttribute(attributes, "label");
    if (label === undefined) continue;
    const component = flavor === "snakemake" ? Boolean(label) : Boolean(label)
      && !/shape\s*=\s*(point|circle)/.test(attributes);
    dotNodes.set(id, { label, component });
  }
  const components = new Set([...dotNodes].filter(([, node]) => node.component).map(([id]) => id));
  if (!components.size) throw new Error("workflow graph did not contain any process or rule nodes");
  const componentEdges = flavor === "nextflow"
    ? collapseIntermediates(components, dotEdges)
    : dotEdges.filter(([source, target]) => components.has(source) && components.has(target));
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const dotId of [...components].sort()) {
    const label = dotNodes.get(dotId)!.label;
    const base = safeId(label.split(":").at(-1) ?? label);
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    ids.set(dotId, id);
  }
  const nodeRanks = ranks(components, componentEdges);
  const incoming = new Map<string, number>();
  const targets = new Set<string>();
  for (const [, target] of componentEdges) {
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
    targets.add(target);
  }
  const rows = new Map<number, number>();
  const nodes: SomiteGraphNode[] = [];
  for (const dotId of [...components].sort()) {
    const rank = nodeRanks.get(dotId) ?? 0;
    const row = rows.get(rank) ?? 0;
    const label = dotNodes.get(dotId)!.label;
    nodes.push({
      id: ids.get(dotId)!,
      operator: "workflow.reference",
      operator_revision: referenceOperatorRevision,
      ports: componentPorts(label, !targets.has(dotId), incoming.get(dotId) ?? 0),
      params: { engine: flavor, workflow, revision, component: label },
      layout: { x: rank * 280, y: row * 150 },
      note: `Imported from ${workflow}@${revision} · ${label}`,
    });
    rows.set(rank, row + 1);
  }
  const slots = new Map<string, number>();
  const edges: SomiteEdge[] = componentEdges.flatMap(([source, target]) => {
    const fromNode = ids.get(source);
    const toNode = ids.get(target);
    if (!fromNode || !toNode) return [];
    const slot = slots.get(toNode) ?? 0;
    const toPort = slot === 0 ? "in" : `in_${slot + 1}`;
    slots.set(toNode, slot + 1);
    return [{ id: `e-${fromNode}-out-${toNode}-${toPort}`, from_node: fromNode, from_port: "out", to_node: toNode, to_port: toPort }];
  });
  const graph: SomiteGraph = { schema_version: 3, nodes, edges };
  const validation = validateGraph(graph);
  if (!validation.ok) throw new Error(validation.issue.message);
  return graph;
}
