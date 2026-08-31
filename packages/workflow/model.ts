export const GRAPH_SCHEMA_VERSION = 3 as const;

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

export type UnsupportedRequiredWorkflowParameter = {
  name: string;
  label: string;
  group: string;
  description?: string;
  reason: string;
  hidden?: boolean;
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
  unsupported_required_parameters?: UnsupportedRequiredWorkflowParameter[];
  bindings?: Record<string, WorkflowBinding>;
  scopes?: SourceScope[];
  invocations?: SourceInvocation[];
  replacements?: SourceInvocationReplacement[];
  capabilities: SourceCapabilities;
  diagnostics?: SourceDiagnostic[];
};

/** One user-authored, presentation-only group in the flat source canvas. */
export type SourceCanvasGroup = {
  id: string;
  title: string;
  parent_group_id: string | null;
  direct_entity_ids: string[];
  collapsed: boolean;
};

/** Presentation-only state for the flat, user-groupable source canvas. */
export type SourceCanvasView = {
  schema_version: 2;
  source_digest: string;
  groups?: SourceCanvasGroup[];
  positions?: Record<string, CanvasPoint>;
  /** Per-item stack of prior direct groups consumed by Move back. */
  move_history?: Record<string, string[]>;
};

export type SomiteGraphNode = {
  id: string;
  operator: string;
  operator_revision: string;
  ports: SomitePort[];
  params?: Record<string, ParamValue>;
  source_workflow?: SourceWorkflowInstance;
  source_canvas?: SourceCanvasView;
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
