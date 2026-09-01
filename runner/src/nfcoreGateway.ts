import { join } from "node:path";

import type { OperatorCatalog } from "@somite/workflow/catalog";
import { boundedResponseBytes } from "@somite/workflow/boundedResponse";
import { byteDigest } from "@somite/workflow/contentIdentity";
import { parseGraph } from "@somite/workflow/graphCodec";
import {
  NFCORE_CATALOG_URL,
  nfcoreCatalogResponse,
  parseNfcoreCatalog,
  searchNfcoreCatalog,
  type NfcorePipeline,
} from "@somite/workflow/nfcore";
import { deriveSourceWorkflow, SOURCE_INDEXER_REVISION, sourceWorkflowRevision } from "@somite/workflow/sourceWorkflow";
import { atomicWrite, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";
import { extractGithubTarGz } from "./githubArchive.ts";
import { persistSourceObject } from "./sourceWorkflowStore.ts";
import { verifyGraphSourceWorkflowTrust } from "./sourceWorkflowTrust.ts";

export { readSourceObject } from "./sourceWorkflowStore.ts";
export { extractGithubTarGz } from "./githubArchive.ts";

const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type CatalogSnapshot = Readonly<{ pipelines: readonly NfcorePipeline[]; cached: boolean }>;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned invalid JSON`);
  return value as Record<string, unknown>;
}

async function boundedResponse(response: Response, maximumBytes: number, label: string) {
  if (!response.ok) throw new Error(`${label} returned ${response.status} ${response.statusText}`);
  return boundedResponseBytes(response, maximumBytes, label);
}

function requestKey(workflow: string, revision: string) {
  return byteDigest(encoder.encode(`somite-nfcore-source-request-ts-v1\0${SOURCE_INDEXER_REVISION}\0${workflow}\0${revision}`)).slice("blake3:".length);
}

export class NfcoreGateway {
  readonly #root: string;
  #catalog: OperatorCatalog;
  readonly #fetcher: typeof fetch;
  #snapshot?: Promise<CatalogSnapshot>;

  constructor(root: string, catalog: OperatorCatalog, fetcher: typeof fetch = fetch) {
    this.#root = root;
    this.#catalog = catalog;
    this.#fetcher = fetcher;
  }

  updateCatalog(catalog: OperatorCatalog) {
    if (!catalog.isExtensionOf(this.#catalog)) throw new Error("nf-core catalog updates must preserve every pinned operator revision");
    this.#catalog = catalog;
  }

  async catalog() {
    const snapshot = await this.#loadCatalog();
    return nfcoreCatalogResponse(snapshot.pipelines, snapshot.cached);
  }

  async search(query: string, limit: number) {
    const snapshot = await this.#loadCatalog();
    return { ...searchNfcoreCatalog(snapshot.pipelines, query, limit), cached: snapshot.cached };
  }

  async import(workflow: string, revision: string) {
    if (!/^nf-core\/[A-Za-z0-9_-]+$/.test(workflow) || !/^[A-Za-z0-9._-]+$/.test(revision)) throw new Error("invalid nf-core workflow or revision");
    const snapshot = await this.#loadCatalog();
    const pipeline = snapshot.pipelines.find((candidate) => `nf-core/${candidate.name}` === workflow && candidate.revision === revision);
    if (!pipeline) throw new Error("workflow release is not in the current nf-core catalog");
    const requests = await ensurePrivateDirectory(this.#root, ".somite/source-workflows/requests-ts");
    const requestPath = join(requests, `${requestKey(workflow, revision)}.json`);
    if (await pathExists(requestPath)) {
      const cached = object(
        JSON.parse(decoder.decode(await regularFile(requestPath, 32 * 1024 * 1024, "nf-core source request"))),
        "cached nf-core source request",
      );
      if (cached.schema_version !== 1 || cached.indexer_revision !== SOURCE_INDEXER_REVISION) {
        throw new Error("cached nf-core source request has an invalid identity");
      }
      const response = await this.#response(workflow, revision, cached.workflow, true);
      const sourceWorkflow = response.graph.nodes[0]?.source_workflow;
      if (!sourceWorkflow || sourceWorkflowRevision(sourceWorkflow) !== sourceWorkflow.workflow_revision
        || sourceWorkflow.source.provider !== "nf_core"
        || sourceWorkflow.source.repository !== `https://github.com/${workflow}`
        || sourceWorkflow.source.requested_revision !== revision
        || sourceWorkflow.source.resolved_revision !== pipeline.resolvedRevision) {
        throw new Error("cached nf-core source request has an invalid identity");
      }
      return response;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("nf-core source download timed out")), 60_000);
    let compressed: Uint8Array;
    try {
      const url = `https://codeload.github.com/${workflow}/tar.gz/${pipeline.resolvedRevision}`;
      compressed = await boundedResponse(await this.#fetcher(url, { signal: controller.signal, headers: { accept: "application/gzip" } }), MAX_ARCHIVE_BYTES, `${workflow}@${revision} source`);
    } finally {
      clearTimeout(timeout);
    }
    const files = await extractGithubTarGz(compressed);
    const derived = deriveSourceWorkflow(files, {
      provider: "nf_core",
      repository: `https://github.com/${workflow}`,
      requested_revision: revision,
      resolved_revision: pipeline.resolvedRevision,
      entrypoint: "main.nf",
    });
    if (!files.some((file) => file.path === "main.nf")) throw new Error(`${workflow}@${revision} has no main.nf entrypoint`);
    await persistSourceObject(this.#root, derived.manifest, files);
    const response = await this.#response(workflow, revision, derived.workflow, false);
    await atomicWrite(requestPath, `${JSON.stringify({
      schema_version: 1,
      indexer_revision: SOURCE_INDEXER_REVISION,
      workflow: derived.workflow,
    }, null, 2)}\n`);
    return response;
  }

  async #response(workflow: string, revision: string, sourceWorkflowValue: unknown, cached: boolean) {
    const sourceOperator = this.#catalog.get("workflow.source");
    if (!sourceOperator) throw new Error("workflow.source operator is missing");
    const graph = parseGraph({
      schema_version: 3,
      name: workflow,
      nodes: [{
        id: `source-${workflow.slice("nf-core/".length)}`,
        operator: sourceOperator.id,
        operator_revision: sourceOperator.revision,
        ports: [],
        params: {},
        source_workflow: sourceWorkflowValue,
        layout: { x: 0, y: 0 },
        note: `Pinned from ${workflow}@${revision}`,
      }],
      edges: [],
      annotations: [],
    }, cached ? "cached nf-core source request.workflow" : "nf-core source workflow");
    const sourceWorkflow = graph.nodes[0]!.source_workflow!;
    graph.nodes[0]!.note = `Pinned from ${workflow}@${revision} (${sourceWorkflow.source.resolved_revision.slice(0, 12)})`;
    const verified = this.#catalog.verifyGraph(graph);
    if (!verified.ok) throw new Error(verified.issue.message);
    await verifyGraphSourceWorkflowTrust(this.#root, this.#catalog, graph);
    return { engine: "nextflow", workflow, revision, graph, cached } as const;
  }

  #loadCatalog() {
    if (!this.#snapshot) this.#snapshot = this.#loadCatalogOnce().catch((error) => {
      this.#snapshot = undefined;
      throw error;
    });
    return this.#snapshot;
  }

  async #loadCatalogOnce(): Promise<CatalogSnapshot> {
    const directory = await ensurePrivateDirectory(this.#root, ".somite/catalog");
    const cache = join(directory, "nfcore-pipelines.json");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("nf-core catalog timed out")), 15_000);
    try {
      const raw = await boundedResponse(await this.#fetcher(NFCORE_CATALOG_URL, { signal: controller.signal, headers: { accept: "application/json" } }), MAX_CATALOG_BYTES, "nf-core catalog");
      const pipelines = parseNfcoreCatalog(decoder.decode(raw));
      await atomicWrite(cache, raw);
      return { pipelines, cached: false };
    } catch (fetchError) {
      if (!await pathExists(cache)) throw fetchError;
      const raw = await regularFile(cache, MAX_CATALOG_BYTES, "nf-core catalog cache");
      return { pipelines: parseNfcoreCatalog(decoder.decode(raw)), cached: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}
