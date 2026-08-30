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

import { assessWorkflow } from "@somite/workflow/assessment";
import {
  archiveFrozenPackage,
  createFrozenPackageFiles,
  type ExportTarget,
  type FrozenPackage,
} from "@somite/workflow/bundle";
import { OperatorCatalog } from "@somite/workflow/catalog";
import { byteDigest, canonicalJsonValue } from "@somite/workflow/contentIdentity";
import {
  bindRepresentativeFastq,
  type FixtureBinding,
  type MaterializedFastqFixture,
} from "@somite/workflow/fixtures";
import {
  createEvidenceReceipt,
  emptyEvidenceIndex,
  insertEvidence,
  type EvidenceIndex,
  type EvidenceReceipt,
  type EvidenceResult,
} from "@somite/workflow/linker";
import type { SomiteGraph } from "@somite/workflow/model";
import { compileNextflow, PINNED_NEXTFLOW_VERSION, PINNED_OPENJDK_VERSION } from "@somite/workflow/nextflow";
import { semanticGraphRevision } from "@somite/workflow/workflow";
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

type CapturedCommand = Readonly<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;

const MAX_CAPTURE_BYTES = 512 * 1024;
const encoder = new TextEncoder();

function terminal(phase: RunPhase) {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

function boundedAppend(current: string, chunk: Buffer) {
  const next = current + chunk.toString("utf8");
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(next.length - MAX_CAPTURE_BYTES);
}

function terminateChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 3_000);
    timer.unref();
  }
}

async function runCaptured(command: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<CapturedCommand> {
  if (signal?.aborted) throw new Error("operation cancelled");
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });
  const cancel = () => terminateChild(child);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code, closeSignal) => resolvePromise({ code, signal: closeSignal }));
    });
    if (signal?.aborted) throw new Error("operation cancelled");
    return { ...result, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function commandFailure(command: string, result: CapturedCommand) {
  const detail = result.stderr.split("\n").reverse().find((line) => line.trim())
    ?? result.stdout.split("\n").reverse().find((line) => line.trim())
    ?? `${command} exited with ${result.code ?? result.signal ?? "unknown status"}`;
  return detail.trim();
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
  signal?: AbortSignal,
) {
  const pixi = await executablePath(projectRoot, "pixi");
  if (!pixi) throw new Error("Pixi is required to freeze and run this workflow");
  await mkdir(directory, { recursive: false });
  const compiled = compileNextflow(graph, catalog, {
    workflowName: "somite-workflow",
    outputDirectory: "results",
    platforms: [target.platform],
    nextflowVersion: PINNED_NEXTFLOW_VERSION,
    openjdkVersion: PINNED_OPENJDK_VERSION,
  });
  await writeFile(join(directory, "pixi.toml"), compiled.pixiToml);
  const locked = await runCaptured(
    pixi,
    ["lock", "--no-install", "--no-progress", "--manifest-path", join(directory, "pixi.toml")],
    directory,
    signal,
  );
  if (locked.code !== 0) throw new Error(`Pixi lock failed: ${commandFailure("pixi lock", locked)}`);
  const lock = await readFile(join(directory, "pixi.lock"));
  const binaries = new Set<string>();
  for (const operator of catalog.values()) {
    if (operator.bin && await executablePath(projectRoot, operator.bin)) binaries.add(operator.bin);
  }
  const frozen = createFrozenPackageFiles(graph, catalog, target, lock, (binary) => binaries.has(binary));
  await writePackageFiles(directory, frozen.files);
  return { frozen, pixi };
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

async function readEvidenceIndex(path: string): Promise<EvidenceIndex> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as EvidenceIndex;
    if (value.schema_version === 1 && Array.isArray(value.receipts)) return value;
  } catch {
    // A missing index starts empty. Malformed content is replaced only after a
    // new receipt has been fully constructed.
  }
  return emptyEvidenceIndex();
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
  readonly #catalog: OperatorCatalog;
  readonly #jobs = new Map<string, RunJob>();
  readonly #startReplays = new Map<string, { request: string; result: RunStart }>();
  readonly #executions = new Set<Promise<void>>();

  constructor(projectRoot: string, repositoryRoot: string, catalog: OperatorCatalog) {
    this.#projectRoot = projectRoot;
    this.#repositoryRoot = repositoryRoot;
    this.#catalog = catalog;
  }

  async start(graph: SomiteGraph, intent: "run" | "validation", idempotencyKey?: string): Promise<RunStart> {
    const requestIdentity = `${intent}:${semanticGraphRevision(graph)}`;
    if (idempotencyKey) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error("invalid run idempotency key");
      const replay = this.#startReplays.get(idempotencyKey);
      if (replay) {
        if (replay.request !== requestIdentity) throw new Error("run idempotency key was already used for a different request");
        return { ...replay.result, replayed: true };
      }
    }
    const assessment = assessWorkflow(graph, this.#catalog);
    if (assessment.state !== "ready") {
      const detail = assessment.state === "empty"
        ? "add at least one operator"
        : `resolve ${assessment.required_count} required item${assessment.required_count === 1 ? "" : "s"}: ${assessment.items.map((item) => `${item.title}: ${item.detail}`).join("; ")}`;
      throw new Error(detail);
    }
    const validation = intent === "validation" ? await this.#validationContext(graph) : undefined;
    const runnable = validation?.binding.graph ?? graph;
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
      if (job.child) terminateChild(job.child);
    }
    return copyStatus(job.status);
  }

  async shutdown() {
    for (const job of this.#jobs.values()) {
      if (terminal(job.status.phase)) continue;
      this.#update(job, { phase: "cancelling" });
      job.abort.abort();
      if (job.child) terminateChild(job.child);
    }
    await Promise.allSettled([...this.#executions]);
  }

  async validationStatus(graph: SomiteGraph) {
    const validation = await this.#validationContext(graph);
    const index = await readEvidenceIndex(join(this.#projectRoot, ".somite", "evidence", "index.json"));
    const receipt = [...index.receipts].reverse().find((candidate) => candidate.subject_digest === validation.subjectDigest
      && candidate.configuration_digest === validation.binding.configuration_digest);
    return {
      subject_digest: validation.subjectDigest,
      configuration_digest: validation.binding.configuration_digest,
      fixture_pack: validation.binding.fixture_pack,
      ...(receipt ? { receipt } : {}),
    };
  }

  async compile(graph: SomiteGraph, target: ExportTarget) {
    const assessment = assessWorkflow(graph, this.#catalog);
    if (assessment.state !== "ready") throw new Error(`workflow is not ready: ${assessment.required_count} required items remain`);
    const parent = join(this.#projectRoot, ".somite", "compiled");
    const temporary = join(parent, `.compile-${randomUUID()}.partial`);
    await mkdir(parent, { recursive: true });
    try {
      const { frozen } = await prepareFrozenPackage(graph, this.#catalog, target, temporary, this.#projectRoot);
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
    const index = await readEvidenceIndex(join(this.#projectRoot, ".somite", "evidence", "index.json"));
    return { subject_digest: subjectDigest, receipts: index.receipts.filter((receipt) => receipt.subject_digest === subjectDigest) };
  }

  async export(graph: SomiteGraph, target: ExportTarget) {
    const assessment = assessWorkflow(graph, this.#catalog);
    if (assessment.state !== "ready") throw new Error("workflow is not ready to export");
    const directory = join(this.#projectRoot, ".somite", "exports", `export-${randomUUID()}`);
    await mkdir(join(directory, ".."), { recursive: true });
    try {
      const { frozen } = await prepareFrozenPackage(graph, this.#catalog, target, directory, this.#projectRoot);
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

  async #execute(job: RunJob) {
    try {
      await mkdir(join(job.packagePath, ".."), { recursive: true });
      const target = { archiveName: job.graph.name ?? "somite-workflow", platform: pixiPlatform() };
      const { frozen, pixi } = await prepareFrozenPackage(
        job.graph,
        this.#catalog,
        target,
        job.packagePath,
        this.#projectRoot,
        job.abort.signal,
      );
      if (job.abort.signal.aborted) return this.#finishCancelled(job);
      this.#update(job, { closure_digest: frozen.closure.closure_digest, phase: "running" });
      const stdout = await open(join(job.packagePath, "run.stdout.log"), "w");
      const stderr = await open(join(job.packagePath, "run.stderr.log"), "w");
      try {
        const child = spawn(
          pixi,
          ["run", "--frozen", "--manifest-path", join(job.packagePath, "pixi.toml"), "run"],
          {
            cwd: job.packagePath,
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: ["ignore", stdout.fd, stderr.fd],
          },
        );
        job.child = child;
        const cancel = () => terminateChild(child);
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
          this.#update(job, { phase: job.validation ? "finalizing" : "completed", exit_code: result.code });
          if (job.validation) await this.#recordEvidence(job, frozen, "completed");
        } else {
          const error = await this.#logTail(join(job.packagePath, "run.stderr.log"))
            ?? `Nextflow exited with ${result.code ?? result.signal ?? "unknown status"}`;
          this.#markFailureStates(job);
          this.#update(job, { phase: job.validation ? "finalizing" : "failed", exit_code: result.code ?? undefined, error });
          if (job.validation) await this.#recordEvidence(job, frozen, "failed");
        }
      } finally {
        await Promise.all([stdout.close(), stderr.close()]);
      }
    } catch (error) {
      if (job.abort.signal.aborted) return this.#finishCancelled(job);
      this.#markFailureStates(job);
      this.#update(job, { phase: "failed", error: error instanceof Error ? error.message : String(error) });
    }
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

  #finishCancelled(job: RunJob) {
    for (const [node, state] of Object.entries(job.status.states)) {
      job.status.states[node] = state === "done" || state === "cached" ? state : state === "running" ? "cancelled" : "skipped";
    }
    this.#update(job, { phase: "cancelled" });
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
    const projectIndexPath = join(this.#projectRoot, ".somite", "evidence", "index.json");
    const index = insertEvidence(await readEvidenceIndex(projectIndexPath), receipt);
    await mkdir(join(projectIndexPath, ".."), { recursive: true });
    const encoded = `${JSON.stringify(canonicalJsonValue(index), null, 2)}\n`;
    await writeFile(projectIndexPath, encoded);
    await writeFile(join(job.packagePath, "evidence", "index.json"), encoded);
    this.#update(job, { phase: terminalPhase, evidence_receipt: receipt });
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
