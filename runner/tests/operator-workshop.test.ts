import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { OperatorCatalog, operatorPorts } from "@somite/workflow/catalog";
import { loadOperatorCatalog, loadOperatorCatalogDirectories } from "@somite/workflow/catalog.node";
import type { SomiteGraph } from "@somite/workflow/model";
import { OperatorWorkshop } from "../src/operatorWorkshop.ts";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

async function mockPixi(root: string) {
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "pixi");
  await writeFile(executable, `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "lock") {
  const manifest = args[args.indexOf("--manifest-path") + 1];
  await writeFile(join(dirname(manifest), "pixi.lock"), "version: 6\\n");
  process.exit(0);
}
if (args[0] === "install") {
  const manifest = args[args.indexOf("--manifest-path") + 1];
  await mkdir(join(dirname(manifest), ".pixi", "envs", "default"), { recursive: true });
  process.exit(0);
}
const nodeMap = JSON.parse(await readFile(join(process.cwd(), "node-map.json"), "utf8"));
await mkdir(join(process.cwd(), ".somite"), { recursive: true });
const processes = Object.values(nodeMap.nodes).map((entry) => entry.process).filter(Boolean);
await writeFile(join(process.cwd(), ".somite", "trace.tsv"), "name\\tstatus\\texit\\thash\\n" + processes.map((name) => name + "\\tCOMPLETED\\t0\\tmock").join("\\n") + "\\n");
await mkdir(join(process.cwd(), "results"), { recursive: true });
await writeFile(join(process.cwd(), "results", "line-count.txt"), "1\\n");
`, "utf8");
  await chmod(executable, 0o755);
  return `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

test("Operator Workshop drafts, proves, and explicitly admits one project-local contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-operator-workshop-"));
  const previousPath = process.env.PATH;
  process.env.PATH = await mockPixi(root);
  try {
    await mkdir(join(root, "data"));
    await writeFile(join(root, "data", "reads.fastq"), "@read\nACGT\n+\n!!!!\n");
    const loaded = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    let catalog = loaded.catalog;
    let acceptanceAttempts = 0;
    let workshop!: OperatorWorkshop;
    workshop = new OperatorWorkshop({
      root,
      repositoryRoot,
      catalog,
      onAccept: async (operator) => {
        acceptanceAttempts += 1;
        if (acceptanceAttempts === 1) throw new Error("simulated catalog refresh failure");
        catalog = new OperatorCatalog([...catalog.values(), operator]);
        workshop.updateCatalog(catalog);
      },
    });
    const candidate = await workshop.draft({
      id: "project.fastq_line_count",
      title: "FASTQ line count",
      palette: ["Project tools"],
      kind: "external",
      cost: "low",
      bin: "wc",
      pixi: ["conda-forge::coreutils"],
      params: {},
      ports: { in: [{ name: "fastq", type: "Fastq" }], out: [{ name: "report", type: "Text" }] },
      argv: ["wc", "-l", "{input.fastq}"],
      outputs: { report: { glob: "{work}/out/line-count.txt", type: "Text" } },
      stdout: "report",
    }, [{ kind: "official_docs", url: "https://www.gnu.org/software/coreutils/manual/html_node/wc-invocation.html" }]);
    assert.equal(candidate.status, "draft");
    assert.match(candidate.operator.revision, /^blake3:/);

    const input = catalog.get("files.import")!;
    const graph: SomiteGraph = {
      schema_version: 3,
      name: "Candidate proof",
      nodes: [{
        id: "reads",
        operator: input.id,
        operator_revision: input.revision,
        ports: operatorPorts(input),
        params: { path: "data/reads.fastq" },
        layout: { x: 0, y: 0 },
      }, {
        id: "count",
        operator: candidate.operator.id,
        operator_revision: candidate.operator.revision,
        ports: operatorPorts(candidate.operator),
        params: {},
        layout: { x: 260, y: 0 },
      }],
      edges: [{ id: "reads-count", from_node: "reads", from_port: "file", to_node: "count", to_port: "fastq" }],
    };
    const proof = await workshop.startProof(candidate.candidate_id, graph, "operator-proof-one");
    let status = await workshop.proofStatus(proof.proof_id, 100);
    while (!status.receipt) status = await workshop.proofStatus(proof.proof_id, 100);
    assert.equal(status.receipt.result, "passed");
    assert.match(status.receipt.receipt_digest, /^blake3:/);

    await assert.rejects(workshop.accept(candidate.candidate_id), /simulated catalog refresh failure/);
    assert.equal(catalog.get(candidate.candidate_id), undefined);
    await assert.rejects(readFile(join(root, ".somite", "operators", "project--fastq_line_count.json")), { code: "ENOENT" });

    const accepted = await workshop.accept(candidate.candidate_id);
    assert.equal(accepted.status, "accepted");
    assert.equal(catalog.get(candidate.candidate_id)?.revision, candidate.operator.revision);
    const projectCatalog = await loadOperatorCatalogDirectories([join(root, ".somite", "operators")]);
    assert.equal(projectCatalog.catalog.get(candidate.candidate_id)?.revision, candidate.operator.revision);
    assert.equal(JSON.parse(await readFile(join(root, ".somite", "operator-workshop", "candidates", "project--fastq_line_count.json"), "utf8")).status, "accepted");
    await workshop.shutdown();
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("Operator Workshop rejects package-only guesses and admission without proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-operator-workshop-reject-"));
  try {
    const loaded = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const workshop = new OperatorWorkshop({ root, repositoryRoot, catalog: loaded.catalog, onAccept: async () => undefined });
    await assert.rejects(workshop.draft({
      id: "project.guess",
      title: "Guess",
      palette: [],
      kind: "external",
      bin: "guess",
      pixi: ["guess"],
      params: {},
      ports: { in: [], out: [] },
      argv: ["guess"],
      outputs: {},
    }, [{ kind: "package_recipe", url: "https://example.test/recipe" }]), /at least one typed output/);
    await assert.rejects(workshop.accept("project.guess"), /was not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
