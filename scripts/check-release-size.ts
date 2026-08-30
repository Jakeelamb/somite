import { execFileSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const KIB = 1024;
const MIB = KIB * KIB;
const limits = {
  trackedBytes: 4 * MIB,
  trackedFileBytes: 1 * MIB,
  clientBytes: 2 * MIB,
  clientJavaScriptBytes: 1_280 * KIB,
  clientCssBytes: 256 * KIB,
  clientChunkBytes: 512 * KIB,
} as const;

const repository = fileURLToPath(new URL("../", import.meta.url));
const client = join(repository, "web", "dist", "client");
const generatedPath = /^(?:node_modules|target|coverage|\.somite|\.pixi|\.nextflow|\.next|\.vinext|\.wrangler|\.turbo|output|web\/dist)(?:\/|$)|\/(?:node_modules|target|coverage|\.somite|\.pixi|\.nextflow|\.next|\.vinext|\.wrangler|\.turbo)(?:\/|$)/;
const MAX_SOURCE_FILES = 10_000;
const argumentsList = process.argv.slice(2);
if (argumentsList.some((argument) => argument !== "--source-only") || new Set(argumentsList).size !== argumentsList.length) {
  throw new Error("usage: check-release-size.ts [--source-only]");
}
const sourceOnly = argumentsList.includes("--source-only");

function formatBytes(bytes: number) {
  return bytes < MIB ? `${(bytes / KIB).toFixed(1)} KiB` : `${(bytes / MIB).toFixed(2)} MiB`;
}

function enforce(label: string, actual: number, maximum: number) {
  if (actual > maximum) {
    throw new Error(`${label} is ${formatBytes(actual)}; release budget is ${formatBytes(maximum)}`);
  }
}

async function archiveSourcePaths(strict: boolean, directory = repository, prefix = ""): Promise<string[]> {
  const paths: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (generatedPath.test(path)) {
      if (strict) throw new Error(`generated install or runtime state is present in release source: ${path}`);
      continue;
    }
    if (entry.isDirectory()) paths.push(...await archiveSourcePaths(strict, join(directory, entry.name), path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`release source contains a non-regular entry: ${path}`);
    if (paths.length > MAX_SOURCE_FILES) throw new Error(`release source exceeds ${MAX_SOURCE_FILES} files`);
  }
  return paths;
}

async function sourcePaths(strictArchive: boolean) {
  const hasGitMetadata = await lstat(join(repository, ".git"))
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  if (!hasGitMetadata) return archiveSourcePaths(strictArchive);
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 8 * MIB,
  });
  return output.split("\0").filter(Boolean);
}

async function releaseSourceProfile(strictArchive = false) {
  const paths = await sourcePaths(strictArchive);
  const generated = paths.filter((path) => generatedPath.test(path));
  if (generated.length) throw new Error(`generated runtime state is tracked: ${generated.slice(0, 5).join(", ")}`);
  const files = await Promise.all(paths.map(async (path) => ({ path, bytes: (await lstat(join(repository, path))).size })));
  for (const file of files) enforce(`tracked file ${file.path}`, file.bytes, limits.trackedFileBytes);
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  enforce("tracked source", bytes, limits.trackedBytes);
  return { files: files.length, bytes };
}

async function builtFiles(directory: string): Promise<Array<{ path: string; bytes: number }>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("production client bundle is missing; run npm run build first");
    throw error;
  });
  const files: Array<{ path: string; bytes: number }> = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await builtFiles(path));
    else if (entry.isFile()) files.push({ path: relative(client, path).replaceAll("\\", "/"), bytes: (await lstat(path)).size });
    else throw new Error(`production client contains a non-regular entry: ${relative(client, path)}`);
  }
  return files;
}

async function clientBundleProfile() {
  const files = await builtFiles(client);
  const javascript = files.filter((file) => file.path.endsWith(".js"));
  const css = files.filter((file) => file.path.endsWith(".css"));
  for (const chunk of javascript) enforce(`client JavaScript chunk ${chunk.path}`, chunk.bytes, limits.clientChunkBytes);
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  const javascriptBytes = javascript.reduce((total, file) => total + file.bytes, 0);
  const cssBytes = css.reduce((total, file) => total + file.bytes, 0);
  enforce("production client", bytes, limits.clientBytes);
  enforce("production client JavaScript", javascriptBytes, limits.clientJavaScriptBytes);
  enforce("production client CSS", cssBytes, limits.clientCssBytes);
  return { files: files.length, bytes, javascriptBytes, cssBytes };
}

if (sourceOnly) {
  const source = await releaseSourceProfile(true);
  process.stdout.write(`Release source size contract passed: ${source.files} source files / ${formatBytes(source.bytes)}\n`);
} else {
  const [source, bundle] = await Promise.all([releaseSourceProfile(), clientBundleProfile()]);
  process.stdout.write([
    `Release size contract passed: ${source.files} source files / ${formatBytes(source.bytes)}`,
    `${bundle.files} client files / ${formatBytes(bundle.bytes)}`,
    `${formatBytes(bundle.javascriptBytes)} JavaScript / ${formatBytes(bundle.cssBytes)} CSS`,
  ].join("; ") + "\n");
}
