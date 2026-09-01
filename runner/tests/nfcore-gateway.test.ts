import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { MAX_SOURCE_FILES } from "@somite/workflow/nextflowSource";
import { SOURCE_INDEXER_REVISION } from "@somite/workflow/sourceWorkflow";
import { NfcoreGateway, extractGithubTarGz, readSourceObject } from "../src/nfcoreGateway.ts";
import { nfcoreCatalogFixture, nfcoreSourceArchive, tarEntry } from "./helpers/nfcoreFixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("GitHub archive reader strips one root and rejects links", async () => {
  const files = await extractGithubTarGz(nfcoreSourceArchive());
  assert.deepEqual(files.map((file) => file.path), ["main.nf", "modules/fastqc.nf", "nextflow_schema.json"]);

  const linked = gzipSync(Buffer.concat([tarEntry("demo/link", "", "2"), Buffer.alloc(1024)]));
  await assert.rejects(extractGithubTarGz(linked), /unsupported linked entry/);
});

test("GitHub archive reader rejects excessive regular-file cardinality before source derivation", async () => {
  const entries = Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, index) => tarEntry(`demo/file-${index}.nf`, ""));
  const archive = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
  await assert.rejects(extractGithubTarGz(archive), new RegExp(`exceeds ${MAX_SOURCE_FILES} regular files`));
});

test("nf-core gateway catalogs, pins, indexes, stores, and reuses exact source", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-nfcore-ts-"));
  let catalogRequests = 0;
  let sourceRequests = 0;
  const fetcher: typeof fetch = async (input) => {
    if (String(input).includes("pipelines.json")) {
      catalogRequests += 1;
      return new Response(nfcoreCatalogFixture, { headers: { "content-type": "application/json" } });
    }
    sourceRequests += 1;
    return new Response(nfcoreSourceArchive(), { headers: { "content-type": "application/gzip" } });
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

    const requestRoot = join(root, ".somite/source-workflows/requests-ts");
    const [request] = await readdir(requestRoot);
    assert.ok(request);
    await writeFile(join(requestRoot, request), JSON.stringify({
      schema_version: 1,
      indexer_revision: SOURCE_INDEXER_REVISION,
      workflow: { source: null },
    }));
    await assert.rejects(
      gateway.import("nf-core/demo", "1.0.0"),
      /cached nf-core source request\.workflow/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
