import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

import {
  archiveFrozenPackage,
  createFrozenPackageFiles,
  planFrozenPackage,
  safeArchiveName,
} from "@somite/workflow/bundle";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import type { SomiteGraph } from "@somite/workflow/model";
import { SOMITE_NEXTFLOW_COMPILER_IDENTITY } from "@somite/workflow/version";

const encoder = new TextEncoder();

async function fixtures() {
  const cases = JSON.parse(await readFile(new URL("../../testdata/assessment-parity-graphs.json", import.meta.url), "utf8")) as Array<{ name: string; graph: SomiteGraph }>;
  const { catalog } = await loadOperatorCatalog(fileURLToPath(new URL("../../operators/", import.meta.url)));
  return {
    graph: cases.find((candidate) => candidate.name === "connected local FastQC workflow is ready")!.graph,
    source: cases.find((candidate) => candidate.name === "source workflow exposes every honest blocker")!.graph,
    catalog,
  };
}

test("bundle planning shares assessment and includes replacement environments", async () => {
  const { graph, source, catalog } = await fixtures();
  const plan = planFrozenPackage(graph, catalog, { archiveName: "RNA seq", platform: "linux-64" });
  assert.equal(plan.filename, "RNA-seq.somite-run.zip");
  assert.equal(plan.ready_count, 1);
  assert.equal(plan.installable_count, 1);
  assert.deepEqual(plan.packages, ["bioconda::fastqc"]);
  assert.equal(plan.assessment.state, "ready");

  const sourcePlan = planFrozenPackage(source, catalog, { archiveName: "Source", platform: "linux-64" });
  assert.ok(sourcePlan.packages.includes("bioconda::fastqc"));
  assert.ok(sourcePlan.tools.some((tool) => tool.operator_id === "qc.fastqc" && tool.state === "installable"));

  const exactSource = structuredClone(source);
  const workflow = exactSource.nodes[0]!.source_workflow!;
  workflow.parameters = [];
  workflow.unsupported_required_parameters = [];
  workflow.replacements = [];
  workflow.capabilities = { ...workflow.capabilities, exact_execution: true, parameter_edits: true };
  const exactSourcePlan = planFrozenPackage(exactSource, catalog, { archiveName: "Exact source", platform: "linux-64" });
  assert.equal(exactSourcePlan.assessment.state, "ready");
  assert.deepEqual(exactSourcePlan.tools, [{
    operator_id: "workflow.source",
    title: "nf-core/rnaseq",
    packages: [],
    state: "built_in",
    detail: "Uses the immutable Pixi manifest and lock stored with this source workflow.",
  }]);
});

test("frozen package is complete and archives deterministically", async () => {
  const { graph, catalog } = await fixtures();
  const frozen = createFrozenPackageFiles(
    graph,
    catalog,
    { archiveName: "RNA seq", platform: "linux-64" },
    encoder.encode("version: 6\n"),
  );
  for (const path of [
    "main.nf",
    "nextflow.config",
    "params.json",
    "node-map.json",
    "pixi.toml",
    "pixi.lock",
    "workflow.somite.json",
    "assessment.json",
    "run-closure.json",
    "evidence/index.json",
    "toolchain/tools.json",
    "operators/files.import.json",
    "operators/qc.fastqc.json",
  ]) assert.ok(frozen.files.has(path), `missing ${path}`);

  const first = archiveFrozenPackage(frozen.files);
  const second = archiveFrozenPackage(frozen.files);
  assert.deepEqual(first, second);
  const archived = unzipSync(first);
  assert.deepEqual(Object.keys(archived).sort(), [...frozen.files.keys()].sort());
  assert.equal(new TextDecoder().decode(archived["pixi.lock"]), "version: 6\n");
  assert.equal(frozen.closure.compiler_identity, SOMITE_NEXTFLOW_COMPILER_IDENTITY);
});

test("archive names are safe and never empty", () => {
  assert.equal(safeArchiveName(" DNA / RNA "), "DNA---RNA");
  assert.equal(safeArchiveName("🧬"), "somite-workflow");
});
