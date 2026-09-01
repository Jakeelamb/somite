import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { reconstructPaper } from "@somite/workflow/paper";
import { pathExists } from "../src/files.ts";
import { extractPaper } from "../src/paperExtractor.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const papers = join(repositoryRoot, "testdata", "papers");
const MINIMUM_COMMITTED_CASES = 12;
const REQUIRED_ASSAYS = ["assembly", "metagenome", "rna_seq", "variants"];
const REQUIRED_OUTCOMES = ["drafts_ready", "recognized_unsupported", "no_reconstructable_methods"];

type CommittedPaperCase = {
  path: string;
  extractVia: string;
  outcome: "drafts_ready" | "recognized_unsupported" | "no_reconstructable_methods";
  assays: string[];
  required: string[];
  forbidden: string[];
  unsupported: string[];
  candidates: number;
};

type FullPaperCase = {
  path: string;
  outcome: "drafts_ready" | "recognized_unsupported";
  assays: string[];
  required: string[];
  forbidden: string[];
  unsupported: string[];
  text_digest?: string;
};

const fullPaperCases: FullPaperCase[] = [
  { path: "pdf/love_f1000.pdf", outcome: "drafts_ready", assays: ["rna_seq"], required: ["align.star", "quant.featurecounts", "diff.deseq2"], forbidden: ["nf.rnaseq"], unsupported: [], text_digest: "1947f0e5f0b66e600dda02bccb9edffa63c097699625f2f165338e67e16bda37" },
  { path: "raw/pertea_hisat.txt", outcome: "drafts_ready", assays: ["rna_seq"], required: ["align.hisat2", "quant.stringtie"], forbidden: ["align.bwa", "nf.rnaseq"], unsupported: ["ballgown"] },
  { path: "raw/gatk_best_practices.txt", outcome: "drafts_ready", assays: ["variants"], required: ["align.bwa", "align.samtools_sort", "align.picard_mark_duplicates", "var.haplotypecaller"], forbidden: ["nf.sarek", "align.hisat2"], unsupported: [] },
  { path: "pdf/cheng_hifiasm.pdf", outcome: "drafts_ready", assays: ["assembly"], required: ["asm.hifiasm"], forbidden: ["nf.rnaseq"], unsupported: [] },
  { path: "pdf/rhie_vgp.pdf", outcome: "drafts_ready", assays: ["assembly"], required: ["qc.busco"], forbidden: ["nf.rnaseq"], unsupported: ["falcon", "purgedups", "salsa"], text_digest: "d9dc361329643ae08de254b15ccf3b94e94f6b07fe0621f3163385dc3226e4bd" },
  { path: "pdf/wood_kraken2.pdf", outcome: "drafts_ready", assays: ["metagenome"], required: ["class.kraken2"], forbidden: ["align.minimap2", "nf.taxprofiler"], unsupported: [] },
  { path: "raw/cwl_workflows_pmc.txt", outcome: "drafts_ready", assays: ["rna_seq", "variants"], required: ["align.hisat2", "align.bwa", "quant.stringtie", "var.haplotypecaller"], forbidden: ["nf.rnaseq", "nf.sarek"], unsupported: [] },
  { path: "raw/sarek_pmc.txt", outcome: "drafts_ready", assays: ["variants"], required: ["nf.sarek"], forbidden: ["align.bwa", "var.haplotypecaller"], unsupported: [] },
  { path: "raw/minto_pmc.txt", outcome: "drafts_ready", assays: ["metagenome", "rna_seq"], required: [], forbidden: ["nf.mag", "nf.taxprofiler"], unsupported: ["trimmomatic", "custom-script"] },
  { path: "raw/scrnabox_pmc.txt", outcome: "drafts_ready", assays: ["single_cell"], required: ["diff.deseq2"], forbidden: ["nf.rnaseq"], unsupported: ["cellranger", "soupx", "seurat", "doubletfinder", "seurataggregateexpression"] },
];

function list(value: string) {
  return value === "-" ? [] : value.split(",").filter(Boolean);
}

async function committedPaperCases(): Promise<CommittedPaperCase[]> {
  const rows = (await readFile(join(papers, "gold.tsv"), "utf8"))
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  const headers = rows.shift()?.split("\t");
  assert.ok(headers, "paper gold corpus needs a header");
  return rows.map((line) => {
    const values = line.split("\t");
    const fields = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? "-"]));
    const candidates = Number(fields.expected_candidates);
    assert.ok(Number.isSafeInteger(candidates) && candidates >= 0, `${fields.fixture}: expected_candidates must be a non-negative integer`);
    return {
      path: fields.fixture,
      extractVia: fields.extract_via,
      outcome: fields.outcome as CommittedPaperCase["outcome"],
      assays: list(fields.tracks),
      required: list(fields.required_operators),
      forbidden: list(fields.forbidden_operators),
      unsupported: list(fields.required_unsupported),
      candidates,
    };
  });
}

test("the committed paper corpus crosses extraction and reconstruction in every release", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const cases = await committedPaperCases();
  const committedFixtures = (await readdir(papers)).filter((name) => name.endsWith(".txt")).sort();
  assert.ok(cases.length >= MINIMUM_COMMITTED_CASES, `paper release gate needs at least ${MINIMUM_COMMITTED_CASES} reviewed cases; found ${cases.length}`);
  assert.deepEqual(cases.map((entry) => entry.path).sort(), committedFixtures, "every committed paper fixture needs one reviewed gold row");

  const representedAssays = new Set(cases.flatMap((entry) => entry.assays));
  const representedOutcomes = new Set(cases.map((entry) => entry.outcome));
  for (const assay of REQUIRED_ASSAYS) assert.ok(representedAssays.has(assay), `paper release gate is missing the ${assay} assay`);
  for (const outcome of REQUIRED_OUTCOMES) assert.ok(representedOutcomes.has(outcome as CommittedPaperCase["outcome"]), `paper release gate is missing the ${outcome} outcome`);

  for (const expected of cases) {
    assert.equal(expected.extractVia, "utf8", `${expected.path}: unsupported committed extraction contract`);
    const extracted = await extractPaper(await readFile(join(papers, expected.path)), "text");
    assert.equal(extracted.extractedVia, "text", `${expected.path}: extraction path changed`);
    const review = reconstructPaper(catalog, extracted.text, extracted.extractedVia);
    assert.equal(review.outcome, expected.outcome, expected.path);
    assert.equal(review.candidates.length, expected.candidates, `${expected.path}: candidate count`);
    assert.deepEqual([...new Set(review.candidates.map((candidate) => candidate.assay))].sort(), [...expected.assays].sort(), `${expected.path}: assay tracks`);
    const operators = new Set(review.candidates.flatMap((candidate) => candidate.graph.nodes.map((node) => node.operator)));
    const unsupported = new Set(review.mentions.filter((mention) => mention.support === "unsupported").map((mention) => mention.normalized_name));
    for (const name of expected.required) assert.ok(operators.has(name), `${expected.path}: missing ${name}`);
    for (const name of expected.forbidden) assert.ok(!operators.has(name), `${expected.path}: invented ${name}`);
    for (const name of expected.unsupported) assert.ok(unsupported.has(name), `${expected.path}: missing unsupported ${name}`);
    for (const candidate of review.candidates) assert.equal(catalog.verifyGraph(candidate.graph).ok, true, `${expected.path}: invalid candidate`);
  }
});

const fullCorpusRequired = process.env.SOMITE_PAPER_CORPUS === "required";
const fullCorpusPresent = await pathExists(join(papers, "pdf"));

test("the optional full-source paper corpus crosses PDF extraction and reconstruction", {
  skip: fullCorpusRequired || fullCorpusPresent ? false : "run scripts/fetch-paper-corpus to install the local full-source corpus",
}, async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const missing: string[] = [];
  for (const expected of fullPaperCases) {
    const path = join(papers, expected.path);
    if (!await pathExists(path)) {
      missing.push(expected.path);
    }
  }
  assert.deepEqual(missing, [], `full paper corpus is incomplete: ${missing.join(", ")}`);

  for (const expected of fullPaperCases) {
    const path = join(papers, expected.path);
    const media = expected.path.endsWith(".pdf") ? "pdf" : "text";
    const extracted = await extractPaper(await readFile(path), media);
    if (expected.text_digest) assert.equal(createHash("sha256").update(extracted.text).digest("hex"), expected.text_digest, `${expected.path}: extraction text changed`);
    const review = reconstructPaper(catalog, extracted.text, extracted.extractedVia);
    assert.equal(review.outcome, expected.outcome, expected.path);
    const operators = new Set(review.candidates.flatMap((candidate) => candidate.graph.nodes.map((node) => node.operator)));
    const unsupported = new Set(review.mentions.filter((mention) => mention.support === "unsupported").map((mention) => mention.normalized_name));
    for (const name of expected.required) assert.ok(operators.has(name), `${expected.path}: missing ${name}`);
    for (const name of expected.forbidden) assert.ok(!operators.has(name), `${expected.path}: invented ${name}`);
    for (const name of expected.unsupported) assert.ok(unsupported.has(name), `${expected.path}: missing unsupported ${name}`);
    if (expected.assays.length === 0) assert.equal(review.candidates.length, 0, `${expected.path}: exported a fake draft`);
    else {
      const assays = new Set(review.candidates.map((candidate) => candidate.assay));
      for (const assay of expected.assays) assert.ok(assays.has(assay), `${expected.path}: missing ${assay} candidate`);
      if (expected.assays.length > 1) assert.ok(review.candidates.every((candidate) => candidate.role === "parallel"), `${expected.path}: flattened parallel tracks`);
      for (const candidate of review.candidates) assert.equal(catalog.verifyGraph(candidate.graph).ok, true, `${expected.path}: invalid candidate`);
    }
  }
});
