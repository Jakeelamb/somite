export type CanvasBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type CanvasViewport = Readonly<{
  x: number;
  y: number;
  zoom: number;
}>;

type HostSize = Readonly<{ width: number; height: number }>;

const ENTER_COVERAGE = 0.82;
const EXIT_COVERAGE = 0.68;

function validBounds(bounds: CanvasBounds) {
  return bounds.width > 0
    && bounds.height > 0
    && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite);
}

function containerScale(portal: CanvasBounds, child: CanvasBounds) {
  if (!validBounds(portal) || !validBounds(child)) throw new Error("semantic zoom requires finite, non-empty bounds");
  return Math.min(portal.width / child.width, portal.height / child.height);
}

function centers(bounds: CanvasBounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/**
 * Rebase a parent camera into a child coordinate system. The child's fitted
 * graph occupies the exact same screen-space rectangle as its portal preview,
 * so changing semantic depth does not produce a visual jump.
 */
export function childViewport(parent: CanvasViewport, portal: CanvasBounds, child: CanvasBounds): CanvasViewport {
  const scale = containerScale(portal, child);
  const portalCenter = centers(portal);
  const childCenter = centers(child);
  const zoom = parent.zoom * scale;
  return {
    x: parent.x + parent.zoom * (portalCenter.x - scale * childCenter.x),
    y: parent.y + parent.zoom * (portalCenter.y - scale * childCenter.y),
    zoom,
  };
}

/** The exact inverse of childViewport. */
export function parentViewport(childCamera: CanvasViewport, portal: CanvasBounds, child: CanvasBounds): CanvasViewport {
  const scale = containerScale(portal, child);
  const portalCenter = centers(portal);
  const childCenter = centers(child);
  const zoom = childCamera.zoom / scale;
  return {
    x: childCamera.x - zoom * (portalCenter.x - scale * childCenter.x),
    y: childCamera.y - zoom * (portalCenter.y - scale * childCenter.y),
    zoom,
  };
}

export function screenBounds(bounds: CanvasBounds, viewport: CanvasViewport): CanvasBounds {
  return {
    x: viewport.x + bounds.x * viewport.zoom,
    y: viewport.y + bounds.y * viewport.zoom,
    width: bounds.width * viewport.zoom,
    height: bounds.height * viewport.zoom,
  };
}

export function semanticZoomIntent({
  direction,
  deltaX,
  deltaY,
  visibleBounds,
  host,
}: Readonly<{
  direction: "in" | "out";
  deltaX: number;
  deltaY: number;
  visibleBounds: CanvasBounds;
  host: HostSize;
}>): "enter" | "exit" | "none" {
  if (host.width <= 0 || host.height <= 0 || Math.abs(deltaX) > Math.abs(deltaY)) return "none";
  const coverage = Math.min(visibleBounds.width / host.width, visibleBounds.height / host.height);
  if (direction === "in" && deltaY < 0 && coverage >= ENTER_COVERAGE) return "enter";
  if (direction === "out" && deltaY > 0 && coverage <= EXIT_COVERAGE) return "exit";
  return "none";
}
