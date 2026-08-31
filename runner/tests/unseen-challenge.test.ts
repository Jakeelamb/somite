import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { reconstructPaper } from "@somite/workflow/paper";
import type { SourceWorkflowInstance } from "@somite/workflow/model";
import {
  challengeContentDigest,
  createPaperChallengeReport,
  createWorkflowChallengeReport,
  decodeChallengeLedger,
  recordChallenge,
  runUnseenPaperChallenge,
  runUnseenWorkflowChallenge,
  selectUnseenContent,
} from "../src/unseenChallenge.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const retrievedAt = "2026-08-30T18:00:00.000Z";
const digest = (character: string) => `blake3:${character.repeat(64)}`;

test("novelty selection skips previously exercised content digests", () => {
  const oldContent = new TextEncoder().encode("already exercised paper");
  const newContent = new TextEncoder().encode("genuinely unseen paper");
  const ledger = decodeChallengeLedger(JSON.stringify({
    schema_version: 1,
    entries: [{
      kind: "paper",
      source_key: "europe-pmc:PMC1",
      content_digest: challengeContentDigest(oldContent),
      tested_at: "2026-08-29T18:00:00.000Z",
    }],
  }));

  const selected = selectUnseenContent([
    { source_key: "europe-pmc:PMC2", content: oldContent },
    { source_key: "europe-pmc:PMC3", content: newContent },
  ], ledger);

  assert.equal(selected?.source_key, "europe-pmc:PMC3");
  assert.equal(selected?.content_digest, challengeContentDigest(newContent));
});

test("paper challenge reports exact provenance and reconstruction gaps", async () => {
  const content = new TextEncoder().encode([
    "Methods",
    "Samples were sequenced with the ARTIC workflow.",
    "Variant calling and lineage assignment used Freyja.",
  ].join("\n"));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, new TextDecoder().decode(content), "jats");
  const report = createPaperChallengeReport({
    source: {
      provider: "europe_pmc",
      id: "PMC12716492",
      title: "Unseen viral methods paper",
      url: "https://europepmc.org/articles/PMC12716492",
    },
    content,
    retrieved_at: retrievedAt,
    review,
  });

  assert.equal(report.content_digest, challengeContentDigest(content));
  assert.equal(report.reconstruction.outcome, "recognized_unsupported");
  assert.equal(report.reconstruction.status, "evidence_only");
  assert.equal(report.quality.result, "attention");
  assert.deepEqual(report.reconstruction.operators, []);
  assert.deepEqual(report.reconstruction.unsupported, ["artic", "freyja"]);
  assert.deepEqual(report.reconstruction.mentions, [
    { name: "artic", support: "unsupported" },
    { name: "freyja", support: "unsupported" },
  ]);
  assert.equal(report.source.id, "PMC12716492");
  assert.equal(report.retrieved_at, retrievedAt);
});

test("paper challenge names missing adapters instead of reporting an opaque evidence fragment", async () => {
  const content = new TextEncoder().encode([
    "Methods",
    "RNA-seq reads were aligned with STAR, duplicates were marked with Picard MarkDuplicates, and counts were generated with featureCounts.",
  ].join("\n"));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, new TextDecoder().decode(content), "jats");
  const report = createPaperChallengeReport({
    source: { provider: "europe_pmc", id: "PMC3", title: "Adapter gap", url: "https://europepmc.org/articles/PMC3" },
    content,
    retrieved_at: retrievedAt,
    review,
  });

  assert.deepEqual(report.reconstruction.gaps, ["Picard"]);
});

test("workflow challenge reports the frozen source identity and exact blockers", () => {
  const sourceWorkflow: SourceWorkflowInstance = {
    schema_version: 1,
    workflow_revision: digest("a"),
    source: {
      provider: "nf_core",
      repository: "https://github.com/nf-core/unseen",
      requested_revision: "1.2.3",
      resolved_revision: "b".repeat(40),
      source_digest: digest("c"),
      entrypoint: "main.nf",
      file_count: 7,
      source_bytes: 1234,
    },
    scopes: [{ id: "root", title: "Unseen", kind: "entry_workflow", span: { path: "main.nf", start_line: 1, end_line: 1 } }],
    invocations: [],
    capabilities: {
      exact_execution: false,
      parameter_edits: true,
      hierarchy_indexed: true,
      structural_edits: false,
      channel_contracts: false,
      source_edits: false,
    },
    diagnostics: [{ code: "source_only_parameter_constraint", message: "pattern remains source-only" }],
  };

  const report = createWorkflowChallengeReport({ source_workflow: sourceWorkflow, retrieved_at: retrievedAt });

  assert.equal(report.content_digest, digest("c"));
  assert.equal(report.source.resolved_revision, "b".repeat(40));
  assert.equal(report.index.scopes, 1);
  assert.equal(report.status, "inspectable_only");
  assert.equal(report.quality.result, "failed");
  assert.equal(report.capabilities.exact_execution, false);
  assert.deepEqual(report.blockers, [
    "Exact source execution is not available because task environments are not frozen.",
    "Typed Nextflow channel contracts are not proven.",
  ]);
  assert.deepEqual(report.diagnostics, [{ code: "source_only_parameter_constraint", message: "pattern remains source-only" }]);

  const ledger = recordChallenge(decodeChallengeLedger(), report);
  assert.equal(ledger.entries[0]?.source_key, `nf-core:https://github.com/nf-core/unseen@${"b".repeat(40)}`);
  assert.equal(selectUnseenContent([{ source_key: "another-copy", content_digest: digest("c") }], ledger), undefined);
});

test("paper challenge discovery fetches past seen content and reconstructs the next live article", async () => {
  const firstXml = new TextEncoder().encode(`<article><body><sec><title>Methods</title><p>${"STAR was used. ".repeat(30)}</p></sec></body></article>`);
  const secondXml = new TextEncoder().encode(`<article><body><sec><title>Methods</title><p>${"ARTIC and Freyja were used. ".repeat(30)}</p></sec></body></article>`);
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/search")) return Response.json({ resultList: { result: [
      { pmcid: "PMC0", title: "A comprehensive survey of genomics tools", pubTypeList: { pubType: ["Review"] } },
      { pmcid: "PMC1", title: "Already seen" },
      { pmcid: "PMC2", title: "New challenge" },
    ] } });
    if (url.includes("PMC1")) return new Response(firstXml, { headers: { "content-type": "application/xml" } });
    if (url.includes("PMC2")) return new Response(secondXml, { headers: { "content-type": "application/xml" } });
    return new Response("not found", { status: 404 });
  };
  const ledger = decodeChallengeLedger({ schema_version: 1, entries: [{
    kind: "paper",
    source_key: "different-source-for-the-same-content",
    content_digest: challengeContentDigest(firstXml),
    tested_at: retrievedAt,
  }] });
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));

  const report = await runUnseenPaperChallenge({ catalog, ledger, fetcher, retrieved_at: retrievedAt });

  assert.equal(report.source.id, "PMC2");
  assert.deepEqual(report.reconstruction.unsupported, ["artic", "freyja"]);
  assert.equal(requested.filter((url) => url.includes("fullTextXML")).length, 2);
  assert.equal(requested.some((url) => url.includes("PMC0")), false, "review articles are not reconstruction challenges");
});

test("workflow challenge discovery imports until it finds a new frozen source digest", async () => {
  const sourceWorkflow = (name: string, sourceDigest: string): SourceWorkflowInstance => ({
    schema_version: 1,
    workflow_revision: digest("a"),
    source: {
      provider: "nf_core",
      repository: `https://github.com/nf-core/${name}`,
      requested_revision: "1.0.0",
      resolved_revision: name === "old" ? "b".repeat(40) : "d".repeat(40),
      source_digest: sourceDigest,
      entrypoint: "main.nf",
      file_count: 2,
      source_bytes: 200,
    },
    scopes: [],
    invocations: [],
    capabilities: {
      exact_execution: false,
      parameter_edits: true,
      hierarchy_indexed: true,
      structural_edits: false,
      channel_contracts: false,
      source_edits: false,
    },
  });
  const old = sourceWorkflow("old", digest("e"));
  const fresh = sourceWorkflow("fresh", digest("f"));
  const imported: string[] = [];
  const gateway = {
    async catalog() {
      return { entries: [
        { repository: "nf-core/old", revision: "1.0.0" },
        { repository: "nf-core/fresh", revision: "1.0.0" },
      ] };
    },
    async import(repository: string) {
      imported.push(repository);
      return { graph: { nodes: [{ source_workflow: repository.endsWith("old") ? old : fresh }] } };
    },
  };
  const ledger = decodeChallengeLedger({ schema_version: 1, entries: [{
    kind: "workflow",
    source_key: "an-identical-old-copy",
    content_digest: old.source.source_digest,
    tested_at: retrievedAt,
  }] });

  const report = await runUnseenWorkflowChallenge({ gateway, ledger, retrieved_at: retrievedAt });

  assert.equal(report.source.repository, "https://github.com/nf-core/fresh");
  assert.deepEqual(imported, ["nf-core/old", "nf-core/fresh"]);
});
