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
  return status(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, MAX_STATUS_BYTES, `run ${runId} status`))), runId);
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
    const runs = await regularChildren(runsRoot);
    for (const run of runs) {
      runBytes += await treeBytes(run.path);
      let terminalStatus: TerminalStatus | undefined;
      try {
        terminalStatus = await readTerminalStatus(run.path, run.name);
      } catch {
        // Malformed status is retained and never considered safe to reclaim.
      }
      if (!terminalStatus) continue;
      terminalCount += 1;
      if (activeRunIds.has(run.name)) continue;
      for (const name of reclaimableNames) reclaimableBytes += await treeBytes(join(run.path, name));
    }

    const environments = await treeBytes(join(state, "pixi", "environments"));
    const paperCache = await treeBytes(join(state, "papers", "cache"));
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
    let retained = Math.max(0, runBytes - reclaimableBytes);
    for (const path of retainedPaths) retained += await treeBytes(join(state, path));
    return {
      schema_version: 1,
      generated_at_unix_ms: Date.now(),
      runs: { count: runs.length, terminal_count: terminalCount, bytes: runBytes, reclaimable_bytes: reclaimableBytes },
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
    let reclaimedBytes = 0;
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
        reclaimedBytes += await treeBytes(path);
        await rm(path, { recursive: true });
      }
    }
    return { run_ids: [...runIds], reclaimed_bytes: reclaimedBytes };
  }
}
