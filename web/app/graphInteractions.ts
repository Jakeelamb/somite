import type { SomiteEdge, SomiteGraphNode, SomitePort, Operator, PortSpec } from "./types";

export type PendingConnection = {
  nodeId: string;
  port: SomitePort;
  position: { x: number; y: number };
  /** Scientific resource contract required or provided by this endpoint. */
  resourceProfile?: string;
};

const IMPORTED_COLUMN_PITCH = 360;
const IMPORTED_ROW_PITCH = 184;

/**
 * Rebuild engine-authored rank/row coordinates around Somite's complete visual
 * footprint. Imported nodes have labels and ports outside their card, so the
 * raw engine pitch is not sufficient when viewers are expanded.
 */
export function normalizeImportedNodeLayouts<T extends SomiteGraphNode>(nodes: readonly T[]): T[] {
  const columns = new Map<number, T[]>();
  for (const node of nodes) {
    const column = columns.get(node.layout.x);
    if (column) column.push(node);
    else columns.set(node.layout.x, [node]);
  }

  const normalized = new Map<string, { x: number; y: number }>();
  [...columns.entries()]
    .sort(([left], [right]) => left - right)
    .forEach(([, column], columnIndex) => {
      column
        .toSorted((left, right) => left.layout.y - right.layout.y || left.id.localeCompare(right.id))
        .forEach((node, rowIndex) => {
          normalized.set(node.id, {
            x: columnIndex * IMPORTED_COLUMN_PITCH,
            y: rowIndex * IMPORTED_ROW_PITCH,
          });
        });
    });

  return nodes.map((node) => ({ ...node, layout: normalized.get(node.id) ?? node.layout }));
}

export function nextContinuationPosition(origin: { x: number; y: number }, direction: SomitePort["dir"], occupied: Array<{ x: number; y: number }>) {
  const x = origin.x + (direction === "out" ? 240 : -240);
  for (const offset of [0, 180, -180, 360, -360]) {
    const candidate = { x, y: origin.y + offset };
    const overlaps = occupied.some((position) => Math.abs(position.x - candidate.x) < 190 && Math.abs(position.y - candidate.y) < 130);
    if (!overlaps) return candidate;
  }
  return { x, y: origin.y + 540 };
}

function accepts(
  source: Pick<SomitePort, "ty"> | Pick<PortSpec, "type">,
  target: Pick<SomitePort, "ty" | "union"> | Pick<PortSpec, "type" | "union">,
  providedProfile?: string,
  requiredProfile?: string,
) {
  const sourceType = "ty" in source ? source.ty : source.type;
  const targetType = "ty" in target ? target.ty : target.type;
  const physicalTypeMatches = sourceType === targetType || target.union?.includes(sourceType) === true;
  return physicalTypeMatches && (!requiredProfile || providedProfile === requiredProfile);
}

export function compatibleOperatorPorts(operator: Operator, pending: PendingConnection): PortSpec[] {
  const candidates = pending.port.dir === "out" ? operator.ports.in : operator.ports.out;
  return candidates.filter((candidate) => pending.port.dir === "out"
    ? accepts(pending.port, candidate, pending.resourceProfile, candidate.resource?.profile)
    : accepts(candidate, pending.port, candidate.resource_profile, pending.resourceProfile));
}

export function operatorContinues(operator: Operator, pending: PendingConnection) {
  return compatibleOperatorPorts(operator, pending).length > 0;
}

export function continuationEdge(operator: Operator, newNode: SomiteGraphNode, pending: PendingConnection): SomiteEdge | null {
  const candidates = compatibleOperatorPorts(operator, pending);
  const port = candidates.find((candidate) => candidate.name === pending.port.name) ?? candidates[0];
  if (!port) return null;
  const fromNode = pending.port.dir === "out" ? pending.nodeId : newNode.id;
  const fromPort = pending.port.dir === "out" ? pending.port.name : port.name;
  const toNode = pending.port.dir === "out" ? newNode.id : pending.nodeId;
  const toPort = pending.port.dir === "out" ? port.name : pending.port.name;
  return {
    id: `e-${fromNode}-${fromPort}-${toNode}-${toPort}`,
    from_node: fromNode,
    from_port: fromPort,
    to_node: toNode,
    to_port: toPort,
  };
}
