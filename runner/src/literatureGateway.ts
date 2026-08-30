import { join } from "node:path";

import { boundedResponseBytes } from "@somite/workflow/boundedResponse";
import { atomicWrite, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";

const EUROPE_PMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type PaperSearchResult = Readonly<{
  id: string;
  doi: string;
  title: string;
  authors: string;
  date: string;
  abstract_text: string;
  url: string;
  full_text_available: boolean;
}>;

type SearchCache = { expiresAt: number; response: Promise<{ query: string; results: PaperSearchResult[] }> };

function inline(value: unknown) {
  return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
}

function validQuery(query: string) {
  const value = query.trim();
  return value.length >= 2 && value.length <= 160 && /[\p{L}\p{N}]/u.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function paperId(value: string) {
  if (!/^PPR\d+$/.test(value)) throw new Error("invalid bioRxiv paper identifier");
  return value;
}

function searchExpression(query: string) {
  const value = query.trim().replace(/^https:\/\/doi\.org\//i, "");
  const subject = value.startsWith("10.")
    ? `DOI:\"${value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"")}\"`
    : `(${value.replace(/[^\p{L}\p{N}\s._-]/gu, " ").replace(/\s+/g, " ").trim()})`;
  return `${subject} AND SRC:PPR AND PUBLISHER:\"bioRxiv\"`;
}

async function bounded(fetcher: typeof fetch, url: URL | string, maximumBytes: number, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("literature request timed out")), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, headers: { accept: "application/json, application/xml;q=0.9, text/xml;q=0.8", "user-agent": "Somite/0.1 paper reconstruction" } });
    if (!response.ok) throw new Error(`literature service returned ${response.status} ${response.statusText}`);
    const bytes = await boundedResponseBytes(response, maximumBytes, "Literature response");
    return decoder.decode(bytes);
  } finally {
    clearTimeout(timeout);
  }
}

function records(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("literature service returned invalid JSON");
  const resultList = (value as Record<string, unknown>).resultList;
  if (!resultList || typeof resultList !== "object" || Array.isArray(resultList)) return [];
  const result = (resultList as Record<string, unknown>).result;
  return Array.isArray(result) ? result.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function jatsText(xml: string) {
  const lower = xml.toLocaleLowerCase("en-US");
  if (!lower.includes("<article")) throw new Error("full text is not available for this paper");
  if (!lower.includes(">biorxiv</journal-id>") && !lower.includes(">biorxiv : the preprint server for biology</journal-title>")) {
    throw new Error("the selected record is not a bioRxiv paper");
  }
  const text = decodeXml(xml
    .replace(/<\/?(?:article-title|title|sec|p|abstract|kwd-group|list-item|caption|table-wrap|fig|ref-list)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < 200) throw new Error("full text is not available for this paper");
  return text;
}

export class LiteratureGateway {
  readonly #root: string;
  readonly #fetcher: typeof fetch;
  readonly #searches = new Map<string, SearchCache>();

  constructor(root: string, fetcher: typeof fetch = fetch) {
    this.#root = root;
    this.#fetcher = fetcher;
  }

  search(query: string) {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (!validQuery(normalized)) throw new Error("bioRxiv search query must contain 2 to 160 readable characters");
    const key = normalized.toLocaleLowerCase("en-US");
    const current = this.#searches.get(key);
    if (current && current.expiresAt > Date.now()) return current.response;
    const response = this.#search(normalized);
    this.#searches.set(key, { expiresAt: Date.now() + 5 * 60_000, response });
    void response.catch(() => {
      if (this.#searches.get(key)?.response === response) this.#searches.delete(key);
    });
    while (this.#searches.size > 64) this.#searches.delete(this.#searches.keys().next().value!);
    return response;
  }

  async #search(query: string) {
    const url = new URL(`${EUROPE_PMC}/search`);
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
    url.searchParams.set("pageSize", "12");
    url.searchParams.set("query", searchExpression(query));
    const raw = await bounded(this.#fetcher, url, MAX_SEARCH_BYTES, 10_000);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("literature service returned invalid search JSON");
    }
    const results = records(parsed).flatMap((record): PaperSearchResult[] => {
      const id = inline(record.id);
      const doi = inline(record.doi);
      if (!/^PPR\d+$/.test(id) || !doi) return [];
      const fullText = record.inEPMC === "Y"
        || Boolean(record.fullTextIdList && typeof record.fullTextIdList === "object" && Array.isArray((record.fullTextIdList as Record<string, unknown>).fullTextId) && ((record.fullTextIdList as Record<string, unknown>).fullTextId as unknown[]).length > 0);
      return [{
        id,
        doi,
        title: inline(record.title),
        authors: inline(record.authorString),
        date: inline(record.firstPublicationDate) || inline(record.pubYear),
        abstract_text: inline(record.abstractText),
        url: `https://www.biorxiv.org/content/${doi}`,
        full_text_available: fullText,
      }];
    });
    return { query, results };
  }

  async fullText(id: string) {
    const validated = paperId(id);
    const cache = await ensurePrivateDirectory(this.#root, ".somite/papers/biorxiv");
    const path = join(cache, `${validated}.xml`);
    if (await pathExists(path)) {
      try {
        return jatsText(new TextDecoder().decode(await regularFile(path, MAX_ARTICLE_BYTES, "cached bioRxiv article")));
      } catch {
        // Re-fetch a generated cache entry that no longer validates.
      }
    }
    const xml = await bounded(this.#fetcher, `${EUROPE_PMC}/${validated}/fullTextXML`, MAX_ARTICLE_BYTES, 18_000);
    const text = jatsText(xml);
    await atomicWrite(path, xml);
    return text;
  }
}
