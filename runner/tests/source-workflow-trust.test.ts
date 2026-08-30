import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assessWorkflow } from "@somite/workflow/assessment";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import type { OperatorCatalog } from "@somite/workflow/catalog";
import type { SomiteGraph, SourceWorkflowInstance } from "@somite/workflow/model";
import type { FrozenSourceFile, SourceManifest } from "@somite/workflow/nextflowSource";
import { applySourceWorkflowEdits, deriveSourceWorkflow, sourceWorkflowRevision } from "@somite/workflow/sourceWorkflow";
import {
  SourceWorkflowTrustError,
  verifyGraphSourceWorkflowTrust,
} from "../src/sourceWorkflowTrust.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const encoder = new TextEncoder();

async function startServer(options: import("../src/server.ts").ServerOptions) {
  return (await import("../src/server.ts")).startServer(options);
}

type Fixture = {
  root: string;
  catalog: OperatorCatalog;
  graph: SomiteGraph;
  manifest: SourceManifest;
};

async function unusedPort() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a test port");
  await new Promise<void>((resolvePromise, rejectPromise) => reservation.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return address.port;
}

async function materializeSourceObject(root: string, manifest: SourceManifest, files: readonly FrozenSourceFile[]) {
  const directory = join(root, ".somite", "source-workflows", "objects", manifest.source_digest.slice("blake3:".length));
  const source = join(directory, "source");
  await mkdir(source, { recursive: true });
  for (const file of files) {
    const path = join(source, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes, { mode: file.mode === 0o100755 ? 0o755 : 0o644 });
  }
  await writeFile(join(directory, "source-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function sourceFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "somite-source-trust-"));
  const files: FrozenSourceFile[] = [
    {
      path: "main.nf",
      mode: 0o100644,
      bytes: encoder.encode([
        "process PREPARE {",
        "  output:",
        "  path 'out.txt'",
        "  script:",
        "  \"\"\"touch out.txt\"\"\"",
        "}",
        "workflow { PREPARE() }",
        "",
      ].join("\n")),
    },
    {
      path: "nextflow_schema.json",
      mode: 0o100644,
      bytes: encoder.encode(JSON.stringify({
        type: "object",
        properties: {
          label: { type: "string", title: "Label" },
          reads: { type: "string", format: "file-path", title: "Reads" },
          workspace: { type: "string", format: "directory-path", title: "Workspace" },
        },
      })),
    },
  ];
  const derived = deriveSourceWorkflow(files, {
    provider: "nf_core",
    repository: "https://github.com/nf-core/demo",
    requested_revision: "1.0.0",
    resolved_revision: "a".repeat(40),
    entrypoint: "main.nf",
  });
  await materializeSourceObject(root, derived.manifest, files);
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const sourceOperator = catalog.get("workflow.source");
  if (!sourceOperator) throw new Error("workflow.source operator is missing from the test catalog");
  const graph: SomiteGraph = {
    schema_version: 3,
    name: "Trusted source workflow",
    nodes: [{
      id: "source-demo",
      operator: sourceOperator.id,
      operator_revision: sourceOperator.revision,
      ports: [],
      params: {},
      source_workflow: derived.workflow,
      layout: { x: 0, y: 0 },
    }],
    edges: [],
    annotations: [],
  };
  return { root, catalog, graph, manifest: derived.manifest };
}

function graphWithWorkflow(graph: SomiteGraph, workflow: SourceWorkflowInstance): SomiteGraph {
  return { ...graph, nodes: [{ ...graph.nodes[0]!, source_workflow: workflow }] };
}

function workflowOf(graph: SomiteGraph) {
  const workflow = graph.nodes[0]?.source_workflow;
  if (!workflow) throw new Error("test graph has no source workflow");
  return workflow;
}

test("source trust reindexes immutable fields and rejects the exact forged-capabilities readiness case", async () => {
  const fixture = await sourceFixture();
  try {
    await verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, fixture.graph);
    const forged = structuredClone(fixture.graph);
    const forgedWorkflow = workflowOf(forged);
    forgedWorkflow.capabilities.exact_execution = true;
    assert.equal(sourceWorkflowRevision(forgedWorkflow), forgedWorkflow.workflow_revision, "capabilities are not protected by the editable workflow revision");
    const forgedAssessment = assessWorkflow(forged, fixture.catalog);
    assert.equal(forgedAssessment.state, "ready");
    assert.equal(forgedAssessment.required_count, 0);
    await assert.rejects(
      verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, forged),
      (error: unknown) => error instanceof SourceWorkflowTrustError
        && error.code === "source_derivation_mismatch"
        && /capabilities/.test(error.message),
    );

    const stale = structuredClone(fixture.graph);
    workflowOf(stale).workflow_revision = `blake3:${"b".repeat(64)}`;
    await assert.rejects(
      verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, stale),
      (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "workflow_revision_invalid",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source trust accepts only existing, correctly typed, non-symlink project bindings", async () => {
  const fixture = await sourceFixture();
  try {
    await mkdir(join(fixture.root, "inputs", "workspace"), { recursive: true });
    await writeFile(join(fixture.root, "inputs", "reads.fastq"), "@read\nACGT\n+\n!!!!\n");
    const base = workflowOf(fixture.graph);
    const valid = applySourceWorkflowEdits(base, base.workflow_revision, [
      { kind: "set_parameter", name: "label", binding: { kind: "literal", value: "demo" } },
      { kind: "set_parameter", name: "reads", binding: { kind: "project_file", path: "inputs/reads.fastq" } },
      { kind: "set_parameter", name: "workspace", binding: { kind: "project_directory", path: "inputs/workspace" } },
    ]);
    await verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, valid));

    const missing = applySourceWorkflowEdits(base, base.workflow_revision, [
      { kind: "set_parameter", name: "reads", binding: { kind: "project_file", path: "inputs/missing.fastq" } },
    ]);
    await assert.rejects(
      verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, missing)),
      (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "binding_invalid" && /not available/.test(error.message),
    );

    const wrongFileType = applySourceWorkflowEdits(base, base.workflow_revision, [
      { kind: "set_parameter", name: "reads", binding: { kind: "project_file", path: "inputs/workspace" } },
    ]);
    await assert.rejects(
      verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, wrongFileType)),
      (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "binding_invalid" && /wrong file type/.test(error.message),
    );

    const wrongDirectoryType = applySourceWorkflowEdits(base, base.workflow_revision, [
      { kind: "set_parameter", name: "workspace", binding: { kind: "project_directory", path: "inputs/reads.fastq" } },
    ]);
    await assert.rejects(
      verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, wrongDirectoryType)),
      (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "binding_invalid" && /wrong file type/.test(error.message),
    );

    if (process.platform !== "win32") {
      await symlink("inputs", join(fixture.root, "linked-inputs"));
      const linked = applySourceWorkflowEdits(base, base.workflow_revision, [
        { kind: "set_parameter", name: "reads", binding: { kind: "project_file", path: "linked-inputs/reads.fastq" } },
      ]);
      await assert.rejects(
        verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, linked)),
        (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "binding_invalid" && /symlink/.test(error.message),
      );

      await symlink("inputs/reads.fastq", join(fixture.root, "linked-reads.fastq"));
      const linkedFile = applySourceWorkflowEdits(base, base.workflow_revision, [
        { kind: "set_parameter", name: "reads", binding: { kind: "project_file", path: "linked-reads.fastq" } },
      ]);
      await assert.rejects(
        verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, linkedFile)),
        (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "binding_invalid" && /symlink/.test(error.message),
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source trust allows typed leaf replacements and rejects untyped or structural replacements", async () => {
  const fixture = await sourceFixture();
  try {
    const base = workflowOf(fixture.graph);
    const invocation = base.invocations?.[0];
    const leaf = fixture.catalog.get("align.bwa");
    const structural = fixture.catalog.get("workflow.reference");
    if (!invocation || !leaf || !structural) throw new Error("replacement test fixture is incomplete");

    const valid = applySourceWorkflowEdits(base, base.workflow_revision, [{
      kind: "replace_invocation",
      invocation_id: invocation.id,
      operator: leaf.id,
      operator_revision: leaf.revision,
      params: { threads: 4 },
    }]);
    await verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, valid));

    const unknown = applySourceWorkflowEdits(base, base.workflow_revision, [{
      kind: "replace_invocation",
      invocation_id: invocation.id,
      operator: leaf.id,
      operator_revision: leaf.revision,
      params: { mystery: true },
    }]);
    await assert.rejects(
      verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, unknown)),
      (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "replacement_invalid" && /unknown parameter/.test(error.message),
    );

    const wrongType = applySourceWorkflowEdits(base, base.workflow_revision, [{
      kind: "replace_invocation",
      invocation_id: invocation.id,
      operator: leaf.id,
      operator_revision: leaf.revision,
      params: { threads: "many" },
    }]);
    await assert.rejects(
      verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, wrongType)),
      (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "replacement_invalid" && /catalog contract/.test(error.message),
    );

    const nonLeaf = applySourceWorkflowEdits(base, base.workflow_revision, [{
      kind: "replace_invocation",
      invocation_id: invocation.id,
      operator: structural.id,
      operator_revision: structural.revision,
    }]);
    await assert.rejects(
      verifyGraphSourceWorkflowTrust(fixture.root, fixture.catalog, graphWithWorkflow(fixture.graph, nonLeaf)),
      (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "replacement_invalid" && /executable leaf/.test(error.message),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runner graph boundaries reject forged source capabilities and unavailable bindings before persistence or execution", async () => {
  const fixture = await sourceFixture();
  const graphPath = join(fixture.root, "workflow.somite.json");
  await writeFile(graphPath, `${JSON.stringify(fixture.graph, null, 2)}\n`);
  const capability = "c".repeat(64);
  const running = await startServer({
    projectRoot: fixture.root,
    graph: "workflow.somite.json",
    port: await unusedPort(),
    agentCapability: capability,
  });
  const mutationHeaders = { "content-type": "application/json", "x-somite-request": "local" };
  try {
    const session = await fetch(`${running.url}/api/session`).then((response) => response.json()) as { state_revision: string };
    const forged = structuredClone(fixture.graph);
    workflowOf(forged).capabilities.exact_execution = true;
    const inputs: Array<{ path: string; body: unknown }> = [
      { path: "/api/graph/validate", body: forged },
      { path: "/api/export/plan", body: forged },
      { path: "/api/export", body: forged },
      { path: "/api/runs", body: forged },
      { path: "/api/validations", body: forged },
      { path: "/api/validations/status", body: forged },
      { path: "/api/graph", body: { base_state_revision: session.state_revision, graph: forged } },
      { path: "/api/graph/autosave", body: { base_state_revision: session.state_revision, graph: forged } },
    ];
    for (const input of inputs) {
      const response = await fetch(`${running.url}${input.path}`, {
        method: input.path === "/api/graph" || input.path === "/api/graph/autosave" ? "PUT" : "POST",
        headers: mutationHeaders,
        body: JSON.stringify(input.body),
      });
      assert.equal(response.status, 422, `${input.path}: ${await response.clone().text()}`);
      assert.equal((await response.json() as { code: string }).code, "source_derivation_mismatch", input.path);
    }

    const workflow = workflowOf(fixture.graph);
    const missingBinding = await fetch(`${running.url}/api/source-workflows/edit`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        base_state_revision: session.state_revision,
        workflow_revision: workflow.workflow_revision,
        edits: [{ kind: "set_parameter", name: "reads", binding: { kind: "project_file", path: "missing.fastq" } }],
      }),
    });
    assert.equal(missingBinding.status, 422, await missingBinding.clone().text());
    assert.equal((await missingBinding.json() as { code: string }).code, "binding_invalid");

    const saved = await fetch(`${running.url}/api/session`).then((response) => response.json()) as { graph: SomiteGraph };
    assert.equal(workflowOf(saved.graph).capabilities.exact_execution, false);
    const persisted = JSON.parse(await readFile(graphPath, "utf8")) as SomiteGraph;
    assert.equal(workflowOf(persisted).capabilities.exact_execution, false);

    const sourceTree = join(
      fixture.root,
      ".somite",
      "source-workflows",
      "objects",
      fixture.manifest.source_digest.slice("blake3:".length),
      "source",
    );
    await writeFile(join(sourceTree, "unmanifested.nf"), "workflow {}\n");
    const currentGraphRoutes: Array<{ path: string; method?: string; headers?: Record<string, string>; body?: string }> = [
      { path: "/api/session" },
      { path: "/api/agent/graph", headers: { "x-somite-mcp-capability": capability } },
      { path: "/api/agent/readiness", headers: { "x-somite-mcp-capability": capability } },
      {
        path: "/api/agent/compile",
        method: "POST",
        headers: { "content-type": "application/json", "x-somite-mcp-capability": capability },
        body: "{}",
      },
    ];
    for (const current of currentGraphRoutes) {
      const response = await fetch(`${running.url}${current.path}`, {
        method: current.method,
        headers: current.headers,
        body: current.body,
      });
      assert.equal(response.status, 422, `${current.path}: ${await response.clone().text()}`);
      assert.equal((await response.json() as { code: string }).code, "source_object_invalid", current.path);
    }
  } finally {
    await running.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("project startup refuses a persisted source graph with forged capabilities", async () => {
  const fixture = await sourceFixture();
  try {
    const forged = structuredClone(fixture.graph);
    workflowOf(forged).capabilities.exact_execution = true;
    await writeFile(join(fixture.root, "forged.somite.json"), `${JSON.stringify(forged, null, 2)}\n`);
    await assert.rejects(
      startServer({ projectRoot: fixture.root, graph: "forged.somite.json", port: await unusedPort() }),
      (error: unknown) => error instanceof SourceWorkflowTrustError && error.code === "source_derivation_mismatch",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
