import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSourceNetwork,
  sourceNetworkEnterPath,
  sourceNetworkExitPath,
} from "../app/sourceWorkflowNetwork.ts";
import type { SourceWorkflowInstance } from "../app/types.ts";

const workflow: SourceWorkflowInstance = {
  schema_version: 1,
  workflow_revision: `blake3:${"a".repeat(64)}`,
  source: {
    provider: "nf_core",
    repository: "https://github.com/nf-core/pangenome.git",
    requested_revision: "1.1.3",
    resolved_revision: "3d02bd1df79f48b4bfdb4ad95d4ca0d7f6aeb337",
    source_digest: `blake3:${"b".repeat(64)}`,
    entrypoint: "main.nf",
    file_count: 170,
    source_bytes: 1_300_000,
  },
  scopes: [
    { id: "entry", title: "Entry workflow", kind: "entry_workflow", span: { path: "main.nf", start_line: 46, end_line: 74 } },
    { id: "pipeline", title: "NFCORE_PANGENOME", symbol: "NFCORE_PANGENOME", kind: "workflow", span: { path: "workflows/pangenome.nf", start_line: 22, end_line: 98 } },
    { id: "wfmash", title: "WFMASH", symbol: "WFMASH", kind: "process", span: { path: "modules/nf-core/wfmash/main.nf", start_line: 1, end_line: 54 } },
  ],
  invocations: [
    { id: "call-pipeline", caller: "entry", name: "NFCORE_PANGENOME", callee: "pipeline", span: { path: "main.nf", start_line: 60, end_line: 60 } },
    { id: "call-wfmash", caller: "pipeline", name: "WFMASH", callee: "wfmash", span: { path: "workflows/pangenome.nf", start_line: 52, end_line: 52 } },
    { id: "call-source-only", caller: "pipeline", name: "COLLECT_STATS", span: { path: "workflows/pangenome.nf", start_line: 61, end_line: 61 } },
  ],
  capabilities: {
    exact_execution: false,
    parameter_edits: true,
    hierarchy_indexed: true,
    structural_edits: false,
    channel_contracts: false,
    source_edits: false,
  },
};

test("entering a source workflow opens its root as a nested canvas", () => {
  const root = projectSourceNetwork(workflow, []);
  assert.equal(root.current?.id, "entry");
  assert.deepEqual(root.breadcrumbs.map((scope) => scope.id), ["entry"]);
  assert.deepEqual(root.cards.map((card) => ({
    id: card.id,
    scope: card.scope?.id,
    relation: card.relation,
    capability: card.capability,
    canEnter: card.canEnter,
  })), [{
    id: "call-pipeline",
    scope: "pipeline",
    relation: "invocation",
    capability: "experimental",
    canEnter: true,
  }]);
});

test("nested navigation only enters a callee visible from the current scope", () => {
  assert.deepEqual(sourceNetworkEnterPath(workflow, [], "pipeline"), ["entry", "pipeline"]);
  assert.deepEqual(sourceNetworkEnterPath(workflow, [], "wfmash"), ["entry"]);

  const nested = projectSourceNetwork(workflow, ["entry", "pipeline"]);
  assert.equal(nested.current?.id, "pipeline");
  assert.deepEqual(nested.cards.map((card) => [card.id, card.scope?.id, card.canEnter]), [
    ["call-wfmash", "wfmash", false],
    ["call-source-only", undefined, false],
  ]);
  assert.deepEqual(sourceNetworkEnterPath(workflow, ["entry", "pipeline"], "wfmash"), ["entry", "pipeline", "wfmash"]);
  assert.deepEqual(sourceNetworkExitPath(["entry", "pipeline", "wfmash"]), ["entry", "pipeline"]);
  assert.deepEqual(sourceNetworkExitPath(["entry"]), []);
});

test("opening a single-child wrapper still reveals exactly one layer", () => {
  const wrapped: SourceWorkflowInstance = {
    ...workflow,
    scopes: [
      workflow.scopes![0],
      { id: "bridge", title: "Wrapper", symbol: "WRAPPER", kind: "workflow", span: { path: "main.nf", start_line: 55, end_line: 59 } },
      ...workflow.scopes!.slice(1),
    ],
    invocations: [
      { id: "call-bridge", caller: "entry", name: "WRAPPER", callee: "bridge", span: { path: "main.nf", start_line: 55, end_line: 55 } },
      { id: "call-pipeline", caller: "bridge", name: "NFCORE_PANGENOME", callee: "pipeline", span: { path: "main.nf", start_line: 60, end_line: 60 } },
      ...workflow.invocations!.slice(1),
    ],
  };

  assert.deepEqual(sourceNetworkEnterPath(wrapped, [], "bridge"), ["entry", "bridge"]);
  assert.deepEqual(projectSourceNetwork(wrapped, ["entry", "bridge"]).cards.map((card) => card.scope?.id), ["pipeline"]);
});

test("invalid saved paths fail closed to the source root", () => {
  const projected = projectSourceNetwork(workflow, ["entry", "missing", "wfmash"]);
  assert.deepEqual(projected.path, ["entry"]);
  assert.equal(projected.current?.id, "entry");
});

test("contracts improve guidance without deciding whether a source scope is editable", () => {
  const editable = {
    ...workflow,
    capabilities: { ...workflow.capabilities, structural_edits: true, channel_contracts: true },
  };
  assert.equal(projectSourceNetwork(editable, []).cards[0]?.capability, "guided");
});

test("a replacement remains anchored to the original source invocation", () => {
  const variant: SourceWorkflowInstance = {
    ...workflow,
    replacements: [{
      invocation_id: "call-pipeline",
      operator: "align.bowtie2",
      operator_revision: `blake3:${"c".repeat(64)}`,
      params: { threads: 8 },
    }],
  };
  const card = projectSourceNetwork(variant, []).cards[0];
  assert.equal(card?.title, "NFCORE PANGENOME");
  assert.equal(card?.replacement?.operator, "align.bowtie2");
  assert.equal(card?.capability, "experimental");
});
