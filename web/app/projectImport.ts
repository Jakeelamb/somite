import { MAX_SOURCE_BYTES, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_FILES } from "@somite/workflow/nextflowSource";

type WebkitEntry = Readonly<{
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
  createReader?: () => Readonly<{
    readEntries: (success: (entries: WebkitEntry[]) => void, failure?: (error: DOMException) => void) => void;
  }>;
}>;

type DropItem = Readonly<{
  kind: string;
  webkitGetAsEntry?: () => unknown;
}>;

export type DroppedProjectFile = Readonly<{ path: string; file: File }>;

function entryFile(entry: WebkitEntry) {
  if (!entry.isFile || !entry.file) throw new Error(`the browser could not read ${entry.name}`);
  return new Promise<File>((resolvePromise, rejectPromise) => entry.file!(resolvePromise, rejectPromise));
}

async function directoryEntries(entry: WebkitEntry) {
  if (!entry.isDirectory || !entry.createReader) throw new Error(`the browser could not read directory ${entry.name}`);
  const reader = entry.createReader();
  const entries: WebkitEntry[] = [];
  while (true) {
    const batch = await new Promise<WebkitEntry[]>((resolvePromise, rejectPromise) => reader.readEntries(resolvePromise, rejectPromise));
    if (!batch.length) return entries;
    entries.push(...batch);
  }
}

function safeEntryName(name: string) {
  return Boolean(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")
    && new TextEncoder().encode(name).byteLength <= 255 && !/[\p{Cc}\p{Cf}]/u.test(name);
}

async function collectDirectory(root: WebkitEntry) {
  if (!safeEntryName(root.name)) throw new Error("the dropped workflow directory has an invalid name");
  const files: DroppedProjectFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: WebkitEntry, prefix: string): Promise<void> => {
    const entries = await directoryEntries(directory);
    for (const entry of entries) {
      if (!safeEntryName(entry.name)) throw new Error(`the dropped workflow contains an invalid path below ${prefix}`);
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(entry, path);
        continue;
      }
      const file = await entryFile(entry);
      if (file.size > MAX_SOURCE_FILE_BYTES) throw new Error(`${path} exceeds the workflow source file limit`);
      totalBytes += file.size;
      if (totalBytes > MAX_SOURCE_BYTES) throw new Error("the dropped workflow exceeds the workflow source size limit");
      files.push({ path, file });
      if (files.length > MAX_SOURCE_FILES) throw new Error("the dropped workflow contains too many files");
    }
  };
  await visit(root, root.name);
  if (!files.some((entry) => entry.path === `${root.name}/main.nf`)) {
    throw new Error("the dropped workflow directory must contain main.nf at its root");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Snapshot a Chrome directory drop synchronously, then enumerate every nested file asynchronously. */
export function droppedProjectDirectory(items: ArrayLike<DropItem>): Promise<DroppedProjectFile[]> | undefined {
  const entries = Array.from(items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is WebkitEntry => Boolean(entry) && typeof entry === "object"
      && typeof (entry as WebkitEntry).name === "string"
      && typeof (entry as WebkitEntry).isFile === "boolean"
      && typeof (entry as WebkitEntry).isDirectory === "boolean");
  const directories = entries.filter((entry) => entry.isDirectory);
  if (!directories.length) return undefined;
  if (directories.length !== 1 || entries.length !== 1) {
    return Promise.reject(new Error("drop one workflow directory at a time"));
  }
  return collectDirectory(directories[0]!);
}
