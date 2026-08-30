import Busboy from "busboy";
import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { byteDigest, createByteDigester } from "@somite/workflow/contentIdentity";
import { atomicWrite, containedPath, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";
import { DEFAULT_PAPER_INTAKE_CONFIG, MAX_CONFIGURED_PAPER_UPLOAD_BYTES, PaperConfigurationError } from "./paperConfig.ts";
import type { PaperMediaKind } from "./paperExtractor.ts";

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
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
  const name = basename(value.replaceAll("\\", "/"));
  if (!name || name === "." || name === ".." || Buffer.byteLength(name) > 255
    || [...name].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) {
    throw new PaperStoreError(400, "paper_filename_invalid", "Paper filename is invalid.");
  }
  return name;
}

function mediaKind(filename: string, contentType: string): PaperMediaKind {
  const extension = extname(filename).toLocaleLowerCase("en-US");
  const suppliedType = contentType.toLocaleLowerCase("en-US").split(";", 1)[0];
  const pdf = extension === ".pdf";
  const text = extension === ".txt" || extension === ".md";
  if ((!pdf && !text) || (pdf && suppliedType.startsWith("text/")) || (text && suppliedType === "application/pdf")) {
    throw new PaperStoreError(415, "paper_media_unsupported", "Choose a PDF, text, or Markdown paper with a matching filename.");
  }
  return pdf ? "pdf" : "text";
}

function validatedMediaKind(filename: string, contentType: string, bytes: Uint8Array) {
  const kind = mediaKind(filename, contentType);
  if (!bytes.byteLength) throw new PaperStoreError(400, "paper_empty", "The paper file is empty.");
  if (kind === "pdf") {
    if (bytes.byteLength < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      throw new PaperStoreError(415, "paper_pdf_invalid", "The uploaded .pdf does not contain a PDF header.");
    }
    return kind;
  }
  if (bytes.includes(0)) throw new PaperStoreError(415, "paper_text_invalid", "Text and Markdown papers cannot contain binary zero bytes.");
  try {
    decoder.decode(bytes);
  } catch {
    throw new PaperStoreError(415, "paper_text_invalid", "Text and Markdown papers must contain valid UTF-8 text.");
  }
  return kind;
}

function uploadLimitMessage(maximumBytes: number) {
  return `Paper upload exceeds the configured ${maximumBytes}-byte limit. Choose a smaller file or raise SOMITE_PAPER_MAX_UPLOAD_BYTES (maximum ${MAX_CONFIGURED_PAPER_UPLOAD_BYTES}) and restart Somite.`;
}

function validatingStream(kind: PaperMediaKind, maximumBytes: number) {
  const digester = createByteDigester();
  const header = Buffer.alloc(5);
  const textDecoder = kind === "text" ? new TextDecoder("utf-8", { fatal: true }) : undefined;
  let headerBytes = 0;
  let total = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maximumBytes) {
        callback(new PaperStoreError(413, "paper_upload_too_large", uploadLimitMessage(maximumBytes)));
        return;
      }
      digester.update(bytes);
      if (headerBytes < header.byteLength) {
        headerBytes += bytes.copy(header, headerBytes, 0, header.byteLength - headerBytes);
      }
      if (textDecoder) {
        if (bytes.includes(0)) {
          callback(new PaperStoreError(415, "paper_text_invalid", "Text and Markdown papers cannot contain binary zero bytes."));
          return;
        }
        try {
          textDecoder.decode(bytes, { stream: true });
        } catch {
          callback(new PaperStoreError(415, "paper_text_invalid", "Text and Markdown papers must contain valid UTF-8 text."));
          return;
        }
      }
      callback(null, bytes);
    },
    flush(callback) {
      if (!total) {
        callback(new PaperStoreError(400, "paper_empty", "The paper file is empty."));
        return;
      }
      if (kind === "pdf" && (headerBytes < header.byteLength || header.toString("ascii") !== "%PDF-")) {
        callback(new PaperStoreError(415, "paper_pdf_invalid", "The uploaded .pdf does not contain a PDF header."));
        return;
      }
      if (kind === "text" && headerBytes === header.byteLength && header.toString("ascii") === "%PDF-") {
        callback(new PaperStoreError(415, "paper_media_unsupported", "The paper filename does not match its PDF content."));
        return;
      }
      try {
        textDecoder?.decode();
        callback();
      } catch {
        callback(new PaperStoreError(415, "paper_text_invalid", "Text and Markdown papers must contain valid UTF-8 text."));
      }
    },
  });
  return { stream, result: () => ({ digest: digester.digest(), size: total }) };
}

async function fileIdentity(path: string, expectedSize: number) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== expectedSize) {
    throw new PaperStoreError(409, "paper_object_conflict", "A stored paper object is not the expected regular file.");
  }
  const digester = createByteDigester();
  for await (const chunk of createReadStream(path)) digester.update(chunk);
  return digester.digest();
}

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function installImmutable(temporary: string, destination: string, digest: string, size: number) {
  try {
    await link(temporary, destination);
    await unlink(temporary);
    await syncDirectory(dirname(destination));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await fileIdentity(destination, size) !== digest) throw new PaperStoreError(409, "paper_object_conflict", "A stored paper object does not match its content address.");
    await unlink(temporary);
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
  readonly #maxPaperBytes: number;
  readonly #maxMultipartBytes: number;

  constructor(root: string, maxPaperBytes = DEFAULT_PAPER_INTAKE_CONFIG.maxUploadBytes) {
    if (!Number.isSafeInteger(maxPaperBytes) || maxPaperBytes < 1 || maxPaperBytes > MAX_CONFIGURED_PAPER_UPLOAD_BYTES) {
      throw new PaperConfigurationError(`Paper upload limit must be an integer from 1 to ${MAX_CONFIGURED_PAPER_UPLOAD_BYTES} bytes.`);
    }
    this.#root = resolve(root);
    this.#maxPaperBytes = maxPaperBytes;
    this.#maxMultipartBytes = maxPaperBytes + MULTIPART_OVERHEAD_BYTES;
  }

  receive(request: IncomingMessage) {
    return this.#receiveMultipart(request, request.headers);
  }

  upload(request: Request) {
    const headers: IncomingHttpHeaders = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    const source = request.body
      ? Readable.fromWeb(request.body as import("node:stream/web").ReadableStream)
      : Readable.from([]);
    return this.#receiveMultipart(source, headers);
  }

  async #receiveMultipart(source: Readable, headers: IncomingHttpHeaders): Promise<PaperArtifact> {
    const announced = Number(headers["content-length"] ?? 0);
    if (Number.isFinite(announced) && announced > this.#maxMultipartBytes) throw new PaperStoreError(413, "paper_upload_too_large", uploadLimitMessage(this.#maxPaperBytes));
    const objects = await ensurePrivateDirectory(this.#root, ".somite/papers/objects");
    let temporary: string | undefined;
    let uploaded: { filename: string; kind: PaperMediaKind; digest: string; size: number } | undefined;
    let fileWrite: Promise<void> | undefined;
    let files = 0;
    let received = 0;
    let rejected: PaperStoreError | undefined;
    const parser = (() => {
      try {
        return Busboy({
          headers,
          limits: { fileSize: this.#maxPaperBytes + 1, files: 2, fields: 1, parts: 3, headerPairs: 100 },
        });
      } catch (error) {
        throw new PaperStoreError(400, "paper_multipart_invalid", `Paper upload is not valid multipart data: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    const parsed = new Promise<void>((resolvePromise, rejectPromise) => {
      source.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > this.#maxMultipartBytes) {
          source.destroy(new PaperStoreError(413, "paper_upload_too_large", uploadLimitMessage(this.#maxPaperBytes)));
        }
      });
      source.once("error", (error) => rejectPromise(error instanceof PaperStoreError
        ? error
        : new PaperStoreError(400, "paper_multipart_invalid", error.message)));
      parser.once("error", (error: Error) => rejectPromise(new PaperStoreError(400, "paper_multipart_invalid", error.message)));
      parser.once("filesLimit", () => { rejected = new PaperStoreError(400, "paper_file_invalid", "Paper upload must contain exactly one file field."); });
      parser.once("fieldsLimit", () => { rejected = new PaperStoreError(400, "paper_field_invalid", "Paper upload may not contain form fields."); });
      parser.once("partsLimit", () => { rejected = new PaperStoreError(400, "paper_file_invalid", "Paper upload must contain exactly one file part."); });
      parser.on("field", () => { rejected = new PaperStoreError(400, "paper_field_invalid", "Paper upload may not contain form fields."); });
      parser.on("file", (field, stream, information) => {
        files += 1;
        if (field !== "file" || files !== 1) {
          rejected = new PaperStoreError(400, "paper_file_invalid", "Paper upload must contain exactly one field named file.");
          stream.resume();
          return;
        }
        let filename: string;
        let kind: PaperMediaKind;
        try {
          filename = safeFilename(information.filename);
          kind = mediaKind(filename, information.mimeType);
        } catch (error) {
          rejected = error instanceof PaperStoreError ? error : new PaperStoreError(400, "paper_file_invalid", String(error));
          stream.resume();
          return;
        }
        temporary = join(objects, `.paper-upload-${process.pid}-${randomUUID()}`);
        const destination = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
        const validator = validatingStream(kind, this.#maxPaperBytes);
        let limited = false;
        stream.once("limit", () => { limited = true; });
        fileWrite = pipeline(stream, validator.stream, destination).then(async () => {
          const metadata = await lstat(temporary!);
          if (limited || stream.truncated || metadata.size > this.#maxPaperBytes) {
            throw new PaperStoreError(413, "paper_upload_too_large", uploadLimitMessage(this.#maxPaperBytes));
          }
          const result = validator.result();
          if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== result.size) {
            throw new PaperStoreError(400, "paper_upload_changed", "Paper upload changed while it was stored.");
          }
          const handle = await open(temporary!, "r");
          try { await handle.sync(); } finally { await handle.close(); }
          uploaded = { filename, kind, digest: result.digest, size: result.size };
        });
        fileWrite.catch(rejectPromise);
      });
      parser.once("close", resolvePromise);
    });
    source.pipe(parser);
    try {
      await parsed;
      if (fileWrite) await fileWrite;
      if (rejected) throw rejected;
      if (files !== 1 || !temporary || !uploaded) throw new PaperStoreError(400, "paper_file_missing", "Multipart field file is required.");
      const { digest, filename, kind, size } = uploaded;
      const identity = digest.slice("blake3:".length);
      const directory = join(objects, identity);
      await mkdir(directory, { mode: 0o700, recursive: false }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new PaperStoreError(409, "paper_object_invalid", "Paper object directory is not a regular directory.");
      const destination = join(directory, kind === "pdf" ? "payload.pdf" : "payload.txt");
      const reused = await installImmutable(temporary, destination, digest, size);
      temporary = undefined;
      const record: StoredArtifact = { schema_version: 1, digest, size_bytes: size, media_kind: kind };
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
        path: relative(this.#root, destination).split("\\").join("/"),
        filename,
        size_bytes: size,
        media_kind: kind,
        reused,
      };
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }

  async resolveDigest(digest: string) {
    const resolved = await this.resolveDigestPath(digest);
    const bytes = await readFile(resolved.path);
    if (bytes.byteLength !== resolved.metadata.size_bytes || byteDigest(bytes) !== digest) throw new PaperStoreError(409, "paper_object_invalid", "Stored paper bytes do not match their content address.");
    return { ...resolved, bytes };
  }

  async resolveDigestPath(digest: string) {
    if (!/^blake3:[0-9a-f]{64}$/.test(digest)) throw new PaperStoreError(400, "paper_digest_invalid", "Paper digest is malformed.");
    const identity = digest.slice("blake3:".length);
    const directory = containedPath(this.#root, `.somite/papers/objects/${identity}`);
    const metadata = storedArtifact(JSON.parse(await readFile(join(directory, "artifact.json"), "utf8")));
    if (metadata.digest !== digest || metadata.size_bytes > this.#maxPaperBytes) throw new PaperStoreError(409, "paper_object_invalid", "Stored paper metadata does not match the requested digest or configured upload limit.");
    const path = join(directory, metadata.media_kind === "pdf" ? "payload.pdf" : "payload.txt");
    const file = await lstat(path);
    if (file.isSymbolicLink() || !file.isFile() || file.size !== metadata.size_bytes) throw new PaperStoreError(409, "paper_object_invalid", "Stored paper is not the expected regular file.");
    return { metadata, path };
  }

  async resolveProjectPath(path: string) {
    const destination = isAbsolute(path) ? resolve(path) : resolve(this.#root, path);
    const shown = relative(this.#root, destination);
    if (!shown || shown.startsWith("..") || isAbsolute(shown)) throw new PaperStoreError(403, "paper_path_outside_project", "Paper path must stay inside this project.");
    const bytes = await regularFile(destination, this.#maxPaperBytes, "paper");
    const filename = safeFilename(destination);
    const kind = validatedMediaKind(filename, "", bytes);
    return { bytes, mediaKind: kind, filename, path: destination };
  }
}
