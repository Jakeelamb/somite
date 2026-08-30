import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import { byteDigest } from "@somite/workflow/contentIdentity";
import { atomicWrite, containedPath, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";
import type { PaperMediaKind } from "./paperExtractor.ts";

const MAX_PAPER_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type PaperArtifact = Readonly<{
  digest: string;
  path: string;
  filename: string;
  size_bytes: number;
  media_kind: PaperMediaKind;
  reused: boolean;
}>;

type StoredArtifact = Readonly<{
  schema_version: 1;
  digest: string;
  size_bytes: number;
  media_kind: PaperMediaKind;
}>;

export class PaperStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PaperStoreError";
    this.status = status;
    this.code = code;
  }
}

function safeFilename(value: string) {
  const name = basename(value);
  if (!name || name === "." || name === ".." || name.includes("\0")) throw new PaperStoreError(400, "paper_filename_invalid", "Paper filename is invalid.");
  return name;
}

function mediaKind(filename: string, contentType: string, bytes: Uint8Array): PaperMediaKind {
  const extension = extname(filename).toLocaleLowerCase("en-US");
  const suppliedType = contentType.toLocaleLowerCase("en-US").split(";", 1)[0];
  const pdf = extension === ".pdf";
  const text = extension === ".txt" || extension === ".md";
  if ((!pdf && !text) || (pdf && suppliedType.startsWith("text/")) || (text && suppliedType === "application/pdf")) {
    throw new PaperStoreError(415, "paper_media_unsupported", "Choose a PDF, text, or Markdown paper with a matching filename.");
  }
  if (pdf) {
    if (bytes.length < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new PaperStoreError(415, "paper_pdf_invalid", "The uploaded .pdf does not contain a PDF header.");
    return "pdf";
  }
  if (bytes.includes(0)) throw new PaperStoreError(415, "paper_text_invalid", "Text and Markdown papers cannot contain binary zero bytes.");
  try {
    decoder.decode(bytes);
  } catch {
    throw new PaperStoreError(415, "paper_text_invalid", "Text and Markdown papers must contain valid UTF-8 text.");
  }
  return "text";
}

async function installImmutable(path: string, bytes: Uint8Array) {
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await regularFile(path, MAX_PAPER_BYTES, "stored paper");
    if (existing.byteLength !== bytes.byteLength || byteDigest(existing) !== byteDigest(bytes)) throw new PaperStoreError(409, "paper_object_conflict", "A stored paper object does not match its content address.");
    return true;
  }
}

function storedArtifact(value: unknown): StoredArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PaperStoreError(500, "paper_object_invalid", "Stored paper metadata is invalid.");
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== 1 || typeof raw.digest !== "string" || typeof raw.size_bytes !== "number" || (raw.media_kind !== "pdf" && raw.media_kind !== "text")) {
    throw new PaperStoreError(500, "paper_object_invalid", "Stored paper metadata is invalid.");
  }
  return raw as StoredArtifact;
}

export class PaperStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async upload(request: Request): Promise<PaperArtifact> {
    const announced = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(announced) && announced > MAX_PAPER_BYTES + 1024 * 1024) throw new PaperStoreError(413, "paper_upload_too_large", `Paper upload exceeds ${MAX_PAPER_BYTES} bytes.`);
    let form: FormData;
    try {
      form = await request.formData();
    } catch (error) {
      throw new PaperStoreError(400, "paper_multipart_invalid", `Paper upload is not valid multipart data: ${error instanceof Error ? error.message : String(error)}`);
    }
    const value = form.get("file");
    if (!(value instanceof File)) throw new PaperStoreError(400, "paper_file_missing", "Multipart field file is required.");
    if (!value.size) throw new PaperStoreError(400, "paper_empty", "The paper file is empty.");
    if (value.size > MAX_PAPER_BYTES) throw new PaperStoreError(413, "paper_upload_too_large", `Paper upload exceeds ${MAX_PAPER_BYTES} bytes.`);
    const filename = safeFilename(value.name);
    const bytes = new Uint8Array(await value.arrayBuffer());
    if (bytes.byteLength !== value.size) throw new PaperStoreError(400, "paper_upload_changed", "Paper upload changed while it was read.");
    const kind = mediaKind(filename, value.type, bytes);
    const digest = byteDigest(bytes);
    const identity = digest.slice("blake3:".length);
    const objects = await ensurePrivateDirectory(this.#root, ".somite/papers/objects");
    const directory = join(objects, identity);
    await mkdir(directory, { mode: 0o700, recursive: false }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new PaperStoreError(409, "paper_object_invalid", "Paper object directory is not a regular directory.");
    const destination = join(directory, kind === "pdf" ? "payload.pdf" : "payload.txt");
    const reused = await installImmutable(destination, bytes);
    const record: StoredArtifact = { schema_version: 1, digest, size_bytes: bytes.byteLength, media_kind: kind };
    const metadataPath = join(directory, "artifact.json");
    if (await pathExists(metadataPath)) {
      const existing = storedArtifact(JSON.parse(await readFile(metadataPath, "utf8")));
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new PaperStoreError(409, "paper_object_conflict", "Stored paper metadata does not match its content address.");
    } else {
      await atomicWrite(metadataPath, `${JSON.stringify(record, null, 2)}\n`);
    }
    const displayDirectory = await ensurePrivateDirectory(this.#root, `.somite/papers/display-names/${identity}`);
    const displayIdentity = byteDigest(new TextEncoder().encode(filename)).slice("blake3:".length);
    const displayPath = join(displayDirectory, `${displayIdentity}.json`);
    if (!await pathExists(displayPath)) await atomicWrite(displayPath, `${JSON.stringify({ schema_version: 1, digest, filename }, null, 2)}\n`);
    return {
      digest,
      path: relative(this.#root, destination),
      filename,
      size_bytes: bytes.byteLength,
      media_kind: kind,
      reused,
    };
  }

  async resolveDigest(digest: string) {
    if (!/^blake3:[0-9a-f]{64}$/.test(digest)) throw new PaperStoreError(400, "paper_digest_invalid", "Paper digest is malformed.");
    const identity = digest.slice("blake3:".length);
    const directory = containedPath(this.#root, `.somite/papers/objects/${identity}`);
    const metadata = storedArtifact(JSON.parse(await readFile(join(directory, "artifact.json"), "utf8")));
    if (metadata.digest !== digest || metadata.size_bytes > MAX_PAPER_BYTES) throw new PaperStoreError(409, "paper_object_invalid", "Stored paper metadata does not match the requested digest.");
    const path = join(directory, metadata.media_kind === "pdf" ? "payload.pdf" : "payload.txt");
    const bytes = await regularFile(path, MAX_PAPER_BYTES, "stored paper");
    if (bytes.byteLength !== metadata.size_bytes || byteDigest(bytes) !== digest) throw new PaperStoreError(409, "paper_object_invalid", "Stored paper bytes do not match their content address.");
    return { metadata, path, bytes };
  }

  async resolveProjectPath(path: string) {
    const destination = isAbsolute(path) ? resolve(path) : resolve(this.#root, path);
    const shown = relative(this.#root, destination);
    if (!shown || shown.startsWith("..") || isAbsolute(shown)) throw new PaperStoreError(403, "paper_path_outside_project", "Paper path must stay inside this project.");
    const bytes = await regularFile(destination, MAX_PAPER_BYTES, "paper");
    const filename = safeFilename(destination);
    const kind = mediaKind(filename, "", bytes);
    return { bytes, mediaKind: kind, filename, path: destination };
  }
}
