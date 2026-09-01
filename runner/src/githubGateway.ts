import { join } from "node:path";

import { boundedResponseBytes } from "@somite/workflow/boundedResponse";
import { byteDigest } from "@somite/workflow/contentIdentity";
import type { OperatorCatalog } from "@somite/workflow/catalog";
import { safeSourcePath, tokenizeNextflow, type FrozenSourceFile } from "@somite/workflow/nextflowSource";
import { parseGraph } from "@somite/workflow/graphCodec";
import { deriveSourceWorkflow, SOURCE_INDEXER_REVISION, sourceWorkflowRevision } from "@somite/workflow/sourceWorkflow";
import { atomicWrite, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";
import { extractGithubTarGz } from "./githubArchive.ts";
import { persistSourceObject } from "./sourceWorkflowStore.ts";
import { verifyGraphSourceWorkflowTrust } from "./sourceWorkflowTrust.ts";

const MAX_API_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const GIT_OBJECT = /^[0-9a-f]{40}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

type GithubRepository = Readonly<{ owner: string; name: string; url: string }>;

function githubRepository(value: string): GithubRepository {
  const matched = value.trim().match(/^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})(?:\.git)?\/?$/i);
  if (!matched) throw new Error("repository must be a canonical public GitHub repository URL");
  const name = matched[2]!.replace(/\.git$/i, "");
  return { owner: matched[1]!, name, url: `https://github.com/${matched[1]}/${name}` };
}

function boundedRevision(value: string) {
  const revision = value.trim();
  if (revision.length > 200 || /[\u0000-\u001f\u007f]/.test(revision)) throw new Error("GitHub revision is invalid");
  return revision;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned invalid JSON`);
  return value as Record<string, unknown>;
}

async function responseBytes(response: Response, maximumBytes: number, label: string) {
  if (!response.ok) throw new Error(`${label} returned ${response.status} ${response.statusText}`);
  return boundedResponseBytes(response, maximumBytes, label);
}

function requestKey(repository: string, requestedRevision: string, resolvedRevision: string) {
  return byteDigest(encoder.encode(`somite-github-source-request-v1\0${SOURCE_INDEXER_REVISION}\0${repository}\0${requestedRevision}\0${resolvedRevision}`))
    .slice("blake3:".length);
}

function tokenText(file: FrozenSourceFile, token: ReturnType<typeof tokenizeNextflow>[number]) {
  return decoder.decode(file.bytes.subarray(token.start, token.end));
}

function configuredEntrypoint(config: FrozenSourceFile) {
  const tokens = tokenizeNextflow(config.bytes);
  const candidates: string[] = [];
  let braceDepth = 0;
  let manifestDepth: number | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "ident" && tokenText(config, token) === "manifest"
      && tokens[index + 1]?.kind === "left_brace") {
      manifestDepth = braceDepth + 1;
    }
    if (token.kind === "left_brace") {
      braceDepth += 1;
      continue;
    }
    if (token.kind === "right_brace") {
      braceDepth -= 1;
      if (manifestDepth !== undefined && braceDepth < manifestDepth) manifestDepth = undefined;
      continue;
    }
    if (token.kind !== "ident" || tokenText(config, token) !== "mainScript") continue;
    const dottedManifest = tokens[index - 1]?.kind === "dot"
      && tokens[index - 2]?.kind === "ident"
      && tokenText(config, tokens[index - 2]!) === "manifest";
    if (braceDepth !== manifestDepth && !dottedManifest) continue;
    const value = tokens[index + 1];
    if (value?.kind !== "string") throw new Error("nextflow.config manifest.mainScript must be one static string literal");
    const assignment = decoder.decode(config.bytes.subarray(token.end, value.offset));
    if (!/^\s*=\s*$/.test(assignment)) throw new Error("nextflow.config manifest.mainScript must be one static string literal");
    const candidate = tokenText(config, value).replace(/^\.\//, "");
    if (!safeSourcePath(candidate) || /[$\\]/.test(candidate)) throw new Error("nextflow.config manifest.mainScript must be one static source-relative path");
    candidates.push(candidate);
  }
  if (candidates.length > 1) throw new Error("nextflow.config declares multiple manifest.mainScript entrypoints");
  return candidates[0];
}

function entrypoint(files: readonly FrozenSourceFile[]) {
  const paths = new Set(files.map((file) => file.path));
  const config = files.find((file) => file.path === "nextflow.config");
  if (config) {
    const configured = configuredEntrypoint(config);
    if (configured) {
      if (!paths.has(configured)) throw new Error(`nextflow.config manifest.mainScript refers to missing source file ${configured}`);
      return configured;
    }
  }
  if (paths.has("main.nf")) return "main.nf";
  const rootScripts = files.map((file) => file.path).filter((path) => !path.includes("/") && path.endsWith(".nf"));
  if (rootScripts.length === 1) return rootScripts[0]!;
  throw new Error("GitHub repository has no unambiguous Nextflow entrypoint (main.nf or manifest.mainScript)");
}

export class GithubGateway {
  readonly #root: string;
  #catalog: OperatorCatalog;
  readonly #fetcher: typeof fetch;

  constructor(root: string, catalog: OperatorCatalog, fetcher: typeof fetch = fetch) {
    this.#root = root;
    this.#catalog = catalog;
    this.#fetcher = fetcher;
  }

  updateCatalog(catalog: OperatorCatalog) {
    if (!catalog.isExtensionOf(this.#catalog)) throw new Error("GitHub source catalog updates must preserve every pinned operator revision");
    this.#catalog = catalog;
  }

  async import(repositoryValue: string, revisionValue = "") {
    const repository = githubRepository(repositoryValue);
    const requested = boundedRevision(revisionValue);
    const resolved = GIT_OBJECT.test(requested) ? requested : await this.#resolveRevision(repository, requested);
    const requestedRevision = requested || "default branch";
    const requests = await ensurePrivateDirectory(this.#root, ".somite/source-workflows/github-requests");
    const requestPath = join(requests, `${requestKey(repository.url, requestedRevision, resolved)}.json`);
    if (await pathExists(requestPath)) {
      const cached = object(
        JSON.parse(decoder.decode(await regularFile(requestPath, 32 * 1024 * 1024, "GitHub source request"))),
        "cached GitHub source request",
      );
      if (cached.schema_version !== 1 || cached.indexer_revision !== SOURCE_INDEXER_REVISION) {
        throw new Error("cached GitHub source request has an invalid identity");
      }
      const response = await this.#response(repository, cached.workflow, true);
      const workflow = response.graph.nodes[0]?.source_workflow;
      if (!workflow || sourceWorkflowRevision(workflow) !== workflow.workflow_revision
        || workflow.source.provider !== "github"
        || workflow.source.repository !== repository.url
        || workflow.source.requested_revision !== requestedRevision
        || workflow.source.resolved_revision !== resolved) throw new Error("cached GitHub source request has an invalid identity");
      return response;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("GitHub source download timed out")), 60_000);
    let compressed: Uint8Array;
    try {
      const url = `https://codeload.github.com/${repository.owner}/${repository.name}/tar.gz/${resolved}`;
      compressed = await responseBytes(await this.#fetcher(url, {
        signal: controller.signal,
        headers: { accept: "application/gzip", "user-agent": "Somite/0.1" },
      }), MAX_ARCHIVE_BYTES, `${repository.owner}/${repository.name}@${resolved.slice(0, 12)} source`);
    } finally {
      clearTimeout(timeout);
    }
    const files = await extractGithubTarGz(compressed);
    const sourceEntrypoint = entrypoint(files);
    const derived = deriveSourceWorkflow(files, {
      provider: "github",
      repository: repository.url,
      requested_revision: requestedRevision,
      resolved_revision: resolved,
      entrypoint: sourceEntrypoint,
    });
    await persistSourceObject(this.#root, derived.manifest, files);
    const response = await this.#response(repository, derived.workflow, false);
    await atomicWrite(requestPath, `${JSON.stringify({
      schema_version: 1,
      indexer_revision: SOURCE_INDEXER_REVISION,
      workflow: derived.workflow,
    }, null, 2)}\n`);
    return response;
  }

  async #resolveRevision(repository: GithubRepository, requested: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("GitHub revision lookup timed out")), 30_000);
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "Somite/0.1",
      "x-github-api-version": "2022-11-28",
    };
    try {
      let revision = requested;
      if (!revision) {
        const metadataBytes = await responseBytes(await this.#fetcher(
          `https://api.github.com/repos/${repository.owner}/${repository.name}`,
          { signal: controller.signal, headers },
        ), MAX_API_BYTES, "GitHub repository lookup");
        const metadata = object(JSON.parse(decoder.decode(metadataBytes)), "GitHub repository lookup");
        if (typeof metadata.default_branch !== "string" || !metadata.default_branch.trim()) throw new Error("GitHub repository has no default branch");
        revision = metadata.default_branch;
      }
      const commitBytes = await responseBytes(await this.#fetcher(
        `https://api.github.com/repos/${repository.owner}/${repository.name}/commits/${encodeURIComponent(revision)}`,
        { signal: controller.signal, headers },
      ), MAX_API_BYTES, "GitHub commit lookup");
      const commit = object(JSON.parse(decoder.decode(commitBytes)), "GitHub commit lookup");
      if (typeof commit.sha !== "string" || !GIT_OBJECT.test(commit.sha)) throw new Error("GitHub commit lookup did not return a canonical commit ID");
      return commit.sha;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #response(repository: GithubRepository, sourceWorkflowValue: unknown, cached: boolean) {
    const sourceOperator = this.#catalog.get("workflow.source");
    if (!sourceOperator) throw new Error("workflow.source operator is missing");
    const graph = parseGraph({
      schema_version: 3,
      name: repository.name,
      nodes: [{
        id: `source-${repository.name.replace(/[^A-Za-z0-9_-]/g, "-")}`,
        operator: sourceOperator.id,
        operator_revision: sourceOperator.revision,
        ports: [],
        params: {},
        source_workflow: sourceWorkflowValue,
        layout: { x: 0, y: 0 },
        note: `Pinned from ${repository.owner}/${repository.name}`,
      }],
      edges: [],
      annotations: [],
    }, cached ? "cached GitHub source request.workflow" : "GitHub source workflow");
    const sourceWorkflow = graph.nodes[0]!.source_workflow!;
    graph.nodes[0]!.note = `Pinned from ${repository.owner}/${repository.name}@${sourceWorkflow.source.resolved_revision.slice(0, 12)}`;
    const verified = this.#catalog.verifyGraph(graph);
    if (!verified.ok) throw new Error(verified.issue.message);
    await verifyGraphSourceWorkflowTrust(this.#root, this.#catalog, graph);
    return {
      engine: "nextflow",
      workflow: `${repository.owner}/${repository.name}`,
      revision: sourceWorkflow.source.requested_revision,
      graph,
      cached,
    } as const;
  }
}
