import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { pathExists, regularDirectory, regularFile } from "./files.ts";

const MAX_STATUS_BYTES = 64 * 1024;
const MAX_WALK_ENTRIES = 2_000_000;
const RUN_ID = /^[A-Za-z0-9_-]{1,160}$/;
const terminal = new Set(["completed", "failed", "cancelled"]);
const reclaimableNames = ["work", ".nextflow", ".pixi"] as const;

type TerminalStatus = Readonly<{
  schema_version: 1;
  run_id: string;
  phase: "completed" | "failed" | "cancelled";
  finished_at_unix_ms: number;
}>;

export type RunStorageProfile = Readonly<{
  schema_version: 1;
  generated_at_unix_ms: number;
  runs: {
    count: number;
    terminal_count: number;
    bytes: number;
    reclaimable_bytes: number;
    reclaimable_run_ids: string[];
    uncertified_count: number;
    uncertified_bytes: number;
  };
  shared_environments: { bytes: number; recreatable: true };
  paper_cache: { bytes: number; recreatable: true };
  retained_scientific_state: { bytes: number };
}>;

function status(value: unknown, expectedRunId: string): TerminalStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`run ${expectedRunId} has invalid terminal status`);
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== 1 || raw.run_id !== expectedRunId || !terminal.has(String(raw.phase))
    || !Number.isSafeInteger(raw.finished_at_unix_ms) || (raw.finished_at_unix_ms as number) < 0) {
    throw new Error(`run ${expectedRunId} has invalid terminal status`);
  }
  return raw as TerminalStatus;
}

async function readTerminalStatus(directory: string, runId: string) {
  const path = join(directory, "run-status.json");
  if (!await pathExists(path)) return undefined;
  try {
    return status(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, MAX_STATUS_BYTES, `run ${runId} status`))), runId);
  } catch {
    throw new Error(`run ${runId} has invalid terminal status`);
  }
}

async function treeBytes(root: string) {
  if (!await pathExists(root)) return 0;
  let bytes = 0;
  let visited = 0;
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    const metadata = await lstat(path);
    visited += 1;
    if (visited > MAX_WALK_ENTRIES) throw new Error(`storage inspection exceeded ${MAX_WALK_ENTRIES} entries`);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      bytes += metadata.size;
      continue;
    }
    for (const entry of await readdir(path)) pending.push(join(path, entry));
  }
  return bytes;
}

async function regularChildren(root: string) {
  if (!await pathExists(root)) return [];
  await regularDirectory(root, "Somite storage directory");
  const children: Array<{ name: string; path: string }> = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const metadata = await lstat(path);
    if (!metadata.isSymbolicLink() && metadata.isDirectory()) children.push({ name, path });
  }
  return children;
}

async function runProfile(run: { name: string; path: string }, activeRunIds: ReadonlySet<string>) {
  let terminalStatus: TerminalStatus | undefined;
  try {
    terminalStatus = await readTerminalStatus(run.path, run.name);
  } catch {
    // Malformed status is retained and never considered safe to reclaim.
  }
  const reclaimable = Boolean(terminalStatus) && !activeRunIds.has(run.name);
  let bytes = 0;
  let reclaimableBytes = 0;
  await Promise.all((await readdir(run.path)).map(async (name) => {
    const path = join(run.path, name);
    const size = await treeBytes(path);
    bytes += size;
    if (!reclaimable || !reclaimableNames.includes(name as typeof reclaimableNames[number])) return;
    const metadata = await lstat(path);
    if (!metadata.isSymbolicLink() && metadata.isDirectory()) reclaimableBytes += size;
  }));
  return { bytes, reclaimableBytes, terminal: Boolean(terminalStatus) };
}

export class RunStorage {
  readonly #root: string;

  constructor(projectRoot: string) {
    this.#root = projectRoot;
  }

  async profile(activeRunIds: ReadonlySet<string> = new Set()): Promise<RunStorageProfile> {
    const state = join(this.#root, ".somite");
    const runsRoot = join(state, "runs");
    let runBytes = 0;
    let reclaimableBytes = 0;
    let terminalCount = 0;
    let uncertifiedCount = 0;
    let uncertifiedBytes = 0;
    const reclaimableRunIds: string[] = [];
    const runs = await regularChildren(runsRoot);
    const profiles = await Promise.all(runs.map((run) => runProfile(run, activeRunIds)));
    for (let index = 0; index < runs.length; index += 1) {
      const profile = profiles[index]!;
      runBytes += profile.bytes;
      reclaimableBytes += profile.reclaimableBytes;
      if (profile.terminal) terminalCount += 1;
      else {
        uncertifiedCount += 1;
        uncertifiedBytes += profile.bytes;
      }
      if (profile.reclaimableBytes > 0) reclaimableRunIds.push(runs[index]!.name);
    }

    const retainedPaths = [
      "uploads",
      "papers/objects",
      "papers/display-names",
      "source-workflows",
      "fixtures",
      "compiled",
      "exports",
      "evidence",
      "catalog",
      "agent-transcripts",
    ];
    const [environments, paperCache, ...retainedSizes] = await Promise.all([
      treeBytes(join(state, "pixi", "environments")),
      treeBytes(join(state, "papers", "cache")),
      ...retainedPaths.map((path) => treeBytes(join(state, path))),
    ]);
    const retained = Math.max(0, runBytes - reclaimableBytes) + retainedSizes.reduce((total, size) => total + size, 0);
    return {
      schema_version: 1,
      generated_at_unix_ms: Date.now(),
      runs: {
        count: runs.length,
        terminal_count: terminalCount,
        bytes: runBytes,
        reclaimable_bytes: reclaimableBytes,
        reclaimable_run_ids: reclaimableRunIds,
        uncertified_count: uncertifiedCount,
        uncertified_bytes: uncertifiedBytes,
      },
      shared_environments: { bytes: environments, recreatable: true },
      paper_cache: { bytes: paperCache, recreatable: true },
      retained_scientific_state: { bytes: retained },
    };
  }

  async dehydrateRuns(runIds: readonly string[], activeRunIds: ReadonlySet<string> = new Set()) {
    if (runIds.length === 0 || runIds.length > 256 || new Set(runIds).size !== runIds.length) {
      throw new Error("run cleanup requires 1 to 256 unique run ids");
    }
    const runsRoot = join(this.#root, ".somite", "runs");
    const targets: Array<{ runId: string; path: string; bytes: number }> = [];
    for (const runId of runIds) {
      if (!RUN_ID.test(runId)) throw new Error(`invalid run id ${runId}`);
      if (activeRunIds.has(runId)) throw new Error(`run ${runId} is still active`);
      const directory = join(runsRoot, runId);
      await regularDirectory(directory, `run ${runId}`);
      if (!await readTerminalStatus(directory, runId)) throw new Error(`run ${runId} has no valid terminal status`);
      for (const name of reclaimableNames) {
        const path = join(directory, name);
        if (!await pathExists(path)) continue;
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`run ${runId} ${name} is not a regular directory`);
        targets.push({ runId, path, bytes: await treeBytes(path) });
      }
    }
    let reclaimedBytes = 0;
    for (const target of targets) {
      const metadata = await lstat(target.path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`run ${target.runId} cleanup target changed during preflight`);
      await rm(target.path, { recursive: true });
      reclaimedBytes += target.bytes;
    }
    return { run_ids: [...runIds], reclaimed_bytes: reclaimedBytes };
  }
}
