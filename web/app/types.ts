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
  SourceCanvasView,
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
  ManagedResourceAvailability,
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

export type {
  EvidenceReceipt,
  EvidenceResult,
} from "@somite/workflow/linker";

export type {
  BundlePlan as ExportPlan,
  ToolRequirement as ExportTool,
} from "@somite/workflow/bundle";

export type {
  PaperCandidate,
  PaperEvidence,
  PaperExtractVia,
  PaperMethodMention,
  PaperReconstructionOutcome,
  PaperResourceCitation,
  PaperReview,
} from "@somite/workflow/paper";

import type { SomiteGraph } from "@somite/workflow/model";
import type { Operator } from "@somite/workflow/catalog";
import type { EvidenceReceipt } from "@somite/workflow/linker";
import type { PaperResourceCitation } from "@somite/workflow/paper";

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

type ProjectOpenBase = {
  project_path: string;
  entrypoint: string;
  graph: SomiteGraph;
  exclusions?: {
    count: number;
    examples: Array<{ path: string; reason: "runtime_state" | "sensitive" | "not_workflow_source" }>;
  };
};

export type ProjectOpenResponse =
  | ProjectOpenBase & {
      kind: "somite";
      input_origin_id: string;
    }
  | ProjectOpenBase & {
      kind: "nextflow" | "snakemake";
      cached?: boolean;
      revision?: string;
      source_digest?: string;
      workflow_revision?: string;
    };

export type ProjectSession = {
  project_name: string;
  graph_path: string;
  graph: SomiteGraph;
  operators: Operator[];
  recovered_autosave: boolean;
  autosave_recovery_warning: string | null;
  input_origin_warning: string | null;
  input_origin_id: string;
  managed_resources: import("@somite/workflow/assessment").ManagedResourceAvailability[];
  agent_cursor: number;
  state_revision: string;
};

export type OperatorEvidenceSource = {
  kind: "official_docs" | "source" | "package_recipe" | "workflow_use";
  url: string;
};

export type OperatorProofReceipt = {
  schema_version: 1;
  receipt_digest: string;
  candidate_id: string;
  operator_revision: string;
  graph_revision: string;
  run_id: string;
  closure_digest: string | null;
  result: "passed" | "failed";
  finished_at: string;
};

export type OperatorCandidate = {
  schema_version: 1;
  candidate_id: string;
  operator: Operator;
  sources: OperatorEvidenceSource[];
  created_at: string;
  status: "draft" | "proven" | "accepted";
  proof?: OperatorProofReceipt;
};

export type ManagedResourceJob = {
  job_id: string;
  provider_id: string;
  profile: string;
  resolution: string;
  phase: "queued" | "downloading" | "verifying" | "extracting" | "completed" | "failed" | "cancelling" | "cancelled";
  progress: { completed: number; total: number; unit: "bytes"; message: string };
  path?: string;
  receipt_digest?: string;
  error?: string;
  replayed?: boolean;
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

export type RunStatusResponse = {
  run_id: string;
  phase: RunPhase;
  states: Record<string, RunNodeState>;
  closure_digest?: string;
  exit_code?: number;
  error?: string;
  evidence_receipt?: EvidenceReceipt;
  progress: { completed: number; total: number; unit: string; message: string };
};

export type ValidationEvidenceResponse = {
  subject_digest: string;
  configuration_digest: string;
  fixture_pack: string;
  receipt?: EvidenceReceipt;
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
