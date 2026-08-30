import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function regularDirectory(path: string, label = path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be a regular directory`);
  return path;
}

export async function regularFile(path: string, maximumBytes: number, label = path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a regular file`);
  if (metadata.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error(`${label} changed while it was read`);
  return bytes;
}

export async function ensurePrivateDirectory(root: string, relativePath: string) {
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const part of relativePath.split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await regularDirectory(current, relativePath);
    const canonical = await realpath(current);
    if (dirname(canonical) !== await realpath(dirname(current))) throw new Error(`${relativePath} escapes its parent`);
  }
  return current;
}

export async function atomicWrite(path: string, contents: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  if (await pathExists(path)) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${path} must be a regular file`);
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
    throw error;
  }
}

export function containedPath(root: string, relativePath: string) {
  const destination = resolve(root, relativePath);
  const prefix = `${resolve(root)}/`;
  if (!destination.startsWith(prefix)) throw new Error(`path ${relativePath} escapes its root`);
  return destination;
}
