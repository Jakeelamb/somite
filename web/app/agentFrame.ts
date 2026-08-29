export type AgentFrame = {
  left: number | null;
  top: number;
  width: number;
  height: number;
};

export type AgentFrameBounds = {
  width: number;
  height: number;
};

const EDGE_GAP = 8;
const RIGHT_ANCHOR_GAP = 16;
const COLLAPSED_HEIGHT = 44;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function clampAgentFrame(frame: AgentFrame, bounds: AgentFrameBounds, collapsed: boolean): AgentFrame {
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
    return frame;
  }

  const rightGap = frame.left === null ? RIGHT_ANCHOR_GAP : EDGE_GAP;
  const width = Math.min(frame.width, Math.max(0, bounds.width - EDGE_GAP - rightGap));
  const height = collapsed
    ? frame.height
    : Math.min(frame.height, Math.max(0, bounds.height - EDGE_GAP * 2));
  const visibleHeight = collapsed ? COLLAPSED_HEIGHT : height;
  const left = frame.left === null
    ? null
    : clamp(frame.left, EDGE_GAP, Math.max(EDGE_GAP, bounds.width - width - EDGE_GAP));
  const top = clamp(frame.top, EDGE_GAP, Math.max(EDGE_GAP, bounds.height - visibleHeight - EDGE_GAP));

  return { left, top, width, height };
}
