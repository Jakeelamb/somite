import {
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
  type ExportTarget,
  type FrozenPackage,
} from "@somite/workflow/bundle";
import { OperatorCatalog } from "@somite/workflow/catalog";
import { byteDigest } from "@somite/workflow/contentIdentity";
import {
  bindRepresentativeFastq,
  type FixtureBinding,
  type MaterializedFastqFixture,
} from "@somite/workflow/fixtures";
import {
  createEvidenceReceipt,
  type EvidenceReceipt,
  type EvidenceResult,
} from "@somite/workflow/linker";
import type { SomiteGraph } from "@somite/workflow/model";
import { compileNextflow, PINNED_NEXTFLOW_VERSION, PINNED_OPENJDK_VERSION } from "@somite/workflow/nextflow";
import { semanticGraphRevision } from "@somite/workflow/workflow";
import { EvidenceStore } from "./evidenceStore.ts";
import { atomicWrite } from "./files.ts";
import { PixiCache } from "./pixiCache.ts";
import { terminateProcessTree } from "./process.ts";
import { materializeProductionGraph, type GraphInputLocation } from "./productionGraph.ts";
import { RunStorage } from "./runStorage.ts";
import { requireReadyWorkflow } from "./workflowAdmission.ts";
import { executablePath, pixiPlatform } from "./system.ts";

export type RunPhase = "preparing" | "running" | "finalizing" | "completed" | "failed" | "cancelling" | "cancelled";
export type RunNodeState = "queued" | "running" | "cached" | "done" | "failed" | "skipped" | "cancelled";

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

type ValidationContext = Readonly<{
  subjectDigest: string;
  binding: FixtureBinding;
  originalGraph: SomiteGraph;
}>;

type RunJob = {
  id: string;
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
  readonly #catalog: OperatorCatalog;
  readonly #evidence: EvidenceStore;
  readonly #pixi: PixiCache;
  readonly #storage: RunStorage;
  readonly #jobs = new Map<string, RunJob>();
  readonly #startReplays = new Map<string, { request: string; result: RunStart }>();
  readonly #executions = new Set<Promise<void>>();

  constructor(projectRoot: string, repositoryRoot: string, catalog: OperatorCatalog, graphBase = projectRoot) {
    this.#projectRoot = projectRoot;
    this.#repositoryRoot = repositoryRoot;
    this.#graphLocation = { graphBase, relativeInputOrder: "project_first" };
    this.#catalog = catalog;
    this.#evidence = new EvidenceStore(projectRoot);
    this.#pixi = new PixiCache(projectRoot);
    this.#storage = new RunStorage(projectRoot);
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
        return { ...replay.result, replayed: true };
      }
    }
    requireReadyWorkflow(graph, this.#catalog, intent === "validation" ? "validate" : "run");
    const validation = intent === "validation" ? await this.#validationContext(graph) : undefined;
    const runnable = await materializeProductionGraph(
      validation?.binding.graph ?? graph,
      this.#catalog,
      this.#projectRoot,
      graphLocation,
    );
    const id = `${intent}-${Date.now().toString(16)}-${randomUUID().slice(0, 8)}`;
    const job: RunJob = {
      id,
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
    if (idempotencyKey) {
      this.#startReplays.set(idempotencyKey, { request: requestIdentity, result });
      if (this.#startReplays.size > 256) this.#startReplays.delete(this.#startReplays.keys().next().value!);
    }
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
      && candidate.configuration_digest === validation.binding.configuration_digest);
    return {
      subject_digest: validation.subjectDigest,
      configuration_digest: validation.binding.configuration_digest,
      fixture_pack: validation.binding.fixture_pack,
      ...(receipt ? { receipt } : {}),
    };
  }

  async compile(graph: SomiteGraph, target: ExportTarget, graphLocation: GraphInputLocation = this.#graphLocation) {
    requireReadyWorkflow(graph, this.#catalog, "compile");
    const parent = join(this.#projectRoot, ".somite", "compiled");
    const temporary = join(parent, `.compile-${randomUUID()}.partial`);
    await mkdir(parent, { recursive: true });
    try {
      const runnable = await materializeProductionGraph(graph, this.#catalog, this.#projectRoot, graphLocation);
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
    requireReadyWorkflow(graph, this.#catalog, "export");
    const directory = join(this.#projectRoot, ".somite", "exports", `export-${randomUUID()}`);
    await mkdir(join(directory, ".."), { recursive: true });
    try {
      const runnable = await materializeProductionGraph(graph, this.#catalog, this.#projectRoot, graphLocation);
      const { frozen } = await prepareFrozenPackage(runnable, this.#catalog, target, directory, this.#projectRoot, this.#pixi);
      return { filename: frozen.plan.filename, bytes: archiveFrozenPackage(frozen.files) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #validationContext(graph: SomiteGraph): Promise<ValidationContext> {
    const [readOne, readTwo] = await Promise.all([
      materializeFixtureObject(this.#projectRoot, join(this.#repositoryRoot, "fixtures", "fastq", "v1", "reads_R1.fastq")),
      materializeFixtureObject(this.#projectRoot, join(this.#repositoryRoot, "fixtures", "fastq", "v1", "reads_R2.fastq")),
    ]);
    return {
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
            await this.#recordEvidence(job, frozen, "completed");
          } else {
            await this.#terminalUpdate(job, { phase: "completed", exit_code: result.code });
          }
        } else {
          const error = await this.#logTail(join(job.packagePath, "run.stderr.log"))
            ?? `Nextflow exited with ${result.code ?? result.signal ?? "unknown status"}`;
          this.#markFailureStates(job);
          if (job.validation) {
            this.#update(job, { phase: "finalizing", exit_code: result.code ?? undefined, error });
            await this.#recordEvidence(job, frozen, "failed");
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

  async #recordEvidence(job: RunJob, frozen: FrozenPackage, terminalPhase: "completed" | "failed") {
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
    const logFiles = [join(job.packagePath, "run.stdout.log"), join(job.packagePath, "run.stderr.log")];
    const receipt = createEvidenceReceipt({
      recorded_at_unix_ms: Date.now(),
      subject_digest: validation.subjectDigest,
      observed_closure_digest: frozen.closure.closure_digest,
      kind: "configuration_validation",
      scope: "graph_e2e",
      configuration_digest: validation.binding.configuration_digest,
      fixture_digests: validation.binding.fixture_digests,
      verifier: "somite-typescript-runner@0.1.0",
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
    const raw = await readOptional(path);
    if (!raw) return undefined;
    const lines = raw.split("\n").filter((line) => line.trim()).slice(-8);
    return lines.length ? lines.join("\n") : undefined;
  }
}

function evidenceNodeResult(state: RunNodeState): EvidenceResult {
  if (state === "done" || state === "cached") return "passed";
  if (state === "failed") return "failed";
  return "inconclusive";
}
