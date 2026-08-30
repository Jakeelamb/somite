import { link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  const parent = dirname(path);
  const canonicalParent = await safeWriteParent(path);
  if (await pathExists(path)) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${path} must be a regular file`);
  }
  const temporary = await durableTemporary(parent, basename(path), contents);
  try {
    if (await realpath(parent) !== canonicalParent) throw new Error(`parent of ${path} changed during the write`);
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Publish immutable content without ever replacing an existing path. */
export async function immutableWrite(path: string, contents: string | Uint8Array) {
  const parent = dirname(path);
  const canonicalParent = await safeWriteParent(path);
  const temporary = await durableTemporary(parent, basename(path), contents);
  try {
    if (await realpath(parent) !== canonicalParent) throw new Error(`parent of ${path} changed during the write`);
    await link(temporary, path);
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function safeWriteParent(path: string) {
  const parent = dirname(path);
  await regularDirectory(parent, `parent of ${path}`);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== resolve(parent)) throw new Error(`parent of ${path} must not contain a symbolic link`);
  return canonicalParent;
}

async function durableTemporary(parent: string, name: string, contents: string | Uint8Array) {
  const temporary = join(parent, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temporary;
}

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function containedPath(root: string, relativePath: string) {
  const canonicalRoot = resolve(root);
  const destination = resolve(canonicalRoot, relativePath);
  const fromRoot = relative(canonicalRoot, destination);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`path ${relativePath} escapes its root`);
  }
  return destination;
}
