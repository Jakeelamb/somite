import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { operatorPorts, type OperatorCatalog } from "@somite/workflow/catalog";
import { parseGraph } from "@somite/workflow/graphCodec";
import type { SomiteGraph } from "@somite/workflow/model";
import {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_FILES,
  buildSourceManifest,
  type FrozenSourceFile,
} from "@somite/workflow/nextflowSource";
import { deriveSourceWorkflow } from "@somite/workflow/sourceWorkflow";
import { validateGraph } from "@somite/workflow/workflow";

import { pathExists, regularDirectory } from "./files.ts";
import { SnakemakeGateway } from "./snakemakeGateway.ts";
import { persistSourceObject, readSourceObject } from "./sourceWorkflowStore.ts";
import { verifyGraphSourceWorkflowTrust } from "./sourceWorkflowTrust.ts";
import { MAX_WORKFLOW_DOCUMENT_BYTES } from "@somite/workflow/limits";

const MAX_SOURCE_DIRECTORIES = 20_000;
const MAX_EXCLUSION_EXAMPLES = 32;
const SOURCE_STATE_ENTRIES = new Set([
  ".cache", ".git", ".nextflow", ".pixi", ".pytest_cache", ".snakemake", ".somite", ".venv",
  "__pycache__", "data", "node_modules", "output", "outputs", "results", "testdata", "venv", "work",
]);
const SOURCE_DIRECTORIES = new Set([
  ".github", "assets", "bin", "conf", "config", "configs", "docs", "envs", "environments", "lib", "modules",
  "schemas", "scripts", "subworkflows", "templates", "tests", "workflows",
]);
const SOURCE_EXTENSIONS = new Set([
  ".bash", ".c", ".cc", ".config", ".cpp", ".css", ".cwl", ".fish", ".go", ".groovy", ".h", ".hpp",
  ".j2", ".java", ".jinja", ".jinja2", ".js", ".json", ".kt", ".lock", ".md", ".nf", ".pl", ".py", ".r",
  ".rb", ".rmd", ".rs", ".rst", ".scala", ".scss", ".sh", ".sql", ".toml", ".ts", ".wdl",
  ".yaml", ".yml", ".zsh",
]);
const SOURCE_NAMES = new Set([
  "citation.cff", "containerfile", "dockerfile", "license", "makefile", "modules.json", "nextflow_schema.json",
  "readme", "version",
]);
const SENSITIVE_EXTENSIONS = new Set([".jks", ".kdbx", ".key", ".keystore", ".p12", ".pem", ".pfx"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ProjectGatewayErrorCode =
  | "project_request_invalid"
  | "project_path_invalid"
  | "project_ambiguous"
  | "project_unsupported"
  | "project_graph_invalid"
  | "project_source_invalid"
  | "project_import_failed";

export class ProjectGatewayError extends Error {
  readonly code: ProjectGatewayErrorCode;

  constructor(code: ProjectGatewayErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectGatewayError";
    this.code = code;
  }
}

export type ProjectOpenRequest = Readonly<{
  path: string;
  snakemake_targets?: readonly string[];
}>;

type ProjectLocation = Readonly<{
  project_path: string;
  entrypoint: string;
}>;

export type ProjectSourceExclusionReason = "runtime_state" | "sensitive" | "not_workflow_source";

export type ProjectSourceExclusions = Readonly<{
  count: number;
  examples: readonly Readonly<{ path: string; reason: ProjectSourceExclusionReason }>[];
}>;

export type ProjectOpenResponse =
  | Readonly<ProjectLocation & {
      kind: "somite";
      graph: SomiteGraph;
      /** Canonical runner-only location; the HTTP adapter replaces it with an opaque identifier. */
      input_base: string;
    }>
  | Readonly<ProjectLocation & {
      kind: "nextflow";
      graph: SomiteGraph;
      cached: boolean;
      source_digest: string;
      workflow_revision: string;
      exclusions: ProjectSourceExclusions;
    }>
  | Readonly<ProjectLocation & {
      kind: "snakemake";
      graph: SomiteGraph;
      cached: boolean;
      revision: string;
    }>;

type CanonicalTarget = Readonly<{
  absolute: string;
  kind: "file" | "directory";
}>;

type DetectedProject =
  | Readonly<{ kind: "somite"; project: string; entrypoint: string; file: string }>
  | Readonly<{ kind: "nextflow"; project: string; entrypoint: "main.nf" }>
  | Readonly<{ kind: "snakemake"; project: string; entrypoint: string; file: string }>;

type SnakemakeImporter = Pick<SnakemakeGateway, "importLocal">;

function failure(code: ProjectGatewayErrorCode, message: string, cause?: unknown): never {
  throw new ProjectGatewayError(code, message, cause);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestContract(value: unknown) {
  if (!isObject(value)) failure("project_request_invalid", "project request must be an object");
  const unknown = Object.keys(value).find((key) => key !== "path" && key !== "snakemake_targets");
  if (unknown) failure("project_request_invalid", `project request contains unknown field ${unknown}`);
  if (typeof value.path !== "string" || !value.path.trim()) {
    failure("project_request_invalid", "project path must be a non-empty string");
  }
  if (value.path.length > 4096 || [...value.path].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0 || code < 32 || code === 127;
  })) failure("project_request_invalid", "project path is not a bounded printable path");
  if (value.snakemake_targets !== undefined
    && (!Array.isArray(value.snakemake_targets) || value.snakemake_targets.some((target) => typeof target !== "string"))) {
    failure("project_request_invalid", "snakemake_targets must be an array of strings");
  }
  return { path: value.path.trim(), targets: value.snakemake_targets ?? [] };
}

function pathInside(root: string, path: string, allowRoot = false) {
  const fromRoot = relative(root, path);
  return (allowRoot || Boolean(fromRoot)) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function portableRelative(root: string, path: string) {
  const fromRoot = relative(root, path);
  return fromRoot ? fromRoot.split(sep).join("/") : ".";
}

async function canonicalTarget(root: string, supplied: string): Promise<CanonicalTarget> {
  const absolute = resolve(root, supplied);
  if (!isAbsolute(supplied) && !pathInside(root, absolute, true)) {
    return failure("project_path_invalid", "a relative local project path must stay inside the current workspace; use an explicit absolute path for another project");
  }
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      return failure("project_path_invalid", "local project path must not be a symbolic link");
    }
    if (!metadata.isFile() && !metadata.isDirectory()) {
      return failure("project_path_invalid", "local project path must be a regular file or directory");
    }
    const canonical = await realpath(absolute);
    if (canonical !== absolute) {
      return failure("project_path_invalid", "local project path must not cross a symbolic link");
    }
    return {
      absolute,
      kind: metadata.isFile() ? "file" : "directory",
    };
  } catch (error) {
    if (error instanceof ProjectGatewayError) throw error;
    return failure("project_path_invalid", `local project path is not available: ${supplied}`, error);
  }
}

function projectDisplayPath(root: string, project: string) {
  return pathInside(root, project, true) ? portableRelative(root, project) : `external/${basename(project)}`;
}

function snakemakeLocation(file: string) {
  const parent = dirname(file);
  const project = basename(parent) === "workflow" && basename(file) === "Snakefile" ? dirname(parent) : parent;
  return { project, entrypoint: portableRelative(project, file) };
}

function explicitProject(target: CanonicalTarget): DetectedProject {
  const name = basename(target.absolute);
  if (name.endsWith(".somite.json")) {
    return { kind: "somite", project: dirname(target.absolute), entrypoint: name, file: target.absolute };
  }
  if (name === "main.nf") {
    return { kind: "nextflow", project: dirname(target.absolute), entrypoint: "main.nf" };
  }
  if (name === "Snakefile" || extname(name) === ".smk") {
    return { kind: "snakemake", ...snakemakeLocation(target.absolute), file: target.absolute };
  }
  return failure(
    "project_unsupported",
    "unsupported local project file; choose a .somite.json graph, main.nf, Snakefile, or .smk entrypoint",
  );
}

async function regularMarker(path: string, label: string) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) failure("project_path_invalid", `${label} must not be a symbolic link`);
  if (!metadata.isFile()) failure("project_path_invalid", `${label} must be a regular file`);
  return path;
}

async function detectDirectory(directory: string): Promise<DetectedProject> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const candidates: DetectedProject[] = [];
  for (const entry of entries.filter((candidate) => candidate.name.endsWith(".somite.json"))) {
    const file = await regularMarker(join(directory, entry.name), entry.name);
    candidates.push({ kind: "somite", project: directory, entrypoint: entry.name, file });
  }
  if (entries.some((entry) => entry.name === "main.nf")) {
    await regularMarker(join(directory, "main.nf"), "main.nf");
    candidates.push({ kind: "nextflow", project: directory, entrypoint: "main.nf" });
  }
  if (entries.some((entry) => entry.name === "Snakefile")) {
    const file = await regularMarker(join(directory, "Snakefile"), "Snakefile");
    candidates.push({ kind: "snakemake", project: directory, entrypoint: "Snakefile", file });
  }
  const workflowEntry = entries.find((entry) => entry.name === "workflow");
  if (workflowEntry) {
    const workflow = join(directory, "workflow");
    const metadata = await lstat(workflow);
    if (metadata.isSymbolicLink()) failure("project_path_invalid", "workflow directory must not be a symbolic link");
    if (metadata.isDirectory()) {
      const nested = (await readdir(workflow)).includes("Snakefile") ? join(workflow, "Snakefile") : undefined;
      if (nested) {
        await regularMarker(nested, "workflow/Snakefile");
        candidates.push({ kind: "snakemake", project: directory, entrypoint: "workflow/Snakefile", file: nested });
      }
    }
  }
  if (!candidates.length) {
    return failure(
      "project_unsupported",
      "unsupported local project directory; expected one .somite.json graph, main.nf, Snakefile, or workflow/Snakefile",
    );
  }
  if (candidates.length !== 1) {
    return failure(
      "project_ambiguous",
      `local project directory is ambiguous: ${candidates.map((candidate) => candidate.entrypoint).join(", ")}; choose one entrypoint explicitly`,
    );
  }
  return candidates[0]!;
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readStableFile(
  path: string,
  inspected: Awaited<ReturnType<typeof lstat>>,
  maximum: number,
  label: string,
  code: "project_graph_invalid" | "project_source_invalid" = "project_source_invalid",
) {
  if (!inspected.isFile() || inspected.isSymbolicLink()) failure(code, `${label} must be a regular non-symlink file`);
  if (inspected.size > maximum) failure(code, `${label} exceeds ${maximum} bytes`);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(inspected, opened)) {
      return failure(code, `${label} changed between inspection and open`);
    }
    const bytes = await handle.readFile();
    const confirmed = await handle.stat();
    if (bytes.byteLength !== inspected.size || !sameFileIdentity(opened, confirmed)) {
      return failure(code, `${label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function legacyGraph(value: unknown, catalog: OperatorCatalog) {
  try {
    return parseGraph(value);
  } catch (originalError) {
    if (!isObject(value) || (value.schema_version !== 1 && value.schema_version !== 2) || !Array.isArray(value.nodes)) {
      throw originalError;
    }
    const nodes = value.nodes.map((candidate) => {
      if (!isObject(candidate) || typeof candidate.operator !== "string") throw originalError;
      const operator = catalog.get(candidate.operator);
      if (!operator) throw originalError;
      return { ...candidate, operator_revision: operator.revision, ports: operatorPorts(operator) };
    });
    return parseGraph({ ...value, schema_version: 3, nodes });
  }
}

async function readSomiteGraph(path: string, catalog: OperatorCatalog) {
  try {
    const metadata = await lstat(path);
    const bytes = await readStableFile(path, metadata, MAX_WORKFLOW_DOCUMENT_BYTES, "Somite graph", "project_graph_invalid");
    const graph = legacyGraph(JSON.parse(decoder.decode(bytes)), catalog);
    const verified = catalog.verifyGraph(graph);
    if (!verified.ok) failure("project_graph_invalid", verified.issue.message);
    return graph;
  } catch (error) {
    if (error instanceof ProjectGatewayError) throw error;
    return failure("project_graph_invalid", `Somite graph could not be opened: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

async function sourceObjectOwner(start: string, destinationRoot: string, sourceDigest: string) {
  const identity = sourceDigest.slice("blake3:".length);
  const candidates: string[] = [];
  let candidate = start;
  while (true) {
    candidates.push(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  if (!candidates.includes(destinationRoot)) candidates.unshift(destinationRoot);
  for (const root of candidates) {
    if (await pathExists(join(root, ".somite", "source-workflows", "objects", identity))) return root;
  }
  return undefined;
}

async function importSomiteSourceObjects(destinationRoot: string, graphRoot: string, graph: SomiteGraph) {
  const digests = new Set(graph.nodes.flatMap((node) => node.source_workflow
    ? [node.source_workflow.source.source_digest]
    : []));
  for (const sourceDigest of digests) {
    const owner = await sourceObjectOwner(graphRoot, destinationRoot, sourceDigest);
    if (!owner) {
      failure(
        "project_graph_invalid",
        `Somite graph references source object ${sourceDigest}, but that frozen source was not found beside either project`,
      );
    }
    const source = await readSourceObject(owner, sourceDigest);
    await persistSourceObject(destinationRoot, source.manifest, source.files);
  }
}

function sensitiveSourcePath(path: string) {
  const components = path.toLocaleLowerCase("en-US").split("/");
  if (components.some((component) => component === ".aws" || component === ".gnupg" || component === ".ssh")) return true;
  const name = components.at(-1) ?? "";
  const stem = name.split(".")[0] ?? name;
  return name === ".netrc" || name === ".npmrc" || name === ".pypirc" || name === "id_ed25519" || name === "id_rsa"
    || name === "token" || name.startsWith(".env") || /^(?:credential|credentials|password|passwords|secret|secrets)$/.test(stem)
    || SENSITIVE_EXTENSIONS.has(extname(name));
}

function sensitiveSourceContent(bytes: Uint8Array) {
  const sampleBytes = 1024 * 1024;
  const textDecoder = new TextDecoder("utf-8");
  const text = bytes.byteLength <= sampleBytes * 2
    ? textDecoder.decode(bytes)
    : `${textDecoder.decode(bytes.subarray(0, sampleBytes))}\n${textDecoder.decode(bytes.subarray(bytes.byteLength - sampleBytes))}`;
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /\bAKIA[0-9A-Z]{16}\b/.test(text)
    || /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})\b/.test(text)
    || /:\/\/[^/\s:@]+:[^@\s/]+@/.test(text)) return true;
  const concreteSecret = /(?:^|\n)\s*(?:export\s+)?[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*\s*[:=]\s*([^\r\n#]+)/gi;
  for (const match of text.matchAll(concreteSecret)) {
    const value = (match[1] ?? "").trim().replace(/^["']|["',]\s*$/g, "");
    if (value.length < 8 || /^(?:[$<{[]|null\b|none\b|false\b|true\b|changeme\b|dummy\b|example\b|placeholder\b|your[_-]|params\.|env\.|secrets\.|process\.env|os\.getenv)/i.test(value)) continue;
    return true;
  }
  return false;
}

function workflowSourceFile(path: string, executable: boolean) {
  const components = path.toLocaleLowerCase("en-US").split("/");
  const name = components.at(-1) ?? "";
  const extension = extname(name);
  if (name.endsWith(".nf.test") || SOURCE_EXTENSIONS.has(extension)) return true;
  if (SOURCE_NAMES.has(name) || name.startsWith("readme.") || name.startsWith("license.")) return true;
  if (components.some((component) => SOURCE_DIRECTORIES.has(component))) return true;
  return executable && !extension && components.some((component) => component === "bin" || component === "scripts");
}

async function nextflowFiles(project: string): Promise<{ files: FrozenSourceFile[]; exclusions: ProjectSourceExclusions }> {
  const files: FrozenSourceFile[] = [];
  const exclusionExamples: Array<{ path: string; reason: ProjectSourceExclusionReason }> = [];
  let exclusionCount = 0;
  const exclude = (path: string, reason: ProjectSourceExclusionReason) => {
    exclusionCount += 1;
    if (exclusionExamples.length < MAX_EXCLUSION_EXAMPLES) exclusionExamples.push({ path, reason });
  };
  const pending: Array<{ directory: string; prefix: string }> = [{ directory: project, prefix: "" }];
  let directoryCount = 1;
  let totalBytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const canonical = await realpath(current.directory);
    if (canonical !== resolve(current.directory) || !pathInside(project, canonical, true)) {
      failure("project_source_invalid", `Nextflow source directory ${current.prefix || "."} crosses a symbolic link`);
    }
    const entries = (await readdir(current.directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const portablePath = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      const path = join(current.directory, entry.name);
      const metadata = await lstat(path);
      const entryName = entry.name.toLocaleLowerCase("en-US");
      if (SOURCE_STATE_ENTRIES.has(entryName) || /^\.nextflow\.log(?:\.\d+)?$/.test(entryName)) {
        exclude(portablePath, "runtime_state");
        continue;
      }
      if (sensitiveSourcePath(portablePath)) {
        exclude(portablePath, "sensitive");
        continue;
      }
      if (metadata.isSymbolicLink()) failure("project_source_invalid", `Nextflow source contains symbolic link ${portablePath}`);
      if (metadata.isDirectory()) {
        directoryCount += 1;
        if (directoryCount > MAX_SOURCE_DIRECTORIES) failure("project_source_invalid", `Nextflow source exceeds ${MAX_SOURCE_DIRECTORIES} directories`);
        pending.push({ directory: path, prefix: portablePath });
        continue;
      }
      if (!metadata.isFile()) failure("project_source_invalid", `Nextflow source contains unsupported entry ${portablePath}`);
      const executable = process.platform !== "win32" && Boolean(metadata.mode & 0o111);
      if (!workflowSourceFile(portablePath, executable)) {
        exclude(portablePath, "not_workflow_source");
        continue;
      }
      if (files.length >= MAX_SOURCE_FILES) failure("project_source_invalid", `Nextflow source exceeds ${MAX_SOURCE_FILES} files`);
      if (metadata.size > MAX_SOURCE_FILE_BYTES) failure("project_source_invalid", `Nextflow source file ${portablePath} exceeds ${MAX_SOURCE_FILE_BYTES} bytes`);
      totalBytes += metadata.size;
      if (totalBytes > MAX_SOURCE_BYTES) failure("project_source_invalid", `Nextflow source exceeds ${MAX_SOURCE_BYTES} bytes`);
      const bytes = await readStableFile(path, metadata, MAX_SOURCE_FILE_BYTES, `Nextflow source file ${portablePath}`);
      if (sensitiveSourceContent(bytes)) {
        totalBytes -= metadata.size;
        exclude(portablePath, "sensitive");
        continue;
      }
      files.push({
        path: portablePath,
        mode: executable ? 0o100755 : 0o100644,
        bytes,
      });
    }
  }
  if (!files.some((file) => file.path === "main.nf")) failure("project_source_invalid", "Nextflow project has no regular main.nf entrypoint");
  return { files, exclusions: { count: exclusionCount, examples: exclusionExamples } };
}

function validGraph(graph: SomiteGraph, catalog: OperatorCatalog) {
  const valid = validateGraph(graph);
  if (!valid.ok) failure("project_source_invalid", valid.issue.message);
  const verified = catalog.verifyGraph(graph);
  if (!verified.ok) failure("project_source_invalid", verified.issue.message);
  return graph;
}

/** Detect, validate, and import one explicit local project without guessing. */
export class ProjectGateway {
  readonly #root: string;
  #catalog: OperatorCatalog;
  readonly #snakemake: SnakemakeImporter;

  constructor(root: string, catalog: OperatorCatalog, snakemake: SnakemakeImporter = new SnakemakeGateway(root, catalog)) {
    this.#root = root;
    this.#catalog = catalog;
    this.#snakemake = snakemake;
  }

  updateCatalog(catalog: OperatorCatalog) {
    if (!catalog.isExtensionOf(this.#catalog)) throw new Error("project catalog updates must preserve every pinned operator revision");
    this.#catalog = catalog;
  }

  async open(value: unknown): Promise<ProjectOpenResponse> {
    return this.#open(value);
  }

  async openUploaded(path: string, displayName: string): Promise<ProjectOpenResponse> {
    if (!displayName || displayName === "." || displayName === ".." || displayName.includes("/") || displayName.includes("\\")
      || Buffer.byteLength(displayName, "utf8") > 255 || [...displayName].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) {
      failure("project_request_invalid", "uploaded project name is invalid");
    }
    return this.#open({ path, snakemake_targets: [] }, displayName);
  }

  async #open(value: unknown, displayPath?: string): Promise<ProjectOpenResponse> {
    const request = requestContract(value);
    const root = await realpath(this.#root).catch((error) => failure("project_path_invalid", "project root is not available", error));
    await regularDirectory(root, "project root").catch((error) => failure("project_path_invalid", "project root must be a regular directory", error));
    const target = await canonicalTarget(root, request.path);
    let detected: DetectedProject;
    try {
      detected = target.kind === "file" ? explicitProject(target) : await detectDirectory(target.absolute);
    } catch (error) {
      if (error instanceof ProjectGatewayError) throw error;
      return failure("project_path_invalid", `local project could not be inspected: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    if (detected.kind !== "snakemake" && request.targets.length) {
      return failure("project_request_invalid", "snakemake_targets can only be used with a Snakemake project");
    }
    const projectPath = displayPath ?? projectDisplayPath(root, detected.project);
    if (detected.kind === "somite") {
      const graph = await readSomiteGraph(detected.file, this.#catalog);
      await importSomiteSourceObjects(root, detected.project, graph);
      await verifyGraphSourceWorkflowTrust(root, this.#catalog, graph);
      return {
        kind: "somite",
        project_path: projectPath,
        entrypoint: detected.entrypoint,
        graph,
        input_base: dirname(detected.file),
      };
    }
    if (detected.kind === "nextflow") {
      try {
        const { files, exclusions } = await nextflowFiles(detected.project);
        const manifest = buildSourceManifest(files);
        const derived = deriveSourceWorkflow(files, {
          provider: "local",
          repository: `local:${projectPath}`,
          requested_revision: "working-tree",
          resolved_revision: manifest.source_digest.slice("blake3:".length),
          entrypoint: "main.nf",
        });
        const stored = await persistSourceObject(root, derived.manifest, files);
        const sourceOperator = this.#catalog.get("workflow.source");
        if (!sourceOperator) failure("project_source_invalid", "workflow.source operator is missing");
        const graph = validGraph({
          schema_version: 3,
          name: projectPath === "." ? "Local Nextflow workflow" : basename(detected.project),
          nodes: [{
            id: `source-${manifest.source_digest.slice("blake3:".length, "blake3:".length + 12)}`,
            operator: sourceOperator.id,
            operator_revision: sourceOperator.revision,
            ports: operatorPorts(sourceOperator),
            params: {},
            source_workflow: derived.workflow,
            layout: { x: 0, y: 0 },
            note: `Frozen from ${projectPath}/main.nf`,
          }],
          edges: [],
          annotations: [],
        }, this.#catalog);
        await verifyGraphSourceWorkflowTrust(root, this.#catalog, graph);
        return {
          kind: "nextflow",
          project_path: projectPath,
          entrypoint: "main.nf",
          graph,
          cached: stored.cached,
          source_digest: manifest.source_digest,
          workflow_revision: derived.workflow.workflow_revision,
          exclusions,
        };
      } catch (error) {
        if (error instanceof ProjectGatewayError) throw error;
        return failure("project_source_invalid", `Nextflow project could not be frozen: ${error instanceof Error ? error.message : String(error)}`, error);
      }
    }
    try {
      const imported = await this.#snakemake.importLocal(detected.file, request.targets, projectPath);
      const verified = this.#catalog.verifyGraph(imported.graph);
      if (!verified.ok) failure("project_import_failed", verified.issue.message);
      return {
        kind: "snakemake",
        project_path: projectPath,
        entrypoint: detected.entrypoint,
        graph: imported.graph,
        cached: imported.cached,
        revision: imported.revision,
      };
    } catch (error) {
      if (error instanceof ProjectGatewayError) throw error;
      return failure("project_import_failed", `Snakemake project could not be visualized: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }
}
