import type { SomiteMcpToolName } from "./mcpTools.ts";

export type JsonSchema = Record<string, unknown>;

const string = { type: "string" } as const;
const boolean = { type: "boolean" } as const;
const number = { type: "number" } as const;
const integer = { type: "integer" } as const;
const nullableString = { type: ["string", "null"] } as const;
const nullableInteger = { type: ["integer", "null"] } as const;
const paramValue = { type: ["string", "number", "boolean"] } as const;

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

function record(values: JsonSchema): JsonSchema {
  return { type: "object", additionalProperties: values };
}

const portTypes = [
  "Sra", "Fastq", "FastqGz", "Fasta", "FastaGz", "Gtf", "GtfGz", "Gff3",
  "Sam", "Bam", "Bai", "Vcf", "VcfGz", "Bed", "Agp", "Chain", "Table",
  "Json", "Html", "Image", "Zip", "Directory", "Text", "Preview",
] as const;

const portType = { type: "string", enum: portTypes };
const layout = object({ x: number, y: number });
const sourceSpan = object({ path: string, start_line: integer, end_line: integer });
const workflowBinding = {
  oneOf: [
    object({ kind: { const: "project_file" }, path: string }),
    object({ kind: { const: "project_directory" }, path: string }),
    object({ kind: { const: "literal" }, value: paramValue }),
  ],
};
const workflowParameter = object({
  name: string,
  label: string,
  group: string,
  description: string,
  help: string,
  type: { enum: ["string", "integer", "number", "boolean"] },
  required: boolean,
  hidden: boolean,
  managed: boolean,
  format: string,
  pattern: string,
  default: paramValue,
  choices: array(paramValue),
  minimum: number,
  maximum: number,
}, ["name", "label", "group", "type"]);
const unsupportedWorkflowParameter = object({
  name: string,
  label: string,
  group: string,
  description: string,
  reason: string,
  hidden: boolean,
}, ["name", "label", "group", "reason"]);
const sourceScope = object({
  id: string,
  title: string,
  symbol: string,
  kind: { enum: ["entry_workflow", "workflow", "process"] },
  span: sourceSpan,
}, ["id", "title", "kind", "span"]);
const sourceInvocation = object({
  id: string,
  caller: string,
  name: string,
  callee: string,
  span: sourceSpan,
}, ["id", "caller", "name", "span"]);
const sourceReplacement = object({
  invocation_id: string,
  operator: string,
  operator_revision: string,
  params: record(paramValue),
}, ["invocation_id", "operator", "operator_revision"]);
const sourceWorkflow = object({
  schema_version: integer,
  workflow_revision: string,
  source: object({
    provider: { enum: ["nf_core", "local"] },
    repository: string,
    requested_revision: string,
    resolved_revision: string,
    source_digest: string,
    entrypoint: string,
    file_count: integer,
    source_bytes: integer,
  }),
  profiles: array(string),
  parameters: array(workflowParameter),
  unsupported_required_parameters: array(unsupportedWorkflowParameter),
  bindings: record(workflowBinding),
  scopes: array(sourceScope),
  invocations: array(sourceInvocation),
  replacements: array(sourceReplacement),
  capabilities: object({
    exact_execution: boolean,
    parameter_edits: boolean,
    hierarchy_indexed: boolean,
    structural_edits: boolean,
    channel_contracts: boolean,
    source_edits: boolean,
  }),
  diagnostics: array(object({
    code: { enum: ["timeout", "somite_tool_error"] },
    message: string,
    span: sourceSpan,
  }, ["code", "message"])),
}, ["schema_version", "workflow_revision", "source", "capabilities"]);
const graphPort = object({
  name: string,
  dir: { enum: ["in", "out"] },
  ty: portType,
  union: array(portType),
  optional: boolean,
}, ["name", "dir", "ty"]);
const graphNode = object({
  id: string,
  operator: string,
  operator_revision: string,
  ports: array(graphPort),
  params: record(paramValue),
  source_workflow: sourceWorkflow,
  layout,
  note: string,
  color: { enum: ["yellow", "orange", "rose", "violet", "blue", "teal", "green", "gray"] },
}, ["id", "operator", "operator_revision", "ports", "layout"]);
const graphEdge = object({ id: string, from_node: string, from_port: string, to_node: string, to_port: string });
const graphAnnotation = {
  oneOf: [
    object({
      id: string,
      kind: { enum: ["sticky", "box"] },
      text: string,
      color: { enum: ["yellow", "orange", "rose", "violet", "blue", "teal", "green", "gray"] },
      layout,
      width: number,
      height: number,
    }),
    object({
      id: string,
      kind: { const: "stroke" },
      color: { enum: ["yellow", "orange", "rose", "violet", "blue", "teal", "green", "gray"] },
      points: array(layout),
    }),
  ],
};
const graph = object({
  schema_version: integer,
  name: string,
  nodes: array(graphNode),
  edges: array(graphEdge),
  annotations: array(graphAnnotation),
  variant_origin: object({
    source_node: graphNode,
    promoted_invocations: record({ type: "string" }),
  }, ["source_node"]),
}, ["schema_version", "nodes", "edges"]);

const recipe = object({
  id: string,
  title: string,
  summary: string,
  version: string,
  kind: { enum: ["external_checkpoint", "environment", "method_selection", "artifact_preparation", "adapter_contract"] },
  steps: array(string),
  parameters: array(string),
  source_url: nullableString,
}, ["id", "title", "summary", "version", "kind", "steps", "parameters"]);
const readiness = object({
  graph_revision: string,
  state: { enum: ["empty", "building", "needs_action", "ready"] },
  required_count: integer,
  items: array(object({
    id: string,
    node_id: string,
    operator_id: string,
    field: string,
    fields: array(object({
      name: string,
      label: string,
      input_mode: { enum: ["connection", "file", "text", "choice", "guide", "agent"] },
    })),
    title: string,
    detail: string,
    kind: { enum: ["input", "parameter", "managed_resource", "manual_checkpoint", "method_details", "legacy_tool", "adapter"] },
    priority: integer,
    escalatable: boolean,
    resource_profile: nullableString,
    resolutions: array(object({
      id: string,
      label: string,
      detail: string,
      kind: { enum: ["connect", "configure", "use_existing", "download", "build", "attach", "review", "setup", "add_adapter"] },
      recommended: boolean,
      download_bytes: nullableInteger,
      stored_bytes: nullableInteger,
      scientific_effect: nullableString,
      source_url: nullableString,
    }, ["id", "label", "detail", "kind", "recommended"])),
    recipes: array(recipe),
  }, ["id", "node_id", "operator_id", "field", "fields", "title", "detail", "kind", "priority", "escalatable", "resolutions", "recipes"])),
  nodes: array(object({
    node_id: string,
    operator_id: string,
    title: string,
    kind: { enum: ["input_required", "managed_tool", "source_workflow", "built_in", "system_tool", "manual_checkpoint", "method_details", "legacy_source", "adapter"] },
    label: string,
    detail: string,
    requires_action: boolean,
    recipes: array(recipe),
  })),
});

const resourceResolution = object({
  id: string,
  label: string,
  detail: string,
  kind: { enum: ["use_existing", "download", "build"] },
  recommended: boolean,
  download_bytes: nullableInteger,
  stored_bytes: nullableInteger,
  scientific_effect: string,
}, ["id", "label", "detail", "kind"]);
const resourceSpec = object({
  profile: string,
  title: string,
  detail: string,
  resolutions: array(resourceResolution),
});
const operatorPort = object({
  name: string,
  type: portType,
  union: array(portType),
  optional: boolean,
  resource_profile: string,
  resource: resourceSpec,
  stage_as: string,
  import_param: string,
}, ["name", "type"]);
const paramSpec = object({
  type: string,
  label: string,
  page: string,
  default: paramValue,
  required: boolean,
  min: number,
  max: number,
}, ["type"]);
const outputSpec = object({
  glob: string,
  type: portType,
  optional: boolean,
  exclude: array(string),
}, ["glob", "type"]);
const operatorProperties = {
  id: string,
  revision: string,
  title: string,
  palette: array(string),
  kind: { enum: ["external", "inprocess", "reference", "source"] },
  cost: { enum: ["low", "high"] },
  bin: string,
  pixi: array(string),
  params: record(paramSpec),
  ports: object({ in: array(operatorPort), out: array(operatorPort) }),
  argv: array(string),
  outputs: record(outputSpec),
  stdout: string,
  resolution: object({
    kind: { enum: ["manual_checkpoint", "method_details", "legacy_source", "adapter"] },
    title: string,
    detail: string,
    action_label: string,
    parameters: array(string),
    source_url: string,
    recipes: array(recipe),
  }, ["kind", "title", "detail", "action_label", "parameters", "recipes"]),
  paper: object({
    aliases: array(string),
    operation_class: string,
    assays: array(string),
  }, ["aliases", "assays"]),
  description: string,
  topics: array(string),
  expandable: boolean,
};
const requiredOperatorProperties = ["id", "revision", "title", "palette", "kind", "cost", "params", "ports"];

const transaction = object({
  transaction_id: string,
  previous_state_revision: string,
  state_revision: string,
  graph_revision: string,
  summary: string,
  graph,
  replayed: boolean,
});
const evidenceResult = { enum: ["passed", "failed", "inconclusive"] };
const evidenceReceipt = object({
  receipt_digest: string,
  recorded_at_unix_ms: integer,
  subject_digest: string,
  observed_closure_digest: nullableString,
  kind: string,
  scope: string,
  configuration_digest: string,
  fixture_digests: array(string),
  verifier: string,
  result: evidenceResult,
  node_results: record(evidenceResult),
  edge_results: record(evidenceResult),
  artifact_digests: array(string),
  log_digests: array(string),
}, [
  "receipt_digest", "recorded_at_unix_ms", "subject_digest", "kind", "scope",
  "configuration_digest", "fixture_digests", "verifier", "result", "node_results",
  "edge_results", "artifact_digests", "log_digests",
]);
const runStatus = object({
  run_id: string,
  phase: { enum: ["preparing", "running", "finalizing", "completed", "failed", "cancelling", "cancelled"] },
  states: record({ enum: ["queued", "running", "cached", "done", "failed", "skipped", "cancelled"] }),
  closure_digest: string,
  exit_code: integer,
  error: string,
  evidence_receipt: evidenceReceipt,
  progress: object({ completed: integer, total: integer, unit: { const: "nodes" }, message: string }),
}, ["run_id", "phase", "states", "progress"]);

const toolFailure = object({
  error: object({
    code: string,
    message: string,
    retryable: boolean,
    status: integer,
    detail: { type: "object", additionalProperties: true },
  }, ["code", "message", "retryable"]),
});

function result(success: JsonSchema): JsonSchema {
  return { oneOf: [success, toolFailure] };
}

/** Concrete success and structured-error contracts advertised at the stdio MCP seam. */
export const MCP_OUTPUT_SCHEMAS = Object.freeze({
  "somite.workflow.get": result(object({ state_revision: string, graph_revision: string, graph })),
  "somite.readiness.get": result(readiness),
  "somite.catalog.search": result(object({
    query: string,
    catalog_revision: string,
    total_matches: integer,
    next_cursor: nullableString,
    matches: array(object({
      ...operatorProperties,
      score: integer,
      matched_terms: array(string),
    }, [...requiredOperatorProperties, "score", "matched_terms"])),
  })),
  "somite.source_workflow.search_nfcore": result(object({
    query: string,
    provenance: string,
    total_matches: integer,
    entries: array(object({
      repository: string,
      title: string,
      description: string,
      topics: array(string),
      revision: string,
    })),
    cached: boolean,
  })),
  "somite.source_workflow.resolve_nfcore": result(transaction),
  "somite.source_workflow.edit": result(transaction),
  "somite.source_workflow.promote": result(transaction),
  "somite.source.search": result(object({
    query: string,
    provider: { enum: ["ncbi", "ensembl"] },
    results: array(object({
      key: string,
      title: string,
      accession: string,
      description: string,
      provider: string,
      data_kind: string,
      tags: array(string),
      request: object({
        kind: string,
        value: string,
        provider: string,
        result: string,
        action: string,
        operator_ids: array(string),
        sequence_type: string,
      }, ["kind", "value", "provider", "result", "action", "operator_ids"]),
    })),
  })),
  "somite.graph.apply_transaction": result(transaction),
  "somite.workflow.compile": result(object({
    source_graph_revision: string,
    closure_digest: string,
    compiled_graph_revision: string,
    output_path: string,
    reused: boolean,
  })),
  "somite.run.start": result(object({
    run_id: string,
    phase: { enum: ["preparing", "running", "finalizing", "completed", "failed", "cancelling", "cancelled"] },
    replayed: boolean,
  })),
  "somite.validation.start": result(object({
    run_id: string,
    phase: { enum: ["preparing", "running", "finalizing", "completed", "failed", "cancelling", "cancelled"] },
    replayed: boolean,
  })),
  "somite.run.status": result(runStatus),
  "somite.run.cancel": result(runStatus),
  "somite.evidence.lookup": result(object({ subject_digest: string, receipts: array(evidenceReceipt) })),
} satisfies Record<SomiteMcpToolName, JsonSchema>);
