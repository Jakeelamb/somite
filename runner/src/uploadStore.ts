import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { lstat, link, open, readdir, realpath, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, extname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

import { ensurePrivateDirectory } from "./files.ts";

const GIB = 1024 ** 3;
const DEFAULT_MAX_FILE_BYTES = 64 * GIB;
const DEFAULT_MAX_PROJECT_BYTES = 256 * GIB;
const MAX_CONFIGURED_BYTES = 8 * 1024 * GIB;

export class UploadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type UploadLimits = {
  maxFileBytes: number;
  maxProjectBytes: number;
};

function environmentBytes(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_CONFIGURED_BYTES ? parsed : fallback;
}

export function uploadLimitsFromEnvironment(): UploadLimits {
  const maxProjectBytes = environmentBytes("SOMITE_UPLOAD_MAX_PROJECT_BYTES", DEFAULT_MAX_PROJECT_BYTES);
  return {
    maxProjectBytes,
    maxFileBytes: Math.min(environmentBytes("SOMITE_UPLOAD_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES), maxProjectBytes),
  };
}

export function safeUploadFilename(value: string) {
  const filename = basename(value.replaceAll("\\", "/"));
  if (!filename || filename === "." || filename === ".." || Buffer.byteLength(filename, "utf8") > 255
    || [...filename].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) {
    throw new UploadError(400, "upload filename is invalid");
  }
  return filename;
}

async function storedBytes(directory: string) {
  let total = 0;
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new UploadError(422, `.somite/uploads contains a non-regular entry: ${entry}`);
    }
    total += metadata.size;
    if (!Number.isSafeInteger(total)) throw new UploadError(422, "upload store byte count overflowed");
  }
  return total;
}

async function publish(directory: string, temporary: string, filename: string) {
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  for (let index = 1; index <= 10_000; index += 1) {
    const candidate = join(directory, index === 1 ? filename : `${stem}-${index}${extension}`);
    try {
      await link(temporary, candidate);
      await unlink(temporary);
      const handle = await open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new UploadError(409, `could not allocate a unique name for ${filename}`);
}

/** Streams one browser-selected scientific file into the project upload store. */
export class UploadStore {
  readonly #root: string;
  readonly #limits: UploadLimits;
  #queue = Promise.resolve();

  constructor(root: string, limits: UploadLimits = uploadLimitsFromEnvironment()) {
    this.#root = resolve(root);
    this.#limits = limits;
  }

  receive(request: IncomingMessage) {
    const operation = this.#queue.then(() => this.#receive(request));
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #receive(request: IncomingMessage) {
    const canonicalRoot = await realpath(this.#root);
    const directory = await ensurePrivateDirectory(this.#root, ".somite/uploads").catch((error) => {
      throw new UploadError(422, error instanceof Error ? error.message : String(error));
    });
    if (await realpath(directory) !== join(canonicalRoot, ".somite", "uploads")) {
      throw new UploadError(422, ".somite/uploads escapes the project");
    }
    const existingBytes = await storedBytes(directory);
    const remaining = this.#limits.maxProjectBytes - existingBytes;
    if (remaining <= 0) {
      throw new UploadError(413, `project upload storage has reached its ${this.#limits.maxProjectBytes}-byte limit`);
    }
    const fileLimit = Math.min(this.#limits.maxFileBytes, remaining);
    let temporary: string | undefined;
    let suppliedFilename: string | undefined;
    let fileWrite: Promise<void> | undefined;
    let files = 0;
    let rejected: UploadError | undefined;
    const parser = (() => {
      try {
        return Busboy({
          headers: request.headers,
          limits: { fileSize: fileLimit + 1, files: 2, fields: 1, parts: 3, headerPairs: 100 },
        });
      } catch (error) {
        throw new UploadError(400, error instanceof Error ? error.message : String(error));
      }
    })();
    const parsed = new Promise<void>((resolvePromise, rejectPromise) => {
      parser.once("error", (error: Error) => rejectPromise(new UploadError(400, error.message)));
      parser.once("filesLimit", () => { rejected = new UploadError(400, "upload must contain exactly one file field"); });
      parser.once("fieldsLimit", () => { rejected = new UploadError(400, "upload may not contain form fields"); });
      parser.once("partsLimit", () => { rejected = new UploadError(400, "upload must contain exactly one file part"); });
      parser.on("field", () => { rejected = new UploadError(400, "upload may not contain form fields"); });
      parser.on("file", (field, stream, information) => {
        files += 1;
        if (field !== "file" || files !== 1) {
          rejected = new UploadError(400, "upload must contain exactly one field named file");
          stream.resume();
          return;
        }
        try {
          suppliedFilename = safeUploadFilename(information.filename);
        } catch (error) {
          rejected = error instanceof UploadError ? error : new UploadError(400, String(error));
          stream.resume();
          return;
        }
        temporary = join(directory, `.upload-${process.pid}-${randomUUID()}`);
        const destination = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
        let limited = false;
        stream.once("limit", () => { limited = true; });
        fileWrite = pipeline(stream, destination).then(async () => {
          const metadata = await lstat(temporary!);
          if (limited || stream.truncated || metadata.size > fileLimit) {
            throw new UploadError(413, `upload exceeds its ${fileLimit}-byte limit`);
          }
          const handle = await open(temporary!, "r");
          try { await handle.sync(); } finally { await handle.close(); }
        });
        fileWrite.catch(rejectPromise);
      });
      parser.once("close", () => resolvePromise());
    });
    request.pipe(parser);
    try {
      await parsed;
      if (fileWrite) await fileWrite;
      if (rejected) throw rejected;
      if (files !== 1 || !temporary || !suppliedFilename) throw new UploadError(400, "upload is missing the file field");
      const destination = await publish(directory, temporary, suppliedFilename);
      temporary = undefined;
      return {
        path: relative(canonicalRoot, destination).split("\\").join("/"),
        filename: basename(destination),
      };
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }
}
