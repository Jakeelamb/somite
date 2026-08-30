import type {
  CanvasAnnotation,
  SomiteEdge,
  SomiteGraph,
  SomiteGraphNode,
  SourceWorkflowVariantOrigin,
} from "./types";
import { semanticGraphKey } from "@somite/workflow/workflow";

export type ProjectedFlowNode = Record<string, unknown> & {
  position: { x: number; y: number };
  data: { graphNode: SomiteGraphNode };
};

export type ProjectedFlowEdge = Record<string, unknown> & {
  data?: { somite: SomiteEdge };
};

export type GraphProjectionInput = {
  name: string;
  nodes: readonly ProjectedFlowNode[];
  edges: readonly ProjectedFlowEdge[];
  annotations: readonly CanvasAnnotation[];
  variantOrigin?: SourceWorkflowVariantOrigin;
};

export type GraphProjection = {
  graph: SomiteGraph;
  graphChanged: boolean;
  semanticChanged: boolean;
  semanticKey: string;
};

function projectGraph(input: GraphProjectionInput): SomiteGraph {
  return {
    schema_version: 3,
    name: input.name,
    nodes: input.nodes.map((node) => ({
      ...node.data.graphNode,
      layout: { x: node.position.x, y: node.position.y },
    })),
    edges: input.edges
      .map((edge) => edge.data?.somite)
      .filter((edge): edge is SomiteEdge => Boolean(edge)),
    annotations: [...input.annotations],
    ...(input.variantOrigin ? { variant_origin: input.variantOrigin } : {}),
  };
}

/**
 * Maintains the browser's graph projection without serializing the entire graph
 * on every React Flow presentation update. Its identity arrays are reused and
 * resized in place as the graph changes.
 */
export class GraphProjectionClock {
  readonly #nodeRefs: SomiteGraphNode[] = [];
  readonly #nodeX: number[] = [];
  readonly #nodeY: number[] = [];
  readonly #edgeRefs: SomiteEdge[] = [];
  #name = "";
  #annotations: readonly CanvasAnnotation[] = [];
  #variantOrigin: SourceWorkflowVariantOrigin | undefined;
  #graph: SomiteGraph = { schema_version: 3, name: "", nodes: [], edges: [], annotations: [] };
  #semanticKey = "";
  #initialized = false;

  observe(input: GraphProjectionInput): GraphProjection {
    let graphChanged = !this.#initialized
      || this.#name !== input.name
      || this.#variantOrigin !== input.variantOrigin
      || (this.#annotations !== input.annotations && (this.#annotations.length > 0 || input.annotations.length > 0))
      || this.#nodeRefs.length !== input.nodes.length;
    let semanticCandidate = !this.#initialized || this.#nodeRefs.length !== input.nodes.length;

    const nodeCount = Math.min(this.#nodeRefs.length, input.nodes.length);
    for (let index = 0; index < nodeCount; index += 1) {
      const node = input.nodes[index]!;
      if (this.#nodeRefs[index] !== node.data.graphNode) {
        graphChanged = true;
        semanticCandidate = true;
      }
      if (this.#nodeX[index] !== node.position.x || this.#nodeY[index] !== node.position.y) graphChanged = true;
    }

    let projectedEdgeCount = 0;
    for (const candidate of input.edges) {
      const edge = candidate.data?.somite;
      if (!edge) continue;
      if (this.#edgeRefs[projectedEdgeCount] !== edge) {
        graphChanged = true;
        semanticCandidate = true;
      }
      projectedEdgeCount += 1;
    }
    if (this.#edgeRefs.length !== projectedEdgeCount) {
      graphChanged = true;
      semanticCandidate = true;
    }

    if (!graphChanged) return { graph: this.#graph, graphChanged: false, semanticChanged: false, semanticKey: this.#semanticKey };
    const previousSemanticKey = this.#semanticKey;
    this.#record(input);
    this.#graph = projectGraph(input);
    if (semanticCandidate) this.#semanticKey = semanticGraphKey(this.#graph);
    return {
      graph: this.#graph,
      graphChanged: true,
      semanticChanged: !this.#initialized || previousSemanticKey !== this.#semanticKey,
      semanticKey: this.#semanticKey,
    };
  }

  prime(graph: SomiteGraph, input?: GraphProjectionInput) {
    const nextSemanticKey = semanticGraphKey(graph);
    const semanticChanged = !this.#initialized || this.#semanticKey !== nextSemanticKey;
    if (input) this.#record(input);
    else this.#recordGraph(graph);
    this.#graph = graph;
    this.#semanticKey = nextSemanticKey;
    return { graph, semanticChanged, semanticKey: this.#semanticKey };
  }

  #record(input: GraphProjectionInput) {
    this.#initialized = true;
    this.#name = input.name;
    this.#annotations = input.annotations;
    this.#variantOrigin = input.variantOrigin;
    this.#nodeRefs.length = input.nodes.length;
    this.#nodeX.length = input.nodes.length;
    this.#nodeY.length = input.nodes.length;
    for (let index = 0; index < input.nodes.length; index += 1) {
      const node = input.nodes[index]!;
      this.#nodeRefs[index] = node.data.graphNode;
      this.#nodeX[index] = node.position.x;
      this.#nodeY[index] = node.position.y;
    }
    let projectedEdgeCount = 0;
    for (const candidate of input.edges) {
      const edge = candidate.data?.somite;
      if (!edge) continue;
      this.#edgeRefs[projectedEdgeCount] = edge;
      projectedEdgeCount += 1;
    }
    this.#edgeRefs.length = projectedEdgeCount;
  }

  #recordGraph(graph: SomiteGraph) {
    this.#initialized = true;
    this.#name = graph.name ?? "";
    this.#annotations = graph.annotations ?? [];
    this.#variantOrigin = graph.variant_origin;
    this.#nodeRefs.length = graph.nodes.length;
    this.#nodeX.length = graph.nodes.length;
    this.#nodeY.length = graph.nodes.length;
    for (let index = 0; index < graph.nodes.length; index += 1) {
      const node = graph.nodes[index]!;
      this.#nodeRefs[index] = node;
      this.#nodeX[index] = node.layout.x;
      this.#nodeY[index] = node.layout.y;
    }
    this.#edgeRefs.length = graph.edges.length;
    for (let index = 0; index < graph.edges.length; index += 1) this.#edgeRefs[index] = graph.edges[index];
  }
}
