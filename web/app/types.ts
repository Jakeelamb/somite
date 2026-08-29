export type PortType =
  | "Sra"
  | "Fastq"
  | "FastqGz"
  | "Fasta"
  | "FastaGz"
  | "Gtf"
  | "GtfGz"
  | "Gff3"
  | "Sam"
  | "Bam"
  | "Bai"
  | "Vcf"
  | "VcfGz"
  | "Bed"
  | "Agp"
  | "Chain"
  | "Table"
  | "Json"
  | "Html"
  | "Image"
  | "Zip"
  | "Directory"
  | "Text"
  | "Preview";

export type ParamValue = string | number | boolean;

export type CanvasColor = "yellow" | "orange" | "rose" | "violet" | "blue" | "teal" | "green" | "gray";

export type CanvasPoint = { x: number; y: number };

export type CanvasAnnotation =
  | { id: string; kind: "sticky" | "box"; text: string; color: CanvasColor; layout: CanvasPoint; width: number; height: number }
  | { id: string; kind: "stroke"; color: CanvasColor; points: CanvasPoint[] };

export type SomitePort = {
  name: string;
  dir: "in" | "out";
  ty: PortType;
  union?: PortType[];
  optional?: boolean;
};

export type SourceProvider = "nf_core" | "local";

export type WorkflowSourcePin = {
  provider: SourceProvider;
  repository: string;
  requested_revision: string;
  resolved_revision: string;
  source_digest: string;
  entrypoint: string;
  file_count: number;
  source_bytes: number;
};

export type WorkflowParameterField = {
  name: string;
  label: string;
  group: string;
  description?: string;
  help?: string;
  type: "string" | "integer" | "number" | "boolean";
  required?: boolean;
  hidden?: boolean;
  managed?: boolean;
  format?: string;
  pattern?: string;
  default?: ParamValue;
  choices?: ParamValue[];
  minimum?: number;
  maximum?: number;
};

export type WorkflowBinding =
  | { kind: "project_file"; path: string }
  | { kind: "project_directory"; path: string }
  | { kind: "literal"; value: ParamValue };

export type SourceSpan = {
  path: string;
  start_line: number;
  end_line: number;
};

export type SourceScope = {
  id: string;
  title: string;
  symbol?: string;
  kind: "entry_workflow" | "workflow" | "process";
  span: SourceSpan;
};

export type SourceInvocation = {
  id: string;
  caller: string;
  name: string;
  callee?: string;
  span: SourceSpan;
};

export type SourceInvocationReplacement = {
  invocation_id: string;
  operator: string;
  operator_revision: string;
  params?: Record<string, ParamValue>;
};

export type SourceCapabilities = {
  exact_execution: boolean;
  parameter_edits: boolean;
  hierarchy_indexed: boolean;
  structural_edits: boolean;
  channel_contracts: boolean;
  source_edits: boolean;
};

export type SourceDiagnostic = {
  code: string;
  message: string;
  span?: SourceSpan;
};

export type SourceWorkflowInstance = {
  schema_version: number;
  workflow_revision: string;
  source: WorkflowSourcePin;
  profiles?: string[];
  parameters?: WorkflowParameterField[];
  bindings?: Record<string, WorkflowBinding>;
  scopes?: SourceScope[];
  invocations?: SourceInvocation[];
  replacements?: SourceInvocationReplacement[];
  capabilities: SourceCapabilities;
  diagnostics?: SourceDiagnostic[];
};

export type SomiteGraphNode = {
  id: string;
  operator: string;
  operator_revision: string;
  ports: SomitePort[];
  params?: Record<string, ParamValue>;
  source_workflow?: SourceWorkflowInstance;
  layout: { x: number; y: number };
  note?: string;
  color?: CanvasColor;
};

export type SourceWorkflowVariantOrigin = {
  source_node: SomiteGraphNode;
  promoted_invocations?: Record<string, string>;
};

export type SomiteEdge = {
  id: string;
  from_node: string;
  from_port: string;
  to_node: string;
  to_port: string;
};

export type SomiteGraph = {
  schema_version: number;
  name?: string;
  nodes: SomiteGraphNode[];
  edges: SomiteEdge[];
  annotations?: CanvasAnnotation[];
  variant_origin?: SourceWorkflowVariantOrigin;
};

export type ParamSpec = {
  type: string;
  label?: string;
  page?: string;
  default?: ParamValue;
  required?: boolean;
  min?: number;
  max?: number;
};

export type PortSpec = {
  name: string;
  type: PortType;
  union?: PortType[];
  optional?: boolean;
  resource?: ResourceSpec;
};

export type ResourceResolutionKind = "use_existing" | "download" | "build";

export type ResourceResolutionSpec = {
  id: string;
  label: string;
  detail: string;
  kind: ResourceResolutionKind;
  recommended?: boolean;
  download_bytes?: number | null;
  stored_bytes?: number | null;
  scientific_effect?: string;
};

export type ResourceSpec = {
  profile: string;
  title: string;
  detail: string;
  resolutions: ResourceResolutionSpec[];
};

export type ReadinessState = "empty" | "building" | "needs_action" | "ready";
export type RequirementKind = "input" | "parameter" | "managed_resource" | "manual_checkpoint" | "method_details" | "legacy_tool" | "adapter";
export type ResolutionKind = "connect" | "configure" | "use_existing" | "download" | "build" | "attach" | "review" | "setup" | "add_adapter";
export type RequirementInputMode = "connection" | "file" | "text" | "choice" | "guide" | "agent";
export type SupportKind = "input_required" | "managed_tool" | "source_workflow" | "built_in" | "system_tool" | "manual_checkpoint" | "method_details" | "legacy_source" | "adapter";
export type ResolutionRecipeKind = "external_checkpoint" | "environment" | "method_selection" | "artifact_preparation" | "adapter_contract";

export type ResolutionRecipe = {
  id: string;
  title: string;
  summary: string;
  version: string;
  kind: ResolutionRecipeKind;
  steps: string[];
  parameters: string[];
  source_url?: string;
};

export type RequirementField = {
  name: string;
  label: string;
  input_mode: RequirementInputMode;
};

export type ReadinessResolution = {
  id: string;
  label: string;
  detail: string;
  kind: ResolutionKind;
  recommended: boolean;
  download_bytes?: number | null;
  stored_bytes?: number | null;
  scientific_effect?: string;
  source_url?: string;
};

export type ReadinessItem = {
  id: string;
  node_id: string;
  operator_id: string;
  field: string;
  fields: RequirementField[];
  title: string;
  detail: string;
  kind: RequirementKind;
  priority: number;
  escalatable: boolean;
  resource_profile?: string;
  resolutions: ReadinessResolution[];
  recipes: ResolutionRecipe[];
};

export type NodeAssessment = {
  node_id: string;
  operator_id: string;
  title: string;
  kind: SupportKind;
  label: string;
  detail: string;
  requires_action: boolean;
  recipes: ResolutionRecipe[];
};

export type WorkflowAssessment = {
  graph_revision: string;
  state: ReadinessState;
  required_count: number;
  items: ReadinessItem[];
  nodes: NodeAssessment[];
};

export type ReadinessSnapshot = WorkflowAssessment;

export type Operator = {
  id: string;
  revision?: string;
  title: string;
  palette: string[];
  kind: "external" | "inprocess" | "reference" | "source";
  cost: "low" | "high";
  bin?: string;
  pixi?: string[];
  params: Record<string, ParamSpec>;
  ports: { in: PortSpec[]; out: PortSpec[] };
  description?: string;
  topics?: string[];
  expandable?: boolean;
};

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

export type ProjectSession = {
  project_name: string;
  graph_path: string;
  graph: SomiteGraph;
  operators: Operator[];
  recovered_autosave: boolean;
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
  extracted_via: "text" | "poppler" | "ocr" | "jats";
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

export type PaperToolSource = "managed_pixi" | "project_pixi" | "system_path";

export type PaperExtractionToolReadiness = {
  name: string;
  available: boolean;
  path?: string;
  source?: PaperToolSource;
  detail: string;
};

export type PaperExtractionPreflight = {
  native_pdf_text: boolean;
  scanned_pdf_ocr: boolean;
  tools: PaperExtractionToolReadiness[];
};

export type SystemProfile = {
  cpu: string;
  physical_cores: number;
  logical_threads: number;
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
