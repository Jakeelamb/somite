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

function archivedMode(archive: Uint8Array, target: string) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = 0; offset + 46 <= archive.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(archive.subarray(offset + 46, offset + 46 + nameBytes));
    if (name === target) return (view.getUint32(offset + 38, true) >>> 16) & 0xffff;
    offset += 45 + nameBytes + extraBytes + commentBytes;
  }
  throw new Error(`archive entry ${target} was not found`);
}

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

test("archive entries preserve reviewed executable modes", () => {
  const files = new Map([
    ["somite-run", encoder.encode("#!/bin/sh\n")],
    ["params.json", encoder.encode("{}\n")],
  ]);
  const archive = archiveFrozenPackage(files, new Map([
    ["somite-run", 0o755],
    ["params.json", 0o644],
  ]));
  assert.equal(archivedMode(archive, "somite-run"), 0o755);
  assert.equal(archivedMode(archive, "params.json"), 0o644);
});
