import { byteDigest } from "@somite/workflow/contentIdentity";
import { boundedResponseBytes } from "@somite/workflow/boundedResponse";
import type { OperatorCatalog } from "@somite/workflow/catalog";
import type { SourceCapabilities, SourceDiagnostic, SourceWorkflowInstance } from "@somite/workflow/model";
import { reconstructPaper, type PaperReview } from "@somite/workflow/paper";
import { projectSourceCanvas } from "@somite/workflow/sourceCanvas";
import { articleJatsText } from "./literatureGateway.ts";

const DIGEST = /^blake3:[0-9a-f]{64}$/;
const EUROPE_PMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 24 * 1024 * 1024;

export type ChallengeKind = "paper" | "workflow";
export type ChallengeQuality = Readonly<{ result: "passed" | "attention" | "failed"; issues: readonly string[] }>;

export class NoUnseenChallengeError extends Error {
  readonly code = "no_unseen_challenge";

  constructor(message: string) {
    super(message);
    this.name = "NoUnseenChallengeError";
  }
}

export type ChallengeLedgerEntry = Readonly<{
  kind: ChallengeKind;
  source_key: string;
  content_digest: string;
  tested_at: string;
}>;

export type ChallengeLedger = Readonly<{
  schema_version: 1;
  entries: readonly ChallengeLedgerEntry[];
}>;

export type PaperChallengeReport = Readonly<{
  schema_version: 1;
  kind: "paper";
  source_key: string;
  source: Readonly<{
    provider: "europe_pmc";
    id: string;
    title: string;
    url: string;
  }>;
  content_digest: string;
  retrieved_at: string;
  quality: ChallengeQuality;
  reconstruction: Readonly<{
    status: "candidate_built" | "source_workflow_found" | "evidence_only" | "no_methods";
    outcome: PaperReview["outcome"];
    candidate_count: number;
    assays: readonly string[];
    operators: readonly string[];
    unsupported: readonly string[];
    mentions: readonly Readonly<{ name: string; support: "operator" | "unsupported"; executable?: boolean; operator_id?: string }>[];
    workflow_sources: readonly Readonly<{ provider: "github"; repository: string; source_location?: string }>[];
    gaps: readonly string[];
    evidence_only_methods: readonly string[];
    omitted_methods: readonly string[];
    required_actions: number;
    unresolved_method_inputs: readonly string[];
    warnings: readonly string[];
  }>;
}>;

export type WorkflowChallengeReport = Readonly<{
  schema_version: 1;
  kind: "workflow";
  source_key: string;
  source: SourceWorkflowInstance["source"];
  content_digest: string;
  retrieved_at: string;
  quality: ChallengeQuality;
  status: "executable" | "inspectable_only";
  index: Readonly<{ scopes: number; invocations: number }>;
  semantic_projection:
    | Readonly<{
      result: "passed";
      indexed_invocations: number;
      projected_entities: number;
      projected_relations: number;
    }>
    | Readonly<{
      result: "failed";
      indexed_invocations: number;
      projected_entities: number;
      projected_relations: number;
      error: string;
    }>;
  timings_ms: Readonly<{
    catalog_discovery: number;
    source_import: number;
    semantic_projection: number;
    total: number;
  }>;
  capabilities: SourceCapabilities;
  blockers: readonly string[];
  diagnostics: readonly SourceDiagnostic[];
}>;

export type ChallengeReport = PaperChallengeReport | WorkflowChallengeReport;

type ContentCandidate = Readonly<{
  source_key: string;
  content?: Uint8Array;
  content_digest?: string;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown, label: string) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function nonblank(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-blank string`);
  return value;
}

function contentDigest(value: unknown, label: string) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} must be a BLAKE3 digest`);
  return value;
}

export function challengeContentDigest(content: Uint8Array) {
  return byteDigest(content);
}

export function decodeChallengeLedger(value?: string | unknown): ChallengeLedger {
  if (value === undefined || value === "") return { schema_version: 1, entries: [] };
  const root = record(typeof value === "string" ? JSON.parse(value) : value);
  if (root?.schema_version !== 1 || !Array.isArray(root.entries)) throw new Error("challenge ledger is not schema version 1");
  const entries = root.entries.map((candidate, index): ChallengeLedgerEntry => {
    const entry = record(candidate);
    if (!entry) throw new Error(`challenge ledger entry ${index} must be an object`);
    const kind = entry?.kind;
    if (kind !== "paper" && kind !== "workflow") throw new Error(`challenge ledger entry ${index} has an invalid kind`);
    return {
      kind,
      source_key: nonblank(entry.source_key, `challenge ledger entry ${index} source_key`),
      content_digest: contentDigest(entry.content_digest, `challenge ledger entry ${index} content_digest`),
      tested_at: timestamp(entry.tested_at, `challenge ledger entry ${index} tested_at`),
    };
  });
  return { schema_version: 1, entries };
}

export function selectUnseenContent<T extends ContentCandidate>(candidates: readonly T[], ledger: ChallengeLedger) {
  const seenSources = new Set(ledger.entries.map((entry) => entry.source_key));
  const seenDigests = new Set(ledger.entries.map((entry) => entry.content_digest));
  for (const candidate of candidates) {
    const digest = candidate.content_digest ?? (candidate.content ? challengeContentDigest(candidate.content) : undefined);
    if (!digest) throw new Error(`challenge candidate ${candidate.source_key} has no content identity`);
    contentDigest(digest, `challenge candidate ${candidate.source_key} content_digest`);
    if (!seenSources.has(candidate.source_key) && !seenDigests.has(digest)) return { ...candidate, content_digest: digest };
  }
  return undefined;
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

function canonicalMethodName(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "").toLocaleLowerCase("en-US");
}

export function createPaperChallengeReport(input: Readonly<{
  source: PaperChallengeReport["source"];
  content: Uint8Array;
  retrieved_at: string;
  review: PaperReview;
}>): PaperChallengeReport {
  const sourceKey = `europe-pmc:${input.source.id}`;
  const status = input.review.candidates.length
    ? "candidate_built" as const
    : input.review.workflow_sources?.length
      ? "source_workflow_found" as const
    : input.review.mentions.length
      ? "evidence_only" as const
      : "no_methods" as const;
  const gapNodes = input.review.candidates.flatMap((candidate) => candidate.graph.nodes
    .filter((node) => node.operator === "gap.missing"));
  const gaps = unique(gapNodes
    .filter((node) => node.ports.some((port) => port.dir === "in") && node.ports.some((port) => port.dir === "out"))
    .map((node) => typeof node.params?.tool === "string" && node.params.tool.trim()
      ? node.params.tool
      : "Unresolved method adapter"));
  const representedMethods = new Set(gapNodes
    .map((node) => typeof node.params?.tool === "string" ? node.params.tool : "")
    .filter(Boolean)
    .map(canonicalMethodName));
  const evidenceOnlyRepresentedMethods = new Set(gapNodes
    .filter((node) => node.ports.length === 0 && typeof node.params?.tool === "string")
    .map((node) => canonicalMethodName(String(node.params!.tool))));
  const evidenceOnlyMethods = unique(input.review.mentions
    .filter((mention) => mention.support === "unsupported"
      && mention.executable !== false
      && evidenceOnlyRepresentedMethods.has(canonicalMethodName(mention.normalized_name)))
    .map((mention) => mention.normalized_name));
  const requiredActions = input.review.candidates.reduce((total, candidate) => total + candidate.assessment.required_count, 0);
  const unresolvedMethodInputs = unique(input.review.candidates.flatMap((candidate) => candidate.assessment.items
    .filter((item) => item.kind === "input")
    .map((item) => `${candidate.assay}:${item.node_id}.${item.field}`)));
  const omittedMethods = unique(input.review.mentions
    .filter((mention) => mention.support === "unsupported"
      && mention.executable !== false
      && !representedMethods.has(canonicalMethodName(mention.normalized_name)))
    .map((mention) => mention.normalized_name));
  const qualityIssues = [
    ...(status === "source_workflow_found" ? ["The paper cites a workflow repository; its frozen source must be imported and assessed separately."] : []),
    ...(status === "evidence_only" ? ["Method evidence was retained, but no typed visual draft was built."] : []),
    ...(gaps.length ? [`The visual draft still needs ${gaps.length} reviewed tool adapter${gaps.length === 1 ? "" : "s"}.`] : []),
    ...(evidenceOnlyMethods.length ? [`The visual draft retains ${evidenceOnlyMethods.length} executable paper method${evidenceOnlyMethods.length === 1 ? "" : "s"} as untyped evidence: ${evidenceOnlyMethods.join(", ")}.`] : []),
    ...(status === "candidate_built" && omittedMethods.length ? [`The visual draft omits ${omittedMethods.length} executable paper method${omittedMethods.length === 1 ? "" : "s"}: ${omittedMethods.join(", ")}.`] : []),
    ...(unresolvedMethodInputs.length ? [`The visual draft has ${unresolvedMethodInputs.length} unconnected required method input${unresolvedMethodInputs.length === 1 ? "" : "s"}.`] : []),
  ];
  const quality: ChallengeQuality = status === "no_methods"
    ? { result: "failed", issues: ["A full-text article with a Methods section produced no computational-method evidence."] }
    : qualityIssues.length
      ? { result: "attention", issues: qualityIssues }
      : { result: "passed", issues: [] };
  return {
    schema_version: 1,
    kind: "paper",
    source_key: sourceKey,
    source: input.source,
    content_digest: challengeContentDigest(input.content),
    retrieved_at: timestamp(input.retrieved_at, "paper challenge retrieved_at"),
    quality,
    reconstruction: {
      status,
      outcome: input.review.outcome,
      candidate_count: input.review.candidates.length,
      assays: unique(input.review.candidates.map((candidate) => candidate.assay)),
      operators: unique(input.review.candidates.flatMap((candidate) => candidate.graph.nodes
        .map((node) => node.operator)
        .filter((operator) => operator !== "gap.missing"))),
      unsupported: unique(input.review.mentions
        .filter((mention) => mention.support === "unsupported")
        .map((mention) => mention.normalized_name)),
      mentions: input.review.mentions.map((mention) => ({
        name: mention.normalized_name,
        support: mention.support,
        ...(mention.executable === undefined ? {} : { executable: mention.executable }),
        ...(mention.operator_id ? { operator_id: mention.operator_id } : {}),
      })),
      workflow_sources: (input.review.workflow_sources ?? []).map((source) => ({
        provider: source.provider,
        repository: source.repository,
        ...(source.source_location ? { source_location: source.source_location } : {}),
      })),
      gaps,
      evidence_only_methods: evidenceOnlyMethods,
      omitted_methods: omittedMethods,
      required_actions: requiredActions,
      unresolved_method_inputs: unresolvedMethodInputs,
      warnings: input.review.warnings,
    },
  };
}

export function createWorkflowChallengeReport(input: Readonly<{
  source_workflow: SourceWorkflowInstance;
  retrieved_at: string;
  clock?: () => number;
  timing?: Readonly<{
    started_at: number;
    catalog_discovery: number;
    source_import: number;
    semantic_projection_prior: number;
    projection_started_at: number;
  }>;
}>): WorkflowChallengeReport {
  const clock = input.clock ?? (() => performance.now());
  const projectionStarted = input.timing?.projection_started_at ?? clock();
  const workflow = input.source_workflow;
  const scopes = workflow.scopes?.length ?? 0;
  const invocations = workflow.invocations?.length ?? 0;
  const projected = projectSourceCanvas(workflow);
  const semanticProjection: WorkflowChallengeReport["semantic_projection"] = !projected.ok
    ? {
      result: "failed",
      indexed_invocations: invocations,
      projected_entities: 0,
      projected_relations: 0,
      error: `${projected.error.code}: ${projected.error.message}`,
    }
    : (() => {
      const indexedIds = new Set((workflow.invocations ?? []).map((invocation) => invocation.id));
      const projectedIds = new Set(projected.projection.entities.map((entity) => entity.invocation_id));
      const complete = invocations > 0
        && indexedIds.size === invocations
        && projectedIds.size === invocations
        && projected.projection.entities.length === invocations
        && [...indexedIds].every((id) => projectedIds.has(id));
      const counts = {
        indexed_invocations: invocations,
        projected_entities: projected.projection.entities.length,
        projected_relations: projected.projection.relations.length,
      };
      return complete
        ? { result: "passed" as const, ...counts }
        : {
          result: "failed" as const,
          ...counts,
          error: invocations === 0
            ? "semantic projection contains no indexed invocations"
            : "semantic projection does not represent every indexed invocation exactly once",
        };
    })();
  const indexIssues = scopes === 0 || invocations === 0
    ? [`Source indexing produced ${scopes} scopes and ${invocations} invocations.`]
    : [];
  const projectionIssues = semanticProjection.result === "failed"
    ? [`Semantic canvas projection failed: ${semanticProjection.error}.`]
    : [];
  const quality: ChallengeQuality = indexIssues.length || projectionIssues.length
    ? { result: "failed", issues: [...indexIssues, ...projectionIssues] }
    : !workflow.capabilities.exact_execution || !workflow.capabilities.channel_contracts
      ? { result: "attention", issues: ["Every indexed invocation reached the semantic canvas projection, but exact execution or typed channel proof remains unavailable."] }
      : { result: "passed", issues: [] };
  const projectionCompleted = clock();
  const elapsed = (start: number, end: number) => {
    const milliseconds = end - start;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("workflow challenge clock must be finite and monotonic");
    return Math.round(milliseconds * 1_000) / 1_000;
  };
  const timings = input.timing
    ? {
      catalog_discovery: input.timing.catalog_discovery,
      source_import: input.timing.source_import,
      semantic_projection: Math.round((input.timing.semantic_projection_prior
        + elapsed(projectionStarted, projectionCompleted)) * 1_000) / 1_000,
      total: elapsed(input.timing.started_at, projectionCompleted),
    }
    : {
      catalog_discovery: 0,
      source_import: 0,
      semantic_projection: elapsed(projectionStarted, projectionCompleted),
      total: elapsed(projectionStarted, projectionCompleted),
    };
  return {
    schema_version: 1,
    kind: "workflow",
    source_key: `nf-core:${workflow.source.repository}@${workflow.source.resolved_revision}`,
    source: workflow.source,
    content_digest: workflow.source.source_digest,
    retrieved_at: timestamp(input.retrieved_at, "workflow challenge retrieved_at"),
    quality,
    status: workflow.capabilities.exact_execution ? "executable" : "inspectable_only",
    index: { scopes, invocations },
    semantic_projection: semanticProjection,
    timings_ms: timings,
    capabilities: workflow.capabilities,
    blockers: [
      ...(!workflow.capabilities.exact_execution
        ? ["Exact source execution is not available because task environments are not frozen."]
        : []),
      ...(!workflow.capabilities.channel_contracts
        ? ["Typed Nextflow channel contracts are not proven."]
        : []),
    ],
    diagnostics: workflow.diagnostics ?? [],
  };
}

export function recordChallenge(ledger: ChallengeLedger, report: ChallengeReport): ChallengeLedger {
  const retained = ledger.entries.filter((entry) => entry.source_key !== report.source_key && entry.content_digest !== report.content_digest);
  return {
    schema_version: 1,
    entries: [...retained, {
      kind: report.kind,
      source_key: report.source_key,
      content_digest: report.content_digest,
      tested_at: report.retrieved_at,
    }],
  };
}

async function bounded(fetcher: typeof fetch, url: URL | string, maximumBytes: number, timeoutMs: number, accept: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("unseen challenge request timed out")), timeoutMs);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: { accept, "user-agent": "Somite/0.1 unseen compatibility challenge" },
    });
    if (!response.ok) throw new Error(`unseen challenge source returned ${response.status} ${response.statusText}`);
    return boundedResponseBytes(response, maximumBytes, "Unseen challenge response");
  } finally {
    clearTimeout(timeout);
  }
}

function searchRecords(value: unknown) {
  const root = record(value);
  const resultList = record(root?.resultList);
  if (!Array.isArray(resultList?.result)) throw new Error("Europe PMC challenge search returned invalid JSON");
  return resultList.result.flatMap((candidate): Array<{ id: string; title: string }> => {
    const item = record(candidate);
    const id = typeof item?.pmcid === "string" ? item.pmcid : "";
    if (!/^PMC\d+$/.test(id)) return [];
    const title = typeof item?.title === "string" ? item.title.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : id;
    const publicationTypes = record(item?.pubTypeList)?.pubType;
    const types = Array.isArray(publicationTypes)
      ? publicationTypes.filter((type): type is string => typeof type === "string").map((type) => type.toLocaleLowerCase("en-US"))
      : [];
    if (types.some((type) => type.includes("review") || type.includes("editorial") || type.includes("comment"))) return [];
    if (/\b(?:review|survey|perspective|commentary)\b/i.test(title)) return [];
    return [{ id, title: title || id }];
  });
}

function hasJatsMethodsSection(xml: string) {
  return /<sec\b[^>]*\bsec-type\s*=\s*["']methods?["']/i.test(xml)
    || /<title\b[^>]*>\s*(?:materials\s+(?:and|&amp;)\s+methods|methods?|methodology|experimental procedures)\b/i.test(xml);
}

export async function runUnseenPaperChallenge(input: Readonly<{
  catalog: OperatorCatalog;
  ledger: ChallengeLedger;
  fetcher?: typeof fetch;
  retrieved_at: string;
}>): Promise<PaperChallengeReport> {
  const fetcher = input.fetcher ?? fetch;
  const retrieved = new Date(timestamp(input.retrieved_at, "paper challenge retrieved_at"));
  const endYear = retrieved.getUTCFullYear();
  const startYear = endYear - 1;
  const query = [
    "OPEN_ACCESS:Y",
    "IN_EPMC:Y",
    `FIRST_PDATE:[${startYear}-01-01 TO ${endYear}-12-31]`,
    '("RNA-seq" OR "genome assembly" OR metagenomic OR "variant calling" OR "single-cell" OR sequencing)',
  ].join(" AND ");
  const url = new URL(`${EUROPE_PMC}/search`);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", "50");
  url.searchParams.set("query", query);
  const searchBytes = await bounded(fetcher, url, MAX_SEARCH_BYTES, 15_000, "application/json");
  let search: unknown;
  try {
    search = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(searchBytes));
  } catch {
    throw new Error("Europe PMC challenge search returned invalid JSON");
  }
  const seenSources = new Set(input.ledger.entries.map((entry) => entry.source_key));
  const seenDigests = new Set(input.ledger.entries.map((entry) => entry.content_digest));
  for (const paper of searchRecords(search)) {
    const sourceKey = `europe-pmc:${paper.id}`;
    if (seenSources.has(sourceKey)) continue;
    const content = await bounded(fetcher, `${EUROPE_PMC}/${paper.id}/fullTextXML`, MAX_ARTICLE_BYTES, 30_000, "application/xml, text/xml");
    if (seenDigests.has(challengeContentDigest(content))) continue;
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (!hasJatsMethodsSection(xml)) continue;
    const text = articleJatsText(xml);
    return createPaperChallengeReport({
      source: {
        provider: "europe_pmc",
        id: paper.id,
        title: paper.title,
        url: `https://europepmc.org/articles/${paper.id}`,
      },
      content,
      retrieved_at: input.retrieved_at,
      review: reconstructPaper(input.catalog, text, "jats"),
    });
  }
  throw new NoUnseenChallengeError("Europe PMC returned no paper content that is new to the challenge ledger");
}

type WorkflowChallengeGateway = Readonly<{
  catalog: () => Promise<Readonly<{ entries: readonly Readonly<{
    repository?: string;
    operator?: Readonly<{ title: string }>;
    revision: string;
  }>[] }>>;
  import: (repository: string, revision: string) => Promise<Readonly<{
    graph: Readonly<{ nodes: readonly Readonly<{ source_workflow?: SourceWorkflowInstance }>[] }>;
  }>>;
}>;

export async function runUnseenWorkflowChallenge(input: Readonly<{
  gateway: WorkflowChallengeGateway;
  ledger: ChallengeLedger;
  retrieved_at: string;
  clock?: () => number;
}>): Promise<WorkflowChallengeReport> {
  const clock = input.clock ?? (() => performance.now());
  const startedAt = clock();
  const discoveryStarted = clock();
  const discovery = await input.gateway.catalog();
  const discoveryCompleted = clock();
  const elapsed = (start: number, end: number) => {
    const milliseconds = end - start;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("workflow challenge clock must be finite and monotonic");
    return milliseconds;
  };
  const catalogDiscovery = elapsed(discoveryStarted, discoveryCompleted);
  let sourceImport = 0;
  let semanticProjection = 0;
  const seenSources = new Set(input.ledger.entries.map((entry) => entry.source_key));
  const seenDigests = new Set(input.ledger.entries.map((entry) => entry.content_digest));
  for (const entry of discovery.entries) {
    const repository = entry.repository ?? entry.operator?.title;
    if (!repository || !/^nf-core\/[A-Za-z0-9_-]+$/.test(repository)) continue;
    const importStarted = clock();
    const imported = await input.gateway.import(repository, entry.revision);
    const importCompleted = clock();
    sourceImport += elapsed(importStarted, importCompleted);
    const workflow = imported.graph.nodes.find((node) => node.source_workflow)?.source_workflow;
    if (!workflow) throw new Error(`${repository}@${entry.revision} import produced no source workflow`);
    const projectionStarted = clock();
    const report = createWorkflowChallengeReport({
      source_workflow: workflow,
      retrieved_at: input.retrieved_at,
      clock,
      timing: {
        started_at: startedAt,
        catalog_discovery: Math.round(catalogDiscovery * 1_000) / 1_000,
        source_import: Math.round(sourceImport * 1_000) / 1_000,
        semantic_projection_prior: semanticProjection,
        projection_started_at: projectionStarted,
      },
    });
    semanticProjection = report.timings_ms.semantic_projection;
    if (!seenSources.has(report.source_key) && !seenDigests.has(report.content_digest)) return report;
  }
  throw new NoUnseenChallengeError("nf-core returned no workflow source that is new to the challenge ledger");
}
