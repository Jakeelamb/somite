import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { SOURCE_INDEXER_REVISION } from "@somite/workflow/sourceWorkflow";
import { GithubGateway } from "../src/githubGateway.ts";
import { readSourceObject } from "../src/sourceWorkflowStore.ts";
import { nfcoreSourceArchive, tarEntry } from "./helpers/nfcoreFixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("GitHub gateway resolves the default branch, pins the commit, and reuses the frozen source", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-github-source-"));
  const resolved = "b".repeat(40);
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.github.com/repos/MedvedevaLab/NEXT-scASV") {
      return Response.json({ default_branch: "main" });
    }
    if (url.endsWith("/commits/main")) return Response.json({ sha: resolved });
    if (url === `https://codeload.github.com/MedvedevaLab/NEXT-scASV/tar.gz/${resolved}`) {
      return new Response(nfcoreSourceArchive(), { headers: { "content-type": "application/gzip" } });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const gateway = new GithubGateway(root, catalog, fetcher);

    const imported = await gateway.import("https://github.com/MedvedevaLab/NEXT-scASV");
    assert.equal(imported.cached, false);
    assert.equal(imported.workflow, "MedvedevaLab/NEXT-scASV");
    const workflow = imported.graph.nodes[0]?.source_workflow;
    assert.ok(workflow);
    assert.equal(workflow.source.provider, "github");
    assert.equal(workflow.source.repository, "https://github.com/MedvedevaLab/NEXT-scASV");
    assert.equal(workflow.source.requested_revision, "default branch");
    assert.equal(workflow.source.resolved_revision, resolved);
    assert.equal(workflow.source.entrypoint, "main.nf");
    await readSourceObject(root, workflow.source.source_digest);

    const cached = await gateway.import("https://github.com/MedvedevaLab/NEXT-scASV");
    assert.equal(cached.cached, true);
    assert.equal(requests.filter((url) => url.includes("codeload.github.com")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub gateway rejects repository pages and ambiguous non-Nextflow sources before downloading", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-github-reject-"));
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const gateway = new GithubGateway(root, catalog, async () => {
      throw new Error("network should not be reached");
    });
    await assert.rejects(
      gateway.import("https://github.com/MedvedevaLab/NEXT-scASV/issues", "b".repeat(40)),
      /canonical public GitHub repository URL/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub gateway honors an explicit manifest mainScript before the conventional main.nf fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-github-entrypoint-"));
  const resolved = "c".repeat(40);
  const archive = gzipSync(Buffer.concat([
    tarEntry("demo/main.nf", "workflow {}\n"),
    tarEntry("demo/pipeline.nf", "workflow {}\n"),
    tarEntry("demo/nextflow.config", "manifest { mainScript = 'pipeline.nf' }\n"),
    Buffer.alloc(1024),
  ]));
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const gateway = new GithubGateway(root, catalog, async (input) => {
      assert.equal(String(input), `https://codeload.github.com/example/workflow/tar.gz/${resolved}`);
      return new Response(archive, { headers: { "content-type": "application/gzip" } });
    });
    const imported = await gateway.import("https://github.com/example/workflow", resolved);
    const workflow = imported.graph.nodes[0]?.source_workflow;
    assert.equal(workflow?.source.entrypoint, "pipeline.nf");
    assert.equal(workflow?.scopes?.find((scope) => scope.kind === "entry_workflow")?.span.path, "pipeline.nf");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub gateway ignores commented mainScript text and fails closed for conflicting declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-github-config-"));
  const resolved = "d".repeat(40);
  const archive = (config: string) => gzipSync(Buffer.concat([
    tarEntry("demo/main.nf", "workflow {}\n"),
    tarEntry("demo/pipeline.nf", "workflow {}\n"),
    tarEntry("demo/nextflow.config", config),
    Buffer.alloc(1024),
  ]));
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    let payload = archive("// manifest { mainScript = 'missing.nf' }\nmanifest { mainScript = 'pipeline.nf' }\n");
    const gateway = new GithubGateway(root, catalog, async () => new Response(payload));
    const imported = await gateway.import("https://github.com/example/comment-aware", resolved);
    assert.equal(imported.graph.nodes[0]?.source_workflow?.source.entrypoint, "pipeline.nf");

    payload = archive("manifest { mainScript = 'pipeline.nf' }\nmanifest.mainScript = 'main.nf'\n");
    await assert.rejects(
      gateway.import("https://github.com/example/conflicting", resolved),
      /multiple manifest\.mainScript entrypoints/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub gateway runtime-decodes cached workflow JSON before using its identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "somite-github-cache-contract-"));
  const resolved = "e".repeat(40);
  try {
    const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
    const gateway = new GithubGateway(root, catalog, async () => new Response(nfcoreSourceArchive()));
    await gateway.import("https://github.com/example/cache-contract", resolved);
    const requestRoot = join(root, ".somite/source-workflows/github-requests");
    const [request] = await readdir(requestRoot);
    assert.ok(request);
    await writeFile(join(requestRoot, request), JSON.stringify({
      schema_version: 1,
      indexer_revision: SOURCE_INDEXER_REVISION,
      workflow: { source: null },
    }));
    await assert.rejects(
      gateway.import("https://github.com/example/cache-contract", resolved),
      /cached GitHub source request\.workflow/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
