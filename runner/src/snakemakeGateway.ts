import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { operatorRevision } from "@somite/workflow/catalogCodec";
import type { Operator, OperatorCatalog, PinnedOperator } from "@somite/workflow/catalog";
import type { SomiteGraph } from "@somite/workflow/model";
import { graphFromDot } from "@somite/workflow/workflowDot";
import { atomicWrite, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";
import { executablePath } from "./system.ts";

export const SNAKEMAKE_CATALOG_URL = "https://raw.githubusercontent.com/snakemake/snakemake-workflow-catalog/main/data.json";
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const MAX_GRAPH_BYTES = 5 * 1024 * 1024;

export type SnakemakeWorkflow = {
  fullName: string;
  description: string;
  topics: string[];
  revision: string;
  stars: number;
  rulegraph?: string;
};

function safeId(value: string) {
  return [...value].map((character) => /[A-Za-z0-9]/.test(character) ? character.toLowerCase() : "-")
    .join("").split("-").filter(Boolean).join("-");
}

export function parseSnakemakeCatalog(value: unknown): SnakemakeWorkflow[] {
  if (!Array.isArray(value)) throw new Error("Snakemake catalog is not an array");
  const workflows = value.flatMap((candidate): SnakemakeWorkflow[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const raw = candidate as Record<string, unknown>;
    if (raw.standardized !== true || typeof raw.latest_release !== "string" || !raw.latest_release
      || typeof raw.full_name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.full_name)) return [];
    return [{
      fullName: raw.full_name,
      description: typeof raw.description === "string" ? raw.description : "",
      topics: Array.isArray(raw.topics) ? raw.topics.filter((topic): topic is string => typeof topic === "string") : [],
      revision: raw.latest_release,
      stars: typeof raw.stargazers_count === "number" && Number.isSafeInteger(raw.stargazers_count) && raw.stargazers_count >= 0 ? raw.stargazers_count : 0,
      ...(typeof raw.rulegraph === "string" ? { rulegraph: raw.rulegraph } : {}),
    }];
  });
  workflows.sort((left, right) => right.stars - left.stars || left.fullName.localeCompare(right.fullName));
  return workflows;
}

function parseSnakemakeCache(value: unknown): SnakemakeWorkflow[] {
  if (!Array.isArray(value)) throw new Error("Snakemake catalog cache is not an array");
  const workflows = value.map((candidate, index): SnakemakeWorkflow => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Snakemake catalog cache entry ${index} is invalid`);
    }
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.fullName !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.fullName)
      || typeof raw.description !== "string" || typeof raw.revision !== "string" || !raw.revision
      || typeof raw.stars !== "number" || !Number.isSafeInteger(raw.stars) || raw.stars < 0
      || !Array.isArray(raw.topics) || raw.topics.some((topic) => typeof topic !== "string")
      || (raw.rulegraph !== undefined && typeof raw.rulegraph !== "string")) {
      throw new Error(`Snakemake catalog cache entry ${index} is invalid`);
    }
    return {
      fullName: raw.fullName,
      description: raw.description,
      revision: raw.revision,
      stars: raw.stars,
      topics: raw.topics as string[],
      ...(typeof raw.rulegraph === "string" ? { rulegraph: raw.rulegraph } : {}),
    };
  });
  workflows.sort((left, right) => right.stars - left.stars || left.fullName.localeCompare(right.fullName));
  return workflows;
}

function dynamicOperator(workflow: SnakemakeWorkflow): PinnedOperator {
  const operator: Operator = {
    id: `smk.catalog.${safeId(workflow.fullName)}`,
    title: workflow.fullName,
    palette: ["Snakemake", "Catalog"],
    kind: "reference",
    cost: "low",
    params: {
      repository: { type: "string", label: "Repository", page: "Workflow", default: workflow.fullName, required: true },
      revision: { type: "string", label: "Release", page: "Workflow", default: workflow.revision, required: true },
    },
    ports: { in: [], out: [] },
    argv: [],
    outputs: {},
  };
  return { ...operator, revision: operatorRevision(operator) };
}

async function boundedResponse(response: Response, maximum: number, label: string) {
  if (!response.ok || !response.body) throw new Error(`${label} returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error(`${label} is too large`);
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

function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

async function captured(command: string, args: string[], cwd: string, milliseconds: number, maximumBytes: number) {
  const child = spawn(command, args, { cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let tooLarge = false;
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > maximumBytes) {
      tooLarge = true;
      terminate(child);
    } else stdout.push(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes <= 512 * 1024) stderr.push(chunk);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, milliseconds);
  timer.unref();
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    if (timedOut) throw new Error("Snakemake rule graph timed out after 45 seconds");
    if (tooLarge) throw new Error("Snakemake returned a rule graph larger than 5 MiB");
    return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } finally {
    clearTimeout(timer);
  }
}

async function projectEntrypoint(suppliedPath: string) {
  const canonical = await realpath(suppliedPath).catch(() => { throw new Error(`local workflow path does not exist: ${suppliedPath}`); });
  const metadata = await lstat(canonical);
  if (metadata.isFile()) {
    if (basename(canonical) !== "Snakefile" && extname(canonical) !== ".smk") throw new Error(`could not find Snakefile under ${canonical}`);
    const parent = dirname(canonical);
    return { project: basename(parent) === "workflow" ? dirname(parent) : parent, snakefile: canonical };
  }
  if (!metadata.isDirectory()) throw new Error(`local workflow path does not exist: ${suppliedPath}`);
  for (const candidate of [join(canonical, "workflow", "Snakefile"), join(canonical, "Snakefile")]) {
    if (await pathExists(candidate)) return { project: canonical, snakefile: candidate };
  }
  throw new Error(`could not find Snakefile or workflow/Snakefile under ${canonical}`);
}

function normalizedTargets(targets: unknown) {
  if (!Array.isArray(targets) || targets.length > 64) throw new Error("targets must be an array of at most 64 names");
  const unique = new Set<string>();
  for (const value of targets) {
    if (typeof value !== "string") throw new Error("Snakemake targets must be strings");
    const target = value.trim();
    if (!target) continue;
    if (target.length > 128 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(target)) throw new Error(`invalid Snakemake target: ${target}`);
    unique.add(target);
  }
  return [...unique].sort();
}

async function sourceRevision(project: string) {
  try {
    const commit = await captured("git", ["rev-parse", "--short=12", "HEAD"], project, 5_000, 64 * 1024);
    if (commit.code !== 0 || !commit.stdout.trim()) return "local-worktree";
    const dirty = await captured("git", ["status", "--porcelain", "--untracked-files=normal"], project, 5_000, 512 * 1024);
    return `git:${commit.stdout.trim()}${dirty.code !== 0 || dirty.signal !== null || dirty.stdout ? "+worktree" : ""}`;
  } catch {
    return "local-worktree";
  }
}

export class SnakemakeGateway {
  readonly #root: string;
  readonly #catalog: OperatorCatalog;
  readonly #fetcher: typeof fetch;
  #snapshot?: Promise<{ workflows: SnakemakeWorkflow[]; cached: boolean }>;

  constructor(root: string, catalog: OperatorCatalog, fetcher: typeof fetch = fetch) {
    this.#root = root;
    this.#catalog = catalog;
    this.#fetcher = fetcher;
  }

  async catalogResponse() {
    const { workflows, cached } = await this.#load();
    return {
      entries: workflows.map((workflow) => ({
        operator: dynamicOperator(workflow),
        description: workflow.description,
        topics: workflow.topics,
        revision: workflow.revision,
        stars: workflow.stars,
        expandable: Boolean(workflow.rulegraph),
      })),
      cached,
    };
  }

  async expand(workflow: string, revision: string) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(workflow) || !revision || !/^[A-Za-z0-9._-]+$/.test(revision)) throw new Error("invalid Snakemake workflow or revision");
    const snapshot = await this.#load();
    const entry = snapshot.workflows.find((candidate) => candidate.fullName === workflow && candidate.revision === revision);
    if (!entry) throw new Error("workflow release is not in the current catalog");
    if (!entry.rulegraph) throw new Error("the official catalog could not resolve this workflow's rule graph; Somite will not insert an opaque replacement");
    const reference = this.#catalog.get("workflow.reference");
    if (!reference) throw new Error("workflow.reference operator is missing");
    return { engine: "snakemake", workflow, revision, graph: graphFromDot("snakemake", workflow, revision, reference.revision, entry.rulegraph), cached: true } as const;
  }

  async importLocal(path: string, targetsValue: unknown, workflowLabel?: string) {
    if (!path.trim()) throw new Error("local workflow path must be a non-empty string");
    const { project, snakefile } = await projectEntrypoint(path.trim());
    const targets = normalizedTargets(targetsValue);
    const declaresPixi = await Promise.all(["pixi.toml", "pixi.lock"].map((name) => pathExists(join(project, name)))).then((results) => results.some(Boolean))
      || await readFile(join(project, "pyproject.toml"), "utf8").then((text) => text.includes("[tool.pixi.workspace]")).catch(() => false);
    const pixi = declaresPixi ? await executablePath(project, "pixi") : undefined;
    const snakemake = await executablePath(project, "snakemake");
    if (!pixi && !snakemake) throw new Error("this project needs Snakemake or Pixi before it can be visualized");
    const command = pixi ?? snakemake!;
    const args = [...(pixi ? ["run", "snakemake"] : []), "--snakefile", snakefile, "--cores", "1", ...targets, "--rulegraph", "dot", "--nocolor", "--nolock"];
    const output = await captured(command, args, project, 45_000, MAX_GRAPH_BYTES);
    if (output.code !== 0) throw new Error(`Snakemake could not build the rule graph: ${output.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? `exit ${output.code ?? output.signal}`}`);
    const reference = this.#catalog.get("workflow.reference");
    if (!reference) throw new Error("workflow.reference operator is missing");
    const revision = await sourceRevision(project);
    const workflow = workflowLabel?.trim() || project;
    const graph: SomiteGraph = graphFromDot("snakemake", workflow, revision, reference.revision, output.stdout);
    return { engine: "snakemake", workflow, revision, graph, cached: false } as const;
  }

  #load() {
    if (!this.#snapshot) this.#snapshot = this.#loadOnce().catch((error) => {
      this.#snapshot = undefined;
      throw error;
    });
    return this.#snapshot;
  }

  async #loadOnce() {
    const directory = await ensurePrivateDirectory(this.#root, ".somite/catalog");
    const cache = join(directory, "snakemake-workflows-ts.json");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Snakemake catalog timed out")), 30_000);
    try {
      const bytes = await boundedResponse(await this.#fetcher(SNAKEMAKE_CATALOG_URL, { signal: controller.signal, headers: { accept: "application/json" } }), MAX_CATALOG_BYTES, "Snakemake catalog");
      const workflows = parseSnakemakeCatalog(JSON.parse(new TextDecoder().decode(bytes)));
      if (!workflows.length) throw new Error("Snakemake catalog did not contain any released standardized workflows");
      await atomicWrite(cache, `${JSON.stringify(workflows)}\n`);
      return { workflows, cached: false };
    } catch (fetchError) {
      if (!await pathExists(cache)) throw fetchError;
      const compact = parseSnakemakeCache(JSON.parse(new TextDecoder().decode(await regularFile(cache, MAX_CATALOG_BYTES, "Snakemake catalog cache"))));
      return { workflows: compact, cached: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
