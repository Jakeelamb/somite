import assert from "node:assert/strict";
import test from "node:test";

import {
  childViewport,
  parentViewport,
  screenBounds,
  semanticZoomIntent,
  type CanvasBounds,
  type CanvasViewport,
} from "../app/semanticZoom.ts";

const portal: CanvasBounds = { x: 120, y: 80, width: 240, height: 160 };
const child: CanvasBounds = { x: -300, y: -100, width: 1_200, height: 800 };
const viewport: CanvasViewport = { x: -44, y: 31, zoom: 3.75 };

test("semantic zoom preserves the child preview when crossing into a container", () => {
  const entered = childViewport(viewport, portal, child);
  const portalOnScreen = screenBounds(portal, viewport);
  const childOnScreen = screenBounds(child, entered);

  assert.deepEqual(childOnScreen, portalOnScreen);
});

test("entering and leaving a container is an exact reversible camera transform", () => {
  const entered = childViewport(viewport, portal, child);
  const returned = parentViewport(entered, portal, child);

  assert.ok(Math.abs(returned.x - viewport.x) < 1e-9);
  assert.ok(Math.abs(returned.y - viewport.y) < 1e-9);
  assert.ok(Math.abs(returned.zoom - viewport.zoom) < 1e-12);
});

test("semantic zoom uses hysteresis and ignores sideways scroll", () => {
  const host = { width: 1_000, height: 800 };
  assert.equal(semanticZoomIntent({ direction: "in", deltaX: 0, deltaY: -60, visibleBounds: { x: 70, y: 60, width: 860, height: 690 }, host }), "enter");
  assert.equal(semanticZoomIntent({ direction: "in", deltaX: 80, deltaY: -20, visibleBounds: { x: 70, y: 60, width: 860, height: 690 }, host }), "none");
  assert.equal(semanticZoomIntent({ direction: "out", deltaX: 0, deltaY: 60, visibleBounds: { x: 180, y: 150, width: 640, height: 500 }, host }), "exit");
  assert.equal(semanticZoomIntent({ direction: "out", deltaX: 0, deltaY: 60, visibleBounds: { x: 90, y: 70, width: 820, height: 660 }, host }), "none");
});
