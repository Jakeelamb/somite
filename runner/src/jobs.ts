import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  archiveFrozenPackage,
  createFrozenPackageFiles,
  safeArchiveName,
  type ExportTarget,
  type FrozenPackage,
} from "@somite/workflow/bundle";
import { OperatorCatalog } from "@somite/workflow/catalog";
import type { WorkflowAssessmentContext } from "@somite/workflow/assessment";
import { byteDigest, canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import {
  bindRepresentativeFastq,
  representativeValidationCapability,
  SOURCE_PREVIEW_PACK,
  type FixtureBinding,
  type MaterializedFastqFixture,
  RepresentativeValidationError,
} from "@somite/workflow/fixtures";
import {
  createEvidenceReceipt,
  emptyEvidenceIndex,
  type EvidenceReceipt,
  type EvidenceResult,
} from "@somite/workflow/linker";
import type { SomiteGraph } from "@somite/workflow/model";
import { compileNextflow, PINNED_NEXTFLOW_VERSION, PINNED_OPENJDK_VERSION } from "@somite/workflow/nextflow";
import { SOMITE_TYPESCRIPT_RUNNER_IDENTITY } from "@somite/workflow/version";
import {
  MAX_FROZEN_PACKAGE_BYTES,
  MAX_GENERATED_PACKAGE_BYTES,
  MAX_PIXI_LOCK_BYTES,
  MAX_WORKFLOW_DOCUMENT_BYTES,
} from "@somite/workflow/limits";
import { semanticGraphRevision } from "@somite/workflow/workflow";
import { EvidenceStore } from "./evidenceStore.ts";
import { atomicWrite, containedPath, pathExists } from "./files.ts";
import { PixiCache, type LockedManifest } from "./pixiCache.ts";
import { readSourceObject } from "./sourceWorkflowStore.ts";
import { terminateProcessTree } from "./process.ts";
import { materializeProductionGraph, type GraphInputLocation, type ManagedResourceResolver } from "./productionGraph.ts";
import { RunStorage } from "./runStorage.ts";
import { requireReadyWorkflow } from "./workflowAdmission.ts";
import { executablePath, pixiPlatform } from "./system.ts";

export type RunPhase = "preparing" | "running" | "finalizing" | "completed" | "failed" | "cancelling" | "cancelled";
export type RunNodeState = "queued" | "running" | "cached" | "done" | "failed" | "skipped" | "cancelled";

const MAX_FAILURE_LOG_TAIL_BYTES = 64 * 1024;

export type RunStatus = {
  run_id: string;
  phase: RunPhase;
  states: Record<string, RunNodeState>;
  closure_digest?: string;
  exit_code?: number;
  error?: string;
  evidence_receipt?: EvidenceReceipt;
  progress: { completed: number; total: number; unit: "nodes"; message: string };
};

export type RunStart = Readonly<{ run_id: string; phase: RunPhase; replayed: boolean }>;

type RepresentativeValidationContext = Readonly<{
  kind: "representative_fastq";
  subjectDigest: string;
  binding: FixtureBinding;
  originalGraph: SomiteGraph;
}>;

type SourceValidationContext = Readonly<{
  kind: "source_preview";
  subjectDigest: string;
  configurationDigest: string;
  fixturePack: typeof SOURCE_PREVIEW_PACK;
  fixtureDigests: readonly string[];
  originalGraph: SomiteGraph;
}>;

type ValidationContext = RepresentativeValidationContext | SourceValidationContext;

type RunJob = {
  id: string;
  intent: "run" | "validation";
  packagePath: string;
  graph: SomiteGraph;
  status: RunStatus;
  validation?: ValidationContext;
  abort: AbortController;
  child?: ChildProcess;
  revision: number;
  waiters: Set<() => void>;
};

const encoder = new TextEncoder();

export type FrozenPackageComponent = "workflow_document" | "pixi_lock" | "generated_files" | "archive";

export class FrozenPackageSizeError extends Error {
  readonly code: string;
  readonly component: FrozenPackageComponent;
  readonly actual_bytes: number;
  readonly maximum_bytes: number;

  constructor(component: FrozenPackageComponent, actualBytes: number, maximumBytes: number) {
    const code = component === "workflow_document" ? "workflow_document_too_large"
      : component === "pixi_lock" ? "pixi_lock_too_large"
        : component === "generated_files" ? "generated_package_too_large"
          : "frozen_package_too_large";
    super(`${component.replaceAll("_", " ")} is ${actualBytes} bytes; maximum is ${maximumBytes} bytes`);
    this.name = "FrozenPackageSizeError";
    this.code = code;
    this.component = component;
    this.actual_bytes = actualBytes;
    this.maximum_bytes = maximumBytes;
  }
}

export type FrozenPackageLimits = Readonly<{
  workflowDocumentBytes: number;
  pixiLockBytes: number;
  generatedBytes: number;
  archiveBytes: number;
}>;

const FROZEN_PACKAGE_LIMITS: FrozenPackageLimits = {
  workflowDocumentBytes: MAX_WORKFLOW_DOCUMENT_BYTES,
  pixiLockBytes: MAX_PIXI_LOCK_BYTES,
  generatedBytes: MAX_GENERATED_PACKAGE_BYTES,
  archiveBytes: MAX_FROZEN_PACKAGE_BYTES,
};

function enforceComponentSize(component: FrozenPackageComponent, actualBytes: number, maximumBytes: number) {
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > maximumBytes) {
    throw new FrozenPackageSizeError(component, actualBytes, maximumBytes);
  }
}

/** Enforce every source envelope before allocating a second full ZIP representation. */
export function enforceFrozenPackageFiles(
  files: ReadonlyMap<string, Uint8Array>,
  limits: FrozenPackageLimits = FROZEN_PACKAGE_LIMITS,
) {
  const workflowBytes = files.get("workflow.somite.json")?.byteLength ?? 0;
  const pixiLockBytes = files.get("pixi.lock")?.byteLength ?? 0;
  let totalBytes = 0;
  for (const bytes of files.values()) totalBytes += bytes.byteLength;
  const generatedBytes = totalBytes - workflowBytes - pixiLockBytes;
  enforceComponentSize("workflow_document", workflowBytes, limits.workflowDocumentBytes);
  enforceComponentSize("pixi_lock", pixiLockBytes, limits.pixiLockBytes);
  enforceComponentSize("generated_files", generatedBytes, limits.generatedBytes);
  enforceComponentSize("archive", totalBytes, limits.archiveBytes);
  return totalBytes;
}

export function enforceFrozenArchiveSize(actualBytes: number, maximumBytes = MAX_FROZEN_PACKAGE_BYTES) {
  enforceComponentSize("archive", actualBytes, maximumBytes);
}

function terminal(phase: RunPhase) {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

async function writePackageFiles(directory: string, packageFiles: ReadonlyMap<string, Uint8Array>) {
  for (const [relativePath, bytes] of packageFiles) {
    const destination = join(directory, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

type PreparedSourcePackage = Readonly<{
  closureDigest: string;
  graphRevision: string;
  locked: LockedManifest;
  files: ReadonlyMap<string, Uint8Array>;
  workflow: NonNullable<SomiteGraph["nodes"][number]["source_workflow"]>;
}>;

function exactSourceNode(graph: SomiteGraph) {
  if (graph.nodes.length !== 1 || graph.edges.length || graph.variant_origin) return undefined;
  const node = graph.nodes[0];
  return node?.source_workflow?.capabilities.exact_execution ? node : undefined;
}

function sourceParameters(workflow: PreparedSourcePackage["workflow"]) {
  return Object.fromEntries(Object.entries(workflow.bindings ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, binding]) => [name, binding.kind === "literal" ? binding.value : binding.path]));
}

async function prepareSourcePackage(
  graph: SomiteGraph,
  directory: string,
  projectRoot: string,
  cache: PixiCache,
) : Promise<PreparedSourcePackage> {
  const node = exactSourceNode(graph);
  if (!node?.source_workflow) throw new Error("source workflow does not have a frozen Pixi execution contract");
  const workflow = node.source_workflow;
  const source = await readSourceObject(projectRoot, workflow.source.source_digest);
  const manifest = source.files.find((file) => file.path === "pixi.toml");
  const lock = source.files.find((file) => file.path === "pixi.lock");
  if (!manifest || !lock) throw new Error("source workflow is missing its trusted Pixi manifest or lock");
  if (source.files.some((file) => file.path.startsWith(".somite/run/"))) {
    throw new Error("source workflow reserves the .somite/run path required for execution metadata");
  }
  const locked = await cache.adoptLock(manifest.bytes, lock.bytes);
  const graphRevision = semanticGraphRevision(graph);
  const params = sourceParameters(workflow);
  const closureDigest = canonicalJsonDigest({
    schema_version: 1,
    kind: "source_workflow",
    graph_revision: graphRevision,
    workflow_revision: workflow.workflow_revision,
    source_digest: workflow.source.source_digest,
    environment_manifest_digest: locked.manifest_digest,
    environment_lock_digest: locked.lock_digest,
    parameters: params,
  });
  const generated = new Map<string, Uint8Array>([
    ["evidence/index.json", encoder.encode(`${JSON.stringify(emptyEvidenceIndex(), null, 2)}\n`)],
    [".somite/run/params.json", encoder.encode(`${JSON.stringify(params, null, 2)}\n`)],
    [".somite/run/workflow.somite.json", encoder.encode(`${JSON.stringify(graph, null, 2)}\n`)],
    [".somite/run/node-map.json", encoder.encode(`${JSON.stringify({
      schema_version: 1,
      nodes: { [node.id]: { process: null, kind: "source" } },
    }, null, 2)}\n`)],
    [".somite/run/run-closure.json", encoder.encode(`${JSON.stringify({
      schema_version: 1,
      kind: "source_workflow",
      closure_digest: closureDigest,
      graph_revision: graphRevision,
      workflow_revision: workflow.workflow_revision,
      source_digest: workflow.source.source_digest,
      environment: { manifest_digest: locked.manifest_digest, lock_digest: locked.lock_digest },
    }, null, 2)}\n`)],
  ]);
  const graphBytes = generated.get(".somite/run/workflow.somite.json")!.byteLength;
  if (graphBytes > MAX_WORKFLOW_DOCUMENT_BYTES) {
    throw new FrozenPackageSizeError("workflow_document", graphBytes, MAX_WORKFLOW_DOCUMENT_BYTES);
  }
  const files = new Map<string, Uint8Array>(source.files.map((file) => [file.path, file.bytes]));
  for (const [path, bytes] of generated) files.set(path, bytes);
  const totalBytes = [...files.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
  enforceFrozenArchiveSize(totalBytes);
  await mkdir(directory, { recursive: false });
  for (const file of source.files) {
    const destination = containedPath(directory, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes, { flag: "wx", mode: file.mode === 0o100755 ? 0o755 : 0o644 });
    if (file.mode === 0o100755) await chmod(destination, 0o755);
  }
  await writePackageFiles(directory, generated);
  return { closureDigest, graphRevision, locked, files, workflow };
}

async function prepareFrozenPackage(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  target: ExportTarget,
  directory: string,
  projectRoot: string,
  cache: PixiCache,
  signal?: AbortSignal,
) {
  await mkdir(directory, { recursive: false });
  const compiled = compileNextflow(graph, catalog, {
    workflowName: "somite-workflow",
    outputDirectory: "results",
    platforms: [target.platform],
    nextflowVersion: PINNED_NEXTFLOW_VERSION,
    openjdkVersion: PINNED_OPENJDK_VERSION,
  });
  const locked = await cache.lock(compiled.pixiToml, target.platform, signal);
  const lock = locked.lock;
  const binaries = new Set<string>();
  for (const operator of catalog.values()) {
    if (operator.bin && await executablePath(projectRoot, operator.bin)) binaries.add(operator.bin);
  }
  const frozen = createFrozenPackageFiles(graph, catalog, target, lock, (binary) => binaries.has(binary));
  enforceFrozenPackageFiles(frozen.files);
  await writePackageFiles(directory, frozen.files);
  return { frozen, locked };
}

async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function traceStates(trace: string | undefined, processName: string) {
  if (!trace) return undefined;
  const lines = trace.trimEnd().split("\n");
  const header = lines.shift()?.split("\t") ?? [];
  const nameIndex = header.indexOf("name");
  const statusIndex = header.indexOf("status");
  if (nameIndex < 0 || statusIndex < 0) return undefined;
  let state: RunNodeState | undefined;
  for (const line of lines) {
    const fields = line.split("\t");
    if (!fields[nameIndex]?.includes(processName)) continue;
    const status = fields[statusIndex]?.toUpperCase();
    state = status === "COMPLETED" ? "done"
      : status === "CACHED" ? "cached"
        : status === "FAILED" || status === "ABORTED" ? "failed"
          : status === "RUNNING" || status === "SUBMITTED" ? "running"
            : state;
  }
  return state;
}

function statusMessage(phase: RunPhase) {
  const messages: Record<RunPhase, string> = {
    preparing: "Preparing workflow",
    running: "Executing workflow",
    finalizing: "Recording validation evidence",
    completed: "Workflow completed",
    failed: "Workflow failed",
    cancelling: "Cancelling workflow",
    cancelled: "Workflow cancelled",
  };
  return messages[phase];
}

function copyStatus(status: RunStatus): RunStatus {
  const states = { ...status.states };
  const completed = Object.values(states).filter((state) => ["cached", "done", "failed", "skipped", "cancelled"].includes(state)).length;
  return {
    ...status,
    states,
    progress: {
      completed,
      total: Object.keys(states).length,
      unit: "nodes",
      message: statusMessage(status.phase),
    },
  };
}

async function fileDigest(path: string) {
  return byteDigest(await readFile(path));
}

async function collectFiles(directory: string, collected: string[] = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return collected;
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, collected);
    else if (entry.isFile()) collected.push(path);
  }
  return collected;
}

async function digestsForPaths(paths: readonly string[]) {
  return Promise.all([...paths].sort().map(fileDigest));
}

async function materializeFixtureObject(projectRoot: string, sourcePath: string): Promise<MaterializedFastqFixture> {
  const bytes = await readFile(sourcePath);
  const digest = byteDigest(bytes);
  const payload = join(projectRoot, ".somite", "fixtures", "objects", digest.slice("blake3:".length), "payload.fastq");
  try {
    const existing = await readFile(payload);
    if (byteDigest(existing) !== digest) throw new Error(`fixture object ${digest} does not match its content address`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("does not match")) throw error;
    await mkdir(join(payload, ".."), { recursive: true });
    await writeFile(payload, bytes, { flag: "wx" }).catch(async (writeError: NodeJS.ErrnoException) => {
      if (writeError.code !== "EEXIST") throw writeError;
      if (byteDigest(await readFile(payload)) !== digest) throw new Error(`fixture object ${digest} does not match its content address`);
    });
  }
  return { path: payload, digest };
}

export class RunManager {
  readonly #projectRoot: string;
  readonly #repositoryRoot: string;
  readonly #graphLocation: GraphInputLocation;
  #catalog: OperatorCatalog;
  readonly #evidence: EvidenceStore;
  readonly #pixi: PixiCache;
  readonly #storage: RunStorage;
  readonly #assessmentContext: () => Promise<WorkflowAssessmentContext>;
  readonly #managedResourceResolver?: ManagedResourceResolver;
  readonly #jobs = new Map<string, RunJob>();
  readonly #startReplays = new Map<string, { request: string; pending: Promise<RunStart> }>();
  readonly #executions = new Set<Promise<void>>();

  constructor(projectRoot: string, repositoryRoot: string, catalog: OperatorCatalog, graphBase = projectRoot, options: {
    assessmentContext?: () => Promise<WorkflowAssessmentContext>;
    managedResourceResolver?: ManagedResourceResolver;
  } = {}) {
    this.#projectRoot = projectRoot;
    this.#repositoryRoot = repositoryRoot;
    this.#graphLocation = { graphBase, relativeInputOrder: "project_first" };
    this.#catalog = catalog;
    this.#evidence = new EvidenceStore(projectRoot);
    this.#pixi = new PixiCache(projectRoot);
    this.#storage = new RunStorage(projectRoot);
    this.#assessmentContext = options.assessmentContext ?? (async () => ({}));
    this.#managedResourceResolver = options.managedResourceResolver;
  }

  updateCatalog(catalog: OperatorCatalog) {
    if (!catalog.isExtensionOf(this.#catalog)) throw new Error("run catalog updates must preserve every pinned operator revision");
    this.#catalog = catalog;
  }

  async start(
    graph: SomiteGraph,
    intent: "run" | "validation",
    idempotencyKey?: string,
    graphLocation: GraphInputLocation = this.#graphLocation,
  ): Promise<RunStart> {
    const requestIdentity = `${intent}:${semanticGraphRevision(graph)}:${JSON.stringify(graphLocation)}`;
    if (idempotencyKey) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error("invalid run idempotency key");
      const replay = this.#startReplays.get(idempotencyKey);
      if (replay) {
        if (replay.request !== requestIdentity) throw new Error("run idempotency key was already used for a different request");
        return { ...await replay.pending, replayed: true };
      }
    }
    const pending = this.#launch(graph, intent, graphLocation);
    if (idempotencyKey) this.#startReplays.set(idempotencyKey, { request: requestIdentity, pending });
    try {
      const result = await pending;
      if (idempotencyKey && this.#startReplays.size > 256) this.#startReplays.delete(this.#startReplays.keys().next().value!);
      return result;
    } catch (cause) {
      if (idempotencyKey && this.#startReplays.get(idempotencyKey)?.pending === pending) this.#startReplays.delete(idempotencyKey);
      throw cause;
    }
  }

  async #launch(
    graph: SomiteGraph,
    intent: "run" | "validation",
    graphLocation: GraphInputLocation,
  ): Promise<RunStart> {
    requireReadyWorkflow(graph, this.#catalog, intent === "validation" ? "validate" : "run", await this.#assessmentContext());
    const validation = intent === "validation" ? await this.#validationContext(graph) : undefined;
    const runnable = await materializeProductionGraph(
      validation?.kind === "representative_fastq" ? validation.binding.graph : graph,
      this.#catalog,
      this.#projectRoot,
      graphLocation,
      this.#managedResourceResolver,
    );
    const id = `${intent}-${Date.now().toString(16)}-${randomUUID().slice(0, 8)}`;
    const job: RunJob = {
      id,
      intent,
      packagePath: join(this.#projectRoot, ".somite", "runs", id),
      graph: runnable,
      validation,
      abort: new AbortController(),
      status: {
        run_id: id,
        phase: "preparing",
        states: Object.fromEntries(runnable.nodes.map((node) => [node.id, "queued" as const])),
        progress: { completed: 0, total: runnable.nodes.length, unit: "nodes", message: "Preparing workflow" },
      },
      revision: 0,
      waiters: new Set(),
    };
    this.#jobs.set(id, job);
    const execution = this.#execute(job);
    this.#executions.add(execution);
    void execution.then(
      () => this.#executions.delete(execution),
      () => this.#executions.delete(execution),
    );
    const result: RunStart = { run_id: id, phase: "preparing", replayed: false };
    return result;
  }

  async status(id: string, waitMs = 0) {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`run ${id} was not found`);
    await this.#refreshStates(job);
    if (waitMs > 0 && !terminal(job.status.phase)) {
      const revision = job.revision;
      await new Promise<void>((resolvePromise) => {
        const wake = () => {
          clearTimeout(timeout);
          job.waiters.delete(wake);
          resolvePromise();
        };
        const timeout = setTimeout(wake, Math.min(waitMs, 25_000));
        job.waiters.add(wake);
      });
      if (job.revision !== revision) await this.#refreshStates(job);
    }
    return copyStatus(job.status);
  }

  async cancel(id: string) {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`run ${id} was not found`);
    if (!terminal(job.status.phase)) {
      this.#update(job, { phase: "cancelling" });
      job.abort.abort();
      if (job.child) terminateProcessTree(job.child);
    }
    return copyStatus(job.status);
  }

  async shutdown() {
    for (const job of this.#jobs.values()) {
      if (terminal(job.status.phase)) continue;
      this.#update(job, { phase: "cancelling" });
      job.abort.abort();
      if (job.child) terminateProcessTree(job.child);
    }
    await Promise.allSettled([...this.#executions]);
  }

  async validationStatus(graph: SomiteGraph) {
    const validation = await this.#validationContext(graph);
    const receipt = [...await this.#evidence.forSubject(validation.subjectDigest)].reverse().find((candidate) => candidate.subject_digest === validation.subjectDigest
      && candidate.configuration_digest === (validation.kind === "representative_fastq" ? validation.binding.configuration_digest : validation.configurationDigest));
    return {
      subject_digest: validation.subjectDigest,
      configuration_digest: validation.kind === "representative_fastq" ? validation.binding.configuration_digest : validation.configurationDigest,
      fixture_pack: validation.kind === "representative_fastq" ? validation.binding.fixture_pack : validation.fixturePack,
      ...(receipt ? { receipt } : {}),
    };
  }

  async compile(graph: SomiteGraph, target: ExportTarget, graphLocation: GraphInputLocation = this.#graphLocation) {
    requireReadyWorkflow(graph, this.#catalog, "compile", await this.#assessmentContext());
    const parent = join(this.#projectRoot, ".somite", "compiled");
    const temporary = join(parent, `.compile-${randomUUID()}.partial`);
    await mkdir(parent, { recursive: true });
    try {
      const runnable = await materializeProductionGraph(graph, this.#catalog, this.#projectRoot, graphLocation, this.#managedResourceResolver);
      if (exactSourceNode(runnable)) {
        const prepared = await prepareSourcePackage(runnable, temporary, this.#projectRoot, this.#pixi);
        const destination = join(parent, prepared.closureDigest.replace(/^blake3:/, ""));
        let reused = false;
        try {
          await readFile(join(destination, ".somite", "run", "run-closure.json"));
          reused = true;
        } catch {
          try {
            await rename(temporary, destination);
          } catch (moveError) {
            try {
              await readFile(join(destination, ".somite", "run", "run-closure.json"));
              reused = true;
            } catch {
              throw moveError;
            }
          }
        }
        if (reused) await rm(temporary, { recursive: true, force: true });
        const displayed = relative(this.#projectRoot, destination);
        return {
          source_graph_revision: semanticGraphRevision(graph),
          closure_digest: prepared.closureDigest,
          compiled_graph_revision: prepared.graphRevision,
          output_path: displayed && !displayed.startsWith("..") ? displayed : destination,
          reused,
        };
      }
      const { frozen } = await prepareFrozenPackage(runnable, this.#catalog, target, temporary, this.#projectRoot, this.#pixi);
      const destination = join(parent, frozen.closure.closure_digest.replace(/^blake3:/, ""));
      let reused = false;
      try {
        await readFile(join(destination, "run-closure.json"));
        reused = true;
      } catch {
        try {
          await rename(temporary, destination);
        } catch (moveError) {
          try {
            await readFile(join(destination, "run-closure.json"));
            reused = true;
          } catch {
            throw moveError;
          }
        }
      }
      if (reused) await rm(temporary, { recursive: true, force: true });
      const displayed = relative(this.#projectRoot, destination);
      return {
        source_graph_revision: semanticGraphRevision(graph),
        closure_digest: frozen.closure.closure_digest,
        compiled_graph_revision: frozen.closure.graph_revision,
        output_path: displayed && !displayed.startsWith("..") ? displayed : destination,
        reused,
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async evidence(subjectDigest: string) {
    return { subject_digest: subjectDigest, receipts: await this.#evidence.forSubject(subjectDigest) };
  }

  async storage() {
    return this.#storage.profile(this.#activeRunIds());
  }

  async dehydrateRuns(runIds: readonly string[]) {
    return this.#storage.dehydrateRuns(runIds, this.#activeRunIds());
  }

  async export(graph: SomiteGraph, target: ExportTarget, graphLocation: GraphInputLocation = this.#graphLocation) {
    requireReadyWorkflow(graph, this.#catalog, "export", await this.#assessmentContext());
    const directory = join(this.#projectRoot, ".somite", "exports", `export-${randomUUID()}`);
    await mkdir(join(directory, ".."), { recursive: true });
    try {
      const runnable = await materializeProductionGraph(graph, this.#catalog, this.#projectRoot, graphLocation, this.#managedResourceResolver);
      if (exactSourceNode(runnable)) {
        const prepared = await prepareSourcePackage(runnable, directory, this.#projectRoot, this.#pixi);
        const bytes = archiveFrozenPackage(prepared.files);
        enforceFrozenArchiveSize(bytes.byteLength);
        return { filename: `${safeArchiveName(target.archiveName)}.somite-source.zip`, bytes };
      }
      const { frozen } = await prepareFrozenPackage(runnable, this.#catalog, target, directory, this.#projectRoot, this.#pixi);
      const bytes = archiveFrozenPackage(frozen.files);
      enforceFrozenArchiveSize(bytes.byteLength);
      return { filename: frozen.plan.filename, bytes };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #validationContext(graph: SomiteGraph): Promise<ValidationContext> {
    const capability = representativeValidationCapability(graph);
    if (!capability.supported) throw new RepresentativeValidationError(capability);
    if (capability.fixture_pack === SOURCE_PREVIEW_PACK) {
      const workflow = exactSourceNode(graph)?.source_workflow;
      if (!workflow) throw new Error("source preview validation requires one exact source workflow");
      return {
        kind: "source_preview",
        subjectDigest: semanticGraphRevision(graph),
        configurationDigest: workflow.workflow_revision,
        fixturePack: SOURCE_PREVIEW_PACK,
        fixtureDigests: [],
        originalGraph: graph,
      };
    }
    const [readOne, readTwo] = await Promise.all([
      materializeFixtureObject(this.#projectRoot, join(this.#repositoryRoot, "fixtures", "fastq", "v1", "reads_R1.fastq")),
      materializeFixtureObject(this.#projectRoot, join(this.#repositoryRoot, "fixtures", "fastq", "v1", "reads_R2.fastq")),
    ]);
    return {
      kind: "representative_fastq",
      subjectDigest: semanticGraphRevision(graph),
      binding: bindRepresentativeFastq(graph, { readOne, readTwo }),
      originalGraph: graph,
    };
  }

  #update(job: RunJob, patch: Partial<RunStatus>) {
    Object.assign(job.status, patch);
    job.revision += 1;
    for (const wake of job.waiters) wake();
    job.waiters.clear();
  }

  #activeRunIds() {
    return new Set([...this.#jobs.values()].filter((job) => !terminal(job.status.phase)).map((job) => job.id));
  }

  async #execute(job: RunJob) {
    try {
      await mkdir(join(job.packagePath, ".."), { recursive: true });
      if (exactSourceNode(job.graph)) return await this.#executeSource(job);
      const target = { archiveName: job.graph.name ?? "somite-workflow", platform: pixiPlatform() };
      const { frozen, locked } = await prepareFrozenPackage(
        job.graph,
        this.#catalog,
        target,
        job.packagePath,
        this.#projectRoot,
        this.#pixi,
        job.abort.signal,
      );
      if (job.abort.signal.aborted) return this.#finishCancelled(job);
      const environmentManifest = await this.#pixi.environment(locked, target.platform, job.abort.signal);
      if (job.abort.signal.aborted) return this.#finishCancelled(job);
      this.#update(job, { closure_digest: frozen.closure.closure_digest, phase: "running" });
      const stdout = await open(join(job.packagePath, "run.stdout.log"), "w");
      const stderr = await open(join(job.packagePath, "run.stderr.log"), "w");
      try {
        const child = spawn(
          locked.pixi,
          ["run", "--frozen", "--manifest-path", environmentManifest, "--", "nextflow", "run", "main.nf", "-params-file", "params.json", "-resume"],
          {
            cwd: job.packagePath,
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: ["ignore", stdout.fd, stderr.fd],
          },
        );
        job.child = child;
        const cancel = () => terminateProcessTree(child);
        job.abort.signal.addEventListener("abort", cancel, { once: true });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
          child.once("error", rejectPromise);
          child.once("close", (code, closeSignal) => resolvePromise({ code, signal: closeSignal }));
        });
        job.abort.signal.removeEventListener("abort", cancel);
        job.child = undefined;
        if (job.abort.signal.aborted) return this.#finishCancelled(job);
        await this.#refreshStates(job);
        if (result.code === 0) {
          if (job.validation) {
            this.#update(job, { phase: "finalizing", exit_code: result.code });
            await this.#recordEvidence(job, frozen.closure.closure_digest, "completed");
          } else {
            await this.#terminalUpdate(job, { phase: "completed", exit_code: result.code });
          }
        } else {
          const error = await this.#executionFailure(job, result);
          this.#markFailureStates(job);
          if (job.validation) {
            this.#update(job, { phase: "finalizing", exit_code: result.code ?? undefined, error });
            await this.#recordEvidence(job, frozen.closure.closure_digest, "failed");
          } else {
            await this.#terminalUpdate(job, { phase: "failed", exit_code: result.code ?? undefined, error });
          }
        }
      } finally {
        await Promise.all([stdout.close(), stderr.close()]);
      }
    } catch (error) {
      if (job.abort.signal.aborted) return this.#finishCancelled(job);
      this.#markFailureStates(job);
      await this.#terminalUpdate(job, { phase: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async #executeSource(job: RunJob) {
    const target = { platform: pixiPlatform() };
    const prepared = await prepareSourcePackage(job.graph, job.packagePath, this.#projectRoot, this.#pixi);
    if (job.abort.signal.aborted) return this.#finishCancelled(job);
    const environmentManifest = await this.#pixi.environment(prepared.locked, target.platform, job.abort.signal);
    if (job.abort.signal.aborted) return this.#finishCancelled(job);
    const nodeId = job.graph.nodes[0]!.id;
    job.status.states[nodeId] = "running";
    this.#update(job, { closure_digest: prepared.closureDigest, phase: "running" });
    const stdout = await open(join(job.packagePath, "run.stdout.log"), "w");
    const stderr = await open(join(job.packagePath, "run.stderr.log"), "w");
    try {
      const nextflowArgs = [
        "run",
        prepared.workflow.source.entrypoint,
        "-params-file",
        ".somite/run/params.json",
        ...(prepared.workflow.profiles?.length ? ["-profile", prepared.workflow.profiles.join(",")] : []),
        ...(job.intent === "validation" ? ["-preview"] : ["-resume"]),
      ];
      const child = spawn(
        prepared.locked.pixi,
        ["run", "--frozen", "--manifest-path", environmentManifest, "--", "nextflow", ...nextflowArgs],
        {
          cwd: job.packagePath,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["ignore", stdout.fd, stderr.fd],
        },
      );
      job.child = child;
      const cancel = () => terminateProcessTree(child);
      job.abort.signal.addEventListener("abort", cancel, { once: true });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("close", (code, closeSignal) => resolvePromise({ code, signal: closeSignal }));
      });
      job.abort.signal.removeEventListener("abort", cancel);
      job.child = undefined;
      if (job.abort.signal.aborted) return this.#finishCancelled(job);
      if (result.code === 0) {
        job.status.states[nodeId] = "done";
        if (job.validation) {
          this.#update(job, { phase: "finalizing", exit_code: result.code });
          await this.#recordEvidence(job, prepared.closureDigest, "completed");
        } else {
          await this.#terminalUpdate(job, { phase: "completed", exit_code: result.code });
        }
      } else {
        job.status.states[nodeId] = "failed";
        const error = await this.#executionFailure(job, result);
        if (job.validation) {
          this.#update(job, { phase: "finalizing", exit_code: result.code ?? undefined, error });
          await this.#recordEvidence(job, prepared.closureDigest, "failed");
        } else {
          await this.#terminalUpdate(job, { phase: "failed", exit_code: result.code ?? undefined, error });
        }
      }
    } finally {
      await Promise.all([stdout.close(), stderr.close()]);
    }
  }

  async #terminalUpdate(job: RunJob, patch: Partial<RunStatus> & { phase: "completed" | "failed" | "cancelled" }) {
    await this.#persistTerminalStatus(job, patch).catch(() => undefined);
    this.#update(job, patch);
  }

  async #persistTerminalStatus(job: RunJob, patch: Partial<RunStatus> & { phase: "completed" | "failed" | "cancelled" }) {
    const status = { ...job.status, ...patch };
    await atomicWrite(join(job.packagePath, "run-status.json"), `${JSON.stringify({
      schema_version: 1,
      run_id: job.id,
      phase: status.phase,
      finished_at_unix_ms: Date.now(),
      ...(status.closure_digest ? { closure_digest: status.closure_digest } : {}),
      ...(status.evidence_receipt ? { evidence_receipt_digest: status.evidence_receipt.receipt_digest } : {}),
    }, null, 2)}\n`);
  }

  async #refreshStates(job: RunJob) {
    let nodeMap: { nodes?: Record<string, { process?: string | null; kind?: string }> };
    try {
      nodeMap = JSON.parse(await readFile(join(job.packagePath, "node-map.json"), "utf8"));
    } catch {
      return;
    }
    const [trace, log] = await Promise.all([
      readOptional(join(job.packagePath, ".somite", "trace.tsv")),
      readOptional(join(job.packagePath, ".nextflow.log")),
    ]);
    let changed = false;
    for (const [nodeId, entry] of Object.entries(nodeMap.nodes ?? {})) {
      let state: RunNodeState;
      if (entry.kind === "input" && job.status.phase !== "preparing") state = "done";
      else if (entry.process) {
        state = traceStates(trace, entry.process)
          ?? ((job.status.phase === "running" || job.status.phase === "cancelling") && log?.includes(entry.process) ? "running"
            : job.status.phase === "completed" ? "done"
              : job.status.phase === "failed" ? "skipped"
                : job.status.phase === "cancelled" ? "skipped" : "queued");
      } else state = "queued";
      if (job.status.states[nodeId] !== state) {
        job.status.states[nodeId] = state;
        changed = true;
      }
    }
    if (changed) this.#update(job, {});
  }

  #markFailureStates(job: RunJob) {
    for (const [node, state] of Object.entries(job.status.states)) {
      if (state === "done" || state === "cached" || state === "failed") continue;
      job.status.states[node] = state === "running" ? "failed" : "skipped";
    }
  }

  async #finishCancelled(job: RunJob) {
    for (const [node, state] of Object.entries(job.status.states)) {
      job.status.states[node] = state === "done" || state === "cached" ? state : state === "running" ? "cancelled" : "skipped";
    }
    await this.#terminalUpdate(job, { phase: "cancelled" });
  }

  async #recordEvidence(job: RunJob, closureDigest: string, terminalPhase: "completed" | "failed") {
    const validation = job.validation!;
    await this.#refreshStates(job);
    const nodeResults = Object.fromEntries(Object.entries(job.status.states).map(([node, state]) => [node, evidenceNodeResult(state)]));
    const edgeResults = Object.fromEntries(validation.originalGraph.edges.map((edge) => {
      const source = nodeResults[edge.from_node];
      const target = nodeResults[edge.to_node];
      const result: EvidenceResult = source === "passed" && target === "passed" ? "passed"
        : source === "failed" || target === "failed" ? "failed" : "inconclusive";
      return [edge.id, result];
    }));
    const artifactFiles = await collectFiles(join(job.packagePath, "results"));
    const candidateLogFiles = [
      join(job.packagePath, "run.stdout.log"),
      join(job.packagePath, "run.stderr.log"),
      join(job.packagePath, ".nextflow.log"),
    ];
    const logFiles = (await Promise.all(candidateLogFiles.map(async (path) => ({ path, exists: await pathExists(path) }))))
      .filter((candidate) => candidate.exists)
      .map((candidate) => candidate.path);
    const receipt = createEvidenceReceipt({
      recorded_at_unix_ms: Date.now(),
      subject_digest: validation.subjectDigest,
      observed_closure_digest: closureDigest,
      kind: validation.kind === "source_preview" ? "source_preview_validation" : "configuration_validation",
      scope: validation.kind === "source_preview" ? "nextflow_source_compile_and_dag" : "graph_e2e",
      configuration_digest: validation.kind === "source_preview" ? validation.configurationDigest : validation.binding.configuration_digest,
      fixture_digests: validation.kind === "source_preview" ? validation.fixtureDigests : validation.binding.fixture_digests,
      verifier: SOMITE_TYPESCRIPT_RUNNER_IDENTITY,
      result: terminalPhase === "completed" ? "passed" : "failed",
      node_results: nodeResults,
      edge_results: edgeResults,
      artifact_digests: await digestsForPaths(artifactFiles),
      log_digests: await digestsForPaths(logFiles),
    });
    await this.#evidence.append(receipt, join(job.packagePath, "evidence"));
    await this.#terminalUpdate(job, { phase: terminalPhase, evidence_receipt: receipt });
  }

  async #logTail(path: string) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let raw: string;
    let truncated = false;
    try {
      handle = await open(path, "r");
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size === 0) return undefined;
      const length = Math.min(metadata.size, MAX_FAILURE_LOG_TAIL_BYTES);
      const offset = metadata.size - length;
      const bytes = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const read = await handle.read(bytes, total, length - total, offset + total);
        if (read.bytesRead === 0) break;
        total += read.bytesRead;
      }
      raw = bytes.subarray(0, total).toString("utf8");
      truncated = offset > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
    const lines = raw.split("\n").filter((line) => line.trim()).slice(-8);
    if (!lines.length) return undefined;
    return `${truncated ? "[earlier log bytes omitted]\n" : ""}${lines.join("\n")}`;
  }

  async #executionFailure(job: RunJob, result: { code: number | null; signal: NodeJS.Signals | null }) {
    const evidence = await Promise.all([
      ["stderr", join(job.packagePath, "run.stderr.log")],
      ["stdout", join(job.packagePath, "run.stdout.log")],
      [".nextflow.log", join(job.packagePath, ".nextflow.log")],
    ].map(async ([label, path]) => ({ label, tail: await this.#logTail(path) })));
    const shown = evidence.filter((entry) => entry.tail).map((entry) => `${entry.label}:\n${entry.tail}`);
    return shown.length
      ? shown.join("\n")
      : `Nextflow exited with ${result.code ?? result.signal ?? "unknown status"}`;
  }
}

function evidenceNodeResult(state: RunNodeState): EvidenceResult {
  if (state === "done" || state === "cached") return "passed";
  if (state === "failed") return "failed";
  return "inconclusive";
}
