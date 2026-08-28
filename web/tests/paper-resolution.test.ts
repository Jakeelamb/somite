import assert from "node:assert/strict";
import test from "node:test";

import { paperAttentionItems, paperResolutionAgentPrompt, paperSupportedCount } from "../app/paperResolution.ts";
import type { PaperCandidate } from "../app/types.ts";

const candidate: PaperCandidate = {
  name: "Linkage workflow",
  role: "primary",
  assay: "assembly",
  graph: { schema_version: 2, nodes: [], edges: [] },
  warnings: [],
  evidence: [{
    target_kind: "node",
    target_id: "gatk",
    status: "explicit",
    detail: "processed with GATK 3.5",
    source_location: "PDF page 12",
  }],
  assessment: {
    graph_revision: "blake3:test",
    state: "needs_action",
    required_count: 1,
    nodes: [
      { node_id: "bwa", operator_id: "align.bwa", title: "BWA", kind: "managed_tool", label: "Managed automatically", detail: "Pixi", requires_action: false, recipes: [] },
      { node_id: "gatk", operator_id: "method.gatk3_unspecified", title: "GATK", kind: "method_details", label: "Choose method", detail: "Caller missing", requires_action: true, recipes: [] },
    ],
    items: [{
      id: "resolution:gatk:review",
      node_id: "gatk",
      operator_id: "method.gatk3_unspecified",
      field: "operator",
      fields: [],
      title: "Choose GATK method",
      detail: "Caller missing",
      kind: "method_details",
      priority: 50,
      escalatable: true,
      resolutions: [{ id: "review", label: "Review details", detail: "Find the caller", kind: "review", recommended: true }],
      recipes: [{ id: "gatk-v1", title: "Recover method", summary: "Find exact caller", version: "1", kind: "method_selection", steps: ["Read supplement"], parameters: [] }],
    }],
  },
};

test("paper setup is attention-first while supported nodes stay summarized", () => {
  assert.equal(paperAttentionItems(candidate).length, 1);
  assert.equal(paperSupportedCount(candidate), 1);
});

test("paper escalation carries exact evidence, location, choices, and recipes", () => {
  const prompt = paperResolutionAgentPrompt(candidate, candidate.assessment.items[0]);
  assert.match(prompt, /PDF page 12/);
  assert.match(prompt, /processed with GATK 3\.5/);
  assert.match(prompt, /Review details/);
  assert.match(prompt, /Read supplement/);
  assert.match(prompt, /do not make an unsupported scientific substitution/);
});
