export type PortType =
  | "Sra"
  | "Fastq"
  | "FastqGz"
  | "Fasta"
  | "FastaGz"
  | "Gtf"
  | "GtfGz"
  | "Bam"
  | "Bai"
  | "Vcf"
  | "VcfGz"
  | "Table"
  | "Json"
  | "Html"
  | "Image"
  | "Zip"
  | "Directory"
  | "Text"
  | "Preview";

export type ParamValue = string | number | boolean;

export type SomitePort = {
  name: string;
  dir: "in" | "out";
  ty: PortType;
  union?: PortType[];
  optional?: boolean;
};

export type SomiteGraphNode = {
  id: string;
  operator: string;
  operator_revision: string;
  ports: SomitePort[];
  params?: Record<string, ParamValue>;
  layout: { x: number; y: number };
  note?: string;
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
};

export type Operator = {
  id: string;
  revision?: string;
  title: string;
  palette: string[];
  kind: "external" | "inprocess" | "reference";
  cost: "low" | "high";
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
};

export type ExportTool = {
  operator_id: string;
  title: string;
  binary?: string;
  packages: string[];
  state: "built_in" | "ready" | "installable" | "system_required" | "adapter_needed";
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
  adapter_count: number;
};

export type PaperCandidate = {
  name: string;
  role: "primary" | "parallel" | "alternative";
  assay: string;
  graph: SomiteGraph;
  warnings: string[];
  evidence: PaperEvidence[];
};

export type PaperReview = {
  extracted_via: "text" | "poppler" | "ocr";
  candidates: PaperCandidate[];
};

export type UploadResult = {
  path: string;
  filename: string;
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
};
