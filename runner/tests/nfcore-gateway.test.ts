import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { NfcoreGateway, extractGithubTarGz, readSourceObject } from "../src/nfcoreGateway.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function tarEntry(path: string, contents: string, type = "0") {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

function sourceArchive() {
  const main = `include { FASTQC } from './modules/fastqc'\nworkflow { FASTQC() }\n`;
  const module = `process FASTQC {\n  script:\n  \"\"\"fastqc reads.fastq\"\"\"\n}\n`;
  const schema = JSON.stringify({
    type: "object",
    $defs: {
      input_options: {
        title: "Input options",
        type: "object",
        required: ["input"],
        properties: { input: { type: "string", format: "file-path", description: "Reads" } },
      },
    },
    allOf: [{ $ref: "#/$defs/input_options" }],
  });
  return gzipSync(Buffer.concat([
    tarEntry("demo-release/main.nf", main),
    tarEntry("demo-release/modules/fastqc.nf", module),
    tarEntry("demo-release/nextflow_schema.json", schema),
    Buffer.alloc(1024),
  ]));
}

test("GitHub archive reader strips one root and rejects links", async () => {
  const files = await extractGithubTarGz(sourceArchive());
  assert.deepEqual(files.map((file) => file.path), ["main.nf", "modules/fastqc.nf", "nextflow_schema.json"]);

  const linked = gzipSync(Buffer.concat([tarEntry("demo/link", "", "2"), Buffer.alloc(1024)]));
  await assert.rejects(extractGithubTarGz(linked), /unsupported linked entry/);
});

test("nf-core gateway catalogs, pins, indexes, stores, and reuses exact source", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-nfcore-ts-"));
  let catalogRequests = 0;
  let sourceRequests = 0;
  const catalogBody = JSON.stringify({ remote_workflows: [{
    name: "demo",
    description: "Demonstration workflow",
    topics: ["testing"],
    releases: [{ tag_name: "1.0.0", tag_sha: "a".repeat(40) }],
  }] });
  const fetcher: typeof fetch = async (input) => {
    if (String(input).includes("pipelines.json")) {
      catalogRequests += 1;
      return new Response(catalogBody, { headers: { "content-type": "application/json" } });
    }
    sourceRequests += 1;
    return new Response(sourceArchive(), { headers: { "content-type": "application/gzip" } });
  };
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const gateway = new NfcoreGateway(root, catalog, fetcher);
    const discovery = await gateway.catalog();
    assert.equal(discovery.entries[0]?.operator.id, "nf.demo");
    const found = await gateway.search("testing", 12);
    assert.equal(found.entries[0]?.repository, "nf-core/demo");

    const imported = await gateway.import("nf-core/demo", "1.0.0");
    assert.equal(imported.cached, false);
    const workflow = imported.graph.nodes[0]?.source_workflow;
    assert.equal(workflow?.source.resolved_revision, "a".repeat(40));
    assert.equal(workflow?.parameters?.[0]?.name, "input");
    assert.equal(workflow?.scopes?.length, 2);
    assert.equal(workflow?.invocations?.[0]?.callee, workflow?.scopes?.find((scope) => scope.kind === "process")?.id);
    assert.ok(workflow);
    await readSourceObject(root, workflow.source.source_digest);

    const cached = await gateway.import("nf-core/demo", "1.0.0");
    assert.equal(cached.cached, true);
    assert.equal(catalogRequests, 1);
    assert.equal(sourceRequests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
