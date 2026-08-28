import assert from "node:assert/strict";
import test from "node:test";
import { formatResourceBytes, readinessAgentPrompt, readinessSummary } from "../app/readinessState.ts";
import type { ReadinessItem, ReadinessSnapshot } from "../app/types.ts";

const resource: ReadinessItem = {
  id: "input:kraken:db",
  node_id: "kraken",
  operator_id: "class.kraken2",
  field: "db",
  title: "Kraken2 database",
  detail: "Connect a database.",
  kind: "managed_resource",
  resource_profile: "kraken2-database",
  resolutions: [{
    id: "standard-8",
    label: "Download Standard-8",
    detail: "Compact database.",
    kind: "download",
    recommended: true,
    download_bytes: 5_500_000_000,
    stored_bytes: 7_500_000_000,
    scientific_effect: "Lower reference coverage than Standard.",
  }],
};

function snapshot(items: ReadinessItem[] = []): ReadinessSnapshot {
  return {
    graph_revision: "blake3:graph",
    state: items.length ? "needs_action" : "ready",
    required_count: items.length,
    items,
  };
}

test("readiness summary prioritizes active work, requirements, and current evidence", () => {
  assert.equal(readinessSummary(snapshot([resource]), true, null).label, "Preparing");
  assert.equal(readinessSummary(snapshot([resource]), false, null).label, "Needs 1 item");
  assert.equal(readinessSummary(snapshot(), false, null).label, "Ready");
  assert.equal(readinessSummary(snapshot(), false, {
    subject_digest: "blake3:graph",
    configuration_digest: "blake3:fixture",
    fixture_pack: "small",
    receipt: {
      receipt_digest: "blake3:receipt",
      recorded_at_unix_ms: 1,
      subject_digest: "blake3:graph",
      kind: "configuration_validation",
      scope: "graph_e2e",
      configuration_digest: "blake3:fixture",
      fixture_digests: [],
      verifier: "somite",
      result: "passed",
      node_results: {},
      edge_results: {},
      artifact_digests: [],
      log_digests: [],
    },
  }).label, "Validated");
});

test("resource sizes and AI handoff remain structured and explicit", () => {
  assert.equal(formatResourceBytes(5_500_000_000), "5.5 GB");
  assert.equal(formatResourceBytes(79_600_000_000), "79.6 GB");
  assert.equal(formatResourceBytes(null), null);
  const prompt = readinessAgentPrompt(resource, "blake3:graph");
  assert.match(prompt, /input:kraken:db/);
  assert.match(prompt, /Download Standard-8 \(download 5.5 GB, stored 7.5 GB\)/);
  assert.match(prompt, /scientific choice/i);
});
