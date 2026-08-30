import { readFile } from "node:fs/promises";

import {
  SOMITE_NEXTFLOW_COMPILER_IDENTITY,
  SOMITE_TYPESCRIPT_RUNNER_IDENTITY,
  SOMITE_VERSION,
} from "../packages/workflow/version.ts";

type Manifest = Readonly<{
  version?: unknown;
  dependencies?: Readonly<Record<string, unknown>>;
  packages?: Readonly<Record<string, { version?: unknown; dependencies?: Readonly<Record<string, unknown>> }>>;
}>;

async function json(path: URL) {
  return JSON.parse(await readFile(path, "utf8")) as Manifest;
}

function requireEqual(label: string, actual: unknown, expected: string) {
  if (actual !== expected) throw new Error(`${label} is ${String(actual)}, expected ${expected}`);
}

const root = await json(new URL("../package.json", import.meta.url));
const web = await json(new URL("../web/package.json", import.meta.url));
const runner = await json(new URL("../runner/package.json", import.meta.url));
const workflow = await json(new URL("../packages/workflow/package.json", import.meta.url));
const lock = await json(new URL("../package-lock.json", import.meta.url));
const pixi = await readFile(new URL("../pixi.toml", import.meta.url), "utf8");
const pixiVersion = /^version = "([^"]+)"$/m.exec(pixi)?.[1];

for (const [label, actual] of [
  ["root package", root.version],
  ["web package", web.version],
  ["runner package", runner.version],
  ["workflow package", workflow.version],
  ["Pixi workspace", pixiVersion],
  ["lockfile", lock.version],
  ["lockfile root package", lock.packages?.[""]?.version],
  ["lockfile web package", lock.packages?.web?.version],
  ["lockfile runner package", lock.packages?.runner?.version],
  ["lockfile workflow package", lock.packages?.["packages/workflow"]?.version],
  ["web workflow dependency", web.dependencies?.["@somite/workflow"]],
  ["runner workflow dependency", runner.dependencies?.["@somite/workflow"]],
  ["lockfile web workflow dependency", lock.packages?.web?.dependencies?.["@somite/workflow"]],
  ["lockfile runner workflow dependency", lock.packages?.runner?.dependencies?.["@somite/workflow"]],
] as const) requireEqual(label, actual, SOMITE_VERSION);

requireEqual("Nextflow compiler identity", SOMITE_NEXTFLOW_COMPILER_IDENTITY, `somite-nextflow@${SOMITE_VERSION}`);
requireEqual("TypeScript runner identity", SOMITE_TYPESCRIPT_RUNNER_IDENTITY, `somite-typescript-runner@${SOMITE_VERSION}`);

const releaseTag = process.argv[2];
if (releaseTag !== undefined) requireEqual("release tag", releaseTag, `v${SOMITE_VERSION}`);

process.stdout.write(`Somite version contract ${SOMITE_VERSION} is consistent\n`);
