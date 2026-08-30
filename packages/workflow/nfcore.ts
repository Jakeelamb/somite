import type { Operator, PinnedOperator } from "./catalog.ts";
import { operatorRevision } from "./catalogCodec.ts";

export const NFCORE_CATALOG_URL = "https://nf-co.re/pipelines.json";

export type NfcorePipeline = Readonly<{
  name: string;
  description: string;
  topics: readonly string[];
  revision: string;
  resolvedRevision: string;
}>;

export type NfcoreCatalogResponse = Readonly<{
  entries: readonly Readonly<{
    operator: PinnedOperator;
    description: string;
    topics: readonly string[];
    revision: string;
  }>[];
  cached: boolean;
}>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseNfcoreCatalog(value: string | unknown): NfcorePipeline[] {
  const root = object(typeof value === "string" ? JSON.parse(value) : value);
  if (!Array.isArray(root?.remote_workflows)) throw new Error("nf-core catalog has no remote_workflows array");
  const pipelines = root.remote_workflows.flatMap((candidate): NfcorePipeline[] => {
    const workflow = object(candidate);
    if (!workflow || workflow.archived === true) return [];
    const name = string(workflow.name);
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return [];
    const releases = Array.isArray(workflow.releases) ? workflow.releases.map(object).filter((release): release is Record<string, unknown> => Boolean(release)) : [];
    const release = releases.find((item) => string(item.tag_name) !== "dev" && string(item.tag_name) && /^[A-Za-z0-9._-]+$/.test(string(item.tag_name)!));
    const revision = string(release?.tag_name);
    const resolvedRevision = string(release?.tag_sha);
    if (!revision || !resolvedRevision || !/^[0-9a-f]{40}$/.test(resolvedRevision)) return [];
    return [{
      name,
      description: string(workflow.description) ?? "",
      topics: strings(workflow.topics),
      revision,
      resolvedRevision,
    }];
  });
  pipelines.sort((left, right) => left.name.localeCompare(right.name));
  return pipelines;
}

export function nfcoreOperator(pipeline: NfcorePipeline): PinnedOperator {
  const operator: Operator = {
    id: `nf.${pipeline.name}`,
    title: `nf-core/${pipeline.name}`,
    palette: ["nf-core", "Catalog"],
    kind: "external",
    cost: "high",
    bin: "nextflow",
    pixi: ["bioconda::nextflow"],
    params: {
      revision: { type: "string", label: "Version", page: "Pipeline", default: pipeline.revision, required: true },
    },
    ports: {
      in: [{ name: "sheet", type: "Table", optional: true }],
      out: [{ name: "results", type: "Directory", optional: true }],
    },
    argv: ["nextflow", "run", `nf-core/${pipeline.name}`, "-r", "{param.revision}", "--input", "{input.sheet}", "--outdir", "{work}/out"],
    outputs: { results: { glob: "{work}/out", type: "Directory", optional: true } },
  };
  return { ...operator, revision: operatorRevision(operator) };
}

export function nfcoreCatalogResponse(pipelines: readonly NfcorePipeline[], cached: boolean): NfcoreCatalogResponse {
  return {
    entries: pipelines.map((pipeline) => ({
      operator: nfcoreOperator(pipeline),
      description: pipeline.description,
      topics: pipeline.topics,
      revision: pipeline.revision,
    })),
    cached,
  };
}

export function searchNfcoreCatalog(pipelines: readonly NfcorePipeline[], query: string, limit = 12) {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 120 || [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) {
    throw new Error("nf-core query must contain 1 to 120 printable characters");
  }
  const terms = normalized.toLocaleLowerCase("en-US").split(" ");
  const matches = pipelines.filter((pipeline) => {
    const haystack = `${pipeline.name} ${pipeline.description} ${pipeline.topics.join(" ")}`.toLocaleLowerCase("en-US");
    return terms.every((term) => haystack.includes(term));
  });
  return {
    query: normalized,
    provenance: NFCORE_CATALOG_URL,
    total_matches: matches.length,
    entries: matches.slice(0, Math.max(1, Math.min(50, limit))).map((pipeline) => ({
      repository: `nf-core/${pipeline.name}`,
      title: `nf-core/${pipeline.name}`,
      description: pipeline.description,
      topics: pipeline.topics,
      revision: pipeline.revision,
    })),
  };
}
