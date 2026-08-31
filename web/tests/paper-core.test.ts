import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { MAX_PAPER_RESOURCE_CITATIONS, MAX_PAPER_REVIEW_BYTES } from "@somite/workflow/limits";
import type { SomiteGraph } from "@somite/workflow/model";
import { hasOrderedPath, hasSharedRootBranch, matchingNodes } from "../../scripts/benchmark-paper-topology.ts";
import {
  PaperReviewLimitError,
  enforcePaperReviewSize,
  paperResourceCitations,
  reconstructPaper,
} from "@somite/workflow/paper";

const root = path.resolve(import.meta.dirname, "../..");
const papers = path.join(root, "testdata/papers");
const { catalog } = await loadOperatorCatalog(path.join(root, "operators"));

type GoldCase = {
  fixture: string;
  extractVia: string;
  outcome: string;
  tracks: string[];
  entities: string[];
  forbiddenEntities: string[];
  requiredOperators: string[];
  forbiddenOperators: string[];
  unsupported: string[];
  candidates: number;
  paths: string[][];
  branches: Array<{ root: string; arms: string[] }>;
  alternatives: string[][];
  parameters: Array<{ selector: string; name: string; value: string }>;
  minimumEvidence: number;
  minimumEvidenceSupportPct: number;
  exactRuns: string[];
  forbidCollectionReads: boolean;
};

function list(value: string) {
  return value === "-" ? [] : value.split(",").filter(Boolean);
}

async function goldCases() {
  const rows = (await readFile(path.join(papers, "gold.tsv"), "utf8"))
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  const headers = rows.shift()!.split("\t");
  return rows.map((line): GoldCase => {
    const fields = Object.fromEntries(headers.map((header, index) => [header, line.split("\t")[index] ?? "-"]));
    return {
      fixture: fields.fixture,
      extractVia: fields.extract_via,
      outcome: fields.outcome,
      tracks: list(fields.tracks),
      entities: list(fields.expected_entities),
      forbiddenEntities: list(fields.forbidden_entities),
      requiredOperators: list(fields.required_operators),
      forbiddenOperators: list(fields.forbidden_operators),
      unsupported: list(fields.required_unsupported),
      candidates: Number(fields.expected_candidates),
      paths: fields.required_paths === "-" ? [] : fields.required_paths.split(";").map((value) => value.split(">")),
      branches: fields.required_branches === "-" ? [] : fields.required_branches.split(";").map((value) => {
        const [root, arms = ""] = value.split(">");
        return { root, arms: arms.split("|") };
      }),
      alternatives: fields.separate_alternatives === "-" ? [] : fields.separate_alternatives.split(";").map((value) => value.split("|")),
      parameters: fields.parameters === "-" ? [] : fields.parameters.split(";").map((value) => {
        const [subject, expected = ""] = value.split("=");
        const separator = subject.lastIndexOf(":");
        return { selector: subject.slice(0, separator), name: subject.slice(separator + 1), value: expected };
      }),
      minimumEvidence: Number(fields.minimum_evidence_records),
      minimumEvidenceSupportPct: Number(fields.minimum_evidence_support_pct),
      exactRuns: list(fields.exact_runs),
      forbidCollectionReads: fields.forbid_collection_reads === "true",
    };
  });
}

function topologyGraph(nodes: ReadonlyArray<readonly [id: string, operator: string]>, edges: ReadonlyArray<readonly [from: string, to: string]>): SomiteGraph {
  return {
    schema_version: 3,
    name: "Topology scoring fixture",
    nodes: nodes.map(([id, operator], index) => ({
      id,
      operator,
      operator_revision: "test",
      ports: [],
      params: {},
      layout: { x: index * 100, y: 0 },
    })),
    edges: edges.map(([from, to], index) => ({
      id: `edge-${index}`,
      from_node: from,
      from_port: "out",
      to_node: to,
      to_port: "in",
    })),
  };
}

test("paper topology paths require one consistent chain of node instances", () => {
  const nodes = [
    ["source-a", "source"],
    ["middle-a", "middle"],
    ["middle-b", "middle"],
    ["sink-a", "sink"],
  ] as const;
  const fragmented = topologyGraph(nodes, [["source-a", "middle-a"], ["middle-b", "sink-a"]]);
  assert.equal(hasOrderedPath(fragmented, ["source", "middle", "sink"]), false);

  const connected = topologyGraph(nodes, [["source-a", "middle-a"], ["middle-b", "sink-a"], ["middle-a", "sink-a"]]);
  assert.equal(hasOrderedPath(connected, ["source", "middle", "sink"]), true);
});

test("paper topology branches require one shared root instance", () => {
  const nodes = [
    ["root-a", "root"],
    ["root-b", "root"],
    ["arm-a", "arm.a"],
    ["arm-b", "arm.b"],
  ] as const;
  const splitRoots = topologyGraph(nodes, [["root-a", "arm-a"], ["root-b", "arm-b"]]);
  assert.equal(hasSharedRootBranch(splitRoots, "root", ["arm.a", "arm.b"]), false);

  const sharedRoot = topologyGraph(nodes, [["root-a", "arm-a"], ["root-b", "arm-b"], ["root-a", "arm-b"]]);
  assert.equal(hasSharedRootBranch(sharedRoot, "root", ["arm.a", "arm.b"]), true);
});

test("paper reconstruction honors the committed evidence and graph gold corpus", async () => {
  const cases = await goldCases();
  const committed = (await readdir(papers)).filter((name) => name.endsWith(".txt")).sort();
  assert.deepEqual(cases.map((entry) => entry.fixture).sort(), committed, "every committed paper fixture needs one reviewed gold row");
  for (const expected of cases) {
    const text = await readFile(path.join(papers, expected.fixture), "utf8");
    const review = reconstructPaper(catalog, text, "text");
    const entities = new Set(review.mentions.map((mention) => mention.normalized_name));
    const operators = new Set(review.candidates.flatMap((candidate) => candidate.graph.nodes.map((node) => node.operator)));
    const unsupported = new Set(review.mentions.filter((mention) => mention.support === "unsupported").map((mention) => mention.normalized_name));

    assert.equal(expected.extractVia, "utf8", `${expected.fixture}: unsupported fixture extraction contract`);
    assert.equal(review.extracted_via, "text", `${expected.fixture}: extraction path`);
    assert.equal(review.outcome, expected.outcome, `${expected.fixture}: outcome`);
    assert.deepEqual([...new Set(review.candidates.map((candidate) => candidate.assay))].sort(), [...expected.tracks].sort(), `${expected.fixture}: assay tracks`);
    assert.equal(review.candidates.length, expected.candidates, `${expected.fixture}: candidates`);
    for (const entity of expected.entities) assert.ok(entities.has(entity), `${expected.fixture}: missing entity ${entity}`);
    for (const entity of expected.forbiddenEntities) assert.ok(!entities.has(entity), `${expected.fixture}: forbidden entity ${entity}`);
    for (const operator of expected.requiredOperators) assert.ok(operators.has(operator), `${expected.fixture}: missing operator ${operator}`);
    for (const operator of expected.forbiddenOperators) assert.ok(!operators.has(operator), `${expected.fixture}: forbidden operator ${operator}`);
    for (const entity of expected.unsupported) assert.ok(unsupported.has(entity), `${expected.fixture}: missing unsupported evidence ${entity}`);
    for (const path of expected.paths) {
      assert.ok(review.candidates.some((candidate) => hasOrderedPath(candidate.graph, path)), `${expected.fixture}: missing path ${path.join(" > ")}`);
    }
    for (const branch of expected.branches) {
      assert.ok(review.candidates.some((candidate) => hasSharedRootBranch(candidate.graph, branch.root, branch.arms)), `${expected.fixture}: missing branch ${branch.root} > ${branch.arms.join(" | ")}`);
    }
    for (const alternatives of expected.alternatives) {
      const placements = alternatives.map((selector) => review.candidates.flatMap((candidate, index) => matchingNodes(candidate.graph, selector).length ? [index] : []));
      assert.ok(placements.every((indices) => indices.length === 1) && new Set(placements.flat()).size === alternatives.length, `${expected.fixture}: alternatives ${alternatives.join(" | ")} placements=${JSON.stringify(placements)}`);
    }
    for (const parameter of expected.parameters) {
      assert.ok(review.candidates.some((candidate) => matchingNodes(candidate.graph, parameter.selector).some((node) => String(node.params?.[parameter.name]) === parameter.value)), `${expected.fixture}: ${parameter.selector}:${parameter.name}=${parameter.value}`);
    }
    const evidenceCount = review.mentions.length + review.candidates.reduce((total, candidate) => total + candidate.evidence.length, 0);
    assert.ok(evidenceCount >= expected.minimumEvidence, `${expected.fixture}: evidence count ${evidenceCount} < ${expected.minimumEvidence}`);
    let supportedEvidence = 0;
    let expectedEvidence = 0;
    for (const mention of review.mentions) {
      expectedEvidence += 1;
      const supported = Boolean(mention.evidence.trim()) && mention.evidence.includes(mention.display_name);
      if (supported) supportedEvidence += 1;
      assert.equal(supported, true, `${expected.fixture}: ${mention.normalized_name} lacks an exact evidence span`);
    }
    for (const [index, candidate] of review.candidates.entries()) {
      for (const node of candidate.graph.nodes) {
        expectedEvidence += 1;
        const supported = candidate.evidence.some((record) => record.target_kind === "node" && record.target_id === node.id && Boolean(record.detail.trim()));
        if (supported) supportedEvidence += 1;
        assert.equal(supported, true, `${expected.fixture}: candidate ${index} node ${node.id} lacks evidence`);
      }
      for (const edge of candidate.graph.edges) {
        expectedEvidence += 1;
        const supported = candidate.evidence.some((record) => record.target_kind === "edge" && record.target_id === edge.id && Boolean(record.detail.trim()));
        if (supported) supportedEvidence += 1;
        assert.equal(supported, true, `${expected.fixture}: candidate ${index} edge ${edge.id} lacks evidence`);
      }
    }
    const supportPct = expectedEvidence ? Math.floor(supportedEvidence * 100 / expectedEvidence) : 100;
    assert.ok(supportPct >= expected.minimumEvidenceSupportPct, `${expected.fixture}: evidence support ${supportPct}% < ${expected.minimumEvidenceSupportPct}%`);

    const readRuns = new Set(review.candidates.flatMap((candidate) => candidate.graph.nodes
      .filter((node) => node.operator === "sra.prefetch")
      .map((node) => String(node.params?.accession ?? ""))));
    assert.deepEqual([...readRuns].sort(), [...expected.exactRuns].sort(), `${expected.fixture}: exact run sources`);
    if (expected.forbidCollectionReads) assert.equal(readRuns.size, 0, `${expected.fixture}: collection citation became a read source`);
  }
});

test("unsupported statistical methods are retained without insulting input guidance", async () => {
  const text = await readFile(path.join(papers, "unsupported_statistics_methods.txt"), "utf8");
  const review = reconstructPaper(catalog, text, "pdfjs");
  assert.equal(review.outcome, "recognized_unsupported");
  assert.equal(review.candidates.length, 0);
  assert.match(review.warnings[0]!, /retained their evidence/i);
  assert.ok(!review.warnings.some((warning) => /cover page|drop a methods section/i.test(warning)));
});

test("paper resources retain collections until an exact run is selected", async () => {
  const text = await readFile(path.join(papers, "cited_resources_methods.txt"), "utf8");
  const review = reconstructPaper(catalog, text, "pdfjs");
  assert.deepEqual(review.resources.map((resource) => resource.accession), ["PRJNA300706", "SRP151479"]);
  assert.ok(review.resources.every((resource) => resource.source_location === "PDF page 1"));
  assert.ok(review.candidates[0]?.graph.nodes.every((node) => node.operator !== "sra.prefetch"));
});

test("paper reconstruction never collapses multiple exact runs into the first read source", () => {
  const review = reconstructPaper(catalog, [
    "Methods",
    "RNA-seq libraries from biological replicates SRR12345678 and SRR12345679 were paired-end.",
    "Raw reads were quality-checked with FastQC, trimmed with fastp, and aligned with STAR.",
    "The reads are deposited under BioProject PRJNA300706; alignment used reference assembly GCF_000001405.40.",
  ].join("\n"), "pdfjs");

  assert.deepEqual(review.resources.map((resource) => resource.accession), ["SRR12345678", "SRR12345679", "PRJNA300706", "GCF_000001405.40"]);
  const candidate = review.candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.graph.nodes.some((node) => node.operator === "sra.prefetch"), false);
  const readSlots = candidate.graph.nodes.filter((node) => node.operator === "files.import_paired");
  assert.equal(readSlots.length, 1);
  assert.match(readSlots[0]?.note ?? "", /SRR12345678.*SRR12345679/);
  assert.match(readSlots[0]?.note ?? "", /no run was selected automatically/i);
  assert.notEqual(candidate.assessment.state, "ready");
  assert.ok(candidate.assessment.required_count > 0);
  assert.ok(candidate.assessment.items.some((item) => item.node_id === readSlots[0]?.id));
  assert.ok(candidate.evidence.some((entry) => entry.target_id === readSlots[0]?.id && /SRR12345678.*SRR12345679/.test(entry.detail)));
});

test("one cited run stays unresolved when the paper has multiple independent read roles", () => {
  const review = reconstructPaper(catalog, [
    "Methods",
    "A draft genome assembly was ordered and oriented with ALLMAPS using a linkage map.",
    "Paired-end DNA-seq and RNA-seq reads from SRR12345678 were aligned with BWA-MEM.",
    "GATK 3.5 and Rascaf were used for scaffolding.",
  ].join("\n"), "pdfjs");

  const candidate = review.candidates[0];
  assert.ok(candidate);
  assert.deepEqual(review.resources.map((resource) => resource.accession), ["SRR12345678"]);
  assert.equal(candidate.graph.nodes.some((node) => node.operator === "sra.prefetch"), false);
  const readSlots = candidate.graph.nodes.filter((node) => node.operator === "files.import_paired");
  assert.equal(readSlots.length, 2);
  assert.ok(readSlots.some((node) => /independent read roles/i.test(node.note ?? "")));
  assert.ok(candidate.assessment.items.some((item) => readSlots.some((node) => node.id === item.node_id)));
  assert.notEqual(candidate.assessment.state, "ready");
});

test("paper resource extraction is bounded, explicit, and page-linear", () => {
  const accessions = Array.from(
    { length: MAX_PAPER_RESOURCE_CITATIONS + 1 },
    (_, index) => `SRR${1_000_000 + index}`,
  );
  const review = reconstructPaper(catalog, [
    "Methods",
    "Reads were checked with FastQC.",
    accessions.join("\f"),
  ].join("\n"), "pdfjs");

  assert.equal(review.resources.length, MAX_PAPER_RESOURCE_CITATIONS);
  assert.equal(review.resources[0]?.accession, accessions[0]);
  assert.equal(review.resources.at(-1)?.accession, accessions[MAX_PAPER_RESOURCE_CITATIONS - 1]);
  assert.equal(review.resources[0]?.source_location, "PDF page 1");
  assert.equal(review.resources.at(-1)?.source_location, `PDF page ${MAX_PAPER_RESOURCE_CITATIONS}`);
  assert.ok(review.warnings.some((warning) => /retained the first 4,096.*omission explicitly/i.test(warning)));
  assert.ok(Buffer.byteLength(JSON.stringify(review)) <= MAX_PAPER_REVIEW_BYTES);
});

test("paper reconstruction retains a novel repository-backed method as a typed adapter gap", () => {
  const review = reconstructPaper(catalog, [
    "SNooPy: a statistical framework for long-read metagenomic variant calling",
    "Materials and methods",
    "SNooPy processes BAM files through a sliding window. Candidate SNP groups are validated and output in a VCF file.",
    "Data availability",
    "SNooPy is freely available at https://github.com/rolandfaure/SNooPy.",
  ].join("\n"), "jats");

  const mention = review.mentions.find((item) => item.normalized_name === "snoopy");
  assert.equal(mention?.support, "unsupported");
  assert.equal(mention?.operation_class, "variant_calling");
  assert.deepEqual(review.candidates.map((candidate) => candidate.assay), ["variants"]);
  assert.ok(review.candidates.length > 0);
  const gap = review.candidates.flatMap((candidate) => candidate.graph.nodes).find((node) => node.operator === "gap.missing" && node.params?.tool === "SNooPy");
  assert.deepEqual(gap?.ports.map((port) => ({ dir: port.dir, ty: port.ty })), [{ dir: "in", ty: "Bam" }, { dir: "out", ty: "Vcf" }]);
  assert.ok(review.candidates.some((candidate) => candidate.assessment.items.some((item) => item.kind === "adapter")));
});

test("paper method recognition stays bounded for repeated aliases and retains the exact PDF page", { timeout: 30_000 }, () => {
  const script = String.raw`
    import path from "node:path";
    import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
    import { reconstructPaper } from "@somite/workflow/paper";

    const { catalog } = await loadOperatorCatalog(path.join(process.cwd(), "operators"));
    const repeatedAlias = "FastQC. ".repeat(2 * 1024 * 1024);
    const review = reconstructPaper(catalog, "Abstract\fMethods\n" + repeatedAlias, "pdfjs");
    const mentions = review.mentions.filter((mention) => mention.operator_id === "qc.fastqc");
    if (mentions.length !== 1 || mentions[0].source_location !== "PDF page 2") {
      throw new Error("repeated FastQC evidence was not retained once on PDF page 2");
    }

    const negatedAlias = "without FastQC. ".repeat(64 * 1024);
    const negated = reconstructPaper(catalog, "Abstract\fMethods\n" + negatedAlias, "pdfjs");
    const negatedMentions = negated.mentions.filter((mention) => mention.operator_id === "qc.fastqc");
    if (negatedMentions.length !== 1 || negatedMentions[0].source_location !== "PDF page 2" || negated.candidates.length !== 0) {
      throw new Error("negated FastQC evidence changed reconstruction semantics");
    }
  `;
  const child = spawnSync(process.execPath, [
    "--max-old-space-size=128",
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    script,
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 8_000,
  });

  assert.equal(child.status, 0, child.stderr || child.error?.message || "paper reconstruction subprocess failed");
});

test("paper method-window discovery does not retain a line array for a dense 64 MiB document", { timeout: 30_000 }, () => {
  const script = String.raw`
    import { paperMethodsWindow } from "@somite/workflow/paper";

    const line = "x".repeat(63) + "\n";
    const text = "Methods\n" + line.repeat(1024 * 1024);
    const window = paperMethodsWindow(text);
    if (window.offset !== 0 || window.text.length !== text.length) {
      throw new Error("dense methods window changed heading semantics");
    }
  `;
  const child = spawnSync(process.execPath, [
    "--max-old-space-size=128",
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    script,
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });

  assert.equal(child.status, 0, child.stderr || child.error?.message || "dense paper reconstruction subprocess failed");
});

test("paper resource extraction rejects absurd identifier lengths without expanding them", () => {
  const text = `SRR${"1".repeat(1024 * 1024)}`;
  assert.deepEqual(paperResourceCitations(text, "text"), []);
});

test("paper review limits fail with a non-retryable typed error", () => {
  const review = reconstructPaper(catalog, "Methods\nFastQC was used for read quality control.", "text");
  assert.throws(
    () => enforcePaperReviewSize(review, 1),
    (error: unknown) => error instanceof PaperReviewLimitError
      && error.code === "paper_reconstruction_limit"
      && error.retryable === false
      && error.sizeBytes > error.maximumBytes,
  );
});
