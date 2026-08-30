import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzip } from "node:zlib";

import type { OperatorCatalog } from "@somite/workflow/catalog";
import { byteDigest } from "@somite/workflow/contentIdentity";
import type { SomiteGraph, SourceWorkflowInstance } from "@somite/workflow/model";
import {
  NFCORE_CATALOG_URL,
  nfcoreCatalogResponse,
  parseNfcoreCatalog,
  searchNfcoreCatalog,
  type NfcorePipeline,
} from "@somite/workflow/nfcore";
import {
  buildSourceManifest,
  safeSourcePath,
  type FrozenSourceFile,
  type SourceManifest,
} from "@somite/workflow/nextflowSource";
import { deriveSourceWorkflow, SOURCE_INDEXER_REVISION, sourceWorkflowRevision } from "@somite/workflow/sourceWorkflow";
import { validateGraph } from "@somite/workflow/workflow";
import { atomicWrite, containedPath, ensurePrivateDirectory, pathExists, regularDirectory, regularFile } from "./files.ts";

const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 640 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type CatalogSnapshot = Readonly<{ pipelines: readonly NfcorePipeline[]; cached: boolean }>;

async function boundedResponse(response: Response, maximumBytes: number, label: string) {
  if (!response.ok) throw new Error(`${label} returned ${response.status} ${response.statusText}`);
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(announced) && announced > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function unzip(bytes: Uint8Array) {
  return new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    gunzip(bytes, { maxOutputLength: MAX_UNPACKED_BYTES }, (error, result) => {
      if (error) rejectPromise(error);
      else resolvePromise(result);
    });
  });
}

function tarText(block: Uint8Array, start: number, length: number) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end < 0 ? field : field.subarray(0, end)).trim();
}

function tarOctal(block: Uint8Array, start: number, length: number, label: string) {
  const value = tarText(block, start, length).replace(/^0+/, "") || "0";
  if (!/^[0-7]+$/.test(value)) throw new Error(`tar ${label} is not octal`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`tar ${label} is outside the safe integer domain`);
  return parsed;
}

function verifyTarHeader(block: Uint8Array) {
  const expected = tarOctal(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 32 : block[index]!;
  if (actual !== expected) throw new Error("tar header checksum is invalid");
}

function parsePax(bytes: Uint8Array) {
  const values = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error("PAX record has no length separator");
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, space)), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw new Error("PAX record length is invalid");
    const record = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) values.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return values;
}

export async function extractGithubTarGz(compressed: Uint8Array): Promise<FrozenSourceFile[]> {
  const archive = await unzip(compressed);
  const raw: Array<{ path: string; mode: number; bytes: Uint8Array }> = [];
  let offset = 0;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    verifyTarHeader(header);
    const size = tarOctal(header, 124, 12, "size");
    const mode = tarOctal(header, 100, 8, "mode");
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = tarText(header, 345, 155);
    const headerName = `${prefix ? `${prefix}/` : ""}${tarText(header, 0, 100)}`;
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) throw new Error("tar entry exceeds the archive");
    const body = archive.slice(bodyStart, bodyEnd);
    if (type === "x") pax = parsePax(body);
    else if (type === "L") longName = tarText(body, 0, body.length);
    else if (type === "0" || type === "\0") {
      const path = pax.get("path") ?? longName ?? headerName;
      raw.push({ path, mode, bytes: body });
      pax = new Map();
      longName = undefined;
    } else if (type === "1" || type === "2") {
      throw new Error(`source archive contains unsupported linked entry ${headerName}`);
    } else if (type !== "5" && type !== "g") {
      throw new Error(`source archive contains unsupported tar entry type ${JSON.stringify(type)}`);
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (!raw.length) throw new Error("source archive contains no regular files");
  const roots = new Set(raw.map((file) => file.path.split("/")[0]));
  if (roots.size !== 1) throw new Error("source archive does not have one repository root");
  return raw.map((file): FrozenSourceFile => {
    const path = file.path.split("/").slice(1).join("/");
    if (!safeSourcePath(path)) throw new Error(`source archive contains unsafe path ${file.path}`);
    return { path, mode: file.mode & 0o111 ? 0o100755 : 0o100644, bytes: file.bytes };
  });
}

async function writeSourceObject(root: string, manifest: SourceManifest, files: readonly FrozenSourceFile[]) {
  const objects = await ensurePrivateDirectory(root, ".somite/source-workflows/objects");
  const identity = manifest.source_digest.slice("blake3:".length);
  const destination = join(objects, identity);
  if (await pathExists(destination)) {
    await readSourceObject(root, manifest.source_digest);
    return;
  }
  const temporary = join(objects, `.incoming-${identity}-${randomUUID()}`);
  await mkdir(join(temporary, "source"), { recursive: true });
  try {
    for (const file of files) {
      const path = containedPath(join(temporary, "source"), file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes, { flag: "wx", mode: file.mode === 0o100755 ? 0o755 : 0o644 });
      if (file.mode === 0o100755) await chmod(path, 0o755);
    }
    await writeFile(join(temporary, "source-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && await pathExists(destination)) {
      await readSourceObject(root, manifest.source_digest);
      return;
    }
    throw error;
  }
}

export async function readSourceObject(root: string, sourceDigest: string) {
  if (!/^blake3:[0-9a-f]{64}$/.test(sourceDigest)) throw new Error("source digest is malformed");
  const objects = await ensurePrivateDirectory(root, ".somite/source-workflows/objects");
  const directory = join(objects, sourceDigest.slice("blake3:".length));
  await regularDirectory(directory, "source object");
  const source = join(directory, "source");
  await regularDirectory(source, "source object tree");
  const manifest = JSON.parse(decoder.decode(await regularFile(join(directory, "source-manifest.json"), 16 * 1024 * 1024, "source manifest"))) as SourceManifest;
  const files: FrozenSourceFile[] = [];
  for (const entry of manifest.files) {
    if (!safeSourcePath(entry.path)) throw new Error(`source manifest contains unsafe path ${entry.path}`);
    const path = containedPath(source, entry.path);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== entry.bytes) throw new Error(`source file ${entry.path} does not match its manifest`);
    files.push({ path: entry.path, mode: entry.mode, bytes: await readFile(path) });
  }
  const actual = buildSourceManifest(files);
  if (JSON.stringify(actual) !== JSON.stringify(manifest) || actual.source_digest !== sourceDigest) throw new Error(`source object ${sourceDigest} failed exact verification`);
  return { manifest: actual, files };
}

function requestKey(workflow: string, revision: string) {
  return byteDigest(encoder.encode(`somite-nfcore-source-request-ts-v1\0${SOURCE_INDEXER_REVISION}\0${workflow}\0${revision}`)).slice("blake3:".length);
}

export class NfcoreGateway {
  readonly #root: string;
  readonly #catalog: OperatorCatalog;
  readonly #fetcher: typeof fetch;
  #snapshot?: Promise<CatalogSnapshot>;

  constructor(root: string, catalog: OperatorCatalog, fetcher: typeof fetch = fetch) {
    this.#root = root;
    this.#catalog = catalog;
    this.#fetcher = fetcher;
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
      const cached = JSON.parse(decoder.decode(await regularFile(requestPath, 32 * 1024 * 1024, "nf-core source request"))) as { workflow: SourceWorkflowInstance };
      if (sourceWorkflowRevision(cached.workflow) !== cached.workflow.workflow_revision
        || cached.workflow.source.requested_revision !== revision
        || cached.workflow.source.resolved_revision !== pipeline.resolvedRevision) throw new Error("cached nf-core source request has an invalid identity");
      await readSourceObject(this.#root, cached.workflow.source.source_digest);
      return this.#response(workflow, revision, cached.workflow, true);
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
    await writeSourceObject(this.#root, derived.manifest, files);
    await atomicWrite(requestPath, `${JSON.stringify({
      schema_version: 1,
      indexer_revision: SOURCE_INDEXER_REVISION,
      workflow: derived.workflow,
    }, null, 2)}\n`);
    return this.#response(workflow, revision, derived.workflow, false);
  }

  #response(workflow: string, revision: string, sourceWorkflow: SourceWorkflowInstance, cached: boolean) {
    const sourceOperator = this.#catalog.get("workflow.source");
    if (!sourceOperator) throw new Error("workflow.source operator is missing");
    const graph: SomiteGraph = {
      schema_version: 3,
      name: workflow,
      nodes: [{
        id: `source-${workflow.slice("nf-core/".length)}`,
        operator: sourceOperator.id,
        operator_revision: sourceOperator.revision,
        ports: [],
        params: {},
        source_workflow: sourceWorkflow,
        layout: { x: 0, y: 0 },
        note: `Pinned from ${workflow}@${revision} (${sourceWorkflow.source.resolved_revision.slice(0, 12)})`,
      }],
      edges: [],
      annotations: [],
    };
    const valid = validateGraph(graph);
    if (!valid.ok) throw new Error(valid.issue.message);
    const verified = this.#catalog.verifyGraph(graph);
    if (!verified.ok) throw new Error(verified.issue.message);
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
