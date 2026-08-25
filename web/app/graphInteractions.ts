import type { AxialEdge, AxialGraphNode, AxialPort, Operator, PortSpec } from "./types";

export type PendingConnection = {
  nodeId: string;
  port: AxialPort;
  position: { x: number; y: number };
};

export function nextContinuationPosition(origin: { x: number; y: number }, direction: AxialPort["dir"], occupied: Array<{ x: number; y: number }>) {
  const x = origin.x + (direction === "out" ? 240 : -240);
  for (const offset of [0, 180, -180, 360, -360]) {
    const candidate = { x, y: origin.y + offset };
    const overlaps = occupied.some((position) => Math.abs(position.x - candidate.x) < 190 && Math.abs(position.y - candidate.y) < 130);
    if (!overlaps) return candidate;
  }
  return { x, y: origin.y + 540 };
}

function accepts(source: Pick<AxialPort, "ty"> | Pick<PortSpec, "type">, target: Pick<AxialPort, "ty" | "union"> | Pick<PortSpec, "type" | "union">) {
  const sourceType = "ty" in source ? source.ty : source.type;
  const targetType = "ty" in target ? target.ty : target.type;
  return sourceType === targetType || target.union?.includes(sourceType) === true;
}

export function compatibleOperatorPorts(operator: Operator, pending: PendingConnection): PortSpec[] {
  const candidates = pending.port.dir === "out" ? operator.ports.in : operator.ports.out;
  return candidates.filter((candidate) => pending.port.dir === "out"
    ? accepts(pending.port, candidate)
    : accepts(candidate, pending.port));
}

export function operatorContinues(operator: Operator, pending: PendingConnection) {
  return compatibleOperatorPorts(operator, pending).length > 0;
}

export function continuationEdge(operator: Operator, newNode: AxialGraphNode, pending: PendingConnection): AxialEdge | null {
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
