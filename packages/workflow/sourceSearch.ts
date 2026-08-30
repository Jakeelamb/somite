export type SourceSearchRequest = Readonly<{
  kind: string;
  value: string;
  provider: string;
  result: string;
  action: string;
  operator_ids: readonly string[];
  sequence_type?: string;
}>;

export type SourceSearchResult = Readonly<{
  key: string;
  title: string;
  accession: string;
  description: string;
  provider: string;
  data_kind: string;
  tags: readonly string[];
  request: SourceSearchRequest;
}>;

export type SourceSearchResponse = Readonly<{
  query: string;
  provider: "ncbi" | "ensembl";
  results: readonly SourceSearchResult[];
}>;

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const ENSEMBL = "https://rest.ensembl.org";

type JsonRecord = Record<string, unknown>;

class HttpResponseError extends Error {
  readonly status: number;

  constructor(response: Response) {
    super(`${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    this.name = "HttpResponseError";
    this.status = response.status;
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function field(value: unknown, name: string) {
  return text(record(value)?.[name]);
}

function between(value: string, start: string, end: string) {
  const begin = value.indexOf(start);
  if (begin < 0) return undefined;
  const offset = begin + start.length;
  const finish = value.indexOf(end, offset);
  return finish < 0 ? undefined : value.slice(offset, finish);
}

function attribute(value: string, name: string) {
  const marker = `${name}="`;
  const begin = value.indexOf(marker);
  if (begin < 0) return undefined;
  const offset = begin + marker.length;
  const finish = value.indexOf('"', offset);
  return finish < 0 ? undefined : value.slice(offset, finish);
}

function attributeAfter(value: string, element: string, name: string) {
  const begin = value.indexOf(element);
  return begin < 0 ? undefined : attribute(value.slice(begin + element.length), name);
}

export function runAccessions(runXml: string) {
  const accessions: string[] = [];
  let offset = 0;
  while (true) {
    const run = runXml.indexOf("<Run ", offset);
    if (run < 0) break;
    const accession = attribute(runXml.slice(run + 5), "acc");
    if (accession) accessions.push(accession);
    offset = run + 5;
  }
  return accessions;
}

export function sraResults(value: unknown): SourceSearchResult[] {
  const runs = field(value, "runs");
  const experiment = field(value, "expxml");
  if (!runs || !experiment) return [];
  const title = between(experiment, "<Title>", "</Title>") ?? "Sequence Read Archive run";
  const organism = attributeAfter(experiment, "<Organism", "ScientificName") ?? "Unknown organism";
  const strategy = between(experiment, "<LIBRARY_STRATEGY>", "</LIBRARY_STRATEGY>") ?? "Sequencing";
  const paired = experiment.includes("<PAIRED");
  return runAccessions(runs).map((accession) => ({
    key: `ncbi-sra-${accession}`,
    title,
    accession,
    description: `${organism} · ${strategy}`,
    provider: "NCBI SRA",
    data_kind: "Reads",
    tags: [strategy, paired ? "Paired" : "Single"],
    request: {
      kind: "sra",
      value: accession,
      provider: "NCBI SRA",
      result: "SRA download → separate R1 / R2 FASTQ streams",
      action: "Add Reads",
      operator_ids: ["sra.prefetch", "sra.fasterq_dump"],
    },
  }));
}

function assemblyRequest(accession: string, provider: string): SourceSearchRequest {
  return {
    kind: "assembly",
    value: accession,
    provider,
    result: "Genome, annotations, proteins & metadata package",
    action: "Add Assembly",
    operator_ids: ["ncbi.datasets_assembly", "archive.unzip"],
  };
}

export function assemblyResult(value: unknown): SourceSearchResult | undefined {
  const accession = field(value, "assemblyaccession");
  if (!accession) return undefined;
  const assembly = field(value, "assemblyname") ?? accession;
  const organism = field(value, "organism") ?? "Genome assembly";
  const level = field(value, "assemblystatus") ?? "Assembly";
  return {
    key: `ncbi-assembly-${accession}`,
    title: `${organism} · ${assembly}`,
    accession,
    description: field(value, "assemblydescription") ?? level,
    provider: "NCBI Datasets",
    data_kind: "Reference",
    tags: ["Genome", level],
    request: assemblyRequest(accession, "NCBI Datasets"),
  };
}

export function ensemblGenomeResult(value: unknown): SourceSearchResult | undefined {
  const accession = field(value, "assembly_accession");
  const display = field(value, "display_name") ?? field(value, "scientific_name");
  if (!accession || !display) return undefined;
  const assembly = field(value, "assembly_name") ?? accession;
  const genebuild = field(value, "genebuild") ?? "Ensembl";
  return {
    key: `ensembl-genome-${accession}`,
    title: `${display} reference · ${assembly}`,
    accession,
    description: `Ensembl ${genebuild} reference assembly`,
    provider: "Ensembl",
    data_kind: "Reference",
    tags: ["Genome", genebuild],
    request: assemblyRequest(accession, "Ensembl → NCBI Datasets"),
  };
}

export function ensemblFeatureResult(value: unknown): SourceSearchResult | undefined {
  const accession = field(value, "id");
  if (!accession) return undefined;
  const objectType = field(value, "object_type") ?? "Gene";
  const title = field(value, "display_name") ?? accession;
  const description = field(value, "description") ?? `Ensembl ${objectType}`;
  const lower = objectType.toLowerCase();
  const [kind, sequenceType, dataKind] = lower.includes("transcript")
    ? ["ensembl-transcript", "cdna", "Transcript"]
    : lower.includes("translation") || lower.includes("protein")
      ? ["ensembl-protein", "protein", "Protein"]
      : ["ensembl-gene", "genomic", "Gene"];
  return {
    key: `ensembl-feature-${accession}`,
    title,
    accession,
    description,
    provider: "Ensembl",
    data_kind: dataKind,
    tags: [objectType],
    request: {
      kind,
      value: accession,
      provider: "Ensembl REST",
      result: `${dataKind} FASTA sequence`,
      action: "Add Sequence",
      operator_ids: ["ensembl.sequence"],
      sequence_type: sequenceType,
    },
  };
}

function ncbiSearchPlan(query: string) {
  const lower = query.toLowerCase();
  const assembly = ["assembly", "reference", "genome", "grch", "chm13", "gcf_", "gca_"].some((term) => lower.includes(term));
  const reads = ["reads", "fastq", "sra", "srr", "rna-seq", "wgs", "illumina", "nanopore"].some((term) => lower.includes(term));
  return reads && !assembly ? "reads" : assembly && !reads ? "assemblies" : "both";
}

function assemblySubject(query: string) {
  const lower = query.toLowerCase();
  if (lower.includes("homo sapiens") || lower.split(/\s+/).includes("human")) return "Homo sapiens";
  const generic = new Set(["latest", "current", "reference", "genome", "assembly", "assemblies", "ncbi", "datasets", "the"]);
  const subject = query.split(/\s+/).filter((word) => !generic.has(word.replace(/[^A-Za-z0-9]/g, "").toLowerCase())).join(" ");
  return subject || query.trim();
}

function ncbiTerm(query: string) {
  const lower = query.toLowerCase();
  const assayWords = ["rna", "seq", "wgs", "liver", "cancer", "tumor", "illumina", "nanopore", "chip", "atac", "single cell"];
  return /^[\p{L}\s-]+$/u.test(query) && !assayWords.some((word) => lower.includes(word)) ? `${query}[Organism]` : query;
}

function collectionQuery(query: string) {
  return query.toUpperCase().split(/[^A-Z0-9]+/).some((token) =>
    /^(?:SRP|ERP|DRP|SRX|ERX|DRX|SRS|ERS|DRS)\d{6,}$/.test(token)
      || /^(?:PRJNA|PRJEB|PRJDB)\d{6,}$/.test(token));
}

function geneQuery(query: string): readonly [string, string] | undefined {
  const parts = query.trim().split(/\s+/);
  const symbol = parts.at(-1);
  if (!symbol || !/[A-Z0-9]/.test(symbol)) return undefined;
  return [parts.length === 1 ? "human" : parts.slice(0, -1).join("_"), symbol.toUpperCase()];
}

async function fetchJson(fetcher: typeof fetch, url: URL, signal?: AbortSignal) {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new HttpResponseError(response);
  return response.json() as Promise<unknown>;
}

function isNotFound(error: unknown) {
  return error instanceof HttpResponseError && error.status === 404;
}

async function esearch(fetcher: typeof fetch, database: string, term: string, limit: number, signal?: AbortSignal) {
  const url = new URL(`${EUTILS}/esearch.fcgi`);
  url.search = new URLSearchParams({ db: database, retmode: "json", retmax: String(limit), tool: "somite", term }).toString();
  const result = record(await fetchJson(fetcher, url, signal));
  const search = record(result?.esearchresult);
  return Array.isArray(search?.idlist) ? search.idlist.filter((id): id is string => typeof id === "string") : [];
}

async function esummary(fetcher: typeof fetch, database: string, ids: readonly string[], signal?: AbortSignal) {
  if (!ids.length) return {};
  const url = new URL(`${EUTILS}/esummary.fcgi`);
  url.search = new URLSearchParams({ db: database, retmode: "json", tool: "somite", id: ids.join(",") }).toString();
  return record(record(await fetchJson(fetcher, url, signal))?.result) ?? {};
}

async function searchSra(fetcher: typeof fetch, query: string, signal?: AbortSignal) {
  const collection = collectionQuery(query);
  const ids = await esearch(fetcher, "sra", ncbiTerm(query), collection ? 16 : 4, signal);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 360));
  const summary = await esummary(fetcher, "sra", ids, signal);
  const results = ids.flatMap((id) => sraResults(summary[id]));
  results.sort((left, right) => Number(!left.accession.toLowerCase().includes(query.toLowerCase())) - Number(!right.accession.toLowerCase().includes(query.toLowerCase())));
  return results.slice(0, collection ? 24 : 8);
}

async function searchAssemblies(fetcher: typeof fetch, query: string, signal?: AbortSignal) {
  const term = `${ncbiTerm(assemblySubject(query))} AND "reference genome"[RefSeq Category]`;
  const ids = await esearch(fetcher, "assembly", term, 3, signal);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 360));
  const summary = await esummary(fetcher, "assembly", ids, signal);
  return ids.map((id) => assemblyResult(summary[id])).filter((result): result is SourceSearchResult => result !== undefined);
}

export async function searchNcbi(query: string, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const plan = ncbiSearchPlan(query);
  if (plan === "reads") return searchSra(fetcher, query, signal);
  if (plan === "assemblies") return searchAssemblies(fetcher, query, signal);
  const reads = await searchSra(fetcher, query, signal);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 360));
  return [...reads, ...await searchAssemblies(fetcher, query, signal)];
}

export async function searchEnsembl(query: string, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const gene = geneQuery(query);
  if (gene) {
    const url = new URL(`${ENSEMBL}/lookup/symbol/${encodeURIComponent(gene[0])}/${encodeURIComponent(gene[1])}`);
    url.searchParams.set("content-type", "application/json");
    try {
      const result = ensemblFeatureResult(await fetchJson(fetcher, url, signal));
      if (!result) throw new Error("malformed Ensembl gene lookup response");
      return [result];
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }
  const url = new URL(`${ENSEMBL}/info/genomes/taxonomy/${encodeURIComponent(query)}`);
  url.searchParams.set("content-type", "application/json");
  try {
    const values = await fetchJson(fetcher, url, signal);
    if (!Array.isArray(values)) throw new Error("malformed Ensembl genome lookup response");
    const results: SourceSearchResult[] = [];
    for (const value of values) {
      const result = ensemblGenomeResult(value);
      if (!result) throw new Error("malformed Ensembl genome lookup response");
      results.push(result);
    }
    return results.slice(0, 3);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

export async function searchSources(provider: "ncbi" | "ensembl", query: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<SourceSearchResponse> {
  return {
    query,
    provider,
    results: provider === "ncbi" ? await searchNcbi(query, fetcher, signal) : await searchEnsembl(query, fetcher, signal),
  };
}
