import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { BENCHMARK_HARNESS_FILES } from "./benchmark-core.ts";

const PROFILE_HARNESS_FILES = [
  "scripts/profile-benchmark.ts",
  "scripts/benchmark-profile-contract.ts",
  "scripts/benchmark-case.ts",
  "runner/src/files.ts",
  ...BENCHMARK_HARNESS_FILES,
] as const;

async function directFiles(repositoryRoot: string, directory: string, suffix: string) {
  const entries = await readdir(join(repositoryRoot, directory), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

async function paperGoldFiles(repositoryRoot: string) {
  const rows = (await readFile(join(repositoryRoot, "testdata", "papers", "gold.tsv"), "utf8"))
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  const headers = rows.shift()?.split("\t") ?? [];
  const fixtureIndex = headers.indexOf("fixture");
  if (fixtureIndex < 0) throw new Error("paper gold corpus has no fixture column");
  const fixtures = rows.map((line) => line.split("\t")[fixtureIndex]).filter((value): value is string => Boolean(value));
  if (fixtures.some((fixture) => !/^[A-Za-z0-9._-]+$/.test(fixture))) throw new Error("paper gold corpus contains an unsafe fixture path");
  return [
    "scripts/benchmark-paper-topology.ts",
    "testdata/papers/gold.tsv",
    ...fixtures.map((fixture) => `testdata/papers/${fixture}`),
  ];
}

/** Exact benchmark harness, workflow implementation, and reviewed operator identity. */
export async function benchmarkProfileContractFiles(repositoryRoot: string, benchmarkCase: string) {
  const [workflowSources, operatorContracts] = await Promise.all([
    directFiles(repositoryRoot, "packages/workflow", ".ts"),
    directFiles(repositoryRoot, "operators", ".json"),
  ]);
  const paperFiles = benchmarkCase === "paper.gold_text" ? await paperGoldFiles(repositoryRoot) : [];
  return [...new Set([
    ...PROFILE_HARNESS_FILES,
    "packages/workflow/package.json",
    ...workflowSources,
    ...operatorContracts,
    ...paperFiles,
  ])].sort();
}

export async function benchmarkProfileContractDigest(repositoryRoot: string, benchmarkCase: string) {
  const hash = createHash("sha256");
  for (const path of await benchmarkProfileContractFiles(repositoryRoot, benchmarkCase)) {
    const bytes = await readFile(join(repositoryRoot, path));
    hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
