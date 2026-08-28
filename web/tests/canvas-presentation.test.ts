import assert from "node:assert/strict";
import test from "node:test";
import { appendStrokePoint, createCanvasAnnotation, nextAnnotationId, strokePath } from "../app/canvasPresentation.ts";
import type { CanvasAnnotation } from "../app/types.ts";

test("canvas annotations get stable human-readable ids and useful defaults", () => {
  const existing: CanvasAnnotation[] = [{ id: "note-1", kind: "sticky", text: "", color: "yellow", layout: { x: 0, y: 0 }, width: 220, height: 140 }];
  assert.equal(nextAnnotationId("sticky", existing), "note-2");
  assert.deepEqual(createCanvasAnnotation("box", "violet", { x: 40, y: 60 }, existing), {
    id: "box-1", kind: "box", text: "", color: "violet", layout: { x: 40, y: 60 }, width: 360, height: 220,
  });
});

test("pen strokes ignore pointer noise and serialize to a simple path", () => {
  let points = [{ x: 10, y: 12 }];
  points = appendStrokePoint(points, { x: 11, y: 12 });
  assert.equal(points.length, 1);
  points = appendStrokePoint(points, { x: 16, y: 18 });
  assert.equal(strokePath(points), "M 10 12 L 16 18");
});
