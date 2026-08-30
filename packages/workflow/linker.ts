import { OperatorCatalog } from "./catalog.ts";
import { operatorDocument } from "./catalogCodec.ts";
import { byteDigest, jsonDigest } from "./contentIdentity.ts";
import type { SomiteGraph } from "./model.ts";
import { semanticGraphRevision, validateGraph } from "./workflow.ts";

export const CLOSURE_SCHEMA_VERSION = 1;
export const EVIDENCE_SCHEMA_VERSION = 1;

export type LinkOptions = Readonly<{
  targetPlatform: string;
  compilerIdentity: string;
  nextflowIdentity: string;
  openjdkIdentity: string;
}>;

export type OperatorRevisionManifest = Readonly<{
  schema_version: number;
  operator_id: string;
  revision: string;
  operator: ReturnType<typeof operatorDocument>;
}>;

export type OperatorPin = Readonly<{ operator_id: string; revision: string }>;

export type EnvironmentIdentity = Readonly<{
  manifest_digest: string;
  lock_digest: string;
}>;

export type RunClosureDraft = Readonly<{
  schema_version: number;
  graph_revision: string;
  target_platform: string;
  operators: readonly OperatorPin[];
  environment_manifest_digest: string;
  compiler_identity: string;
  nextflow_identity: string;
  openjdk_identity: string;
}>;

export type RunClosure = Readonly<{
  schema_version: number;
  closure_digest: string;
  graph_revision: string;
  target_platform: string;
  operators: readonly OperatorPin[];
  environment: EnvironmentIdentity;
  compiler_identity: string;
  nextflow_identity: string;
  openjdk_identity: string;
}>;

export type LinkPlan = Readonly<{
  draft: RunClosureDraft;
  operatorManifests: readonly OperatorRevisionManifest[];
}>;

export type EvidenceResult = "passed" | "failed" | "inconclusive";

export type EvidenceDraft = Readonly<{
  recorded_at_unix_ms: number;
  subject_digest: string;
  observed_closure_digest?: string | null;
  kind: string;
  scope: string;
  configuration_digest: string;
  fixture_digests: readonly string[];
  verifier: string;
  result: EvidenceResult;
  node_results: Readonly<Record<string, EvidenceResult>>;
  edge_results: Readonly<Record<string, EvidenceResult>>;
  artifact_digests: readonly string[];
  log_digests: readonly string[];
}>;

export type EvidenceReceipt = Readonly<{
  receipt_digest: string;
  recorded_at_unix_ms: number;
  subject_digest: string;
  observed_closure_digest?: string | null;
  kind: string;
  scope: string;
  configuration_digest: string;
  fixture_digests: readonly string[];
  verifier: string;
  result: EvidenceResult;
  node_results: Readonly<Record<string, EvidenceResult>>;
  edge_results: Readonly<Record<string, EvidenceResult>>;
  artifact_digests: readonly string[];
  log_digests: readonly string[];
}>;

export type EvidenceIndex = Readonly<{
  schema_version: number;
  receipts: readonly EvidenceReceipt[];
}>;

export type LinkErrorCode = "invalid_graph" | "empty_target" | "empty_lock" | "empty_evidence_field";

export class LinkError extends Error {
  readonly code: LinkErrorCode;

  constructor(code: LinkErrorCode, message: string) {
    super(message);
    this.name = "LinkError";
    this.code = code;
  }
}

function fail(code: LinkErrorCode, message: string): never {
  throw new LinkError(code, message);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedRecord<T>(record: Readonly<Record<string, T>>) {
  return Object.fromEntries(Object.keys(record).sort(compareText).map((key) => [key, record[key]]));
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort(compareText);
}

/** Resolve an exact graph and catalog snapshot into a target-specific draft. */
export function linkRunClosure(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  pixiManifest: Uint8Array,
  options: LinkOptions,
): LinkPlan {
  if (!options.targetPlatform.trim()) fail("empty_target", "target platform must not be empty");
  const graphValidation = validateGraph(graph);
  if (!graphValidation.ok) fail("invalid_graph", `invalid graph: ${graphValidation.issue.message}`);
  const catalogValidation = catalog.verifyGraph(graph);
  if (!catalogValidation.ok) fail("invalid_graph", `operator catalog: ${catalogValidation.issue.message}`);

  const operatorIds = [...new Set(graph.nodes.map((node) => node.operator))].sort(compareText);
  const operators: OperatorPin[] = [];
  const operatorManifests: OperatorRevisionManifest[] = [];
  for (const operatorId of operatorIds) {
    const operator = catalog.get(operatorId);
    if (!operator) fail("invalid_graph", `operator catalog: unknown operator ${operatorId}`);
    operators.push({ operator_id: operatorId, revision: operator.revision });
    operatorManifests.push({
      schema_version: 1,
      operator_id: operatorId,
      revision: operator.revision,
      operator: operatorDocument(operator),
    });
  }

  return {
    draft: {
      schema_version: CLOSURE_SCHEMA_VERSION,
      graph_revision: semanticGraphRevision(graph),
      target_platform: options.targetPlatform,
      operators,
      environment_manifest_digest: byteDigest(pixiManifest),
      compiler_identity: options.compilerIdentity,
      nextflow_identity: options.nextflowIdentity,
      openjdk_identity: options.openjdkIdentity,
    },
    operatorManifests,
  };
}

/** Add exact Pixi lock identity and finalize an immutable run closure. */
export function freezeRunClosure(draft: RunClosureDraft, pixiLock: Uint8Array): RunClosure {
  if (pixiLock.byteLength === 0) fail("empty_lock", "Pixi lock is empty");
  const lockDigest = byteDigest(pixiLock);
  const closureDigest = jsonDigest({ draft, lock_digest: lockDigest });
  return {
    schema_version: draft.schema_version,
    closure_digest: closureDigest,
    graph_revision: draft.graph_revision,
    target_platform: draft.target_platform,
    operators: draft.operators,
    environment: {
      manifest_digest: draft.environment_manifest_digest,
      lock_digest: lockDigest,
    },
    compiler_identity: draft.compiler_identity,
    nextflow_identity: draft.nextflow_identity,
    openjdk_identity: draft.openjdk_identity,
  };
}

/** Finalize validation evidence without changing executable identity. */
export function createEvidenceReceipt(draft: EvidenceDraft): EvidenceReceipt {
  for (const [field, value] of [
    ["subject_digest", draft.subject_digest],
    ["kind", draft.kind],
    ["scope", draft.scope],
    ["configuration_digest", draft.configuration_digest],
    ["verifier", draft.verifier],
  ] as const) {
    if (!value.trim()) fail("empty_evidence_field", `evidence field ${field} must not be empty`);
  }
  const fixtureDigests = sortedUnique(draft.fixture_digests);
  const artifactDigests = sortedUnique(draft.artifact_digests);
  const logDigests = sortedUnique(draft.log_digests);
  const nodeResults = sortedRecord(draft.node_results);
  const edgeResults = sortedRecord(draft.edge_results);
  const material = {
    recorded_at_unix_ms: draft.recorded_at_unix_ms,
    subject_digest: draft.subject_digest,
    observed_closure_digest: draft.observed_closure_digest ?? null,
    kind: draft.kind,
    scope: draft.scope,
    configuration_digest: draft.configuration_digest,
    fixture_digests: fixtureDigests,
    verifier: draft.verifier,
    result: draft.result,
    node_results: nodeResults,
    edge_results: edgeResults,
    artifact_digests: artifactDigests,
    log_digests: logDigests,
  };
  return {
    receipt_digest: jsonDigest(material),
    recorded_at_unix_ms: draft.recorded_at_unix_ms,
    subject_digest: draft.subject_digest,
    ...(draft.observed_closure_digest !== undefined ? { observed_closure_digest: draft.observed_closure_digest } : {}),
    kind: draft.kind,
    scope: draft.scope,
    configuration_digest: draft.configuration_digest,
    fixture_digests: fixtureDigests,
    verifier: draft.verifier,
    result: draft.result,
    node_results: nodeResults,
    edge_results: edgeResults,
    artifact_digests: artifactDigests,
    log_digests: logDigests,
  };
}

export function emptyEvidenceIndex(): EvidenceIndex {
  return { schema_version: EVIDENCE_SCHEMA_VERSION, receipts: [] };
}

/** Immutable append with digest de-duplication and deterministic chronology. */
export function insertEvidence(index: EvidenceIndex, receipt: EvidenceReceipt): EvidenceIndex {
  if (index.receipts.some((existing) => existing.receipt_digest === receipt.receipt_digest)) return index;
  return {
    schema_version: index.schema_version,
    receipts: [...index.receipts, receipt].sort((left, right) => {
      const time = left.recorded_at_unix_ms - right.recorded_at_unix_ms;
      return time || compareText(left.receipt_digest, right.receipt_digest);
    }),
  };
}
