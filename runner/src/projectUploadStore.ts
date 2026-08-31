import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { MAX_SOURCE_BYTES, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_FILES } from "@somite/workflow/nextflowSource";
import { ensurePrivateDirectory } from "./files.ts";
import type { ProjectGateway } from "./projectGateway.ts";
import { UploadError } from "./uploadStore.ts";

const MAX_PROJECT_PATH_BYTES = 4096;

export function safeProjectUploadPath(value: string) {
  if (!value || value.includes("\\") || Buffer.byteLength(value, "utf8") > MAX_PROJECT_PATH_BYTES
    || [...value].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) {
    throw new UploadError(400, "project upload path is invalid");
  }
  const parts = value.split("/");
  if (parts.length < 2 || parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255)) {
    throw new UploadError(400, "project uploads must retain one safe root directory");
  }
  return parts;
}

function browserExecutable(parts: readonly string[]) {
  const name = parts.at(-1) ?? "";
  return !extname(name) && parts.some((part) => part === "bin" || part === "scripts");
}

/** Streams one browser-selected Nextflow directory into a temporary project and invokes the production importer. */
export class ProjectUploadStore {
  readonly #root: string;
  readonly #projects: Pick<ProjectGateway, "openUploaded">;
  #queue = Promise.resolve();

  constructor(root: string, projects: Pick<ProjectGateway, "openUploaded">) {
    this.#root = resolve(root);
    this.#projects = projects;
  }

  receive(request: IncomingMessage) {
    const operation = this.#queue.then(() => this.#receive(request));
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #receive(request: IncomingMessage) {
    const canonicalRoot = await realpath(this.#root);
    const imports = await ensurePrivateDirectory(canonicalRoot, ".somite/project-imports").catch((error) => {
      throw new UploadError(422, error instanceof Error ? error.message : String(error));
    });
    const temporary = await mkdtemp(join(imports, ".upload-"));
    const roots = new Set<string>();
    const paths = new Set<string>();
    const writes: Promise<void>[] = [];
    let fileCount = 0;
    let totalBytes = 0;
    let rejected: UploadError | undefined;
    const parser = (() => {
      try {
        return Busboy({
          headers: request.headers,
          preservePath: true,
          limits: {
            fileSize: MAX_SOURCE_FILE_BYTES + 1,
            files: MAX_SOURCE_FILES + 1,
            fields: 1,
            parts: MAX_SOURCE_FILES + 2,
            headerPairs: 100,
          },
        });
      } catch (error) {
        throw new UploadError(400, error instanceof Error ? error.message : String(error));
      }
    })();
    const parsed = new Promise<void>((resolvePromise, rejectPromise) => {
      parser.once("error", (error: Error) => rejectPromise(new UploadError(400, error.message)));
      parser.once("filesLimit", () => { rejected = new UploadError(413, `project upload exceeds ${MAX_SOURCE_FILES} files`); });
      parser.once("fieldsLimit", () => { rejected = new UploadError(400, "project upload may not contain form fields"); });
      parser.once("partsLimit", () => { rejected = new UploadError(413, `project upload exceeds ${MAX_SOURCE_FILES} files`); });
      parser.on("field", () => { rejected = new UploadError(400, "project upload may not contain form fields"); });
      parser.on("file", (field, stream, information) => {
        fileCount += 1;
        if (field !== "file") {
          rejected = new UploadError(400, "project upload fields must be named file");
          stream.resume();
          return;
        }
        let parts: string[];
        try {
          parts = safeProjectUploadPath(information.filename);
          if (paths.has(parts.join("/"))) throw new UploadError(400, `project upload repeats ${parts.join("/")}`);
          paths.add(parts.join("/"));
          roots.add(parts[0]!);
        } catch (error) {
          rejected = error instanceof UploadError ? error : new UploadError(400, String(error));
          stream.resume();
          return;
        }
        const destination = join(temporary, ...parts);
        const write = (async () => {
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          let fileBytes = 0;
          let limited = false;
          stream.once("limit", () => { limited = true; });
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              fileBytes += chunk.byteLength;
              totalBytes += chunk.byteLength;
              if (totalBytes > MAX_SOURCE_BYTES) callback(new UploadError(413, `project upload exceeds ${MAX_SOURCE_BYTES} bytes`));
              else callback(null, chunk);
            },
          });
          await pipeline(stream, counter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
          if (limited || stream.truncated || fileBytes > MAX_SOURCE_FILE_BYTES) {
            throw new UploadError(413, `project file ${parts.join("/")} exceeds ${MAX_SOURCE_FILE_BYTES} bytes`);
          }
          if (browserExecutable(parts)) await chmod(destination, 0o700);
          const handle = await open(destination, "r");
          try { await handle.sync(); } finally { await handle.close(); }
        })();
        writes.push(write);
      });
      parser.once("close", resolvePromise);
    });
    request.pipe(parser);
    try {
      await parsed;
      await Promise.all(writes);
      if (rejected) throw rejected;
      if (!fileCount) throw new UploadError(400, "project upload contains no files");
      if (roots.size !== 1) throw new UploadError(400, "project upload must contain exactly one root directory");
      const projectName = [...roots][0]!;
      const project = join(temporary, projectName);
      const metadata = await lstat(project).catch(() => undefined);
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new UploadError(400, "project upload root is invalid");
      const entrypoint = await lstat(join(project, "main.nf")).catch(() => undefined);
      if (!entrypoint?.isFile() || entrypoint.isSymbolicLink()) {
        throw new UploadError(422, "dropped workflow directory must contain a regular main.nf entrypoint");
      }
      return await this.#projects.openUploaded(project, projectName);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
