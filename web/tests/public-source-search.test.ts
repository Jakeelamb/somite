import assert from "node:assert/strict";
import test from "node:test";

import { publicSourceOutcome } from "../app/publicSourceSearch.ts";

test("public source status distinguishes genuine zero results from provider failure", () => {
  assert.deepEqual(publicSourceOutcome(false, true, 0, {}), {
    tone: "empty",
    message: "No public data matches in NCBI or Ensembl · tools and workflows remain below",
    failed: [],
  });
  const degraded = publicSourceOutcome(false, true, 0, { ensembl: "503" });
  assert.equal(degraded.tone, "degraded");
  assert.match(degraded.message, /not a complete search/);
  assert.doesNotMatch(degraded.message, /^No public data matches/);
});

test("partial public results remain usable and complete failure retains retry context", () => {
  const partial = publicSourceOutcome(false, true, 3, { ncbi: "timeout" });
  assert.equal(partial.tone, "degraded");
  assert.match(partial.message, /Results from the other provider remain usable/);
  const unavailable = publicSourceOutcome(false, true, 0, { ncbi: "timeout", ensembl: "503" });
  assert.equal(unavailable.tone, "unavailable");
  assert.match(unavailable.message, /search is retained.*retry/i);
});
