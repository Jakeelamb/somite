import { operatorPorts, type Operator } from "@somite/workflow/catalog";
import type { ParamValue, SomiteEdge, SomiteGraphNode } from "@somite/workflow/model";

import type { SourceRequest } from "./sourceBuilder";

export type PublicSourceGraph = Readonly<{
  nodes: SomiteGraphNode[];
  edges: SomiteEdge[];
}>;

function graphNode(operator: Operator, id: string, layout: { x: number; y: number }, params: Record<string, ParamValue> = {}): SomiteGraphNode {
  const defaults = Object.fromEntries(
    Object.entries(operator.params)
      .filter(([, spec]) => spec.default !== undefined)
      .map(([key, spec]) => [key, spec.default as ParamValue]),
  );
  return {
    id,
    operator: operator.id,
    operator_revision: operator.revision ?? "",
    ports: operatorPorts(operator),
    params: { ...defaults, ...params },
    layout,
  };
}

function nextId(operator: Operator, used: Set<string>) {
  const stem = operator.id.split(".").at(-1)?.replaceAll(/[^a-z0-9]/gi, "") || "node";
  let index = 1;
  while (used.has(`${stem}${index}`)) index += 1;
  const id = `${stem}${index}`;
  used.add(id);
  return id;
}

/** Build the exact native graph slice created when a public-data result is selected. */
export function buildPublicSourceGraph(
  request: SourceRequest,
  operators: ReadonlyMap<string, Operator>,
  existingNodes: readonly SomiteGraphNode[],
  origin: { x: number; y: number },
): PublicSourceGraph {
  const used = new Set(existingNodes.map((node) => node.id));
  const nodes: SomiteGraphNode[] = [];
  const edges: SomiteEdge[] = [];
  const requireOperator = (id: string) => {
    const operator = operators.get(id);
    if (!operator) throw new Error(`${id} operator is missing`);
    return operator;
  };
  const add = (operatorId: string, offset: number, params: Record<string, ParamValue> = {}) => {
    const operator = requireOperator(operatorId);
    const node = graphNode(operator, nextId(operator, used), { x: origin.x + offset, y: origin.y }, params);
    nodes.push(node);
    return node;
  };

  if (request.kind === "sra") {
    if (request.read_layout !== "single" && request.read_layout !== "paired") {
      throw new Error(`SRA library layout is unresolved for ${request.value}`);
    }
    const prefetch = add("sra.prefetch", 0, { accession: request.value });
    const converter = add(request.read_layout === "paired" ? "sra.fasterq_dump" : "sra.fasterq_dump_single", 240);
    edges.push({
      id: `e-${prefetch.id}-sra-${converter.id}-sra`,
      from_node: prefetch.id,
      from_port: "sra",
      to_node: converter.id,
      to_port: "sra",
    });
  } else if (request.kind === "assembly") {
    const download = add("ncbi.datasets_assembly", 0, { accession: request.value });
    const extract = add("ncbi.datasets_extract_assembly", 240);
    edges.push({
      id: `e-${download.id}-package-${extract.id}-package`,
      from_node: download.id,
      from_port: "package",
      to_node: extract.id,
      to_port: "package",
    });
  } else {
    add("ensembl.sequence", 0, {
      accession: request.value,
      sequence_type: request.sequenceType ?? request.sequence_type ?? "genomic",
    });
  }

  return { nodes, edges };
}
