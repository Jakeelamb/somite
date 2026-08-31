import type { SomiteMcpToolName } from "./mcpTools.ts";

export type JsonSchema = Record<string, unknown>;

const string = { type: "string" } as const;
const boolean = { type: "boolean" } as const;
const number = { type: "number" } as const;
const integer = { type: "integer" } as const;
const nullableString = { type: ["string", "null"] } as const;
const parameterValue = { type: ["string", "number", "boolean"] } as const;

function array(items: unknown): JsonSchema {
  return { type: "array", items };
}

function object(
  properties: Record<string, unknown>,
  required: readonly string[] = Object.keys(properties),
  additionalProperties: boolean | JsonSchema = false,
): JsonSchema {
  return { type: "object", properties, required, additionalProperties };
}

/** Nested domain records may grow without replicating their complete model in every tool. */
function openObject(properties: Record<string, unknown>, required: readonly string[]): JsonSchema {
  return object(properties, required, true);
}

function record(values: JsonSchema): JsonSchema {
  return { type: "object", additionalProperties: values };
}

const portType = {
  type: "string",
  enum: [
    "Sra", "Fastq", "FastqGz", "Fasta", "FastaGz", "Gtf", "GtfGz", "Gff3",
    "Sam", "Bam", "Bai", "Vcf", "VcfGz", "Bed", "Agp", "Chain", "Table",
    "Json", "Html", "Image", "Zip", "Directory", "Text", "Preview",
  ],
} as const;
const layout = object({ x: number, y: number });
const graphPort = openObject({
  name: string,
  dir: { enum: ["in", "out"] },
  ty: portType,
  union: array(portType),
  optional: boolean,
}, ["name", "dir", "ty"]);
const sourceWorkflow = openObject({
  schema_version: { const: 1 },
  workflow_revision: string,
  source: openObject({
    provider: { enum: ["nf_core", "local"] },
    repository: string,
    requested_revision: string,
    resolved_revision: string,
    source_digest: string,
    entrypoint: string,
  }, ["provider", "repository", "requested_revision", "resolved_revision", "source_digest", "entrypoint"]),
  capabilities: object({
    exact_execution: boolean,
    parameter_edits: boolean,
    hierarchy_indexed: boolean,
    structural_edits: boolean,
    channel_contracts: boolean,
    source_edits: boolean,
  }),
}, ["schema_version", "workflow_revision", "source", "capabilities"]);
const graphNode = openObject({
  id: string,
  operator: string,
  operator_revision: string,
  ports: array(graphPort),
  params: record(parameterValue),
  source_workflow: sourceWorkflow,
  layout,
}, ["id", "operator", "operator_revision", "ports", "layout"]);
const graphEdge = object({ id: string, from_node: string, from_port: string, to_node: string, to_port: string });
const graph = object({
  schema_version: integer,
  name: string,
  nodes: array(graphNode),
  edges: array(graphEdge),
  annotations: array(openObject({ id: string, kind: { enum: ["sticky", "box", "stroke"] } }, ["id", "kind"])),
  variant_origin: openObject({
    source_node: openObject({ id: string, operator: string, operator_revision: string }, ["id", "operator", "operator_revision"]),
  }, ["source_node"]),
}, ["schema_version", "nodes", "edges"]);

// Mutation tools return the complete graph, but advertise only the identities
// needed to chain the next atomic edit. workflow.get owns the richer graph contract.
const transactionGraph = openObject({
  schema_version: integer,
  nodes: array(openObject({
    id: string,
    operator: string,
    operator_revision: string,
    ports: array(openObject({ name: string, dir: { enum: ["in", "out"] }, ty: string }, ["name", "dir", "ty"])),
    source_workflow: openObject({ workflow_revision: string }, ["workflow_revision"]),
  }, ["id", "operator", "operator_revision"])),
  edges: array(graphEdge),
}, ["schema_version", "nodes", "edges"]);

const transaction = object({
  transaction_id: string,
  previous_state_revision: string,
  state_revision: string,
  graph_revision: string,
  summary: string,
  graph: transactionGraph,
  replayed: boolean,
});

const recipe = openObject({
  id: string,
  title: string,
  kind: { enum: ["external_checkpoint", "environment", "method_selection", "artifact_preparation", "adapter_contract"] },
}, ["id", "title", "kind"]);
const readinessResolution = openObject({
  id: string,
  label: string,
  kind: { enum: ["connect", "configure", "use_existing", "download", "build", "attach", "review", "setup", "add_adapter"] },
  recommended: boolean,
}, ["id", "label", "kind", "recommended"]);
const readiness = object({
  graph_revision: string,
  state: { enum: ["empty", "building", "needs_action", "ready"] },
  required_count: integer,
  items: array(openObject({
    id: string,
    node_id: string,
    operator_id: string,
    field: string,
    kind: { enum: ["input", "parameter", "managed_resource", "manual_checkpoint", "method_details", "legacy_tool", "adapter"] },
    title: string,
    detail: string,
    priority: integer,
    escalatable: boolean,
    resolutions: array(readinessResolution),
    recipes: array(recipe),
  }, ["id", "node_id", "operator_id", "field", "kind", "title", "detail", "priority", "escalatable", "resolutions", "recipes"])),
  nodes: array(openObject({
    node_id: string,
    operator_id: string,
    kind: { enum: ["input_required", "managed_tool", "source_workflow", "built_in", "system_tool", "manual_checkpoint", "method_details", "legacy_source", "adapter"] },
    requires_action: boolean,
  }, ["node_id", "operator_id", "kind", "requires_action"])),
});

const catalogPort = openObject({ name: string, type: portType }, ["name", "type"]);
const catalogMatch = openObject({
  id: string,
  revision: string,
  title: string,
  palette: array(string),
  kind: { enum: ["external", "inprocess", "reference", "source"] },
  cost: { enum: ["low", "high"] },
  params: record(openObject({ type: string }, ["type"])),
  ports: object({ in: array(catalogPort), out: array(catalogPort) }),
  score: integer,
  matched_terms: array(string),
}, ["id", "revision", "title", "palette", "kind", "cost", "params", "ports", "score", "matched_terms"]);

const evidenceResult = { enum: ["passed", "failed", "inconclusive"] };
const evidenceReceipt = openObject({
  receipt_digest: string,
  subject_digest: string,
  configuration_digest: string,
  verifier: string,
  result: evidenceResult,
  node_results: record(evidenceResult),
  edge_results: record(evidenceResult),
}, ["receipt_digest", "subject_digest", "configuration_digest", "verifier", "result"]);
const runPhase = { enum: ["preparing", "running", "finalizing", "completed", "failed", "cancelling", "cancelled"] };
const runStatus = object({
  run_id: string,
  phase: runPhase,
  states: record({ enum: ["queued", "running", "cached", "done", "failed", "skipped", "cancelled"] }),
  closure_digest: string,
  exit_code: integer,
  error: string,
  evidence_receipt: evidenceReceipt,
  progress: object({ completed: integer, total: integer, unit: { const: "nodes" }, message: string }),
}, ["run_id", "phase", "states", "progress"]);
const operatorCandidate = openObject({
  schema_version: { const: 1 },
  candidate_id: string,
  operator: openObject({ id: string, revision: string }, ["id", "revision"]),
  sources: array(openObject({ url: string }, ["url"])),
  created_at: string,
  status: string,
}, ["schema_version", "candidate_id", "operator", "sources", "created_at", "status"]);
const operatorProofReceipt = openObject({
  receipt_digest: string,
}, ["receipt_digest"]);

const toolFailure = object({
  // Error responses may carry status and tool-specific detail, but callers only
  // need these three stable fields to decide whether and how to recover. Keeping
  // the extension fields open avoids repeating a large generic schema for every
  // advertised tool.
  error: openObject({ retryable: boolean }, ["code", "message", "retryable"]),
});

function result(success: JsonSchema): JsonSchema {
  return { oneOf: [success, toolFailure] };
}

/** Compact concrete contracts advertised at the stdio MCP seam. */
export const MCP_OUTPUT_SCHEMAS = Object.freeze({
  "somite.workflow.get": result(object({ state_revision: string, graph_revision: string, graph })),
  "somite.readiness.get": result(readiness),
  "somite.catalog.search": result(object({
    query: string,
    catalog_revision: string,
    total_matches: integer,
    next_cursor: nullableString,
    matches: array(catalogMatch),
  })),
  "somite.source_workflow.search_nfcore": result(object({
    query: string,
    provenance: string,
    total_matches: integer,
    entries: array(openObject({
      repository: string,
      title: string,
      revision: string,
    }, ["repository", "title", "revision"])),
    cached: boolean,
  })),
  "somite.source_workflow.resolve_nfcore": result(transaction),
  "somite.source_workflow.edit": result(transaction),
  "somite.source_workflow.promote": result(transaction),
  "somite.source.search": result(object({
    query: string,
    provider: { enum: ["ncbi", "ensembl"] },
    results: array(openObject({
      key: string,
      title: string,
      accession: string,
      provider: string,
      data_kind: string,
      request: openObject({
        kind: string,
        value: string,
        provider: string,
        result: string,
        action: string,
        operator_ids: array(string),
      }, ["kind", "value", "provider", "result", "action", "operator_ids"]),
    }, ["key", "title", "accession", "provider", "data_kind", "request"])),
  })),
  "somite.operator_candidate.draft": result(operatorCandidate),
  "somite.operator_candidate.prove": result(object({ proof_id: string, replayed: boolean })),
  "somite.operator_proof.status": result(openObject({
    proof_id: string,
    candidate_id: string,
    run: openObject({ run_id: string, phase: runPhase }, ["run_id", "phase"]),
    receipt: operatorProofReceipt,
  }, ["proof_id", "candidate_id", "run"])),
  "somite.resource": result(openObject({
    job_id: string,
    provider_id: string,
    profile: string,
    resolution: string,
    phase: string,
    progress: openObject({ completed: integer, total: integer, unit: string, message: string }, ["completed", "total", "unit", "message"]),
  }, ["job_id", "provider_id", "profile", "resolution", "phase", "progress"])),
  "somite.graph.apply_transaction": result(transaction),
  "somite.workflow.compile": result(object({
    source_graph_revision: string,
    closure_digest: string,
    compiled_graph_revision: string,
    output_path: string,
    reused: boolean,
  })),
  "somite.run.start": result(object({ run_id: string, phase: runPhase, replayed: boolean })),
  "somite.validation.start": result(object({ run_id: string, phase: runPhase, replayed: boolean })),
  "somite.run.status": result(runStatus),
  "somite.run.cancel": result(runStatus),
  "somite.evidence.lookup": result(object({ subject_digest: string, receipts: array(evidenceReceipt) })),
} satisfies Record<SomiteMcpToolName, JsonSchema>);
