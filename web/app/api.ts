import { parsePinnedOperator } from "@somite/workflow/catalogCodec";
import { ResponseHeaderError, ResponseSizeError, boundedResponseBytes } from "@somite/workflow/boundedResponse";
import { parseGraph } from "@somite/workflow/graphCodec";
import type { EvidenceReceipt, EvidenceResult } from "@somite/workflow/linker";
import {
  MAX_AGENT_SNAPSHOT_BYTES,
  MAX_FROZEN_PACKAGE_BYTES,
  MAX_PAPER_REVIEW_BYTES,
  MAX_PAPER_STATUS_BYTES,
  MAX_WORKFLOW_DOCUMENT_BYTES,
} from "@somite/workflow/limits";
import type { PaperCandidate, PaperEvidence, PaperMethodMention, PaperResourceCitation, PaperReview, PaperWorkflowCitation } from "@somite/workflow/paper";
import type { SomiteGraph } from "@somite/workflow/model";

import type { GraphWritePath } from "./graphPersistence";
import type { PaperArtifact, PaperIntakeFailure } from "./paperIntake";
import type { SourceRequest, SourceSearchResponse, SourceSearchResult } from "./sourceBuilder";
import type {
  AgentConfigOption,
  AgentDiscovery,
  AgentEvent,
  AgentSnapshot,
  ExportPlan,
  GraphWriteResponse,
  NfcoreCatalog,
  ManagedResourceJob,
  ManagedResourceAvailability,
  OperatorCandidate,
  PaperExtractionPreflight,
  PaperResourceResolution,
  PaperSearchResponse,
  ProjectOpenResponse,
  ProjectSession,
  RunStartResponse,
  RunStatusResponse,
  RunStorageCleanup,
  RunStorageProfile,
  SnakemakeCatalog,
  SourceWorkflowEditResponse,
  SystemProfile,
  UploadResult,
  ValidationEvidenceResponse,
  WorkflowGraphResponse,
  WorkflowAssessment,
} from "./types";

const DEFAULT_SOMITE_SERVER = "http://localhost:7310";
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_RESPONSE_BYTES = MAX_WORKFLOW_DOCUMENT_BYTES;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

type Decoder<T> = (value: unknown, path: string) => T;
type GraphRequest = Readonly<{ graph: SomiteGraph; input_origin_id?: string }>;
type GraphWriteRequest = GraphRequest & Readonly<{ base_state_revision: string }>;

export type InputOriginRecoveryResponse = Readonly<{
  state_revision: string;
  input_origin_id: string;
  input_origin_warning: null;
}>;

export function normalizedSomiteServerUrl(value: string | undefined): string {
  if (!value) return DEFAULT_SOMITE_SERVER;
  const candidate = new URL(value);
  if ((candidate.protocol !== "http:" && candidate.protocol !== "https:")
    || candidate.username
    || candidate.password
    || candidate.pathname !== "/"
    || candidate.search
    || candidate.hash) {
    throw new Error("Somite's runner URL must be an HTTP(S) origin without credentials or a path");
  }
  return candidate.origin;
}

export class JsonRequestError extends Error {
  readonly status: number;
  readonly body: { error?: string; state_revision?: string; code?: string; retryable?: boolean } | null;

  constructor(
    message: string,
    status: number,
    body: { error?: string; state_revision?: string; code?: string; retryable?: boolean } | null,
  ) {
    super(message);
    this.name = "JsonRequestError";
    this.status = status;
    this.body = body;
  }
}

export class ResponseContractError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, detail: string, options?: ErrorOptions) {
    super(`Somite received an invalid response from ${endpoint}: ${detail}`, options);
    this.name = "ResponseContractError";
    this.endpoint = endpoint;
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, path);
}

function httpUrl(value: unknown, path: string): string {
  const candidate = text(value, path);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${path} must be an absolute HTTP(S) URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error(`${path} must be an absolute HTTP(S) URL without credentials`);
  }
  return candidate;
}

function optionalHttpUrl(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : httpUrl(value, path);
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer`);
  return value as number;
}

function nonnegative(value: unknown, path: string): number {
  const parsed = integer(value, path);
  if (parsed < 0) throw new Error(`${path} must be nonnegative`);
  return parsed;
}

function oneOf<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${path} has an unsupported value`);
  return value as T;
}

function list<T>(value: unknown, path: string, decoder: Decoder<T>): T[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => decoder(item, `${path}[${index}]`));
}

function texts(value: unknown, path: string): string[] {
  return list(value, path, text);
}

function optional<T>(value: unknown, path: string, decoder: Decoder<T>): T | undefined {
  return value === undefined ? undefined : decoder(value, path);
}

function mapOf<T>(value: unknown, path: string, decoder: Decoder<T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record(value, path)).map(([key, item]) => [key, decoder(item, `${path}.${key}`)]));
}

function requireArrayFields(value: unknown, path: string, fields: readonly string[]) {
  const raw = record(value, path);
  for (const field of fields) {
    if (!Array.isArray(raw[field])) throw new Error(`${path}.${field} must be an array`);
  }
  return raw;
}

function validateRecipe(value: unknown, path: string) {
  const raw = record(value, path);
  for (const field of ["id", "title", "summary", "version"] as const) text(raw[field], `${path}.${field}`);
  oneOf(raw.kind, `${path}.kind`, ["external_checkpoint", "environment", "method_selection", "artifact_preparation", "adapter_contract"] as const);
  texts(raw.steps, `${path}.steps`);
  texts(raw.parameters, `${path}.parameters`);
  optionalText(raw.source_url, `${path}.source_url`);
  return value;
}

function assessment(value: unknown, path: string): WorkflowAssessment {
  const raw = requireArrayFields(value, path, ["items", "nodes"]);
  text(raw.graph_revision, `${path}.graph_revision`);
  oneOf(raw.state, `${path}.state`, ["empty", "building", "needs_action", "ready"] as const);
  nonnegative(raw.required_count, `${path}.required_count`);
  for (const [index, item] of (raw.items as unknown[]).entries()) {
    const itemPath = `${path}.items[${index}]`;
    const entry = requireArrayFields(item, itemPath, ["fields", "resolutions", "recipes"]);
    for (const field of ["id", "node_id", "operator_id", "field", "title", "detail"] as const) text(entry[field], `${itemPath}.${field}`);
    list(entry.fields, `${itemPath}.fields`, (field, fieldPath) => {
      const fieldRaw = record(field, fieldPath);
      text(fieldRaw.name, `${fieldPath}.name`);
      text(fieldRaw.label, `${fieldPath}.label`);
      oneOf(fieldRaw.input_mode, `${fieldPath}.input_mode`, ["connection", "file", "text", "choice", "guide", "agent"] as const);
      return field;
    });
    oneOf(entry.kind, `${itemPath}.kind`, ["input", "parameter", "managed_resource", "manual_checkpoint", "method_details", "legacy_tool", "adapter"] as const);
    integer(entry.priority, `${itemPath}.priority`);
    bool(entry.escalatable, `${itemPath}.escalatable`);
    if (entry.resource_profile !== undefined && entry.resource_profile !== null) text(entry.resource_profile, `${itemPath}.resource_profile`);
    list(entry.resolutions, `${itemPath}.resolutions`, (resolution, resolutionPath) => {
      const resolutionRaw = record(resolution, resolutionPath);
      for (const field of ["id", "label", "detail"] as const) text(resolutionRaw[field], `${resolutionPath}.${field}`);
      oneOf(resolutionRaw.kind, `${resolutionPath}.kind`, ["connect", "configure", "use_existing", "download", "build", "attach", "review", "setup", "add_adapter"] as const);
      bool(resolutionRaw.recommended, `${resolutionPath}.recommended`);
      for (const field of ["download_bytes", "stored_bytes"] as const) {
        if (resolutionRaw[field] !== undefined && resolutionRaw[field] !== null) number(resolutionRaw[field], `${resolutionPath}.${field}`);
      }
      for (const field of ["scientific_effect", "source_url"] as const) {
        if (resolutionRaw[field] !== undefined && resolutionRaw[field] !== null) text(resolutionRaw[field], `${resolutionPath}.${field}`);
      }
      return resolution;
    });
    list(entry.recipes, `${itemPath}.recipes`, validateRecipe);
  }
  for (const [index, node] of (raw.nodes as unknown[]).entries()) {
    const nodePath = `${path}.nodes[${index}]`;
    const entry = requireArrayFields(node, nodePath, ["recipes"]);
    for (const field of ["node_id", "operator_id", "title", "label", "detail"] as const) text(entry[field], `${nodePath}.${field}`);
    oneOf(entry.kind, `${nodePath}.kind`, ["input_required", "managed_tool", "source_workflow", "built_in", "system_tool", "manual_checkpoint", "method_details", "legacy_source", "adapter"] as const);
    bool(entry.requires_action, `${nodePath}.requires_action`);
    list(entry.recipes, `${nodePath}.recipes`, validateRecipe);
  }
  return value as WorkflowAssessment;
}

function evidenceResult(value: unknown, path: string): EvidenceResult {
  return oneOf(value, path, ["passed", "failed", "inconclusive"] as const);
}

function operatorProofReceipt(value: unknown, path: string): NonNullable<OperatorCandidate["proof"]> {
  const raw = record(value, path);
  if (integer(raw.schema_version, `${path}.schema_version`) !== 1) throw new Error(`${path}.schema_version must be 1`);
  return {
    schema_version: 1,
    receipt_digest: text(raw.receipt_digest, `${path}.receipt_digest`),
    candidate_id: text(raw.candidate_id, `${path}.candidate_id`),
    operator_revision: text(raw.operator_revision, `${path}.operator_revision`),
    graph_revision: text(raw.graph_revision, `${path}.graph_revision`),
    run_id: text(raw.run_id, `${path}.run_id`),
    closure_digest: nullableText(raw.closure_digest, `${path}.closure_digest`),
    result: oneOf(raw.result, `${path}.result`, ["passed", "failed"] as const),
    finished_at: text(raw.finished_at, `${path}.finished_at`),
  };
}

function operatorCandidate(value: unknown, path: string): OperatorCandidate {
  const raw = record(value, path);
  if (integer(raw.schema_version, `${path}.schema_version`) !== 1) throw new Error(`${path}.schema_version must be 1`);
  const proof = optional(raw.proof, `${path}.proof`, operatorProofReceipt);
  return {
    schema_version: 1,
    candidate_id: text(raw.candidate_id, `${path}.candidate_id`),
    operator: parsePinnedOperator(raw.operator, `${path}.operator`),
    sources: list(raw.sources, `${path}.sources`, (source, sourcePath) => {
      const item = record(source, sourcePath);
      return {
        kind: oneOf(item.kind, `${sourcePath}.kind`, ["official_docs", "source", "package_recipe", "workflow_use"] as const),
        url: httpUrl(item.url, `${sourcePath}.url`),
      };
    }),
    created_at: text(raw.created_at, `${path}.created_at`),
    status: oneOf(raw.status, `${path}.status`, ["draft", "proven", "accepted"] as const),
    ...(proof ? { proof } : {}),
  };
}

function managedResourceJob(value: unknown, path: string): ManagedResourceJob {
  const raw = record(value, path);
  const progress = record(raw.progress, `${path}.progress`);
  return {
    job_id: text(raw.job_id, `${path}.job_id`),
    provider_id: text(raw.provider_id, `${path}.provider_id`),
    profile: text(raw.profile, `${path}.profile`),
    resolution: text(raw.resolution, `${path}.resolution`),
    phase: oneOf(raw.phase, `${path}.phase`, ["queued", "downloading", "verifying", "extracting", "completed", "failed", "cancelling", "cancelled"] as const),
    progress: {
      completed: nonnegative(progress.completed, `${path}.progress.completed`),
      total: nonnegative(progress.total, `${path}.progress.total`),
      unit: oneOf(progress.unit, `${path}.progress.unit`, ["bytes"] as const),
      message: text(progress.message, `${path}.progress.message`),
    },
    ...(optionalText(raw.path, `${path}.path`) ? { path: text(raw.path, `${path}.path`) } : {}),
    ...(optionalText(raw.receipt_digest, `${path}.receipt_digest`) ? { receipt_digest: text(raw.receipt_digest, `${path}.receipt_digest`) } : {}),
    ...(optionalText(raw.error, `${path}.error`) ? { error: text(raw.error, `${path}.error`) } : {}),
    ...(raw.replayed !== undefined ? { replayed: bool(raw.replayed, `${path}.replayed`) } : {}),
  };
}

function evidenceReceipt(value: unknown, path: string): EvidenceReceipt {
  const raw = record(value, path);
  text(raw.receipt_digest, `${path}.receipt_digest`);
  nonnegative(raw.recorded_at_unix_ms, `${path}.recorded_at_unix_ms`);
  text(raw.subject_digest, `${path}.subject_digest`);
  if (raw.observed_closure_digest !== undefined && raw.observed_closure_digest !== null) text(raw.observed_closure_digest, `${path}.observed_closure_digest`);
  text(raw.kind, `${path}.kind`);
  text(raw.scope, `${path}.scope`);
  text(raw.configuration_digest, `${path}.configuration_digest`);
  texts(raw.fixture_digests, `${path}.fixture_digests`);
  text(raw.verifier, `${path}.verifier`);
  evidenceResult(raw.result, `${path}.result`);
  mapOf(raw.node_results, `${path}.node_results`, evidenceResult);
  mapOf(raw.edge_results, `${path}.edge_results`, evidenceResult);
  texts(raw.artifact_digests, `${path}.artifact_digests`);
  texts(raw.log_digests, `${path}.log_digests`);
  return value as EvidenceReceipt;
}

function paperCitation(value: unknown, path: string): PaperResourceCitation {
  const raw = record(value, path);
  text(raw.accession, `${path}.accession`);
  oneOf(raw.kind, `${path}.kind`, ["sra_study", "sra_sample", "sra_experiment", "sra_run", "bioproject", "biosample", "assembly", "ensembl"] as const);
  oneOf(raw.role, `${path}.role`, ["reads", "reference", "annotation", "sample_metadata", "unknown"] as const);
  text(raw.context, `${path}.context`);
  optionalText(raw.source_location, `${path}.source_location`);
  return value as PaperResourceCitation;
}

function paperWorkflowCitation(value: unknown, path: string): PaperWorkflowCitation {
  const raw = record(value, path);
  oneOf(raw.provider, `${path}.provider`, ["github"] as const);
  const repository = httpUrl(raw.repository, `${path}.repository`);
  const parsed = new URL(repository);
  if (parsed.protocol !== "https:" || parsed.hostname.toLocaleLowerCase("en-US") !== "github.com"
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !/^\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(parsed.pathname.replace(/\.git\/?$/i, ""))) {
    throw new Error(`${path}.repository must be a canonical public GitHub repository URL`);
  }
  text(raw.context, `${path}.context`);
  optionalText(raw.source_location, `${path}.source_location`);
  return value as PaperWorkflowCitation;
}

function paperEvidence(value: unknown, path: string): PaperEvidence {
  const raw = record(value, path);
  oneOf(raw.target_kind, `${path}.target_kind`, ["node", "edge"] as const);
  text(raw.target_id, `${path}.target_id`);
  oneOf(raw.status, `${path}.status`, ["explicit", "inferred", "needs_adapter"] as const);
  text(raw.detail, `${path}.detail`);
  if (raw.resolution_kind !== undefined) oneOf(raw.resolution_kind, `${path}.resolution_kind`, ["input_required", "managed_tool", "source_workflow", "built_in", "system_tool", "manual_checkpoint", "method_details", "legacy_source", "adapter"] as const);
  optionalText(raw.resolution_label, `${path}.resolution_label`);
  optionalText(raw.resolution_detail, `${path}.resolution_detail`);
  if (raw.resolution_required !== undefined) bool(raw.resolution_required, `${path}.resolution_required`);
  optionalText(raw.source_location, `${path}.source_location`);
  return value as PaperEvidence;
}

function paperMention(value: unknown, path: string): PaperMethodMention {
  const raw = record(value, path);
  text(raw.display_name, `${path}.display_name`);
  text(raw.normalized_name, `${path}.normalized_name`);
  optionalText(raw.operation_class, `${path}.operation_class`);
  optionalText(raw.version, `${path}.version`);
  text(raw.evidence, `${path}.evidence`);
  oneOf(raw.support, `${path}.support`, ["operator", "unsupported"] as const);
  if (raw.executable !== undefined) bool(raw.executable, `${path}.executable`);
  optionalText(raw.operator_id, `${path}.operator_id`);
  optionalText(raw.source_location, `${path}.source_location`);
  return value as PaperMethodMention;
}

function paperCandidate(value: unknown, path: string): PaperCandidate {
  const raw = record(value, path);
  text(raw.name, `${path}.name`);
  oneOf(raw.role, `${path}.role`, ["primary", "parallel", "alternative"] as const);
  text(raw.assay, `${path}.assay`);
  const parsedGraph = parseGraph(raw.graph, `${path}.graph`);
  const warnings = texts(raw.warnings, `${path}.warnings`);
  const evidence = list(raw.evidence, `${path}.evidence`, paperEvidence);
  const parsedAssessment = assessment(raw.assessment, `${path}.assessment`);
  return { name: raw.name as string, role: raw.role as PaperCandidate["role"], assay: raw.assay as string, graph: parsedGraph, warnings, evidence, assessment: parsedAssessment };
}

function paperReview(value: unknown, path: string): PaperReview {
  const raw = record(value, path);
  const extractedVia = oneOf(raw.extracted_via, `${path}.extracted_via`, ["text", "pdfjs", "ocr", "jats"] as const);
  const outcome = oneOf(raw.outcome, `${path}.outcome`, ["drafts_ready", "recognized_unsupported", "no_reconstructable_methods"] as const);
  return {
    extracted_via: extractedVia,
    outcome,
    warnings: texts(raw.warnings, `${path}.warnings`),
    mentions: list(raw.mentions, `${path}.mentions`, paperMention),
    resources: list(raw.resources, `${path}.resources`, paperCitation),
    workflow_sources: raw.workflow_sources === undefined
      ? []
      : list(raw.workflow_sources, `${path}.workflow_sources`, paperWorkflowCitation),
    candidates: list(raw.candidates, `${path}.candidates`, paperCandidate),
  };
}

function sourceRequest(value: unknown, path: string): SourceRequest {
  const raw = record(value, path);
  oneOf(raw.kind, `${path}.kind`, ["sra", "assembly", "ensembl-gene", "ensembl-transcript", "ensembl-protein"] as const);
  for (const field of ["value", "provider", "result", "action"] as const) text(raw[field], `${path}.${field}`);
  if (raw.operator_ids !== undefined) texts(raw.operator_ids, `${path}.operator_ids`);
  if (raw.sequence_type !== undefined) oneOf(raw.sequence_type, `${path}.sequence_type`, ["genomic", "cdna", "protein"] as const);
  if (raw.sequenceType !== undefined) oneOf(raw.sequenceType, `${path}.sequenceType`, ["genomic", "cdna", "protein"] as const);
  if (raw.read_layout !== undefined) oneOf(raw.read_layout, `${path}.read_layout`, ["single", "paired"] as const);
  return value as SourceRequest;
}

function sourceResult(value: unknown, path: string): SourceSearchResult {
  const raw = record(value, path);
  for (const field of ["key", "title", "accession", "description", "provider", "data_kind"] as const) text(raw[field], `${path}.${field}`);
  texts(raw.tags, `${path}.tags`);
  sourceRequest(raw.request, `${path}.request`);
  return value as SourceSearchResult;
}

function sourceSearch(value: unknown, path: string): SourceSearchResponse {
  const raw = record(value, path);
  return {
    query: text(raw.query, `${path}.query`),
    provider: oneOf(raw.provider, `${path}.provider`, ["ncbi", "ensembl"] as const),
    results: list(raw.results, `${path}.results`, sourceResult),
  };
}

function projectSession(value: unknown, path: string): ProjectSession {
  const raw = record(value, path);
  return {
    project_name: text(raw.project_name, `${path}.project_name`),
    graph_path: text(raw.graph_path, `${path}.graph_path`),
    graph: parseGraph(raw.graph, `${path}.graph`),
    operators: list(raw.operators, `${path}.operators`, parsePinnedOperator),
    recovered_autosave: bool(raw.recovered_autosave, `${path}.recovered_autosave`),
    autosave_recovery_warning: nullableText(raw.autosave_recovery_warning, `${path}.autosave_recovery_warning`),
    input_origin_warning: nullableText(raw.input_origin_warning, `${path}.input_origin_warning`),
    input_origin_id: text(raw.input_origin_id, `${path}.input_origin_id`),
    managed_resources: list(raw.managed_resources, `${path}.managed_resources`, managedResourceAvailability),
    agent_cursor: nonnegative(raw.agent_cursor, `${path}.agent_cursor`),
    state_revision: text(raw.state_revision, `${path}.state_revision`),
  };
}

function managedResourceAvailability(value: unknown, path: string): ManagedResourceAvailability {
  const raw = record(value, path);
  return {
    reference: text(raw.reference, `${path}.reference`),
    provider_id: text(raw.provider_id, `${path}.provider_id`),
    profile: text(raw.profile, `${path}.profile`),
    resolution: text(raw.resolution, `${path}.resolution`),
    title: text(raw.title, `${path}.title`),
    available: bool(raw.available, `${path}.available`),
    detail: text(raw.detail, `${path}.detail`),
    download_bytes: nonnegative(raw.download_bytes, `${path}.download_bytes`),
    stored_bytes: nonnegative(raw.stored_bytes, `${path}.stored_bytes`),
    scientific_effect: text(raw.scientific_effect, `${path}.scientific_effect`),
    source_url: httpUrl(raw.source_url, `${path}.source_url`),
    ...(optionalText(raw.error, `${path}.error`) ? { error: text(raw.error, `${path}.error`) } : {}),
  };
}

function graphWrite(value: unknown, path: string): GraphWriteResponse {
  const raw = record(value, path);
  return { valid: bool(raw.valid, `${path}.valid`), state_revision: text(raw.state_revision, `${path}.state_revision`) };
}

function sourceWorkflowEdit(value: unknown, path: string): SourceWorkflowEditResponse {
  const raw = record(value, path);
  return {
    state_revision: text(raw.state_revision, `${path}.state_revision`),
    graph_revision: text(raw.graph_revision, `${path}.graph_revision`),
    graph: parseGraph(raw.graph, `${path}.graph`),
  };
}

function agentEvent(value: unknown, path: string): AgentEvent {
  const raw = record(value, path);
  const cursor = nonnegative(raw.cursor, `${path}.cursor`);
  const recordedAt = nonnegative(raw.recorded_at_unix_ms, `${path}.recorded_at_unix_ms`);
  const kind = oneOf(raw.kind, `${path}.kind`, ["status", "user", "message", "tool", "transaction", "permission", "error"] as const);
  const title = text(raw.title, `${path}.title`);
  for (const field of ["detail", "status", "permission_id", "tool_call_id"] as const) optionalText(raw[field], `${path}.${field}`);
  let transaction: AgentEvent["transaction"];
  if (raw.transaction !== undefined) {
    const entry = record(raw.transaction, `${path}.transaction`);
    transaction = {
      transaction_id: text(entry.transaction_id, `${path}.transaction.transaction_id`),
      previous_state_revision: text(entry.previous_state_revision, `${path}.transaction.previous_state_revision`),
      state_revision: text(entry.state_revision, `${path}.transaction.state_revision`),
      graph_revision: text(entry.graph_revision, `${path}.transaction.graph_revision`),
      summary: text(entry.summary, `${path}.transaction.summary`),
      graph: parseGraph(entry.graph, `${path}.transaction.graph`),
    };
  }
  const permissionChoices = raw.permission_choices === undefined ? undefined : list(raw.permission_choices, `${path}.permission_choices`, (choice, choicePath) => {
    const entry = record(choice, choicePath);
    return {
      option_id: text(entry.option_id, `${choicePath}.option_id`),
      name: text(entry.name, `${choicePath}.name`),
      kind: oneOf(entry.kind, `${choicePath}.kind`, ["allow_once", "allow_always", "reject_once", "reject_always", "other"] as const),
    };
  });
  return {
    cursor,
    recorded_at_unix_ms: recordedAt,
    kind,
    title,
    ...(raw.detail !== undefined && raw.detail !== null ? { detail: raw.detail as string } : {}),
    ...(raw.status !== undefined && raw.status !== null ? { status: raw.status as string } : {}),
    ...(transaction ? { transaction } : {}),
    ...(raw.permission_id !== undefined && raw.permission_id !== null ? { permission_id: raw.permission_id as string } : {}),
    ...(raw.tool_call_id !== undefined && raw.tool_call_id !== null ? { tool_call_id: raw.tool_call_id as string } : {}),
    ...(permissionChoices ? { permission_choices: permissionChoices } : {}),
  };
}

function agentOption(value: unknown, path: string): AgentConfigOption {
  const raw = record(value, path);
  text(raw.id, `${path}.id`);
  text(raw.name, `${path}.name`);
  optionalText(raw.description, `${path}.description`);
  optionalText(raw.category, `${path}.category`);
  const kind = oneOf(raw.type, `${path}.type`, ["select", "boolean"] as const);
  if (kind === "boolean") bool(raw.currentValue, `${path}.currentValue`);
  else {
    text(raw.currentValue, `${path}.currentValue`);
    list(raw.options, `${path}.options`, (option, optionPath) => {
      const entry = record(option, optionPath);
      text(entry.name, `${optionPath}.name`);
      if (entry.options === undefined) {
        text(entry.value, `${optionPath}.value`);
        optionalText(entry.description, `${optionPath}.description`);
      } else {
        text(entry.group, `${optionPath}.group`);
        list(entry.options, `${optionPath}.options`, (choice, choicePath) => {
          const choiceRaw = record(choice, choicePath);
          text(choiceRaw.value, `${choicePath}.value`);
          text(choiceRaw.name, `${choicePath}.name`);
          optionalText(choiceRaw.description, `${choicePath}.description`);
          return choice;
        });
      }
      return option;
    });
  }
  return value as AgentConfigOption;
}

function agentSnapshot(value: unknown, path: string): AgentSnapshot {
  const raw = record(value, path);
  const agentName = optionalText(raw.agent_name, `${path}.agent_name`);
  const authoritativeRevision = optionalText(raw.authoritative_state_revision, `${path}.authoritative_state_revision`);
  return {
    connected: bool(raw.connected, `${path}.connected`),
    connecting: bool(raw.connecting, `${path}.connecting`),
    busy: bool(raw.busy, `${path}.busy`),
    ...(agentName !== undefined ? { agent_name: agentName } : {}),
    config_options: list(raw.config_options, `${path}.config_options`, agentOption),
    cursor: nonnegative(raw.cursor, `${path}.cursor`),
    events: list(raw.events, `${path}.events`, agentEvent),
    ...(authoritativeRevision !== undefined ? { authoritative_state_revision: authoritativeRevision } : {}),
  };
}

function agentDiscovery(value: unknown, path: string): AgentDiscovery {
  const raw = record(value, path);
  return {
    registry_url: httpUrl(raw.registry_url, `${path}.registry_url`),
    registry_status: oneOf(raw.registry_status, `${path}.registry_status`, ["live", "offline_cache", "unavailable"] as const),
    agents: list(raw.agents, `${path}.agents`, (agent, agentPath) => {
    const entry = record(agent, agentPath);
      const command = optionalText(entry.command, `${agentPath}.command`);
      const repository = optionalHttpUrl(entry.repository, `${agentPath}.repository`);
      const website = optionalHttpUrl(entry.website, `${agentPath}.website`);
      const icon = optionalText(entry.icon, `${agentPath}.icon`);
      return {
        id: text(entry.id, `${agentPath}.id`),
        name: text(entry.name, `${agentPath}.name`),
        version: text(entry.version, `${agentPath}.version`),
        description: text(entry.description, `${agentPath}.description`),
        ...(command !== undefined ? { command } : {}),
        availability: oneOf(entry.availability, `${agentPath}.availability`, ["installed", "ready", "unavailable"] as const),
        availability_detail: text(entry.availability_detail, `${agentPath}.availability_detail`),
        ...(repository !== undefined ? { repository } : {}),
        ...(website !== undefined ? { website } : {}),
        ...(icon !== undefined ? { icon } : {}),
      };
    }),
  };
}

function paperPreflight(value: unknown, path: string): PaperExtractionPreflight {
  const raw = record(value, path);
  bool(raw.native_pdf_text, `${path}.native_pdf_text`);
  bool(raw.scanned_pdf_ocr, `${path}.scanned_pdf_ocr`);
  list(raw.tools, `${path}.tools`, (tool, toolPath) => {
    const entry = record(tool, toolPath);
    text(entry.name, `${toolPath}.name`);
    bool(entry.available, `${toolPath}.available`);
    optionalText(entry.path, `${toolPath}.path`);
    if (entry.source !== undefined) oneOf(entry.source, `${toolPath}.source`, ["built_in", "managed_pixi", "project_pixi", "system_path"] as const);
    if (entry.package !== undefined) oneOf(entry.package, `${toolPath}.package`, ["poppler", "tesseract"] as const);
    optionalText(entry.version, `${toolPath}.version`);
    optionalText(entry.identity, `${toolPath}.identity`);
    text(entry.detail, `${toolPath}.detail`);
    return tool;
  });
  list(raw.missing, `${path}.missing`, (item, itemPath) => oneOf(item, itemPath, ["pdfinfo", "pdftoppm", "tesseract"] as const));
  return value as PaperExtractionPreflight;
}

function systemProfile(value: unknown, path: string): SystemProfile {
  const raw = record(value, path);
  text(raw.cpu, `${path}.cpu`);
  if (raw.physical_cores !== null) nonnegative(raw.physical_cores, `${path}.physical_cores`);
  for (const field of ["logical_threads", "available_parallelism", "memory_bytes"] as const) nonnegative(raw[field], `${path}.${field}`);
  texts(raw.gpus, `${path}.gpus`);
  text(raw.os, `${path}.os`);
  const tools = record(raw.tools, `${path}.tools`);
  for (const field of ["pixi", "sra", "datasets", "ensembl", "nextflow", "snakemake"] as const) bool(tools[field], `${path}.tools.${field}`);
  paperPreflight(raw.paper_extraction, `${path}.paper_extraction`);
  return value as SystemProfile;
}

function catalog(value: unknown, path: string, engine: "nfcore" | "snakemake"): NfcoreCatalog | SnakemakeCatalog {
  const raw = record(value, path);
  const entries = list(raw.entries, `${path}.entries`, (entry, entryPath) => {
    const item = record(entry, entryPath);
    const base = {
      operator: parsePinnedOperator(item.operator, `${entryPath}.operator`),
      description: text(item.description, `${entryPath}.description`),
      topics: texts(item.topics, `${entryPath}.topics`),
      revision: text(item.revision, `${entryPath}.revision`),
    };
    return engine === "snakemake" ? {
      ...base,
      stars: nonnegative(item.stars, `${entryPath}.stars`),
      expandable: bool(item.expandable, `${entryPath}.expandable`),
    } : base;
  });
  return { entries, cached: bool(raw.cached, `${path}.cached`) } as NfcoreCatalog | SnakemakeCatalog;
}

function workflowGraph(value: unknown, path: string): WorkflowGraphResponse {
  const raw = record(value, path);
  return {
    engine: oneOf(raw.engine, `${path}.engine`, ["nextflow", "snakemake"] as const),
    workflow: text(raw.workflow, `${path}.workflow`),
    revision: text(raw.revision, `${path}.revision`),
    graph: parseGraph(raw.graph, `${path}.graph`),
    cached: bool(raw.cached, `${path}.cached`),
  };
}

function projectOpen(value: unknown, path: string): ProjectOpenResponse {
  const raw = record(value, path);
  const kind = oneOf(raw.kind, `${path}.kind`, ["somite", "nextflow", "snakemake"] as const);
  const exclusions = raw.exclusions === undefined ? undefined : (() => {
    const excluded = record(raw.exclusions, `${path}.exclusions`);
    return {
      count: nonnegative(excluded.count, `${path}.exclusions.count`),
      examples: list(excluded.examples, `${path}.exclusions.examples`, (example, examplePath) => {
        const entry = record(example, examplePath);
        return {
          path: text(entry.path, `${examplePath}.path`),
          reason: oneOf(entry.reason, `${examplePath}.reason`, ["runtime_state", "sensitive", "not_workflow_source"] as const),
        };
      }),
    };
  })();
  const base = {
    project_path: text(raw.project_path, `${path}.project_path`),
    entrypoint: text(raw.entrypoint, `${path}.entrypoint`),
    graph: parseGraph(raw.graph, `${path}.graph`),
    ...(exclusions !== undefined ? { exclusions } : {}),
  };
  if (kind === "somite") return { ...base, kind, input_origin_id: text(raw.input_origin_id, `${path}.input_origin_id`) };
  return {
    ...base,
    kind,
    ...(raw.cached !== undefined ? { cached: bool(raw.cached, `${path}.cached`) } : {}),
    ...(raw.revision !== undefined ? { revision: text(raw.revision, `${path}.revision`) } : {}),
    ...(raw.source_digest !== undefined ? { source_digest: text(raw.source_digest, `${path}.source_digest`) } : {}),
    ...(raw.workflow_revision !== undefined ? { workflow_revision: text(raw.workflow_revision, `${path}.workflow_revision`) } : {}),
  };
}

function storageProfile(value: unknown, path: string): RunStorageProfile {
  const raw = record(value, path);
  if (raw.schema_version !== 1) throw new Error(`${path}.schema_version must be 1`);
  nonnegative(raw.generated_at_unix_ms, `${path}.generated_at_unix_ms`);
  const runs = record(raw.runs, `${path}.runs`);
  for (const field of ["count", "terminal_count", "bytes", "reclaimable_bytes", "uncertified_count", "uncertified_bytes"] as const) nonnegative(runs[field], `${path}.runs.${field}`);
  texts(runs.reclaimable_run_ids, `${path}.runs.reclaimable_run_ids`);
  for (const field of ["shared_environments", "paper_cache", "retained_scientific_state"] as const) {
    const entry = record(raw[field], `${path}.${field}`);
    nonnegative(entry.bytes, `${path}.${field}.bytes`);
    if (field !== "retained_scientific_state" && entry.recreatable !== true) throw new Error(`${path}.${field}.recreatable must be true`);
  }
  return value as RunStorageProfile;
}

function exportPlan(value: unknown, path: string): ExportPlan {
  const raw = record(value, path);
  text(raw.filename, `${path}.filename`);
  text(raw.platform, `${path}.platform`);
  texts(raw.channels, `${path}.channels`);
  texts(raw.packages, `${path}.packages`);
  list(raw.tools, `${path}.tools`, (tool, toolPath) => {
    const entry = record(tool, toolPath);
    text(entry.operator_id, `${toolPath}.operator_id`);
    text(entry.title, `${toolPath}.title`);
    optionalText(entry.binary, `${toolPath}.binary`);
    texts(entry.packages, `${toolPath}.packages`);
    oneOf(entry.state, `${toolPath}.state`, ["built_in", "ready", "installable", "system_required", "source_setup", "manual_checkpoint", "method_details", "legacy_source", "adapter_needed"] as const);
    text(entry.detail, `${toolPath}.detail`);
    return tool;
  });
  for (const field of ["ready_count", "installable_count", "source_setup_count", "manual_count", "details_count", "legacy_count", "adapter_count"] as const) nonnegative(raw[field], `${path}.${field}`);
  assessment(raw.assessment, `${path}.assessment`);
  return value as ExportPlan;
}

const RUN_PHASES = ["preparing", "running", "finalizing", "completed", "failed", "cancelling", "cancelled"] as const;

function runStart(value: unknown, path: string): RunStartResponse {
  const raw = record(value, path);
  return { run_id: text(raw.run_id, `${path}.run_id`), phase: oneOf(raw.phase, `${path}.phase`, RUN_PHASES), replayed: bool(raw.replayed, `${path}.replayed`) };
}

function runStatus(value: unknown, path: string): RunStatusResponse {
  const raw = record(value, path);
  text(raw.run_id, `${path}.run_id`);
  oneOf(raw.phase, `${path}.phase`, RUN_PHASES);
  mapOf(raw.states, `${path}.states`, (state, statePath) => oneOf(state, statePath, ["queued", "running", "cached", "done", "failed", "skipped", "cancelled"] as const));
  const progress = record(raw.progress, `${path}.progress`);
  nonnegative(progress.completed, `${path}.progress.completed`);
  nonnegative(progress.total, `${path}.progress.total`);
  text(progress.unit, `${path}.progress.unit`);
  text(progress.message, `${path}.progress.message`);
  optionalText(raw.closure_digest, `${path}.closure_digest`);
  if (raw.exit_code !== undefined) integer(raw.exit_code, `${path}.exit_code`);
  optionalText(raw.error, `${path}.error`);
  if (raw.evidence_receipt !== undefined) evidenceReceipt(raw.evidence_receipt, `${path}.evidence_receipt`);
  return value as RunStatusResponse;
}

function paperArtifact(value: unknown, path: string): PaperArtifact {
  const raw = record(value, path);
  const mediaKind = oneOf(raw.media_kind, `${path}.media_kind`, ["pdf", "text"] as const);
  return {
    digest: text(raw.digest, `${path}.digest`),
    path: text(raw.path, `${path}.path`),
    filename: text(raw.filename, `${path}.filename`),
    size_bytes: nonnegative(raw.size_bytes, `${path}.size_bytes`),
    media_kind: mediaKind,
    reused: bool(raw.reused, `${path}.reused`),
  };
}

const PAPER_INTAKE_PHASES = ["queued", "extracting", "locating_methods", "recognizing_methods", "assessing_drafts", "completed", "failed", "cancelling", "cancelled"] as const;
type PaperIntakePhase = typeof PAPER_INTAKE_PHASES[number];

export type PaperIntakeStartResponse = {
  job_id: string;
  source_digest: string;
  phase: PaperIntakePhase;
  replayed: boolean;
};

export type PaperIntakeStatusResponse = {
  job_id: string;
  source_digest: string;
  phase: PaperIntakePhase;
  progress?: { completed: number; total?: number | null; unit?: string | null; message: string };
  durations_ms?: Record<string, number>;
  cache?: { extraction?: boolean; reconstruction?: boolean };
  result?: PaperReview;
  failure?: PaperIntakeFailure;
};

function paperIntakeStart(value: unknown, path: string): PaperIntakeStartResponse {
  const raw = record(value, path);
  return {
    job_id: text(raw.job_id, `${path}.job_id`),
    source_digest: text(raw.source_digest, `${path}.source_digest`),
    phase: oneOf(raw.phase, `${path}.phase`, PAPER_INTAKE_PHASES),
    replayed: bool(raw.replayed, `${path}.replayed`),
  };
}

function paperIntakeStatus(value: unknown, path: string): PaperIntakeStatusResponse {
  const raw = record(value, path);
  const jobId = text(raw.job_id, `${path}.job_id`);
  const sourceDigest = text(raw.source_digest, `${path}.source_digest`);
  const phase = oneOf(raw.phase, `${path}.phase`, PAPER_INTAKE_PHASES);
  const result = optional(raw.result, `${path}.result`, paperReview);
  if (raw.progress !== undefined) {
    const progress = record(raw.progress, `${path}.progress`);
    nonnegative(progress.completed, `${path}.progress.completed`);
    if (progress.total !== undefined && progress.total !== null) nonnegative(progress.total, `${path}.progress.total`);
    if (progress.unit !== undefined && progress.unit !== null) text(progress.unit, `${path}.progress.unit`);
    text(progress.message, `${path}.progress.message`);
  }
  if (raw.durations_ms !== undefined) mapOf(raw.durations_ms, `${path}.durations_ms`, number);
  if (raw.cache !== undefined) {
    const cache = record(raw.cache, `${path}.cache`);
    if (cache.extraction !== undefined) bool(cache.extraction, `${path}.cache.extraction`);
    if (cache.reconstruction !== undefined) bool(cache.reconstruction, `${path}.cache.reconstruction`);
  }
  if (raw.failure !== undefined) {
    const failure = record(raw.failure, `${path}.failure`);
    text(failure.code, `${path}.failure.code`);
    text(failure.message, `${path}.failure.message`);
    bool(failure.retryable, `${path}.failure.retryable`);
  }
  return {
    job_id: jobId,
    source_digest: sourceDigest,
    phase,
    ...(raw.progress !== undefined ? { progress: raw.progress as PaperIntakeStatusResponse["progress"] } : {}),
    ...(raw.durations_ms !== undefined ? { durations_ms: raw.durations_ms as Record<string, number> } : {}),
    ...(raw.cache !== undefined ? { cache: raw.cache as PaperIntakeStatusResponse["cache"] } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(raw.failure !== undefined ? { failure: raw.failure as PaperIntakeFailure } : {}),
  };
}

function errorPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    ...(typeof raw.state_revision === "string" ? { state_revision: raw.state_revision } : {}),
    ...(typeof raw.code === "string" ? { code: raw.code } : {}),
    ...(typeof raw.retryable === "boolean" ? { retryable: raw.retryable } : {}),
  };
}

async function responseBytes(response: Response, endpoint: string, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await boundedResponseBytes(response, limit, "Somite response body") as Uint8Array<ArrayBuffer>;
  } catch (error) {
    if (error instanceof ResponseSizeError) {
      throw new ResponseContractError(endpoint, `body exceeds ${limit} bytes`, { cause: error });
    }
    if (error instanceof ResponseHeaderError) {
      throw new ResponseContractError(endpoint, "body has an invalid Content-Length header", { cause: error });
    }
    throw error;
  }
}

export async function boundedZipBlob(response: Response, endpoint: string, limit = MAX_FROZEN_PACKAGE_BYTES) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const advertised = Number(contentLength);
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(advertised)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseContractError(endpoint, "body has an invalid Content-Length header");
    }
    if (advertised > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseContractError(endpoint, `body exceeds ${limit} bytes`);
    }
  }
  if (!response.body) throw new ResponseContractError(endpoint, "body is empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const signature = new Uint8Array(4);
  let signatureBytes = 0;
  let signatureValidated = false;
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseContractError(endpoint, `body exceeds ${limit} bytes`);
      }
      if (signatureBytes < signature.byteLength) {
        const copied = Math.min(signature.byteLength - signatureBytes, value.byteLength);
        signature.set(value.subarray(0, copied), signatureBytes);
        signatureBytes += copied;
        if (signatureBytes === signature.byteLength) {
          const localHeader = signature[0] === 0x50 && signature[1] === 0x4b && signature[2] === 0x03 && signature[3] === 0x04;
          const emptyArchive = signature[0] === 0x50 && signature[1] === 0x4b && signature[2] === 0x05 && signature[3] === 0x06;
          if (!localHeader && !emptyArchive) {
            await reader.cancel().catch(() => undefined);
            throw new ResponseContractError(endpoint, "body is not a ZIP archive");
          }
          signatureValidated = true;
        }
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!signatureValidated) throw new ResponseContractError(endpoint, "body is not a ZIP archive");
  return new Blob(chunks, { type: "application/zip" });
}

async function requireSuccess(response: Response, endpoint: string) {
  if (response.ok) return response;
  let detail: ReturnType<typeof errorPayload> = null;
  try {
    const bytes = await responseBytes(response, endpoint, MAX_ERROR_RESPONSE_BYTES);
    detail = bytes.byteLength ? errorPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) : null;
  } catch {
    // A malformed error body must not hide the HTTP status.
  }
  throw new JsonRequestError(detail?.error ?? `${response.status} ${response.statusText}`, response.status, detail);
}

async function decodedResponse<T>(response: Response, endpoint: string, decoder: Decoder<T>, limit = MAX_JSON_RESPONSE_BYTES): Promise<T> {
  await requireSuccess(response, endpoint);
  let value: unknown;
  try {
    const bytes = await responseBytes(response, endpoint, limit);
    if (!bytes.byteLength) throw new Error("body is empty");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ResponseContractError) throw error;
    throw new ResponseContractError(endpoint, error instanceof Error ? error.message : String(error), { cause: error });
  }
  try {
    return decoder(value, "response");
  } catch (error) {
    throw new ResponseContractError(endpoint, error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  };
}

export class SomiteClient {
  readonly origin: string;
  readonly #fetch: typeof fetch;

  constructor(origin = DEFAULT_SOMITE_SERVER, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.origin = normalizedSomiteServerUrl(origin);
    this.#fetch = fetcher;
  }

  #request(endpoint: string, init?: RequestInit) {
    return this.#fetch(`${this.origin}${endpoint}`, { ...init, redirect: "error" });
  }

  async #json<T>(endpoint: string, decoder: Decoder<T>, init?: RequestInit, limit?: number): Promise<T> {
    return decodedResponse(await this.#request(endpoint, init), endpoint, decoder, limit);
  }

  async #empty(endpoint: string, init: RequestInit): Promise<void> {
    const response = await requireSuccess(await this.#request(endpoint, init), endpoint);
    const bytes = await responseBytes(response, endpoint, MAX_ERROR_RESPONSE_BYTES);
    if (bytes.byteLength) throw new ResponseContractError(endpoint, "expected an empty response body");
  }

  session(signal?: AbortSignal) {
    return this.#json("/api/session", projectSession, signal ? { signal } : undefined, MAX_DOCUMENT_RESPONSE_BYTES);
  }

  recoverInputOrigin(baseStateRevision: string, inputOriginId: string) {
    return this.#json<InputOriginRecoveryResponse>("/api/input-origin/recover", (value, path) => {
      const raw = record(value, path);
      if (raw.input_origin_warning !== null) throw new Error(`${path}.input_origin_warning must be null`);
      return {
        state_revision: text(raw.state_revision, `${path}.state_revision`),
        input_origin_id: text(raw.input_origin_id, `${path}.input_origin_id`),
        input_origin_warning: null,
      };
    }, jsonInit("POST", { base_state_revision: baseStateRevision, input_origin_id: inputOriginId }));
  }

  validationEvidence(request: GraphRequest, signal?: AbortSignal) {
    return this.#json<ValidationEvidenceResponse>("/api/validations/status", (value, path) => {
      const raw = record(value, path);
      return {
        subject_digest: text(raw.subject_digest, `${path}.subject_digest`),
        configuration_digest: text(raw.configuration_digest, `${path}.configuration_digest`),
        fixture_pack: text(raw.fixture_pack, `${path}.fixture_pack`),
        ...(raw.receipt !== undefined ? { receipt: evidenceReceipt(raw.receipt, `${path}.receipt`) } : {}),
      };
    }, jsonInit("POST", request, signal));
  }

  writeGraph(endpoint: GraphWritePath, request: GraphWriteRequest) {
    return this.#json(endpoint, graphWrite, jsonInit("PUT", request), MAX_DOCUMENT_RESPONSE_BYTES);
  }

  discoverAgents() { return this.#json("/api/agent/discover", agentDiscovery); }
  agentEvents(after: number) { return this.#json(`/api/agent/events?after=${encodeURIComponent(after)}`, agentSnapshot, undefined, MAX_AGENT_SNAPSHOT_BYTES); }
  connectAgent(command: string) { return this.#json("/api/agent/connect", agentSnapshot, jsonInit("POST", { command }), MAX_AGENT_SNAPSHOT_BYTES); }
  promptAgent(request: GraphWriteRequest & { message: string }) { return this.#json("/api/agent/prompt", graphWrite, jsonInit("POST", request), MAX_DOCUMENT_RESPONSE_BYTES); }
  configureAgent(configId: string, value: string | boolean) { return this.#json("/api/agent/config", agentSnapshot, jsonInit("POST", { config_id: configId, value }), MAX_AGENT_SNAPSHOT_BYTES); }
  cancelAgent() { return this.#empty("/api/agent/cancel", { method: "POST" }); }
  disconnectAgent() { return this.#empty("/api/agent/disconnect", { method: "POST" }); }
  answerAgentPermission(permissionId: string, optionId?: string) { return this.#empty(`/api/agent/permissions/${encodeURIComponent(permissionId)}`, jsonInit("POST", { option_id: optionId })); }
  operatorCandidates() {
    return this.#json<OperatorCandidate[]>("/api/operator-workshop/candidates", (value, path) => {
      const raw = record(value, path);
      return list(raw.candidates, `${path}.candidates`, operatorCandidate);
    });
  }
  acceptOperatorCandidate(candidateId: string) {
    return this.#json(`/api/operator-workshop/candidates/${encodeURIComponent(candidateId)}/accept`, operatorCandidate, jsonInit("POST", {}));
  }
  installManagedResource(profile: string, resolution: string, idempotencyKey: string) {
    return this.#json("/api/resources/install", managedResourceJob, jsonInit("POST", { profile, resolution, idempotency_key: idempotencyKey }));
  }
  managedResourceStatus(jobId: string, waitMs = 0) {
    return this.#json(`/api/resources/jobs/${encodeURIComponent(jobId)}?wait_ms=${Math.max(0, Math.min(30_000, Math.round(waitMs)))}`, managedResourceJob);
  }
  cancelManagedResource(jobId: string) {
    return this.#json(`/api/resources/jobs/${encodeURIComponent(jobId)}/cancel`, managedResourceJob, jsonInit("POST", {}));
  }
  system() { return this.#json("/api/system", systemProfile); }

  workflowCatalog(engine: "nfcore"): Promise<NfcoreCatalog>;
  workflowCatalog(engine: "snakemake"): Promise<SnakemakeCatalog>;
  workflowCatalog(engine: "nfcore" | "snakemake") {
    return this.#json(engine === "nfcore" ? "/api/catalog/nfcore" : "/api/catalog/snakemake", (value, path) => catalog(value, path, engine));
  }

  storage() { return this.#json("/api/storage", storageProfile); }
  dehydrateRuns(runIds: string[]) {
    return this.#json<RunStorageCleanup>("/api/storage/dehydrate-runs", (value, path) => {
      const raw = record(value, path);
      return { run_ids: texts(raw.run_ids, `${path}.run_ids`), reclaimed_bytes: nonnegative(raw.reclaimed_bytes, `${path}.reclaimed_bytes`) };
    }, jsonInit("POST", { run_ids: runIds }));
  }
  installPaperOcr() {
    return this.#json<{ preflight: PaperExtractionPreflight }>("/api/paper-tools/ocr/install", (value, path) => {
      const raw = record(value, path);
      return { preflight: paperPreflight(raw.preflight, `${path}.preflight`) };
    }, jsonInit("POST", {}));
  }

  openProject(path: string) { return this.#json("/api/projects/open", projectOpen, jsonInit("POST", { path, snakemake_targets: [] }), MAX_DOCUMENT_RESPONSE_BYTES); }
  importProject(files: readonly Readonly<{ path: string; file: File }>[]) {
    const body = new FormData();
    for (const entry of files) body.append("file", entry.file, entry.path);
    return this.#json("/api/projects/import", projectOpen, { method: "POST", body }, MAX_DOCUMENT_RESPONSE_BYTES);
  }
  expandWorkflow(engine: "nfcore" | "snakemake", workflow: string, revision: string) {
    return this.#json(engine === "nfcore" ? "/api/catalog/nfcore/expand" : "/api/catalog/snakemake/expand", workflowGraph, jsonInit("POST", { workflow, revision }), MAX_DOCUMENT_RESPONSE_BYTES);
  }
  resolveGithubWorkflow(repository: string, revision = "") {
    return this.#json("/api/source-workflows/github/resolve", workflowGraph, jsonInit("POST", { repository, revision }), MAX_DOCUMENT_RESPONSE_BYTES);
  }
  uploadFile(file: File, signal?: AbortSignal) {
    const body = new FormData();
    body.append("file", file);
    return this.#json<UploadResult>("/api/files", (value, path) => {
      const raw = record(value, path);
      return { path: text(raw.path, `${path}.path`), filename: text(raw.filename, `${path}.filename`) };
    }, { method: "POST", body, ...(signal ? { signal } : {}) });
  }
  editSourceWorkflow(request: unknown) { return this.#json("/api/source-workflows/edit", sourceWorkflowEdit, jsonInit("POST", request), MAX_DOCUMENT_RESPONSE_BYTES); }
  promoteSourceWorkflow(request: unknown) { return this.#json("/api/source-workflows/promote", sourceWorkflowEdit, jsonInit("POST", request), MAX_DOCUMENT_RESPONSE_BYTES); }
  restoreSourceWorkflow(baseStateRevision: string) { return this.#json("/api/source-workflows/restore", sourceWorkflowEdit, jsonInit("POST", { base_state_revision: baseStateRevision }), MAX_DOCUMENT_RESPONSE_BYTES); }
  validateGraph(request: GraphRequest) {
    return this.#json("/api/graph/validate", (value, path) => {
      const raw = record(value, path);
      return { valid: bool(raw.valid, `${path}.valid`) };
    }, jsonInit("POST", request));
  }
  exportPlan(request: GraphRequest) { return this.#json("/api/export/plan", exportPlan, jsonInit("POST", request), MAX_DOCUMENT_RESPONSE_BYTES); }
  async downloadExport(request: GraphRequest) {
    const endpoint = "/api/export";
    const response = await requireSuccess(await this.#request(endpoint, jsonInit("POST", request)), endpoint);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/zip") {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseContractError(endpoint, "content-type must be application/zip");
    }
    return boundedZipBlob(response, endpoint);
  }

  startRun(intent: "run" | "validation", request: GraphRequest) { return this.#json(intent === "validation" ? "/api/validations" : "/api/runs", runStart, jsonInit("POST", request)); }
  runStatus(runId: string) { return this.#json(`/api/runs/${encodeURIComponent(runId)}`, runStatus); }
  cancelRun(runId: string) { return this.#json(`/api/runs/${encodeURIComponent(runId)}/cancel`, runStatus, { method: "POST" }); }
  searchSources(query: string, provider: "ncbi" | "ensembl", signal?: AbortSignal) { return this.#json(`/api/sources/search?q=${encodeURIComponent(query)}&provider=${provider}`, sourceSearch, signal ? { signal } : undefined); }
  searchPapers(query: string, signal?: AbortSignal) {
    return this.#json<PaperSearchResponse>(`/api/papers/search?q=${encodeURIComponent(query)}`, (value, path) => {
      const raw = record(value, path);
      return {
        query: text(raw.query, `${path}.query`),
        results: list(raw.results, `${path}.results`, (paper, paperPath) => {
          const entry = record(paper, paperPath);
          for (const field of ["id", "doi", "title", "authors", "date", "abstract_text", "url"] as const) text(entry[field], `${paperPath}.${field}`);
          bool(entry.full_text_available, `${paperPath}.full_text_available`);
          return paper as PaperSearchResponse["results"][number];
        }),
      };
    }, signal ? { signal } : undefined);
  }
  resolvePaperResources(resources: readonly PaperResourceCitation[], signal?: AbortSignal) {
    return this.#json<PaperResourceResolution>("/api/paper/resources/resolve", (value, path) => {
      const raw = record(value, path);
      return { groups: list(raw.groups, `${path}.groups`, (group, groupPath) => {
        const entry = record(group, groupPath);
        return {
          citation: paperCitation(entry.citation, `${groupPath}.citation`),
          provider: oneOf(entry.provider, `${groupPath}.provider`, ["ncbi", "ensembl"] as const),
          status: oneOf(entry.status, `${groupPath}.status`, ["available", "unavailable"] as const),
          results: list(entry.results, `${groupPath}.results`, sourceResult),
        };
      }) };
    }, jsonInit("POST", { resources }, signal));
  }

  uploadPaper(file: File, signal: AbortSignal) {
    const body = new FormData();
    body.append("file", file);
    return this.#json("/api/papers/uploads", paperArtifact, { method: "POST", body, signal });
  }
  startPaperIntake(digest: string, attemptKey: string, signal?: AbortSignal) { return this.#json(`/api/papers/intakes?idempotency_key=${encodeURIComponent(attemptKey)}`, paperIntakeStart, jsonInit("POST", { digest }, signal)); }
  paperIntakeStatus(jobId: string, signal?: AbortSignal) { return this.#json(`/api/papers/intakes/${encodeURIComponent(jobId)}?wait_ms=15000`, paperIntakeStatus, signal ? { signal } : undefined, MAX_PAPER_STATUS_BYTES); }
  cancelPaperIntake(jobId: string) { return this.#json(`/api/papers/intakes/${encodeURIComponent(jobId)}/cancel`, paperIntakeStatus, { method: "POST" }, MAX_PAPER_STATUS_BYTES); }
  reconstructBiorxiv(id: string, signal: AbortSignal) { return this.#json("/api/papers/biorxiv/reconstruct", paperReview, jsonInit("POST", { id }, signal), MAX_PAPER_REVIEW_BYTES); }
  reconstructPaperPath(path: string, signal: AbortSignal) { return this.#json("/api/paper", paperReview, jsonInit("POST", { path }, signal), MAX_PAPER_REVIEW_BYTES); }
}

export function createSomiteClient(origin?: string, fetcher?: typeof fetch) {
  return new SomiteClient(origin, fetcher);
}
