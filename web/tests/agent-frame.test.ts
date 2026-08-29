import assert from "node:assert/strict";
import test from "node:test";
import { clampAgentFrame } from "../app/agentFrame.ts";

test("an Agent frame saved on a larger display is brought fully into the current viewport", () => {
  const frame = clampAgentFrame(
    { left: 1765, top: 669, width: 360, height: 499 },
    { width: 1463, height: 813 },
    false,
  );

  assert.deepEqual(frame, { left: 1095, top: 306, width: 360, height: 499 });
  assert.ok(frame.left !== null && frame.left + frame.width <= 1463 - 8);
  assert.ok(frame.top + frame.height <= 813 - 8);
});

test("the default Agent frame remains right anchored", () => {
  assert.deepEqual(
    clampAgentFrame(
      { left: null, top: 16, width: 360, height: 500 },
      { width: 1463, height: 739 },
      false,
    ),
    { left: null, top: 16, width: 360, height: 500 },
  );
});

test("a collapsed Agent keeps its expanded height while its visible header is clamped", () => {
  assert.deepEqual(
    clampAgentFrame(
      { left: 1765, top: 669, width: 360, height: 499 },
      { width: 1463, height: 739 },
      true,
    ),
    { left: 1095, top: 669, width: 360, height: 499 },
  );
});
