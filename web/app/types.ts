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
};

export type RunResponse = {
  states: Record<string, "cached" | "done" | "failed" | "skipped">;
  artifacts: Record<string, Record<string, { basename: string; declared_type: PortType; size: number; hash: string }>>;
  errors: Record<string, string>;
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
