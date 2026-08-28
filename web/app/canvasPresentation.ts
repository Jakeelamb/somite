import type { CanvasAnnotation, CanvasColor, CanvasPoint } from "./types";

export const canvasPalette: Array<{ color: CanvasColor; label: string; hex: string }> = [
  { color: "blue", label: "Input", hex: "#5ba8ff" },
  { color: "teal", label: "QC", hex: "#46c8bd" },
  { color: "violet", label: "Analysis", hex: "#9c7cff" },
  { color: "yellow", label: "Review", hex: "#e4b84f" },
  { color: "green", label: "Output", hex: "#62c77e" },
  { color: "orange", label: "Next", hex: "#e6954f" },
  { color: "rose", label: "Attention", hex: "#df7185" },
  { color: "gray", label: "Neutral", hex: "#8b949b" },
];

export function canvasColor(color?: CanvasColor) {
  return canvasPalette.find((entry) => entry.color === color) ?? canvasPalette.at(-1)!;
}

export function nextAnnotationId(kind: CanvasAnnotation["kind"], annotations: CanvasAnnotation[]) {
  const stem = kind === "sticky" ? "note" : kind;
  const used = new Set(annotations.map((annotation) => annotation.id));
  let index = 1;
  while (used.has(`${stem}-${index}`)) index += 1;
  return `${stem}-${index}`;
}

export function createCanvasAnnotation(
  kind: "sticky" | "box",
  color: CanvasColor,
  position: CanvasPoint,
  annotations: CanvasAnnotation[],
): CanvasAnnotation {
  return {
    id: nextAnnotationId(kind, annotations),
    kind,
    text: "",
    color,
    layout: position,
    width: kind === "sticky" ? 220 : 360,
    height: kind === "sticky" ? 140 : 220,
  };
}

export function appendStrokePoint(points: CanvasPoint[], point: CanvasPoint, minimumDistance = 2) {
  const previous = points.at(-1);
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < minimumDistance) return points;
  return [...points, point];
}

export function strokePath(points: CanvasPoint[]) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}
