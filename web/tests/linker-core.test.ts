import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { byteDigest } from "@somite/workflow/contentIdentity";
import {
  createEvidenceReceipt,
  emptyEvidenceIndex,
  freezeRunClosure,
  insertEvidence,
  linkRunClosure,
  LinkError,
} from "@somite/workflow/linker";
import type { SomiteGraph } from "@somite/workflow/model";
import { SOMITE_NEXTFLOW_COMPILER_IDENTITY } from "@somite/workflow/version";

const encoder = new TextEncoder();
const graphCasesPath = new URL("../../testdata/assessment-parity-graphs.json", import.meta.url);
const oraclePath = new URL("../../testdata/linker-oracle.json", import.meta.url);

async function fixture() {
  const cases = JSON.parse(await readFile(graphCasesPath, "utf8")) as Array<{ name: string; graph: SomiteGraph }>;
  const graph = cases.find((candidate) => candidate.name === "connected local FastQC workflow is ready")!.graph;
  const { catalog } = await loadOperatorCatalog(fileURLToPath(new URL("../../operators/", import.meta.url)));
  return { graph, catalog };
}

test("linking, Pixi freezing, evidence, and Operator manifests match the accepted oracle", async () => {
  const { graph, catalog } = await fixture();
  const plan = linkRunClosure(graph, catalog, encoder.encode("[workspace]\n"), {
    targetPlatform: "linux-64",
    compilerIdentity: SOMITE_NEXTFLOW_COMPILER_IDENTITY,
    nextflowIdentity: "nextflow@26.04.6",
    openjdkIdentity: "openjdk@25.0.2",
  });
  const closure = freezeRunClosure(plan.draft, encoder.encode("version: 6\n"));
  const evidence = createEvidenceReceipt({
    recorded_at_unix_ms: 1_787_718_000_000,
    subject_digest: closure.graph_revision,
    observed_closure_digest: closure.closure_digest,
    kind: "configuration_validation",
    scope: "graph_e2e",
    configuration_digest: "blake3:fixture-config",
    fixture_digests: ["blake3:b", "blake3:a", "blake3:a"],
    verifier: SOMITE_NEXTFLOW_COMPILER_IDENTITY,
    result: "passed",
    node_results: { input1: "passed", fastqc1: "passed" },
    edge_results: { reads: "passed" },
    artifact_digests: ["blake3:output"],
    log_digests: ["blake3:log"],
  });
  const operator_manifest_digests = Object.fromEntries(plan.operatorManifests.map((manifest) => [
    manifest.operator_id,
    byteDigest(encoder.encode(JSON.stringify(manifest))),
  ]));
  const oracle = JSON.parse(await readFile(oraclePath, "utf8"));
  assert.deepEqual({ draft: plan.draft, closure, evidence, operator_manifest_digests }, oracle);
});

test("evidence index is immutable, ordered, and digest-idempotent", () => {
  const later = createEvidenceReceipt({
    recorded_at_unix_ms: 2,
    subject_digest: "graph",
    kind: "configuration_validation",
    scope: "graph_e2e",
    configuration_digest: "config",
    fixture_digests: [],
    verifier: "somite",
    result: "passed",
    node_results: {},
    edge_results: {},
    artifact_digests: [],
    log_digests: [],
  });
  const earlier = createEvidenceReceipt({ ...later, recorded_at_unix_ms: 1 });
  const empty = emptyEvidenceIndex();
  const ordered = insertEvidence(insertEvidence(empty, later), earlier);
  assert.deepEqual(ordered.receipts.map((receipt) => receipt.recorded_at_unix_ms), [1, 2]);
  assert.equal(insertEvidence(ordered, earlier), ordered);
  assert.deepEqual(empty.receipts, []);
});

test("link and freeze reject invalid target and empty Pixi lock", async () => {
  const { graph, catalog } = await fixture();
  assert.throws(
    () => linkRunClosure(graph, catalog, encoder.encode("manifest"), {
      targetPlatform: " ",
      compilerIdentity: "compiler",
      nextflowIdentity: "nextflow",
      openjdkIdentity: "openjdk",
    }),
    (error) => error instanceof LinkError && error.code === "empty_target",
  );
  const plan = linkRunClosure(graph, catalog, encoder.encode("manifest"), {
    targetPlatform: "linux-64",
    compilerIdentity: "compiler",
    nextflowIdentity: "nextflow",
    openjdkIdentity: "openjdk",
  });
  assert.throws(
    () => freezeRunClosure(plan.draft, new Uint8Array()),
    (error) => error instanceof LinkError && error.code === "empty_lock",
  );
});
