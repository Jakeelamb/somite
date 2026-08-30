export type {
  CanvasAnnotation,
  CanvasColor,
  CanvasPoint,
  ParamValue,
  PortType,
  SomiteEdge,
  SomiteGraph,
  SomiteGraphNode,
  SomitePort,
  SourceCapabilities,
  SourceDiagnostic,
  SourceInvocation,
  SourceInvocationReplacement,
  SourceProvider,
  SourceScope,
  SourceSpan,
  SourceWorkflowInstance,
  SourceWorkflowVariantOrigin,
  UnsupportedRequiredWorkflowParameter,
  WorkflowBinding,
  WorkflowParameterField,
  WorkflowSourcePin,
} from "@somite/workflow/model";

export type {
  CommandBindings,
  Operator,
  OperatorResolutionKind,
  OperatorResolutionSpec,
  OutputSpec,
  PaperRecognitionSpec,
  ParamSpec,
  PinnedOperator,
  PortSpec,
  ResolutionRecipe,
  ResolutionRecipeKind,
  ResourceResolutionKind,
  ResourceResolutionSpec,
  ResourceSpec,
} from "@somite/workflow/catalog";

export type {
  NodeAssessment,
  ReadinessItem,
  ReadinessResolution,
  ReadinessSnapshot,
  ReadinessState,
  RequirementField,
  RequirementInputMode,
  RequirementKind,
  ResolutionKind,
  SupportKind,
  WorkflowAssessment,
} from "@somite/workflow/assessment";

import type { SomiteGraph } from "@somite/workflow/model";
import type { Operator } from "@somite/workflow/catalog";
import type { WorkflowAssessment } from "@somite/workflow/assessment";

export type NfcoreCatalog = {
  entries: Array<{ operator: Operator; description: string; topics: string[]; revision: string }>;
  cached: boolean;
};

export type SnakemakeCatalog = {
  entries: Array<{ operator: Operator; description: string; topics: string[]; revision: string; stars: number; expandable: boolean }>;
  cached: boolean;
};

export type WorkflowGraphResponse = {
  engine: "nextflow" | "snakemake";
  workflow: string;
  revision: string;
  graph: SomiteGraph;
  cached: boolean;
};

export type ProjectOpenResponse = {
  kind: "somite" | "nextflow" | "snakemake";
  project_path: string;
  entrypoint: string;
  graph: SomiteGraph;
  cached?: boolean;
  revision?: string;
  source_digest?: string;
  workflow_revision?: string;
  exclusions?: {
    count: number;
    examples: Array<{ path: string; reason: "runtime_state" | "sensitive" | "not_workflow_source" }>;
  };
};

export type ProjectSession = {
  project_name: string;
  graph_path: string;
  graph: SomiteGraph;
  operators: Operator[];
  recovered_autosave: boolean;
  autosave_recovery_warning: string | null;
  agent_cursor: number;
  state_revision: string;
};

export type GraphWriteResponse = {
  valid: boolean;
  state_revision: string;
};

export type SourceWorkflowEditResponse = {
  state_revision: string;
  graph_revision: string;
  graph: SomiteGraph;
};

export type AgentPermissionChoice = {
  option_id: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "other";
};

export type AgentTransaction = {
  transaction_id: string;
  previous_state_revision: string;
  state_revision: string;
  graph_revision: string;
  summary: string;
  graph: SomiteGraph;
};

export type AgentEvent = {
  cursor: number;
  recorded_at_unix_ms: number;
  kind: "status" | "user" | "message" | "tool" | "transaction" | "permission" | "error";
  title: string;
  detail?: string;
  status?: string;
  transaction?: AgentTransaction;
  permission_id?: string;
  tool_call_id?: string;
  permission_choices?: AgentPermissionChoice[];
};

export type AgentConfigSelectChoice = {
  value: string;
  name: string;
  description?: string;
};

export type AgentConfigSelectGroup = {
  group: string;
  name: string;
  options: AgentConfigSelectChoice[];
};

export type AgentConfigOption = {
  id: string;
  name: string;
  description?: string;
  category?: "model" | "model_config" | "mode" | "thought_level" | string;
} & ({
  type: "select";
  currentValue: string;
  options: AgentConfigSelectChoice[] | AgentConfigSelectGroup[];
} | {
  type: "boolean";
  currentValue: boolean;
});

export type DiscoveredAgent = {
  id: string;
  name: string;
  version: string;
  description: string;
  command?: string;
  availability: "installed" | "ready" | "unavailable";
  availability_detail: string;
  repository?: string;
  website?: string;
  icon?: string;
};

export type AgentDiscovery = {
  registry_url: string;
  registry_status: "live" | "offline_cache" | "unavailable";
  agents: DiscoveredAgent[];
};

export type AgentSnapshot = {
  connected: boolean;
  connecting: boolean;
  busy: boolean;
  agent_name?: string;
  config_options: AgentConfigOption[];
  cursor: number;
  events: AgentEvent[];
  authoritative_state_revision?: string;
};

export type RunPhase = "preparing" | "running" | "finalizing" | "completed" | "failed" | "cancelling" | "cancelled";

export type RunNodeState = "queued" | "running" | "cached" | "done" | "failed" | "skipped" | "cancelled";

export type RunStartResponse = {
  run_id: string;
  phase: RunPhase;
  replayed: boolean;
};

export type RunStatusResponse = RunStartResponse & {
  states: Record<string, RunNodeState>;
  closure_digest?: string;
  exit_code?: number;
  error?: string;
  evidence_receipt?: EvidenceReceipt;
  progress: { completed: number; total: number; unit: string; message: string };
};

export type EvidenceResult = "passed" | "failed" | "inconclusive";

export type EvidenceReceipt = {
  receipt_digest: string;
  recorded_at_unix_ms: number;
  subject_digest: string;
  observed_closure_digest?: string;
  kind: string;
  scope: string;
  configuration_digest: string;
  fixture_digests: string[];
  verifier: string;
  result: EvidenceResult;
  node_results: Record<string, EvidenceResult>;
  edge_results: Record<string, EvidenceResult>;
  artifact_digests: string[];
  log_digests: string[];
};

export type ValidationEvidenceResponse = {
  subject_digest: string;
  configuration_digest: string;
  fixture_pack: string;
  receipt?: EvidenceReceipt;
};

export type PaperEvidence = {
  target_kind: "node" | "edge";
  target_id: string;
  status: "explicit" | "inferred" | "needs_adapter";
  detail: string;
  resolution_kind?: "input_required" | "managed_tool" | "source_workflow" | "built_in" | "system_tool" | "manual_checkpoint" | "method_details" | "legacy_source" | "adapter";
  resolution_label?: string;
  resolution_detail?: string;
  resolution_required?: boolean;
  source_location?: string;
};

export type ExportTool = {
  operator_id: string;
  title: string;
  binary?: string;
  packages: string[];
  state: "built_in" | "ready" | "installable" | "system_required" | "source_setup" | "manual_checkpoint" | "method_details" | "legacy_source" | "adapter_needed";
  detail: string;
};

export type ExportPlan = {
  filename: string;
  platform: string;
  channels: string[];
  packages: string[];
  tools: ExportTool[];
  ready_count: number;
  installable_count: number;
  source_setup_count: number;
  manual_count: number;
  details_count: number;
  legacy_count: number;
  adapter_count: number;
  assessment: WorkflowAssessment;
};

export type PaperCandidate = {
  name: string;
  role: "primary" | "parallel" | "alternative";
  assay: string;
  graph: SomiteGraph;
  warnings: string[];
  evidence: PaperEvidence[];
  assessment: WorkflowAssessment;
};

export type PaperResourceCitation = {
  accession: string;
  kind: "sra_study" | "sra_sample" | "sra_experiment" | "sra_run" | "bioproject" | "biosample" | "assembly" | "ensembl";
  role: "reads" | "reference" | "annotation" | "sample_metadata" | "unknown";
  context: string;
  source_location?: string;
};

export type PaperResourceGroup = {
  citation: PaperResourceCitation;
  provider: "ncbi" | "ensembl";
  status: "available" | "unavailable";
  results: import("./sourceBuilder").SourceSearchResult[];
};

export type PaperResourceResolution = {
  groups: PaperResourceGroup[];
};

export type PaperReconstructionOutcome = "drafts_ready" | "recognized_unsupported" | "no_reconstructable_methods";

export type PaperMethodMention = {
  display_name: string;
  normalized_name: string;
  operation_class?: string;
  evidence: string;
  support: "operator" | "unsupported";
  operator_id?: string;
  source_location?: string;
};

export type PaperReview = {
  extracted_via: "text" | "pdfjs" | "poppler" | "ocr" | "jats";
  outcome: PaperReconstructionOutcome;
  warnings: string[];
  mentions: PaperMethodMention[];
  resources: PaperResourceCitation[];
  candidates: PaperCandidate[];
};

export type PaperSearchResult = {
  id: string;
  doi: string;
  title: string;
  authors: string;
  date: string;
  abstract_text: string;
  url: string;
  full_text_available: boolean;
};

export type PaperSearchResponse = {
  query: string;
  results: PaperSearchResult[];
};

export type UploadResult = {
  path: string;
  filename: string;
};

export type PaperToolSource = "built_in" | "managed_pixi" | "project_pixi" | "system_path";

export type PaperExtractionToolReadiness = {
  name: string;
  available: boolean;
  path?: string;
  source?: PaperToolSource;
  package?: "poppler" | "tesseract";
  version?: string;
  identity?: string;
  detail: string;
};

export type PaperExtractionPreflight = {
  native_pdf_text: boolean;
  scanned_pdf_ocr: boolean;
  tools: PaperExtractionToolReadiness[];
  missing: Array<"pdfinfo" | "pdftoppm" | "tesseract">;
};

export type SystemProfile = {
  cpu: string;
  physical_cores: number | null;
  logical_threads: number;
  available_parallelism: number;
  memory_bytes: number;
  gpus: string[];
  os: string;
  tools: {
    pixi: boolean;
    sra: boolean;
    datasets: boolean;
    ensembl: boolean;
    nextflow: boolean;
    snakemake: boolean;
  };
  paper_extraction: PaperExtractionPreflight;
};

export type RunStorageProfile = {
  schema_version: 1;
  generated_at_unix_ms: number;
  runs: {
    count: number;
    terminal_count: number;
    bytes: number;
    reclaimable_bytes: number;
    reclaimable_run_ids: string[];
    uncertified_count: number;
    uncertified_bytes: number;
  };
  shared_environments: { bytes: number; recreatable: true };
  paper_cache: { bytes: number; recreatable: true };
  retained_scientific_state: { bytes: number };
};

export type RunStorageCleanup = {
  run_ids: string[];
  reclaimed_bytes: number;
};
