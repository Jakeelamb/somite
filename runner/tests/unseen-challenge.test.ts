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
const canonicalTool = (value: unknown) => String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLocaleLowerCase("en-US");

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
    { name: "artic", support: "unsupported", executable: true },
    { name: "freyja", support: "unsupported", executable: true },
  ]);
  assert.equal(report.source.id, "PMC12716492");
  assert.equal(report.retrieved_at, retrievedAt);
});

test("paper challenge keeps executable method evidence visible in a partial draft", async () => {
  const content = new TextEncoder().encode([
    "Methods",
    "Paired-end sequencing reads were assessed with FastQC and trimmed using Trim Galore.",
    "The ARTIC pipeline was used to generate the final consensus genome.",
  ].join("\n"));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, new TextDecoder().decode(content), "jats");
  const report = createPaperChallengeReport({
    source: { provider: "europe_pmc", id: "PMC4", title: "Partial draft", url: "https://europepmc.org/articles/PMC4" },
    content,
    retrieved_at: retrievedAt,
    review,
  });

  assert.equal(report.reconstruction.status, "candidate_built");
  assert.deepEqual(report.reconstruction.gaps, []);
  assert.deepEqual(report.reconstruction.evidence_only_methods, ["trimgalore", "artic"]);
  assert.deepEqual(report.reconstruction.omitted_methods, []);
  assert.equal(report.quality.result, "attention");
  assert.deepEqual(report.quality.issues, ["The visual draft retains 2 executable paper methods as untyped evidence: trimgalore, artic."]);
});

test("paper challenge compares canonical method identities when labels contain punctuation", async () => {
  const content = new TextEncoder().encode([
    "Methods",
    "Paired-end sequencing reads were assessed with FastQC.",
    "A custom Python script was used to summarize the resulting reports.",
  ].join("\n"));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, new TextDecoder().decode(content), "jats");
  const report = createPaperChallengeReport({
    source: { provider: "europe_pmc", id: "PMC-CANONICAL", title: "Punctuated method", url: "https://example.invalid/canonical" },
    content,
    retrieved_at: retrievedAt,
    review,
  });

  assert.ok(review.mentions.some((mention) => mention.normalized_name === "custom-script"));
  assert.deepEqual(report.reconstruction.evidence_only_methods, ["custom-script"]);
  assert.deepEqual(report.reconstruction.omitted_methods, []);
});

test("paper challenge distinguishes an exact cited workflow from a failed no-method extraction", async () => {
  const content = new TextEncoder().encode([
    "Methods",
    "The analysis workflow source code is available at https://github.com/example/reconstructable-pipeline.",
  ].join("\n"));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, new TextDecoder().decode(content), "jats");
  const report = createPaperChallengeReport({
    source: { provider: "europe_pmc", id: "PMC-SOURCE", title: "Cited source", url: "https://example.invalid/source" },
    content,
    retrieved_at: retrievedAt,
    review,
  });

  assert.equal(report.reconstruction.status, "source_workflow_found");
  assert.equal(report.quality.result, "attention");
  assert.equal(report.reconstruction.workflow_sources[0]?.repository, "https://github.com/example/reconstructable-pipeline");
});

test("paper challenge matches a long tool label to its canonical acronym evidence", async () => {
  const content = new TextEncoder().encode([
    "Methods",
    "PacBio HiFi reads were assembled with hifiasm.",
    "Another Gtf/Gff Analysis Toolkit (AGAT) was used to retain the longest transcript isoform.",
  ].join("\n"));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, new TextDecoder().decode(content), "jats");
  const report = createPaperChallengeReport({
    source: { provider: "europe_pmc", id: "PMC-ACRONYM", title: "Acronym method evidence", url: "https://example.invalid/acronym" },
    content,
    retrieved_at: retrievedAt,
    review,
  });

  const candidate = review.candidates.find((item) => item.assay === "assembly");
  assert.ok(candidate?.graph.nodes.some((node) => node.operator === "asm.hifiasm"));
  const evidence = candidate?.graph.nodes.find((node) => node.operator === "gap.missing" && node.params?.tool === "AGAT");
  assert.ok(evidence);
  assert.deepEqual(evidence.ports, []);
  assert.equal(candidate?.graph.edges.some((edge) => edge.from_node === evidence.id || edge.to_node === evidence.id), false);
  assert.deepEqual(report.reconstruction.evidence_only_methods, ["agat"]);
  assert.deepEqual(report.reconstruction.omitted_methods, []);
});

test("paper challenge uses the reviewed Picard action while retaining typed local inputs", async () => {
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

  assert.deepEqual(report.reconstruction.gaps, []);
  assert.equal(report.reconstruction.required_actions, 3);
  assert.ok(report.reconstruction.operators.includes("align.picard_mark_duplicates"));
  assert.ok(report.reconstruction.operators.includes("files.import_gtf"));
  assert.deepEqual(report.reconstruction.unresolved_method_inputs, []);
  assert.deepEqual(report.quality.issues, []);
});

test("paper challenge fails quality when a candidate omits its named core method", async () => {
  const content = new TextEncoder().encode([
    "Methods",
    "RNA-MosaicHunter was the core workflow used to identify RNA mosaic variants.",
    "The RNA-MosaicHunter source code is available at https://github.com/example/RNA-MosaicHunter.",
    "STAR aligned the RNA-seq reads before the workflow was run.",
  ].join("\n"));
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const review = reconstructPaper(catalog, new TextDecoder().decode(content), "jats");
  assert.ok(review.mentions.some((mention) => mention.normalized_name === "rnamosaichunter" && mention.core));
  assert.ok(review.candidates.length > 0);
  const brokenReview = {
    ...review,
    candidates: review.candidates.map((candidate) => ({
      ...candidate,
      graph: {
        ...candidate.graph,
        nodes: candidate.graph.nodes.filter((node) => !(node.operator === "gap.missing"
          && canonicalTool(node.params?.tool) === "rnamosaichunter")),
      },
    })),
  };
  const report = createPaperChallengeReport({
    source: { provider: "europe_pmc", id: "PMC-CORE", title: "Core omission", url: "https://example.invalid/core" },
    content,
    retrieved_at: retrievedAt,
    review: brokenReview,
  });

  assert.equal(report.quality.result, "failed");
  assert.deepEqual(report.reconstruction.omitted_core_methods, ["rnamosaichunter"]);
  assert.ok(report.quality.issues.some((issue) => /named core method.*rnamosaichunter/i.test(issue)));
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
  assert.equal(report.semantic_projection.result, "failed");
  assert.equal(report.semantic_projection.indexed_invocations, 0);
  assert.equal(report.semantic_projection.projected_entities, 0);
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
    scopes: [
      { id: "root", title: "Root", kind: "entry_workflow", span: { path: "main.nf", start_line: 1, end_line: 4 } },
      { id: "task", title: "Task", kind: "process", span: { path: "modules/task.nf", start_line: 1, end_line: 3 } },
    ],
    invocations: [{
      id: "call-task",
      caller: "root",
      name: "TASK",
      callee: "task",
      span: { path: "main.nf", start_line: 3, end_line: 3 },
    }],
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
  const ticks = [0, 0, 10, 10, 25, 25, 27, 27, 47, 47, 50];

  const report = await runUnseenWorkflowChallenge({
    gateway,
    ledger,
    retrieved_at: retrievedAt,
    clock: () => ticks.shift() ?? 50,
  });

  assert.equal(report.source.repository, "https://github.com/nf-core/fresh");
  assert.deepEqual(imported, ["nf-core/old", "nf-core/fresh"]);
  assert.deepEqual(report.semantic_projection, {
    result: "passed",
    indexed_invocations: 1,
    projected_entities: 1,
    projected_relations: 0,
  });
  assert.deepEqual(report.timings_ms, {
    catalog_discovery: 10,
    source_import: 35,
    semantic_projection: 5,
    total: 50,
  });
});
