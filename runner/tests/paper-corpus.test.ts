import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { reconstructPaper } from "@somite/workflow/paper";
import { pathExists } from "../src/files.ts";
import { extractPaper } from "../src/paperExtractor.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const papers = join(repositoryRoot, "testdata", "papers");

type FullPaperCase = {
  path: string;
  outcome: "drafts_ready" | "recognized_unsupported";
  assays: string[];
  required: string[];
  forbidden: string[];
  unsupported: string[];
  text_digest?: string;
};

const cases: FullPaperCase[] = [
  { path: "pdf/love_f1000.pdf", outcome: "drafts_ready", assays: ["rna_seq"], required: ["align.star", "quant.featurecounts", "diff.deseq2"], forbidden: ["nf.rnaseq"], unsupported: [], text_digest: "1947f0e5f0b66e600dda02bccb9edffa63c097699625f2f165338e67e16bda37" },
  { path: "raw/pertea_hisat.txt", outcome: "drafts_ready", assays: ["rna_seq"], required: ["align.hisat2", "quant.stringtie"], forbidden: ["align.bwa", "nf.rnaseq"], unsupported: ["ballgown"] },
  { path: "raw/gatk_best_practices.txt", outcome: "drafts_ready", assays: ["variants"], required: ["align.bwa", "var.haplotypecaller"], forbidden: ["nf.sarek", "align.hisat2"], unsupported: ["picard"] },
  { path: "pdf/cheng_hifiasm.pdf", outcome: "drafts_ready", assays: ["assembly"], required: ["asm.hifiasm"], forbidden: ["nf.rnaseq"], unsupported: [] },
  { path: "pdf/rhie_vgp.pdf", outcome: "drafts_ready", assays: ["assembly"], required: ["qc.busco"], forbidden: ["nf.rnaseq"], unsupported: ["falcon", "purgedups", "salsa"], text_digest: "d9dc361329643ae08de254b15ccf3b94e94f6b07fe0621f3163385dc3226e4bd" },
  { path: "pdf/wood_kraken2.pdf", outcome: "drafts_ready", assays: ["metagenome"], required: ["class.kraken2"], forbidden: ["align.minimap2", "nf.taxprofiler"], unsupported: [] },
  { path: "raw/cwl_workflows_pmc.txt", outcome: "drafts_ready", assays: ["rna_seq", "variants"], required: ["align.hisat2", "align.bwa", "quant.stringtie", "var.haplotypecaller"], forbidden: ["nf.rnaseq", "nf.sarek"], unsupported: [] },
  { path: "raw/sarek_pmc.txt", outcome: "drafts_ready", assays: ["variants"], required: ["nf.sarek"], forbidden: ["align.bwa", "var.haplotypecaller"], unsupported: [] },
  { path: "raw/minto_pmc.txt", outcome: "recognized_unsupported", assays: [], required: [], forbidden: ["nf.mag", "nf.taxprofiler"], unsupported: ["trimmomatic", "custom-script"] },
  { path: "raw/scrnabox_pmc.txt", outcome: "recognized_unsupported", assays: [], required: [], forbidden: ["nf.rnaseq"], unsupported: ["cellranger", "soupx", "seurat", "doubletfinder"] },
];

test("the optional full-paper corpus crosses real extraction and reconstruction", async () => {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const missing: string[] = [];
  let checked = 0;
  for (const expected of cases) {
    const path = join(papers, expected.path);
    if (!await pathExists(path)) {
      missing.push(expected.path);
      continue;
    }
    checked += 1;
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
  const required = process.env.SOMITE_PAPER_CORPUS === "required" || await pathExists(join(papers, "pdf"));
  if (required) {
    assert.deepEqual(missing, [], `full paper corpus is incomplete: ${missing.join(", ")}`);
    assert.equal(checked, cases.length);
  }
});
