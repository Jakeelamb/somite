import { searchSources, type SourceSearchResponse } from "@somite/workflow/sourceSearch";

export type SourceProvider = "ncbi" | "ensembl";

type CacheEntry = {
  expiresAt: number;
  response: Promise<SourceSearchResponse>;
};

export class SourceSearchGateway {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #fetcher: typeof fetch;
  readonly #ttlMs: number;
  readonly #maximumEntries: number;

  constructor(options: {
    fetcher?: typeof fetch;
    ttlMs?: number;
    maximumEntries?: number;
  } = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#maximumEntries = options.maximumEntries ?? 128;
  }

  search(provider: SourceProvider, query: string) {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.length < 2) throw new Error("search query must contain at least two characters");
    if (normalized.length > 200) throw new Error("search query must not exceed 200 characters");
    const key = `${provider}\u0000${normalized.toLocaleLowerCase("en-US")}`;
    const now = Date.now();
    const cached = this.#entries.get(key);
    if (cached && cached.expiresAt > now) return cached.response;
    if (cached) this.#entries.delete(key);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("public data search timed out")), 15_000);
    const response = searchSources(provider, normalized, this.#fetcher, controller.signal)
      .finally(() => clearTimeout(timeout));
    this.#entries.set(key, { expiresAt: now + this.#ttlMs, response });
    void response.catch(() => {
      if (this.#entries.get(key)?.response === response) this.#entries.delete(key);
    });
    this.#evictExpiredAndOldest(now);
    return response;
  }

  #evictExpiredAndOldest(now: number) {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    while (this.#entries.size > this.#maximumEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
