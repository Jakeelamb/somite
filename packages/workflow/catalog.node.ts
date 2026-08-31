import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OperatorCatalog, type PinnedOperator } from "./catalog.ts";
import { catalogRevision, operatorRevision, parseOperator } from "./catalogCodec.ts";

export type LoadedOperatorCatalog = Readonly<{
  catalog: OperatorCatalog;
  revision: string;
  operators: readonly PinnedOperator[];
}>;

/** Load, validate, pin, and identify the reviewed operator directory. */
export async function loadOperatorCatalog(directory: string): Promise<LoadedOperatorCatalog> {
  return loadOperatorCatalogDirectories([directory]);
}

/** Load reviewed built-in and project-local directories into one immutable catalog. */
export async function loadOperatorCatalogDirectories(directories: readonly string[]): Promise<LoadedOperatorCatalog> {
  const operators: PinnedOperator[] = [];
  for (const directory of directories) operators.push(...await loadOperatorDirectory(directory));
  return {
    catalog: new OperatorCatalog(operators),
    revision: catalogRevision(operators),
    operators,
  };
}

async function loadOperatorDirectory(directory: string): Promise<PinnedOperator[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const operators: PinnedOperator[] = [];
  for (const file of files) {
    const path = join(directory, file);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(`json ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const operator = parseOperator(value, path);
    operators.push({ ...operator, revision: operatorRevision(operator) });
  }
  return operators;
}
