import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform as operatingSystem } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CORPUS_BYTES = 32 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 2_000;
const FETCH_TIMEOUT_MS = 30_000;
const SAFE_DOC_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_./-]+\.mdx?$/;

type GitHubTree = { tree?: Array<{ path?: string; type?: string }> };

function fetchSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedResponseText(response: Response, maximumBytes: number, label: string) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`${label} exceeds the response limit`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel(`${label} exceeds the response limit`);
        throw new Error(`${label} exceeds the response limit`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function documentationCacheRoot(environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.SOMITE_MCP_DOCS_CACHE_DIR;
  if (configured && isAbsolute(configured)) return configured;
  const home = homedir();
  if (operatingSystem() === "darwin") return join(home, "Library", "Caches", "Somite", "mcp-docs");
  if (operatingSystem() === "win32") {
    const local = environment.LOCALAPPDATA;
    return join(local && isAbsolute(local) ? local : join(home, "AppData", "Local"), "Somite", "mcp-docs");
  }
  const xdg = environment.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".cache"), "somite", "mcp-docs");
}

function validCatalog(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_CATALOG_ENTRIES
    && value.every((path) => typeof path === "string" && SAFE_DOC_PATH.test(path))
    && new Set(value).size === value.length;
}

export type DocumentationSource = {
  name: string;
  repository: string;
  branch: string;
  directory: string;
  website: string;
};

export class OfficialDocumentation {
  #catalog?: string[];
  #documents = new Map<string, string>();
  #corpus?: Promise<void>;
  readonly source: DocumentationSource;
  readonly #cacheDirectory: string;
  readonly #fetch: typeof fetch;

  constructor(source: DocumentationSource, cacheRoot = documentationCacheRoot(), fetcher: typeof fetch = globalThis.fetch) {
    this.source = source;
    this.#fetch = fetcher;
    const key = createHash("sha256").update(JSON.stringify({
      schema: 1,
      repository: source.repository,
      revision: source.branch,
      directory: source.directory,
    })).digest("hex");
    this.#cacheDirectory = join(cacheRoot, key);
  }

  async catalog(signal?: AbortSignal) {
    if (this.#catalog) return this.#catalog;
    const cached = await this.readCache("catalog.json", MAX_DOCUMENT_BYTES);
    if (cached) {
      try {
        const entries = JSON.parse(cached) as unknown;
        if (validCatalog(entries)) {
          this.#catalog = entries;
          return entries;
        }
      } catch {
        // A malformed public cache entry is ignored and replaced from upstream.
      }
    }
    const response = await this.#fetch(`https://api.github.com/repos/${this.source.repository}/git/trees/${encodeURIComponent(this.source.branch)}?recursive=1`, {
      signal: fetchSignal(signal),
      headers: { Accept: "application/vnd.github+json", "User-Agent": "somite-mcp" },
    });
    if (!response.ok) throw new Error(`${this.source.name} documentation catalog returned HTTP ${response.status}`);
    const body = JSON.parse(await boundedResponseText(response, MAX_CATALOG_BYTES, "documentation catalog")) as GitHubTree;
    const prefix = `${this.source.directory.replace(/\/$/, "")}/`;
    const entries = (body.tree ?? [])
      .filter((entry) => entry.type === "blob" && entry.path?.startsWith(prefix) && /\.mdx?$/.test(entry.path))
      .map((entry) => entry.path!.slice(prefix.length))
      .sort();
    if (!validCatalog(entries)) throw new Error(`${this.source.name} documentation catalog is invalid`);
    this.#catalog = entries;
    await this.writeCache("catalog.json", JSON.stringify(entries));
    return entries;
  }

  async search(query: string, limit: number, signal?: AbortSignal) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const entries = await this.catalog(signal);
    await this.loadCorpus(entries, signal);
    return entries
      .map((path) => {
        const normalizedPath = path.toLowerCase();
        const text = this.#documents.get(path) ?? "";
        const normalizedText = text.toLowerCase();
        const score = terms.reduce((total, term) => {
          const pathScore = normalizedPath.includes(term) ? 8 : 0;
          let contentScore = 0;
          let offset = 0;
          while (contentScore < 8 && (offset = normalizedText.indexOf(term, offset)) >= 0) {
            contentScore += 1;
            offset += term.length;
          }
          return total + pathScore + contentScore;
        }, 0);
        const first = terms.map((term) => normalizedText.indexOf(term)).filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? 0;
        const start = Math.max(0, first - 100);
        const snippet = text.slice(start, start + 320).replace(/\s+/g, " ").trim();
        return { path, score, snippet };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit)
      .map(({ path, snippet }) => ({ path, url: this.websiteUrl(path), snippet }));
  }

  async read(path: string, signal?: AbortSignal) {
    if (!SAFE_DOC_PATH.test(path)) throw new Error("documentation path must be a safe .md or .mdx path from the catalog");
    if (!(await this.catalog(signal)).includes(path)) throw new Error("documentation path is not in the official catalog");
    const cached = this.#documents.get(path);
    const text = cached ?? await this.fetchPage(path, signal);
    this.#documents.set(path, text);
    const sourcePath = `${this.source.directory.replace(/\/$/, "")}/${path}`;
    return {
      path,
      url: this.websiteUrl(path),
      source_revision: this.source.branch,
      source_url: `https://raw.githubusercontent.com/${this.source.repository}/${encodeURIComponent(this.source.branch)}/${sourcePath}`,
      text,
    };
  }

  private async fetchPage(path: string, signal?: AbortSignal) {
    const cachePath = join("pages", ...path.split("/"));
    const cached = await this.readCache(cachePath, MAX_DOCUMENT_BYTES);
    if (cached !== undefined) return cached;
    const sourcePath = `${this.source.directory.replace(/\/$/, "")}/${path}`;
    const response = await this.#fetch(`https://raw.githubusercontent.com/${this.source.repository}/${encodeURIComponent(this.source.branch)}/${sourcePath}`, {
      signal: fetchSignal(signal),
      headers: { "User-Agent": "somite-mcp" },
    });
    if (!response.ok) throw new Error(`${this.source.name} documentation returned HTTP ${response.status}`);
    const text = await boundedResponseText(response, MAX_DOCUMENT_BYTES, "documentation page");
    await this.writeCache(cachePath, text);
    return text;
  }

  private async readCache(path: string, maximumBytes: number) {
    try {
      const bytes = await readFile(join(this.#cacheDirectory, path));
      if (bytes.byteLength > maximumBytes) return undefined;
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }

  private async writeCache(path: string, text: string) {
    const destination = join(this.#cacheDirectory, path);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.partial`;
    try {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async loadCorpus(entries: string[], signal?: AbortSignal) {
    if (entries.every((path) => this.#documents.has(path))) return;
    if (!this.#corpus) {
      this.#corpus = (async () => {
        let cursor = 0;
        let totalBytes = 0;
        const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
          while (cursor < entries.length) {
            const path = entries[cursor++]!;
            if (this.#documents.has(path)) continue;
            const text = await this.fetchPage(path, signal);
            totalBytes += Buffer.byteLength(text, "utf8");
            if (totalBytes > MAX_CORPUS_BYTES) throw new Error(`${this.source.name} documentation corpus exceeds the search limit`);
            this.#documents.set(path, text);
          }
        });
        await Promise.all(workers);
      })().catch((cause) => {
        this.#corpus = undefined;
        throw cause;
      });
    }
    await this.#corpus;
  }

  websiteUrl(path: string) {
    const withoutExtension = path.replace(/(?:\/index)?\.mdx?$/, "");
    return new URL(`${withoutExtension}${withoutExtension ? "/" : ""}`, this.source.website).toString();
  }
}

export type DocumentationProvider = Pick<OfficialDocumentation, "source" | "catalog" | "search" | "read">;
