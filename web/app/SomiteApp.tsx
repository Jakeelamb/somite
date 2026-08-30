"use client";

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  addEdge,
  getBezierPath,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeProps,
  type FinalConnectionState,
  type Node,
  type NodeProps,
  type OnConnectStartParams,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Check,
  CheckCircle2,
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CloudUpload,
  Cpu,
  Eye,
  EyeOff,
  FileSearch,
  FolderOpen,
  LoaderCircle,
  Maximize2,
  MousePointer2,
  Minus,
  Moon,
  PackageOpen,
  Palette,
  PenTool,
  Plus,
  Play,
  Redo2,
  Save,
  ShieldCheck,
  Square,
  StickyNote,
  Sun,
  Undo2,
  X,
} from "lucide-react";
import React, {
  createContext,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AgentPanel,
  InspectorPanel,
  LibraryPanel,
  MachinePanel,
  PaperPanel,
  ProjectPanel,
  ReadinessPanel,
  ToolchainPanel,
} from "./WorkspacePanels";
import { CanvasAnnotations } from "./CanvasAnnotations";
import type { SourceRequest, SourceSearchResult } from "./sourceBuilder";
import { preventBrowserZoomOutsideCanvas } from "./canvasGestures";
import { nextPaperReadSlot, paperCandidateDocument, paperCanvasUpdate, paperResolutionAgentPrompt, replacePaperReadSlot } from "./paperResolution";
import {
  createPaperIntakeCoordinator,
  paperCandidateCanApply,
  paperIntakeIsBusy,
  paperIntakePresentation,
} from "./paperIntake";
import { createPaperIntakeHttpTransport } from "./paperIntakeApi";
import {
  continuationEdge,
  nextContinuationPosition,
  normalizeImportedNodeLayouts,
  type PendingConnection,
} from "./graphInteractions";
import type {
  AgentDiscovery,
  AgentSnapshot,
  CanvasAnnotation,
  CanvasColor,
  SomiteEdge,
  SomiteGraph,
  SomiteGraphNode,
  SomitePort,
  Operator,
  NfcoreCatalog,
  SnakemakeCatalog,
  ParamValue,
  PaperCandidate,
  PaperEvidence,
  PaperSearchResult,
  ExportPlan,
  ProjectSession,
  ReadinessItem,
  ReadinessSnapshot,
  RunNodeState,
  RunStorageProfile,
  RunStatusResponse,
  SystemProfile,
  UploadResult,
  ValidationEvidenceResponse,
  SourceWorkflowVariantOrigin,
  WorkflowBinding,
} from "./types";
import { portColor } from "./visual";
import { edgeLifecycleState, evidenceNodeState } from "./validationState";
import { GraphProjectionClock, type GraphProjectionInput } from "./graphProjection";
import { JsonRequestError, createSomiteClient, type SomiteClient } from "./api";
import { AGENT_POLL_DEGRADED_AFTER, AGENT_POLL_INTERVAL_MS, agentBatchMatchesAuthoritativeState, agentPollCursorAfterSnapshot, agentPollFailureState, compactConsumedAgentEvents, mergeAgentSnapshots, planAgentTransactions, retainAppliedAgentTransactionIds } from "./agentState";
import { readinessAgentPrompt, readinessSummary } from "./readinessState";
import { appendStrokePoint, canvasColor as getCanvasColor, canvasPalette, createCanvasAnnotation, nextAnnotationId } from "./canvasPresentation";
import type { CatalogExpansionActivity } from "./catalogExpansion";
import { editableRequiredSourceFileParameters, mergeCanonicalSourceWorkflow, opaqueNfcoreFallback, sourceScopeTitle, sourceSpanLabel, sourceWorkflowCanAppendGraph, sourceWorkflowCanvasIsEmpty, sourceWorkflowProvider, sourceWorkflowReplacementCandidate, sourceWorkflowRevision, sourceWorkflowSetupLabel, sourceWorkflowTitle } from "./sourceWorkflowPresentation";
import { projectSourceNetwork, sourceNetworkEnterPath, sourceNetworkExitPath } from "./sourceWorkflowNetwork";
import { canonicalRefreshAccepted, canonicalRefreshDisposition, captureGraphWrite, commitIfCanonicalEpochCurrent, enqueueGraphWrite, graphNodeSetChanged, type GraphWritePath, type GraphWriteSnapshot } from "./graphPersistence";
import {
  openProjectDocument,
  redoDocument,
  rememberDocument,
  scopedGraphRequest,
  undoDocument,
  workflowDocument,
  type WorkflowDocumentHistory,
} from "./projectDocument";
import { validationEvidenceRequestPath, workflowCatalogRequestPaths, type WorkflowCatalogLoadState } from "./backgroundRequests";
import { planLocalInputs } from "./localInputPlanning";
import { assessWorkflow } from "@somite/workflow/assessment";
import { OperatorCatalog } from "@somite/workflow/catalog";
import { representativeValidationCapability } from "@somite/workflow/fixtures";

const SNAP: [number, number] = [20, 20];
const HISTORY_LIMIT = 80;
const countFormatter = new Intl.NumberFormat();

type SomiteNodeData = Record<string, unknown> & {
  graphNode: SomiteGraphNode;
  title: string;
  cost: "low" | "high";
  viewerHidden: boolean;
  runState: "idle" | RunNodeState;
  readinessItems: ReadinessItem[];
};
type SomiteFlowNode = Node<SomiteNodeData, "somite">;
type SomiteFlowEdge = Edge<{ somite: SomiteEdge; portType: string; validationState: "idle" | RunNodeState }, "typed">;
type History = WorkflowDocumentHistory;
type Theme = "dark" | "light";
type CanvasTool = "select" | "pen" | "sticky" | "box";
type ContinueFromPort = (nodeId: string, port: SomitePort) => void;
type SourceNetworkView = { nodeId: string; path: string[] } | null;
type OpenNestedCanvas = (nodeId: string) => void;
type SourceWorkflowSemanticEdit =
  | { kind: "set_parameter"; name: string; binding: WorkflowBinding }
  | { kind: "reset_parameter"; name: string }
  | { kind: "replace_invocation"; invocation_id: string; operator: string; operator_revision: string; params: Record<string, ParamValue> }
  | { kind: "reset_invocation"; invocation_id: string };

const ContinuationContext = createContext<ContinueFromPort | null>(null);
const NestedCanvasContext = createContext<OpenNestedCanvas | null>(null);

function SourceWorkflowCanvasCard({ graphNode, readinessItems }: {
  graphNode: SomiteGraphNode;
  readinessItems: ReadinessItem[];
}) {
  const workflow = graphNode.source_workflow;
  const openNestedCanvas = useContext(NestedCanvasContext);
  if (!workflow) return null;
  return (
    <div className="source-workflow-card">
      <header><span>{sourceWorkflowProvider(workflow)}</span><em>Workflow</em></header>
      <strong>{sourceWorkflowTitle(workflow)}</strong>
      <small>{sourceWorkflowRevision(workflow)} · {workflow.replacements?.length ? `${workflow.replacements.length} variant edit${workflow.replacements.length === 1 ? "" : "s"}` : "pinned source"}</small>
      <footer><span>{sourceWorkflowSetupLabel(workflow, readinessItems.length)}</span><button type="button" className="nodrag nopan" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); openNestedCanvas?.(graphNode.id); }}>Enter workflow<ChevronRight size={11} /></button></footer>
    </div>
  );
}

function NestedSourceCanvas({ graphNode, path, operators, onEnter, onExit, onOpenPath, onReplace, onPromote, onReset }: {
  graphNode: SomiteGraphNode;
  path: string[];
  operators: Operator[];
  onEnter: (scopeId: string) => void;
  onExit: () => void;
  onOpenPath: (path: string[]) => void;
  onReplace: (invocationId: string, operator: Operator) => Promise<void>;
  onPromote: (invocationId: string) => Promise<void>;
  onReset: (invocationId: string) => Promise<void>;
}) {
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const [replacementQuery, setReplacementQuery] = useState("");
  const [savingInvocation, setSavingInvocation] = useState<string | null>(null);
  const workflow = graphNode.source_workflow;
  if (!workflow) return null;
  const projection = projectSourceNetwork(workflow, path);
  const currentTitle = projection.current ? sourceScopeTitle(projection.current) : sourceWorkflowTitle(workflow);
  const operatorMap = new Map(operators.map((operator) => [operator.id, operator]));
  const targetCard = projection.cards.find((card) => card.id === replaceTarget);
  const normalizedQuery = replacementQuery.trim().toLowerCase();
  const replacementOperators = operators.filter((operator) =>
    sourceWorkflowReplacementCandidate(operator)
    && (!normalizedQuery || `${operator.title} ${operator.id} ${operator.palette.join(" ")}`.toLowerCase().includes(normalizedQuery))
  );
  const chooseReplacement = async (operator: Operator) => {
    if (!targetCard) return;
    setSavingInvocation(targetCard.invocation.id);
    try {
      await onReplace(targetCard.invocation.id, operator);
      setReplaceTarget(null);
      setReplacementQuery("");
    } finally {
      setSavingInvocation(null);
    }
  };
  const promoteReplacement = async (invocationId: string) => {
    setSavingInvocation(invocationId);
    try {
      await onPromote(invocationId);
    } finally {
      setSavingInvocation(null);
    }
  };

  return (
    <section className="nested-source-canvas" aria-label="Nested source canvas">
      <header className="nested-source-head">
        <button type="button" className="nested-source-return" onClick={onExit}><ChevronLeft size={15} />{projection.path.length > 1 ? "Back one layer" : "Return to main canvas"}</button>
        <div><span>{sourceWorkflowProvider(workflow)} · {sourceWorkflowRevision(workflow)} · pinned</span><strong>{sourceWorkflowTitle(workflow)}</strong></div>
        <em>{workflow.replacements?.length ? `Variant · ${workflow.replacements.length} edit${workflow.replacements.length === 1 ? "" : "s"}` : "Editable variant"}</em>
      </header>
      <nav className="nested-source-breadcrumbs" aria-label="Nested source canvas breadcrumbs">
        {projection.breadcrumbs.map((scope, index) => <React.Fragment key={scope.id}>
          {index > 0 && <ChevronRight size={11} aria-hidden="true" />}
          <button type="button" aria-current={index === projection.breadcrumbs.length - 1 ? "page" : undefined} onClick={() => onOpenPath(projection.path.slice(0, index + 1))}>{sourceScopeTitle(scope)}</button>
        </React.Fragment>)}
      </nav>
      <div className="nested-source-title"><span><strong>{currentTitle}</strong><small>{projection.current?.kind.replaceAll("_", " ") ?? "source workflow"}</small></span><em>{projection.cards.length} immediate call{projection.cards.length === 1 ? "" : "s"}</em></div>
      <div className="nested-source-relation"><i aria-hidden="true" />Source invocations · not data wires</div>
      <div className="nested-source-stage">
        <div className="nested-source-origin"><span>Current scope</span><strong>{currentTitle}</strong></div>
        <i className="nested-source-spine" aria-hidden="true" />
        <section className="nested-source-nodes" aria-label={`Immediate children of ${currentTitle}`}>
          {projection.cards.map((card) => {
            const replacementOperator = card.replacement ? operatorMap.get(card.replacement.operator) : undefined;
            const canEnter = card.canEnter && !card.replacement;
            return <article key={card.id} className={`nested-source-node ${card.scope ? `kind-${card.scope.kind}` : "source-only"} ${canEnter ? "can-enter" : "leaf"} ${card.replacement ? "is-replaced" : ""}`} onDoubleClick={() => canEnter && card.scope && onEnter(card.scope.id)}>
              <header><span>{card.replacement ? "Replacement" : card.scope?.kind.replaceAll("_", " ") ?? "Source call"}</span><em>{card.replacement ? "Unverified" : canEnter ? "Nested" : card.scope ? "Leaf" : "Unresolved"}</em></header>
              <strong>{replacementOperator?.title ?? card.replacement?.operator ?? card.title}</strong>
              {card.replacement && <small className="nested-replacement-origin">Replaces {card.title} · original retained</small>}
              <code>{sourceSpanLabel(card.invocation.span)}</code>
              {card.replacement && <small className="nested-replacement-check"><CircleAlert size={11} aria-hidden="true" />Connections need checking</small>}
              {!card.replacement && !card.scope && <small>Exact call retained · no inferred node</small>}
              <div className="nested-source-actions">
                {canEnter && card.scope && <button type="button" onClick={() => onEnter(card.scope!.id)}>Enter<ChevronRight size={12} /></button>}
                {card.replacement && <button type="button" className="nested-promote-action" disabled={savingInvocation !== null} onClick={() => void promoteReplacement(card.invocation.id)}>Edit on canvas<ChevronRight size={12} /></button>}
                <button type="button" disabled={savingInvocation !== null} onClick={() => { setReplaceTarget(card.id); setReplacementQuery(""); }}>{card.replacement ? "Change tool" : "Replace tool"}</button>
                {card.replacement && <button type="button" disabled={savingInvocation === card.invocation.id} onClick={() => void onReset(card.invocation.id)}>Reset</button>}
              </div>
              {card.replacement && <small className="nested-promote-note">Creates a native typed node · exact source provenance stays attached</small>}
            </article>;
          })}
          {!projection.cards.length && <div className="nested-source-empty"><strong>No child scopes</strong><span>{projection.current ? sourceSpanLabel(projection.current.span) : "No indexed source"}</span></div>}
        </section>
      </div>
      {targetCard && <aside className="nested-replacement-picker" role="dialog" aria-label="Replace source invocation">
        <header><span><strong>Replace {targetCard.title}</strong><small>Choose freely · Somite will check what remains</small></span><button type="button" aria-label="Close replacement picker" onClick={() => setReplaceTarget(null)}><X size={14} /></button></header>
        <input value={replacementQuery} onChange={(event) => setReplacementQuery(event.currentTarget.value)} placeholder="Search tools…" aria-label="Search replacement tools" />
        <div>{replacementOperators.map((operator) => <button type="button" key={operator.id} disabled={savingInvocation !== null} onClick={() => void chooseReplacement(operator)}><span><strong>{operator.title}</strong><code>{operator.id}</code></span><small>{operator.ports.in.length} in · {operator.ports.out.length} out{operator.pixi?.length ? ` · Pixi ${operator.pixi.join(", ")}` : ""}</small></button>)}{!replacementOperators.length && <p>No matching tools.</p>}</div>
      </aside>}
      <footer><span>Editable workflow variant · original source preserved</span><span>Logic checks guide changes · validation proves them</span></footer>
    </section>
  );
}

function SomiteNodeCardBase({ data, selected }: NodeProps<SomiteFlowNode>) {
  const { graphNode, title, viewerHidden, runState, readinessItems } = data;
  const sourceWorkflow = graphNode.source_workflow;
  const openNestedCanvas = useContext(NestedCanvasContext);
  const nodeColor = graphNode.color ? getCanvasColor(graphNode.color) : null;
  const inputs = graphNode.ports.filter((port) => port.dir === "in");
  const outputs = graphNode.ports.filter((port) => port.dir === "out");
  return (
    <article className={`somite-node state-${runState} ${selected ? "is-selected" : ""} ${viewerHidden ? "viewer-hidden" : ""} ${sourceWorkflow ? "source-workflow-node" : ""} ${readinessItems.length ? "needs-readiness" : ""} ${nodeColor ? "has-user-color" : ""}`} style={nodeColor ? { "--node-user-color": nodeColor.hex } as React.CSSProperties : undefined} onDoubleClick={sourceWorkflow && openNestedCanvas ? (event) => { event.stopPropagation(); openNestedCanvas(graphNode.id); } : undefined}>
      <div className="node-floating-title"><i /><span>{title}</span>{nodeColor && <b className="node-stage-label">{nodeColor.label}</b>}{readinessItems.length > 0 ? <em className="node-requirement-badge">{readinessItems.length} needed</em> : runState !== "idle" && <em>{runState}</em>}</div>
      {sourceWorkflow ? (
        <SourceWorkflowCanvasCard graphNode={graphNode} readinessItems={readinessItems} />
      ) : viewerHidden ? (
        <div className="node-collapsed-body">
          <strong>{graphNode.operator.startsWith("nf.") || graphNode.operator.startsWith("smk.") ? "Required Inputs" : title}</strong>
          <span>{inputs.length} inputs · {outputs.length} outputs</span>
        </div>
      ) : (
        <div className="node-viewer">
          <span className="node-operator">{graphNode.operator}</span>
          <NodeViewer node={graphNode} title={title} />
        </div>
      )}
      {!sourceWorkflow && <span className={`viewer-flag ${viewerHidden ? "off" : ""}`} title={viewerHidden ? "Viewer hidden" : "Viewer visible"} />}
      {!sourceWorkflow && !viewerHidden && <span className="node-name">{graphNode.id}</span>}
      <div className="port-column port-inputs">
        {inputs.map((port, index) => <PortHandle key={port.name} nodeId={graphNode.id} port={port} index={index} count={inputs.length} required={readinessItems.some((item) => item.field === port.name && item.kind !== "parameter")} />)}
      </div>
      <div className="port-column port-outputs">
        {outputs.map((port, index) => <PortHandle key={port.name} nodeId={graphNode.id} port={port} index={index} count={outputs.length} />)}
      </div>
    </article>
  );
}

function stringParam(node: SomiteGraphNode, key: string) {
  const value = node.params?.[key];
  return typeof value === "string" ? value : "";
}

function NodeViewer({ node, title }: { node: SomiteGraphNode; title: string }) {
  const operator = node.operator;
  if (operator === "files.import" || operator === "files.import_directory" || operator === "files.import_kraken2_database") {
    const path = stringParam(node, "path");
    const filename = path.split(/[\\/]/).at(-1) || "Choose a file";
    return <div className="viewer-file"><strong>{filename}</strong><span>{operator === "files.import_kraken2_database" ? "Kraken2 database directory" : path ? "local source" : "file input"}</span><div className="sequence-strip" aria-hidden="true"><i>A</i><i>C</i><i>G</i><i>T</i><i>G</i><i>A</i><i>C</i><i>T</i></div></div>;
  }
  if (operator === "files.import_paired") {
    return <div className="viewer-paired"><strong>R1 + R2</strong><span>{stringParam(node, "r1").split(/[\\/]/).at(-1) || "forward reads"}</span><span>{stringParam(node, "r2").split(/[\\/]/).at(-1) || "reverse reads"}</span><div aria-hidden="true"><i /><i /></div></div>;
  }
  if (operator === "qc.fastqc" || operator === "qc.fastp") {
    return <div className="viewer-qc"><div><strong>{operator === "qc.fastp" ? "fastp" : "Per base quality"}</strong><span>quality profile</span></div><svg viewBox="0 0 150 50" role="img" aria-label="Quality profile preview"><path className="qc-grid" d="M0 12H150M0 25H150M0 38H150" /><path className="qc-good" d="M0 15 C18 12,25 18,38 14 S63 11,78 16 S102 18,116 20 S137 26,150 31" /><path className="qc-warn" d="M0 27 C20 25,31 29,45 25 S74 23,92 27 S124 31,150 39" /></svg></div>;
  }
  if (operator.startsWith("nf.") || operator.startsWith("smk.")) {
    const engine = operator.startsWith("nf.") ? "nf-core" : "Snakemake";
    return <div className="viewer-pipeline"><span>{engine}</span><strong>{operator.split(".").slice(1).join("/")}</strong><small>{stringParam(node, "revision") || stringParam(node, "profile") || "workflow"}</small><div aria-hidden="true"><i /><b /><i /><b /><i /></div></div>;
  }
  if (operator === "sra.fasterq_dump") {
    return <div className="viewer-accession"><span>SRA conversion</span><strong>FASTQ</strong><small>separate R1 / R2</small></div>;
  }
  if (operator.startsWith("sra.") || operator.startsWith("ncbi.")) {
    const accession = stringParam(node, "accession") || stringParam(node, "taxon") || operator.split(".").at(-1);
    const output = node.ports.find((port) => port.dir === "out")?.ty ?? "record";
    return <div className="viewer-accession"><span>NCBI source</span><strong>{accession}</strong><small>{output}</small></div>;
  }
  if (operator.startsWith("ensembl.")) {
    const stableId = stringParam(node, "accession") || stringParam(node, "id") || "Ensembl";
    return <div className="viewer-ensembl"><strong>{stableId}</strong><div aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</div><span>{stringParam(node, "sequence_type") || "genomic sequence"}</span></div>;
  }
  if (operator === "sheet.rnaseq") {
    return <div className="viewer-sheet"><span>sample&nbsp;&nbsp; r1&nbsp;&nbsp; r2&nbsp;&nbsp; strand</span><strong>{stringParam(node, "sample") || "sample1"}</strong><small>{stringParam(node, "strandedness") || "auto"}</small></div>;
  }
  return <div className="viewer-generic"><strong>{title}</strong><span>{node.note ?? "Ready to configure"}</span><div className="sequence-trace" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div></div>;
}

const SomiteNodeCard = memo(SomiteNodeCardBase);

function PortHandle({ nodeId, port, index, count, required = false }: { nodeId: string; port: SomitePort; index: number; count: number; required?: boolean }) {
  const top = `${((index + 1) * 100) / (count + 1)}%`;
  const input = port.dir === "in";
  const continueFrom = useContext(ContinuationContext);
  return (
    <div className={`port-row ${input ? "input" : "output"} ${required ? "required" : ""}`} style={{ top }}>
      <span title={port.name}>{port.name}</span>
      {required && <CircleAlert className="port-requirement" size={11} aria-label={`${nodeId}.${port.name} is required`} />}
      {!input && <button type="button" className="port-continue nodrag nowheel" aria-label={`Continue from ${nodeId}.${port.name}`} title={`Continue from ${port.name}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); continueFrom?.(nodeId, port); }}>+</button>}
      <Handle
        id={port.name}
        type={input ? "target" : "source"}
        position={input ? Position.Left : Position.Right}
        title={`${port.name}: ${port.ty}`}
        style={{ backgroundColor: portColor[port.ty] ?? "#8b949b" }}
      />
    </div>
  );
}

const nodeTypes = { somite: SomiteNodeCard };

function TypedEdgeBase({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps<SomiteFlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.42 });
  const state = data?.validationState ?? "idle";
  const stroke = state === "done" || state === "cached" ? "var(--success)" : state === "failed" || state === "cancelled" ? "var(--danger)" : state === "running" || state === "queued" ? "var(--warning)" : state === "skipped" ? "var(--muted)" : portColor[data?.portType ?? ""] ?? "#8b949b";
  const dash = state === "failed" || state === "cancelled" ? "7 4" : state === "running" || state === "queued" ? "5 5" : state === "skipped" ? "2 5" : undefined;
  return <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke, strokeDasharray: dash, strokeWidth: selected ? 3 : state === "done" || state === "cached" ? 2.6 : 2.1, opacity: selected ? 1 : state === "skipped" ? .48 : .86 }} />;
}

const TypedEdge = memo(TypedEdgeBase);
const edgeTypes = { typed: TypedEdge };

function flowNode(node: SomiteGraphNode, operators: Map<string, Operator>, viewerHidden = false, runState: SomiteNodeData["runState"] = "idle", readinessItems: ReadinessItem[] = []): SomiteFlowNode {
  const operator = operators.get(node.operator);
  const importedTitle = node.operator === "workflow.reference" && typeof node.params?.component === "string"
    ? node.params.component.split(":").at(-1)?.replaceAll("_", " ")
    : undefined;
  return {
    id: node.id,
    type: "somite",
    position: node.layout,
    data: { graphNode: node, title: node.source_workflow ? sourceWorkflowTitle(node.source_workflow) : importedTitle ?? operator?.title ?? node.operator, cost: operator?.cost ?? "high", viewerHidden, runState, readinessItems },
  };
}

function edgePortType(edge: SomiteEdge, graphNodes: SomiteGraphNode[]) {
  return graphNodes.find((node) => node.id === edge.from_node)?.ports.find((port) => port.dir === "out" && port.name === edge.from_port)?.ty ?? "Text";
}

function flowEdge(edge: SomiteEdge, graphNodes: SomiteGraphNode[]): SomiteFlowEdge {
  return {
    id: edge.id,
    source: edge.from_node,
    sourceHandle: edge.from_port,
    target: edge.to_node,
    targetHandle: edge.to_port,
    type: "typed",
    markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13 },
    data: { somite: edge, portType: edgePortType(edge, graphNodes), validationState: "idle" },
  };
}

function pairedCompanion(edge: SomiteEdge, graphNodes: SomiteGraphNode[]): SomiteEdge | null {
  const pair = edge.from_port === "r1" && edge.to_port === "r1" ? "r2" : edge.from_port === "r2" && edge.to_port === "r2" ? "r1" : null;
  if (!pair) return null;
  const source = graphNodes.find((node) => node.id === edge.from_node);
  const target = graphNodes.find((node) => node.id === edge.to_node);
  const output = source?.ports.find((port) => port.dir === "out" && port.name === pair);
  const input = target?.ports.find((port) => port.dir === "in" && port.name === pair);
  if (!output || !input) return null;
  const compatible = output.ty === input.ty || input.union?.includes(output.ty) || output.union?.includes(input.ty);
  if (!compatible) return null;
  return {
    id: `e-${edge.from_node}-${pair}-${edge.to_node}-${pair}`,
    from_node: edge.from_node,
    from_port: pair,
    to_node: edge.to_node,
    to_port: pair,
  };
}

function somiteGraph(name: string, nodes: SomiteFlowNode[], edges: SomiteFlowEdge[], annotations: CanvasAnnotation[] = [], variantOrigin?: SourceWorkflowVariantOrigin): SomiteGraph {
  return {
    schema_version: 3,
    name,
    nodes: nodes.map((node) => ({ ...node.data.graphNode, layout: { x: node.position.x, y: node.position.y } })),
    edges: edges.map((edge) => edge.data?.somite).filter((edge): edge is SomiteEdge => Boolean(edge)),
    annotations,
    ...(variantOrigin ? { variant_origin: variantOrigin } : {}),
  };
}

function workflowName(graph: SomiteGraph, graphPath: string) {
  const explicit = graph.name?.trim();
  if (explicit) return explicit;
  const filename = graphPath.split(/[\\/]/).at(-1) ?? "";
  const stem = filename.replace(/\.somite\.json$/i, "").replace(/\.json$/i, "");
  if (!stem || /^(web|graph)$/i.test(stem)) return "Untitled workflow";
  return stem.replaceAll(/[-_]+/g, " ").trim() || "Untitled workflow";
}

function normalizedWorkflowName(name: string) {
  return name.trim() || "Untitled workflow";
}

function safeWorkflowFilename(name: string) {
  const safe = [...normalizedWorkflowName(name)]
    .map((character) => /[a-z0-9_-]/i.test(character) ? character : "-")
    .join("")
    .replace(/^-+|-+$/g, "");
  return safe || "somite-workflow";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function nextNodeId(operator: Operator, nodes: SomiteFlowNode[]) {
  const stem = operator.id.split(".").at(-1)?.replaceAll(/[^a-z0-9]/gi, "") || "node";
  const used = new Set(nodes.map((node) => node.id));
  let index = 1;
  while (used.has(`${stem}${index}`)) index += 1;
  return `${stem}${index}`;
}

function makeGraphNode(operator: Operator, id: string, position: { x: number; y: number }, params: Record<string, ParamValue> = {}): SomiteGraphNode {
  const defaults = Object.fromEntries(Object.entries(operator.params).filter(([, spec]) => spec.default !== undefined).map(([key, spec]) => [key, spec.default as ParamValue]));
  return {
    id,
    operator: operator.id,
    operator_revision: operator.revision ?? "",
    ports: [
      ...operator.ports.in.map((port) => ({ name: port.name, dir: "in" as const, ty: port.type, ...(port.union?.length ? { union: port.union } : {}), ...(port.optional ? { optional: true } : {}) })),
      ...operator.ports.out.map((port) => ({ name: port.name, dir: "out" as const, ty: port.type, ...(port.union?.length ? { union: port.union } : {}), ...(port.optional ? { optional: true } : {}) })),
    ],
    params: { ...defaults, ...params },
    layout: position,
  };
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

function eventClientPoint(event: MouseEvent | TouchEvent) {
  if ("changedTouches" in event) {
    const touch = event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}

function neighborAlignment(node: SomiteFlowNode, nodes: SomiteFlowNode[]) {
  const threshold = 9;
  let x: number | undefined;
  let y: number | undefined;
  let dx = threshold + 1;
  let dy = threshold + 1;
  for (const other of nodes) {
    if (other.id === node.id) continue;
    const nextDx = Math.abs(other.position.x - node.position.x);
    const nextDy = Math.abs(other.position.y - node.position.y);
    if (nextDx < dx && nextDx <= threshold) {
      dx = nextDx;
      x = other.position.x;
    }
    if (nextDy < dy && nextDy <= threshold) {
      dy = nextDy;
      y = other.position.y;
    }
  }
  return { x, y };
}

function SomiteWorkspace({ initialQuery, client }: { initialQuery: string; client: SomiteClient }) {
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [system, setSystem] = useState<SystemProfile | null>(null);
  const [storage, setStorage] = useState<RunStorageProfile | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageReclaiming, setStorageReclaiming] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [paperToolsInstalling, setPaperToolsInstalling] = useState(false);
  const [paperToolsError, setPaperToolsError] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<SomiteFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SomiteFlowEdge>([]);
  const [flow, setFlow] = useState<ReactFlowInstance<SomiteFlowNode, SomiteFlowEdge> | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDeferredValue(query);
  const [libraryVisible, setLibraryVisible] = useState(true);
  const [projectVisible, setProjectVisible] = useState(false);
  const [machineVisible, setMachineVisible] = useState(false);
  const [toolchainVisible, setToolchainVisible] = useState(false);
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportDownloading, setExportDownloading] = useState(false);
  const [paperVisible, setPaperVisible] = useState(false);
  const [agentVisible, setAgentVisible] = useState(false);
  const [canvasTool, setCanvasTool] = useState<CanvasTool>("select");
  const [activeCanvasColor, setActiveCanvasColor] = useState<CanvasColor>("yellow");
  const [annotations, setAnnotations] = useState<CanvasAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [readinessVisible, setReadinessVisible] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [readinessRetry, setReadinessRetry] = useState(0);
  const [validationEvidence, setValidationEvidence] = useState<ValidationEvidenceResponse | null>(null);
  const [agentDraft, setAgentDraft] = useState<{ id: number; message: string } | null>(null);
  const [agentSnapshot, setAgentSnapshot] = useState<AgentSnapshot>({ connected: false, connecting: false, busy: false, config_options: [], cursor: 0, events: [] });
  const [agentTransportError, setAgentTransportError] = useState<string | null>(null);
  const [agentDiscovery, setAgentDiscovery] = useState<AgentDiscovery | null>(null);
  const [agentDiscoveryLoading, setAgentDiscoveryLoading] = useState(false);
  const paperIntakeCoordinator = useMemo(
    () => createPaperIntakeCoordinator(createPaperIntakeHttpTransport(client)),
    [client],
  );
  const [paperIntake, setPaperIntake] = useState(() => paperIntakeCoordinator.getState());
  const paperReview = paperIntake.current?.review ?? null;
  const [activePaperCandidate, setActivePaperCandidate] = useState(0);
  const [appliedPaperCandidate, setAppliedPaperCandidate] = useState<number | null>(null);
  const paperBusy = paperIntakeIsBusy(paperIntake.activity);
  const [paperPreparingField, setPaperPreparingField] = useState<string | null>(null);
  const [nfcoreCatalog, setNfcoreCatalog] = useState<NfcoreCatalog | null>(null);
  const [snakemakeCatalog, setSnakemakeCatalog] = useState<SnakemakeCatalog | null>(null);
  const [workflowCatalogState, setWorkflowCatalogState] = useState<WorkflowCatalogLoadState>("idle");
  const [categoryOpen, setCategoryOpen] = useState<Record<string, boolean>>({});
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recent, setRecent] = useState<string[]>([]);
  const [catalogExpansion, setCatalogExpansion] = useState<CatalogExpansionActivity | null>(null);
  const [workflowTitle, setWorkflowTitle] = useState("Untitled workflow");
  const [titleEditing, setTitleEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Connecting to the local Somite engine…");
  const [saving, setSaving] = useState(false);
  const [inputOriginRecovering, setInputOriginRecovering] = useState(false);
  const [activeIntent, setActiveIntent] = useState<"run" | "validation" | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [sourceNetworkView, setSourceNetworkView] = useState<SourceNetworkView>(null);
  const [variantOrigin, setVariantOrigin] = useState<SourceWorkflowVariantOrigin | undefined>();
  const [theme, setTheme] = useState<Theme>("dark");
  const [snapGuides, setSnapGuides] = useState<{ x?: number; y?: number }>({});
  const [pendingAddPosition, setPendingAddPosition] = useState<{ x: number; y: number } | null>(null);
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  const [pendingSourceFile, setPendingSourceFile] = useState<{ nodeId: string; file: File; parameterNames: string[] } | null>(null);
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [libraryStateLoaded, setLibraryStateLoaded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const presentedPaperRequestRef = useRef(0);
  const dragSnapshotRef = useRef<SomiteGraph | null>(null);
  const paramHistoryKeyRef = useRef<string | null>(null);
  const connectionStartRef = useRef<Pick<PendingConnection, "nodeId" | "port"> | null>(null);
  const drawingRef = useRef<Extract<CanvasAnnotation, { kind: "stroke" }> | null>(null);
  const semanticKeyRef = useRef("");
  const agentCursorRef = useRef(0);
  const appliedAgentTransactionsRef = useRef(new Set<string>());
  const agentPollInFlightRef = useRef(false);
  const previousSemanticKeyRef = useRef("");
  const graphSnapshotRef = useRef<SomiteGraph>({ schema_version: 3, name: "Untitled workflow", nodes: [], edges: [], annotations: [] });
  const inputOriginIdRef = useRef("");
  const graphProjectionClockRef = useRef<GraphProjectionClock | null>(null);
  const graphProjectionInputRef = useRef<GraphProjectionInput | null>(null);
  if (!graphProjectionClockRef.current) graphProjectionClockRef.current = new GraphProjectionClock();
  const graphEpochRef = useRef(0);
  const canonicalEpochRef = useRef(0);
  const stateRevisionRef = useRef("");
  const acknowledgedGraphRef = useRef("");
  const acknowledgedInputOriginIdRef = useRef("");
  const browserWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const reconcilingGraphRef = useRef(false);
  const titleEditStartRef = useRef<{ graph: SomiteGraph; dirty: boolean; title: string } | null>(null);
  const titleEditCancelledRef = useRef(false);
  const initialViewportFitRef = useRef(false);
  const workflowCatalogLoadInFlightRef = useRef(false);
  const running = activeIntent !== null;
  const inputOriginRecoveryRequired = Boolean(session?.input_origin_warning);
  const inputOriginBlockedReason = inputOriginRecoveryRequired
    ? "Confirm the original workflow location or choose this project folder first. Relative files must never resolve from an uncertain folder."
    : null;

  const availableOperators = useMemo(() => {
    const operators = new Map<string, Operator>();
    for (const operator of session?.operators ?? []) operators.set(operator.id, operator);
    for (const entry of nfcoreCatalog?.entries ?? []) operators.set(entry.operator.id, { ...entry.operator, description: entry.description, topics: entry.topics });
    for (const entry of snakemakeCatalog?.entries ?? []) operators.set(entry.operator.id, { ...entry.operator, description: `${entry.description}${entry.stars ? ` · ★ ${entry.stars}` : ""}${entry.expandable ? " · graph ready" : " · graph pending upstream"}`, topics: entry.topics, expandable: entry.expandable });
    return [...operators.values()];
  }, [nfcoreCatalog, session, snakemakeCatalog]);
  const operatorMap = useMemo(() => new Map(availableOperators.map((operator) => [operator.id, operator])), [availableOperators]);
  const workflowCatalog = useMemo(() => session ? new OperatorCatalog(session.operators) : null, [session]);
  const projectionInput: GraphProjectionInput = { name: workflowTitle, nodes, edges, annotations, variantOrigin };
  graphProjectionInputRef.current = projectionInput;
  const projection = graphProjectionClockRef.current.observe(projectionInput);
  if (projection.graphChanged) graphEpochRef.current += 1;
  graphSnapshotRef.current = projection.graph;
  const snapshot = useCallback(() => graphSnapshotRef.current, []);
  const snapshotDocument = useCallback((graph = snapshot()) => workflowDocument(graph, inputOriginIdRef.current), [snapshot]);
  const graphRequest = useCallback((graph = snapshot()) => scopedGraphRequest(snapshotDocument(graph)), [snapshot, snapshotDocument]);
  const renderedGraph = projection.graph;
  const semanticKey = projection.semanticKey;
  semanticKeyRef.current = semanticKey;
  const validationCapability = useMemo(() => representativeValidationCapability(renderedGraph), [renderedGraph]);

  useEffect(() => {
    return paperIntakeCoordinator.subscribe((next) => {
      setPaperIntake(next);
      const activity = next.activity;
      if (activity.status !== "idle") {
        const presentation = paperIntakePresentation(next);
        setStatus(`${presentation.headline} · ${activity.source.label}`);
      }
      const requestId = next.current?.requestId;
      if (!requestId || presentedPaperRequestRef.current === requestId) return;
      presentedPaperRequestRef.current = requestId;
      setActivePaperCandidate(0);
      setAppliedPaperCandidate(null);
    });
  }, [paperIntakeCoordinator]);

  useEffect(() => {
    const previous = previousSemanticKeyRef.current;
    previousSemanticKeyRef.current = semanticKey;
    if (!previous || previous === semanticKey) return;
    setReadiness(null);
    setReadinessError(null);
    setValidationEvidence(null);
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, runState: "idle", readinessItems: [] } })));
    setEdges((current) => current.map((edge) => ({ ...edge, animated: false, data: edge.data ? { ...edge.data, validationState: "idle" } : edge.data })));
  }, [semanticKey, setEdges, setNodes]);

  useEffect(() => {
    const graph = graphSnapshotRef.current;
    const requestPath = validationEvidenceRequestPath({
      sessionReady: Boolean(session),
      activeIntent: Boolean(activeIntent),
      workflowReady: readiness?.state === "ready",
      graph,
    });
    if (!requestPath) return;
    const requestedKey = semanticKey;
    const timeout = window.setTimeout(() => {
      void client.validationEvidence(graphRequest(graph))
        .then((evidence) => {
          if (semanticKeyRef.current !== requestedKey) return;
          setValidationEvidence(evidence);
          if (!evidence.receipt) return;
          const nodeStates = Object.fromEntries(Object.entries(evidence.receipt.node_results).map(([node, result]) => [node, evidenceNodeState(result)])) as Record<string, RunNodeState>;
          setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, runState: nodeStates[node.id] ?? "idle" } })));
          setEdges((current) => current.map((edge) => {
            const result = evidence.receipt?.edge_results[edge.id];
            const validationState = result ? evidenceNodeState(result) : "idle";
            return { ...edge, data: edge.data ? { ...edge.data, validationState } : edge.data };
          }));
        })
        .catch(() => undefined);
    }, 240);
    return () => window.clearTimeout(timeout);
  }, [activeIntent, client, graphRequest, readiness?.state, semanticKey, session, setEdges, setNodes]);

  useEffect(() => {
    if (!workflowCatalog || activeIntent) return;
    const requestedKey = semanticKey;
    const graph = graphSnapshotRef.current;
    let cancelled = false;
    let outcome: { readiness: ReadinessSnapshot; error: null } | { readiness: null; error: string };
    try {
      outcome = { readiness: assessWorkflow(graph, workflowCatalog), error: null };
    } catch (error) {
      outcome = { readiness: null, error: errorMessage(error) };
    }
    queueMicrotask(() => {
      if (cancelled || semanticKeyRef.current !== requestedKey) return;
      setReadinessError(outcome.error);
      setReadiness(outcome.readiness);
      const itemsByNode = new Map<string, ReadinessItem[]>();
      for (const item of outcome.readiness?.items ?? []) itemsByNode.set(item.node_id, [...(itemsByNode.get(item.node_id) ?? []), item]);
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, readinessItems: itemsByNode.get(node.id) ?? [] } })));
    });
    return () => { cancelled = true; };
  }, [activeIntent, readinessRetry, semanticKey, setNodes, workflowCatalog]);

  const remember = useCallback((graph = snapshot()) => {
    setHistory((current) => rememberDocument(current, snapshotDocument(graph), HISTORY_LIMIT));
  }, [snapshot, snapshotDocument]);

  const fitGraph = useCallback((duration = 260) => {
    window.setTimeout(() => {
      void flow?.fitView({ padding: .25, duration, maxZoom: 1 });
    }, 0);
  }, [flow]);

  const restoreGraph = useCallback((
    graph: SomiteGraph,
    markDirty = true,
    fitAfterRestore = false,
    inputOriginId = inputOriginIdRef.current,
    preservePresentation = true,
  ) => {
    const hidden = preservePresentation ? new Map(nodes.map((node) => [node.id, node.data.viewerHidden])) : new Map<string, boolean>();
    const states = preservePresentation ? new Map(nodes.map((node) => [node.id, node.data.runState])) : new Map<string, RunNodeState>();
    const requirements = preservePresentation ? new Map(nodes.map((node) => [node.id, node.data.readinessItems])) : new Map<string, ReadinessItem[]>();
    if (inputOriginId) inputOriginIdRef.current = inputOriginId;
    setWorkflowTitle(graph.name ?? "Untitled workflow");
    setNodes(graph.nodes.map((node) => flowNode(node, operatorMap, hidden.get(node.id) ?? false, states.get(node.id) ?? "idle", requirements.get(node.id) ?? [])));
    setEdges(graph.edges.map((edge) => flowEdge(edge, graph.nodes)));
    setAnnotations(graph.annotations ?? []);
    setVariantOrigin(graph.variant_origin);
    setSelectedIds([]);
    setSelectedAnnotationId(null);
    setDirty(markDirty);
    if (fitAfterRestore) fitGraph();
  }, [fitGraph, nodes, operatorMap, setEdges, setNodes]);

  const writeBrowserGraph = useCallback((path: GraphWritePath, snapshot: GraphWriteSnapshot) => {
    return enqueueGraphWrite(
      browserWriteChainRef,
      () => stateRevisionRef.current,
      (revision) => {
        stateRevisionRef.current = revision;
        acknowledgedGraphRef.current = JSON.stringify(snapshot.graph);
        acknowledgedInputOriginIdRef.current = snapshot.input_origin_id ?? acknowledgedInputOriginIdRef.current;
      },
      (requestPath, request) => client.writeGraph(requestPath, request),
      path,
      snapshot,
      () => canonicalEpochRef.current,
    );
  }, [client]);

  const markCanonicalGraph = useCallback((graph: SomiteGraph, preserveCurrentProjection = false) => {
    const primed = graphProjectionClockRef.current!.prime(
      graph,
      preserveCurrentProjection ? graphProjectionInputRef.current ?? undefined : undefined,
    );
    graphEpochRef.current += 1;
    canonicalEpochRef.current = graphEpochRef.current;
    graphSnapshotRef.current = graph;
    semanticKeyRef.current = primed.semanticKey;
  }, []);

  const refreshCanonicalSession = useCallback(async () => {
    if (reconcilingGraphRef.current) return { disposition: "busy" as const };
    reconcilingGraphRef.current = true;
    const requested = {
      canonicalEpoch: canonicalEpochRef.current,
      graphEpoch: graphEpochRef.current,
      stateRevision: stateRevisionRef.current,
    };
    try {
      const loaded = await client.session();
      const disposition = canonicalRefreshDisposition(
        requested,
        {
          canonicalEpoch: canonicalEpochRef.current,
          graphEpoch: graphEpochRef.current,
          stateRevision: stateRevisionRef.current,
        },
      );
      if (disposition === "stale") return { disposition };

      const localDraft = graphSnapshotRef.current;
      const localDocument = snapshotDocument(localDraft);
      const localKey = JSON.stringify(localDraft);
      const loadedKey = JSON.stringify(loaded.graph);
      const localDiffers = localKey !== loadedKey || localDocument.input_origin_id !== loaded.input_origin_id;
      stateRevisionRef.current = loaded.state_revision;
      acknowledgedGraphRef.current = loadedKey;
      acknowledgedInputOriginIdRef.current = loaded.input_origin_id;
      setSession(loaded);
      if (disposition === "preserve_local") {
        if (localDiffers) {
          setHistory((current) => ({
            past: [...current.past, workflowDocument(loaded.graph, loaded.input_origin_id)].slice(-HISTORY_LIMIT),
            future: [],
          }));
        }
        markCanonicalGraph(localDraft, true);
        setDirty(localDiffers);
        return { disposition, loaded };
      }

      if (localDiffers) {
        setHistory((current) => ({
          past: [...current.past, localDocument].slice(-HISTORY_LIMIT),
          future: [],
        }));
      }
      markCanonicalGraph(loaded.graph);
      restoreGraph(loaded.graph, false, graphNodeSetChanged(localDraft, loaded.graph), loaded.input_origin_id);
      return { disposition, loaded };
    } finally {
      reconcilingGraphRef.current = false;
    }
  }, [client, markCanonicalGraph, restoreGraph, snapshotDocument]);

  const reconcileGraphConflict = useCallback(async (error: unknown) => {
    if (!(error instanceof JsonRequestError) || error.status !== 409) return false;
    try {
      const result = await refreshCanonicalSession();
      if (result.disposition === "busy") return true;
      if (result.disposition === "stale") {
        setStatus("A newer canvas state already arrived · ignored the late conflict refresh");
      } else if (result.disposition === "preserve_local") {
        setStatus("Refreshed the server revision · kept edits made while refreshing · server canvas is available in Undo");
      } else {
        setStatus("A newer canvas change was preserved · refreshed safely · your local draft is available in Undo");
      }
    } catch (refreshError) {
      setStatus(`Canvas changed elsewhere and could not be refreshed — ${errorMessage(refreshError)}`);
    }
    return true;
  }, [refreshCanonicalSession]);

  const recoverInputOrigin = useCallback(async (inputOriginId: string, label: string) => {
    setInputOriginRecovering(true);
    setStatus(`Confirming workflow input location from ${label}…`);
    const operation = browserWriteChainRef.current.then(() => client.recoverInputOrigin(
      stateRevisionRef.current,
      inputOriginId,
    ));
    browserWriteChainRef.current = operation.then(() => undefined, () => undefined);
    try {
      const recovered = await operation;
      stateRevisionRef.current = recovered.state_revision;
      inputOriginIdRef.current = recovered.input_origin_id;
      acknowledgedInputOriginIdRef.current = recovered.input_origin_id;
      setSession((current) => current ? {
        ...current,
        state_revision: recovered.state_revision,
        input_origin_id: recovered.input_origin_id,
        input_origin_warning: null,
      } : current);
      setStatus(`Workflow input location confirmed · ${label} · save, Agent, export, validation, and run are available`);
      return recovered;
    } catch (error) {
      await reconcileGraphConflict(error);
      setStatus(`Could not confirm workflow input location — ${errorMessage(error)}`);
      throw error;
    } finally {
      setInputOriginRecovering(false);
    }
  }, [client, reconcileGraphConflict]);

  const startTitleEdit = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
    titleEditStartRef.current = { graph: snapshot(), dirty, title: workflowTitle };
    titleEditCancelledRef.current = false;
    setTitleEditing(true);
    if (workflowTitle === "Untitled workflow") event.currentTarget.select();
  }, [dirty, snapshot, workflowTitle]);

  const finishTitleEdit = useCallback(() => {
    const start = titleEditStartRef.current;
    setTitleEditing(false);
    if (!start) return;
    if (titleEditCancelledRef.current) {
      titleEditCancelledRef.current = false;
      titleEditStartRef.current = null;
      return;
    }
    const title = normalizedWorkflowName(workflowTitle);
    setWorkflowTitle(title);
    titleEditStartRef.current = null;
    if (title === start.title) {
      setDirty(start.dirty);
      return;
    }
    remember(start.graph);
    setDirty(true);
    setExportPlan(null);
    setStatus(`Renamed workflow to ${title}`);
  }, [remember, workflowTitle]);

  const cancelTitleEdit = useCallback((input: HTMLInputElement) => {
    const start = titleEditStartRef.current;
    if (!start) return;
    titleEditCancelledRef.current = true;
    setWorkflowTitle(start.title);
    setDirty(start.dirty);
    input.blur();
  }, []);

  const mergeAgentSnapshot = useCallback((incoming: AgentSnapshot, eventsWereCanonicallyConsumed = false) => {
    agentCursorRef.current = agentPollCursorAfterSnapshot(
      agentCursorRef.current,
      incoming.cursor,
      eventsWereCanonicallyConsumed,
    );
    setAgentSnapshot((current) => {
      const merged = mergeAgentSnapshots(current, incoming);
      return eventsWereCanonicallyConsumed
        ? { ...merged, events: compactConsumedAgentEvents(merged.events, appliedAgentTransactionsRef.current) }
        : merged;
    });
  }, []);

  const refreshAgentDiscovery = useCallback(async () => {
    setAgentDiscoveryLoading(true);
    try {
      setAgentDiscovery(await client.discoverAgents());
    } catch (error) {
      setStatus(`Agent scan failed — ${errorMessage(error)}`);
    } finally {
      setAgentDiscoveryLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!session || (!agentVisible && !agentSnapshot.connected && !agentSnapshot.connecting)) return;
    let stopped = false;
    let timer: number | undefined;
    let consecutiveFailures = 0;
    const schedule = (delayMs: number) => {
      if (!stopped) timer = window.setTimeout(() => void poll(), delayMs);
    };
    const poll = async () => {
      if (agentPollInFlightRef.current) {
        schedule(AGENT_POLL_INTERVAL_MS);
        return;
      }
      agentPollInFlightRef.current = true;
      let nextDelayMs = AGENT_POLL_INTERVAL_MS;
      try {
        const incoming = await client.agentEvents(agentCursorRef.current);
        if (stopped) return;
        const recovered = consecutiveFailures >= AGENT_POLL_DEGRADED_AFTER;
        consecutiveFailures = 0;
        setAgentTransportError(null);
        if (recovered) setStatus("Agent connection restored");
        if (incoming.events.some((event) => event.kind === "status" && event.status === "ready")) {
          setStatus(`${incoming.agent_name ?? "Agent"} is ready`);
        }
        let plan = planAgentTransactions(
          incoming.events,
          appliedAgentTransactionsRef.current,
          stateRevisionRef.current,
        );
        let supersededByRefresh = false;
        const needsAuthoritativeRefresh = !agentBatchMatchesAuthoritativeState(
          plan,
          stateRevisionRef.current,
          incoming.authoritative_state_revision,
        );
        if (needsAuthoritativeRefresh) {
          const refreshed = await refreshCanonicalSession();
          if (!canonicalRefreshAccepted(refreshed.disposition)) return;
          plan = planAgentTransactions(
            incoming.events,
            appliedAgentTransactionsRef.current,
            stateRevisionRef.current,
            true,
          );
          supersededByRefresh = plan.apply.length === 0
            && plan.represented.length > 0;
        }
        if (plan.apply.length) {
          const transactions = plan.apply;
          const localDraft = graphSnapshotRef.current;
          const hasLocalDraft = JSON.stringify(localDraft) !== acknowledgedGraphRef.current;
          const precedingGraphs: SomiteGraph[] = [];
          let nextGraph = localDraft;
          for (const transaction of transactions) {
            precedingGraphs.push(nextGraph);
            nextGraph = transaction.graph;
          }
          const last = transactions.at(-1)!;
          stateRevisionRef.current = last.state_revision;
          acknowledgedGraphRef.current = JSON.stringify(nextGraph);
          setSession((current) => current ? {
            ...current,
            state_revision: last.state_revision,
            graph: nextGraph,
          } : current);
          if (hasLocalDraft) {
            setHistory((current) => ({
              past: [...current.past, ...transactions.map((transaction) => snapshotDocument(transaction.graph))].slice(-HISTORY_LIMIT),
              future: [],
            }));
            markCanonicalGraph(localDraft, true);
            setDirty(true);
            setStatus(`Agent finished “${last.summary}” · kept your newer canvas edits · Agent result is available in Undo`);
          } else {
            setHistory((current) => ({
              past: [...current.past, ...precedingGraphs.map((graph) => snapshotDocument(graph))].slice(-HISTORY_LIMIT),
              future: [],
            }));
            markCanonicalGraph(nextGraph);
            restoreGraph(nextGraph, false, graphNodeSetChanged(localDraft, nextGraph));
            setStatus(transactions.length === 1
              ? `Agent applied “${last.summary}” · Undo available`
              : `Agent applied ${transactions.length} transactions · Undo each from the history`);
          }
        }
        appliedAgentTransactionsRef.current = retainAppliedAgentTransactionIds(
          appliedAgentTransactionsRef.current,
          [...plan.represented, ...plan.apply].map((transaction) => transaction.transaction_id),
        );
        mergeAgentSnapshot(incoming, true);
        if (supersededByRefresh) {
          setStatus("Agent activity was already superseded by the current server canvas · no older graph was replayed");
        } else if (needsAuthoritativeRefresh && !plan.apply.length) {
          setStatus("Canvas synchronized with the current server state");
        }
      } catch (error) {
        if (stopped) return;
        consecutiveFailures += 1;
        const failure = agentPollFailureState(consecutiveFailures);
        nextDelayMs = failure.retryDelayMs;
        if (failure.degraded) {
          const detail = errorMessage(error);
          setAgentTransportError(detail);
          if (consecutiveFailures === AGENT_POLL_DEGRADED_AFTER) {
            setStatus(`Agent connection interrupted — ${detail} · canvas work remains available`);
          }
        }
      } finally {
        agentPollInFlightRef.current = false;
        schedule(nextDelayMs);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agentSnapshot.connected, agentSnapshot.connecting, agentVisible, client, markCanonicalGraph, mergeAgentSnapshot, refreshCanonicalSession, restoreGraph, session, snapshotDocument]);

  const undo = useCallback(() => {
    const current = snapshotDocument();
    const transition = undoDocument(history, current, HISTORY_LIMIT);
    if (!transition) {
      setStatus("Nothing to undo");
      return;
    }
    setHistory(transition.history);
    restoreGraph(
      transition.document.graph,
      true,
      graphNodeSetChanged(current.graph, transition.document.graph),
      transition.document.input_origin_id,
    );
    setStatus("Undid edit");
  }, [history, restoreGraph, snapshotDocument]);

  const redo = useCallback(() => {
    const current = snapshotDocument();
    const transition = redoDocument(history, current, HISTORY_LIMIT);
    if (!transition) {
      setStatus("Nothing to redo");
      return;
    }
    setHistory(transition.history);
    restoreGraph(
      transition.document.graph,
      true,
      graphNodeSetChanged(current.graph, transition.document.graph),
      transition.document.input_origin_id,
    );
    setStatus("Redid edit");
  }, [history, restoreGraph, snapshotDocument]);

  useEffect(() => {
    const stored = window.localStorage.getItem("somite.theme.v1");
    if (stored !== "light" && stored !== "dark") return;
    const timeout = window.setTimeout(() => setTheme(stored), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("somite.theme.v1", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f7f5" : "#050505");
  }, [theme]);

  useEffect(() => {
    document.addEventListener("wheel", preventBrowserZoomOutsideCanvas, { passive: false });
    return () => document.removeEventListener("wheel", preventBrowserZoomOutsideCanvas);
  }, []);

  useEffect(() => {
    const requested = {
      canonicalEpoch: canonicalEpochRef.current,
      graphEpoch: graphEpochRef.current,
      stateRevision: stateRevisionRef.current,
    };
    client.session()
      .then((loaded) => {
        const operators = new Map(loaded.operators.map((operator) => [operator.id, operator]));
        const localDraft = graphSnapshotRef.current;
        const disposition = canonicalRefreshDisposition(requested, {
          canonicalEpoch: canonicalEpochRef.current,
          graphEpoch: graphEpochRef.current,
          stateRevision: stateRevisionRef.current,
        });
        const recoveryWarning = [loaded.autosave_recovery_warning, loaded.input_origin_warning].filter(Boolean).join(" ") || null;
        setSession(loaded);
        stateRevisionRef.current = loaded.state_revision;
        acknowledgedGraphRef.current = JSON.stringify(loaded.graph);
        acknowledgedInputOriginIdRef.current = loaded.input_origin_id;
        inputOriginIdRef.current = loaded.input_origin_id;
        if (disposition === "preserve_local") {
          if (localDraft.nodes.length > 0) setLibraryVisible(false);
          setHistory((current) => ({
            past: [...current.past, workflowDocument(loaded.graph, loaded.input_origin_id)].slice(-HISTORY_LIMIT),
            future: [],
          }));
          markCanonicalGraph(localDraft, true);
          agentCursorRef.current = loaded.agent_cursor;
          setAgentSnapshot((current) => ({ ...current, cursor: loaded.agent_cursor }));
          setDirty(true);
          setStatus(recoveryWarning
            ? `${recoveryWarning} Kept the canvas edits you made while connecting; the saved project canvas is available in Undo.`
            : "Project opened · kept the canvas edits you made while connecting · project canvas is available in Undo");
          return;
        }
        if (loaded.graph.nodes.length > 0) setLibraryVisible(false);
        markCanonicalGraph(loaded.graph);
        setWorkflowTitle(workflowName(loaded.graph, loaded.graph_path));
        agentCursorRef.current = loaded.agent_cursor;
        setAgentSnapshot((current) => ({ ...current, cursor: loaded.agent_cursor }));
        setNodes(loaded.graph.nodes.map((node) => flowNode(node, operators)));
        setEdges((loaded.graph.edges ?? []).map((edge) => flowEdge(edge, loaded.graph.nodes)));
        setAnnotations(loaded.graph.annotations ?? []);
        setVariantOrigin(loaded.graph.variant_origin);
        setDirty(loaded.recovered_autosave);
        setStatus(recoveryWarning ?? (loaded.recovered_autosave ? "Recovered the last autosave" : "Tab add · drag ports to wire · space-drag pan · F fit"));
      })
      .catch((error) => setStatus(`Project engine is not running — ${errorMessage(error)}`));
    client.system().then(setSystem).catch(() => undefined);
  // The React Flow state helpers are not part of this effect's lifecycle.
  // Loading must happen exactly once or a setter identity change can turn the
  // project bootstrap into a fetch -> set state -> fetch render loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    const requestPaths = workflowCatalogRequestPaths({
      sessionReady: Boolean(session),
      libraryVisible,
      loadState: workflowCatalogState,
    });
    if (requestPaths.length === 0 || workflowCatalogLoadInFlightRef.current) return;
    workflowCatalogLoadInFlightRef.current = true;
    setWorkflowCatalogState("loading");
    const requests = requestPaths.map((requestPath) => requestPath === "/api/catalog/nfcore"
      ? client.workflowCatalog("nfcore").then(setNfcoreCatalog)
      : client.workflowCatalog("snakemake").then(setSnakemakeCatalog));
    void Promise.allSettled(requests).then((results) => {
      workflowCatalogLoadInFlightRef.current = false;
      setWorkflowCatalogState(results.every((result) => result.status === "fulfilled") ? "loaded" : "failed");
    });
  }, [client, libraryVisible, session, workflowCatalogState]);

  const retryWorkflowCatalogs = useCallback(() => {
    if (!workflowCatalogLoadInFlightRef.current) setWorkflowCatalogState("idle");
  }, []);

  const refreshStorage = useCallback(async () => {
    setStorageLoading(true);
    setStorageError(null);
    try {
      setStorage(await client.storage());
    } catch (error) {
      setStorageError(errorMessage(error));
    } finally {
      setStorageLoading(false);
    }
  }, [client]);

  const reclaimFinishedRunWork = useCallback(async () => {
    const runIds = storage?.runs.reclaimable_run_ids ?? [];
    if (runIds.length === 0 || storageReclaiming) return;
    setStorageReclaiming(true);
    setStorageError(null);
    try {
      const result = await client.dehydrateRuns(runIds);
      setStatus(`Reclaimed ${result.reclaimed_bytes.toLocaleString()} bytes of finished-run work · results and evidence retained`);
      await refreshStorage();
    } catch (error) {
      const detail = errorMessage(error);
      setStorageError(detail);
      setStatus(`Run work was not reclaimed — ${detail}`);
    } finally {
      setStorageReclaiming(false);
    }
  }, [client, refreshStorage, storage?.runs.reclaimable_run_ids, storageReclaiming]);

  const installPaperTools = useCallback(async () => {
    if (paperToolsInstalling) return;
    setPaperToolsInstalling(true);
    setPaperToolsError(null);
    setStatus("Installing and verifying scanned-PDF OCR tools with Pixi…");
    try {
      const installed = await client.installPaperOcr();
      setSystem((current) => current ? { ...current, paper_extraction: installed.preflight } : current);
      setStatus("Scanned PDF OCR is ready · Poppler and Tesseract were verified and pinned locally");
      await refreshStorage();
    } catch (error) {
      const detail = errorMessage(error);
      setPaperToolsError(detail);
      setStatus(`Scanned PDF OCR setup failed — ${detail}`);
    } finally {
      setPaperToolsInstalling(false);
    }
  }, [client, paperToolsInstalling, refreshStorage]);

  useEffect(() => {
    if (!flow || !session || nodes.length === 0 || initialViewportFitRef.current) return;
    initialViewportFitRef.current = true;
    const timeout = window.setTimeout(() => {
      void flow.fitView({ padding: .25, duration: 220, maxZoom: 1 });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [flow, nodes.length, session]);

  const connectAgent = useCallback(async (command: string) => {
    try {
      setAgentTransportError(null);
      const connected = await client.connectAgent(command);
      mergeAgentSnapshot(connected);
      setStatus("Agent is connecting…");
    } catch (error) {
      setStatus(`Agent connection failed — ${errorMessage(error)}`);
    }
  }, [client, mergeAgentSnapshot]);

  const promptAgent = useCallback(async (message: string) => {
    if (session?.input_origin_warning) {
      setProjectVisible(true);
      setStatus("Confirm the workflow input location before Agent can change this canvas");
      throw new Error("workflow input location needs confirmation");
    }
    const operation = browserWriteChainRef.current.then(async () => {
      const graph = graphSnapshotRef.current;
      const requestEpoch = graphEpochRef.current;
      const response = await client.promptAgent({
        message,
        base_state_revision: stateRevisionRef.current,
        graph,
        input_origin_id: inputOriginIdRef.current,
      });
      commitIfCanonicalEpochCurrent(requestEpoch, () => canonicalEpochRef.current, () => {
        stateRevisionRef.current = response.state_revision;
        acknowledgedGraphRef.current = JSON.stringify(graph);
        acknowledgedInputOriginIdRef.current = inputOriginIdRef.current;
      });
    });
    browserWriteChainRef.current = operation.catch(() => undefined);
    try {
      await operation;
      setAgentSnapshot((current) => ({ ...current, busy: true }));
      setStatus("Agent is working on the workflow…");
    } catch (error) {
      if (await reconcileGraphConflict(error)) throw error;
      setStatus(`Agent prompt failed — ${errorMessage(error)}`);
      throw error;
    }
  }, [client, reconcileGraphConflict, session?.input_origin_warning]);

  const configureAgent = useCallback(async (configId: string, value: string | boolean) => {
    try {
      const configured = await client.configureAgent(configId, value);
      mergeAgentSnapshot(configured);
      setStatus("Agent configuration updated");
    } catch (error) {
      setStatus(`Agent configuration failed — ${errorMessage(error)}`);
    }
  }, [client, mergeAgentSnapshot]);

  const cancelAgent = useCallback(async () => {
    try {
      await client.cancelAgent();
      setStatus("Cancelling the agent turn…");
    } catch (error) {
      setStatus(`Could not cancel agent — ${errorMessage(error)}`);
    }
  }, [client]);

  const disconnectAgent = useCallback(async () => {
    try {
      await client.disconnectAgent();
      setAgentTransportError(null);
      setStatus("Disconnecting Agent…");
    } catch (error) {
      setStatus(`Could not disconnect agent — ${errorMessage(error)}`);
    }
  }, [client]);

  const answerAgentPermission = useCallback(async (permissionId: string, optionId?: string) => {
    try {
      await client.answerAgentPermission(permissionId, optionId);
      setAgentSnapshot((current) => ({
        ...current,
        events: current.events.map((event) => event.permission_id === permissionId
          ? { ...event, permission_choices: [], status: optionId ? "answered" : "cancelled" }
          : event),
      }));
      setStatus(optionId ? "Agent permission answered" : "Agent action cancelled");
    } catch (error) {
      setStatus(`Permission response failed — ${errorMessage(error)}`);
    }
  }, [client]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem("somite.library.v1");
        if (raw) {
          const stored = JSON.parse(raw) as { favorites?: string[]; recent?: string[] };
          if (Array.isArray(stored.favorites)) setFavorites(new Set(stored.favorites.filter((id): id is string => typeof id === "string")));
          if (Array.isArray(stored.recent)) setRecent(stored.recent.filter((id): id is string => typeof id === "string").slice(0, 6));
        }
      } catch {
        window.localStorage.removeItem("somite.library.v1");
      }
      setLibraryStateLoaded(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!libraryStateLoaded) return;
    window.localStorage.setItem("somite.library.v1", JSON.stringify({ favorites: [...favorites], recent }));
  }, [favorites, libraryStateLoaded, recent]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
  }, [query]);

  useEffect(() => {
    if (!dirty || !session || session.input_origin_warning || titleEditing) return;
    const graphWrite = captureGraphWrite(snapshot(), graphEpochRef.current, inputOriginIdRef.current);
    const timeout = window.setTimeout(() => {
      void writeBrowserGraph("/api/graph/autosave", graphWrite)
        .catch(async (error) => {
          if (await reconcileGraphConflict(error)) return;
          setStatus(`Autosave failed — ${errorMessage(error)}`);
        });
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [dirty, nodes, edges, reconcileGraphConflict, session, snapshot, titleEditing, writeBrowserGraph]);

  const canvasCenter = useCallback(() => {
    if (!flow) return { x: 160, y: 160 };
    return flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, { snapToGrid: true });
  }, [flow]);

  const enterSourceNetwork = useCallback((nodeId: string, scopeId: string) => {
    const workflow = graphSnapshotRef.current.nodes.find((node) => node.id === nodeId)?.source_workflow;
    if (!workflow) return;
    setSourceNetworkView((current) => ({
      nodeId,
      path: sourceNetworkEnterPath(workflow, current?.nodeId === nodeId ? current.path : [], scopeId),
    }));
  }, []);

  const exitSourceNetwork = useCallback((nodeId: string) => {
    setSourceNetworkView((current) => {
      if (current?.nodeId !== nodeId) return null;
      const path = sourceNetworkExitPath(current.path);
      return path.length ? { nodeId, path } : null;
    });
  }, []);

  const openSourceNetworkPath = useCallback((nodeId: string, path: string[]) => {
    const workflow = graphSnapshotRef.current.nodes.find((node) => node.id === nodeId)?.source_workflow;
    if (!workflow) return;
    setSourceNetworkView({ nodeId, path: projectSourceNetwork(workflow, path).path });
  }, []);

  const exploreSourceWorkflow = useCallback((nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    const workflow = node?.data.graphNode.source_workflow;
    if (!node || !workflow) return;
    setSourceNetworkView({ nodeId, path: projectSourceNetwork(workflow, []).path });
    setSelectedIds([]);
    setCanvasTool("select");
    setSelectedAnnotationId(null);
    setNodes((current) => current.map((candidate) => ({ ...candidate, selected: false })));
    setLibraryVisible(false);
    setProjectVisible(false);
    setPaperVisible(false);
    setToolchainVisible(false);
    setStatus("Nested source canvas · showing immediate calls only");
  }, [nodes, setNodes]);

  const openContinuation = useCallback<ContinueFromPort>((nodeId, port) => {
    if (port.dir === "in" && edges.some((edge) => edge.data?.somite.to_node === nodeId && edge.data.somite.to_port === port.name)) {
      setStatus(`${nodeId}.${port.name} is already connected`);
      return;
    }
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const position = nextContinuationPosition(node.position, port.dir, nodes.map((candidate) => candidate.position));
    const operator = operatorMap.get(node.data.graphNode.operator);
    const contract = port.dir === "in"
      ? operator?.ports.in.find((candidate) => candidate.name === port.name)?.resource?.profile
      : operator?.ports.out.find((candidate) => candidate.name === port.name)?.resource_profile;
    setPendingConnection({ nodeId, port, position, ...(contract ? { resourceProfile: contract } : {}) });
    setPendingAddPosition(position);
    setQuery("");
    setProjectVisible(false);
    setPaperVisible(false);
    setLibraryVisible(true);
    setStatus(`Choose a tool for ${nodeId}.${port.name} · ${port.ty}`);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [edges, nodes, operatorMap]);

  const focusRequirement = useCallback((item: ReadinessItem) => {
    const node = nodes.find((candidate) => candidate.id === item.node_id);
    if (!node) return;
    setSelectedIds([node.id]);
    setNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
    void flow?.setCenter(node.position.x + 97, node.position.y + 62, { zoom: Math.max(zoom, .72), duration: 220 });
    setStatus(`${item.title} · ${item.node_id}.${item.field}`);
  }, [flow, nodes, setNodes, zoom]);

  const resolveRequirement = useCallback((item: ReadinessItem, resolution?: ReadinessItem["resolutions"][number]) => {
    focusRequirement(item);
    const sourceNode = graphSnapshotRef.current.nodes.find((candidate) => candidate.id === item.node_id && candidate.source_workflow);
    if (sourceNode) {
      setReadinessVisible(false);
      if (item.field.startsWith("replacement:")) {
        exploreSourceWorkflow(sourceNode.id);
        setStatus(`${item.title} · edit freely, then validate the variant`);
        return;
      }
      setStatus(item.field === "execution_environment"
        ? "Review the pinned workflow and its execution setup in the workflow inspector"
        : `Configure ${item.title.replace(/^Set\s+/i, "")} in the workflow inspector`);
      return;
    }
    if (!["input", "managed_resource"].includes(item.kind)) {
      setReadinessVisible(false);
      return;
    }
    const node = nodes.find((candidate) => candidate.id === item.node_id);
    const port = node?.data.graphNode.ports.find((candidate) => candidate.dir === "in" && candidate.name === item.field);
    if (!node || !port) return;
    if (item.kind === "managed_resource" && resolution && resolution.kind !== "use_existing") {
      setStatus(`${resolution.label} is guidance only · Somite will not silently download or build a scientific database. Connect a reviewed existing database or ask Agent for setup help.`);
      return;
    }
    if (item.resource_profile === "kraken2-database" && (!resolution || resolution.kind === "use_existing")) {
      const databaseOperator = operatorMap.get("files.import_kraken2_database");
      if (!databaseOperator) {
        setStatus("The reviewed Kraken2 database input is unavailable from this operator catalog");
        return;
      }
      const position = nextContinuationPosition(node.position, "in", nodes.map((candidate) => candidate.position));
      const id = nextNodeId(databaseOperator, nodes);
      const graphNode = makeGraphNode(databaseOperator, id, position, { path: "" });
      const pending: PendingConnection = {
        nodeId: item.node_id,
        port,
        position,
        resourceProfile: item.resource_profile,
      };
      const connected = continuationEdge(databaseOperator, graphNode, pending);
      if (!connected) {
        setStatus("The reviewed Kraken2 database contract cannot connect to this requirement");
        return;
      }
      remember();
      const graphNodes = [...nodes.map((candidate) => candidate.data.graphNode), graphNode];
      setNodes((current) => [
        ...current.map((candidate) => ({ ...candidate, selected: false })),
        { ...flowNode(graphNode, operatorMap), selected: true },
      ]);
      setEdges((current) => [...current, flowEdge(connected, graphNodes)]);
      setSelectedIds([id]);
      setReadinessVisible(false);
      setDirty(true);
      setStatus("Kraken2 database connected · enter the existing database directory path in the inspector");
      return;
    }
    setReadinessVisible(false);
    openContinuation(item.node_id, port);
  }, [exploreSourceWorkflow, focusRequirement, nodes, openContinuation, operatorMap, remember, setEdges, setNodes]);

  const askAssistantAboutRequirement = useCallback((item: ReadinessItem) => {
    focusRequirement(item);
    setAgentDraft({ id: Date.now(), message: readinessAgentPrompt(item, readiness?.graph_revision ?? "not yet computed") });
    setAgentVisible(true);
    if (!agentSnapshot.connected && !agentDiscovery && !agentDiscoveryLoading) void refreshAgentDiscovery();
  }, [agentDiscovery, agentDiscoveryLoading, agentSnapshot.connected, focusRequirement, readiness, refreshAgentDiscovery]);

  const insertImportedGraph = useCallback((imported: { graph: SomiteGraph }, target: { x: number; y: number }, title: string, recentId?: string) => {
    const currentGraph = graphSnapshotRef.current;
    const currentSource = currentGraph.nodes.some((node) => Boolean(node.source_workflow));
    if (!sourceWorkflowCanAppendGraph(currentGraph, imported.graph)) {
      const detail = currentSource
        ? "This pinned workflow already uses the whole canvas. Bind its inputs in the workflow inspector."
        : "This pinned workflow uses the whole canvas. Start it in a new or empty project.";
      setCatalogExpansion((current) => current ? { ...current, phase: "failed", detail } : current);
      setStatus(detail);
      return;
    }
    remember();
    const normalizedNodes = normalizeImportedNodeLayouts(imported.graph.nodes);
    const occupied = new Set(currentGraph.nodes.map((node) => node.id));
    const idMap = new Map<string, string>();
    for (const source of normalizedNodes) {
      let id = source.id;
      let suffix = 2;
      while (occupied.has(id)) id = `${source.id}-${suffix++}`;
      occupied.add(id);
      idMap.set(source.id, id);
    }
    const minX = Math.min(...normalizedNodes.map((node) => node.layout.x));
    const minY = Math.min(...normalizedNodes.map((node) => node.layout.y));
    const created = normalizedNodes.map((source) => ({
      ...source,
      id: idMap.get(source.id) ?? source.id,
      layout: { x: target.x + source.layout.x - minX, y: target.y + source.layout.y - minY },
    }));
    const createdEdges = imported.graph.edges.map((edge, index) => ({
      ...edge,
      id: `e-${idMap.get(edge.from_node)}-out-${idMap.get(edge.to_node)}-in-${index}`,
      from_node: idMap.get(edge.from_node) ?? edge.from_node,
      to_node: idMap.get(edge.to_node) ?? edge.to_node,
    }));
    const graphNodes = [...currentGraph.nodes, ...created];
    const createdFlowNodes = created.map((node) => flowNode(node, operatorMap, true));
    const sourceWorkflow = created.length === 1 ? created[0].source_workflow : undefined;
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...createdFlowNodes.map((node) => ({ ...node, selected: Boolean(sourceWorkflow) })),
    ]);
    setEdges((current) => [...current, ...createdEdges.map((edge) => flowEdge(edge, graphNodes))]);
    setSelectedIds(sourceWorkflow ? created.map((node) => node.id) : []);
    if (recentId) setRecent((current) => [recentId, ...current.filter((value) => value !== recentId)].slice(0, 6));
    setLibraryVisible(false);
    setPendingAddPosition(null);
    setPendingConnection(null);
    setDirty(true);
    setStatus(sourceWorkflow ? `${title} · pinned source` : `${title} · ${created.length} rules · ${createdEdges.length} dependencies`);
    window.setTimeout(() => void flow?.fitView({ nodes: createdFlowNodes, padding: 0.16, duration: 520, maxZoom: 0.9 }), 0);
  }, [flow, operatorMap, remember, setEdges, setNodes]);

  const importLocalProject = useCallback(async (path: string) => {
    const target = pendingAddPosition ?? canvasCenter();
    setStatus(`Opening local project ${path}…`);
    try {
      const imported = await client.openProject(path);
      const label = path.split("/").filter(Boolean).at(-1) ?? "Local project";
      const kind = imported.kind === "somite" ? "Somite graph" : imported.kind === "nextflow" ? "frozen Nextflow source" : "Snakemake rules";
      const exclusions = imported.exclusions?.count
        ? ` · ${countFormatter.format(imported.exclusions.count)} runtime, sensitive, or unrelated item${imported.exclusions.count === 1 ? "" : "s"} left out`
        : "";
      if (session?.input_origin_warning) {
        if (imported.kind !== "somite") {
          throw new Error("Choose the original .somite.json file, or explicitly use this project folder");
        }
        await recoverInputOrigin(imported.input_origin_id, label);
        setProjectVisible(false);
        setStatus(`Workflow input location restored from ${label} · recovered canvas kept`);
        return;
      }
      if (imported.kind === "somite") {
        await browserWriteChainRef.current;
        const currentDocument = snapshotDocument();
        setHistory((current) => openProjectDocument(imported, currentDocument, current, HISTORY_LIMIT)!.history);
        markCanonicalGraph(imported.graph);
        restoreGraph(imported.graph, true, true, imported.input_origin_id, false);
        setSession((current) => current ? { ...current, graph: imported.graph, input_origin_id: imported.input_origin_id } : current);
        setLibraryVisible(false);
        setProjectVisible(false);
        setPaperVisible(false);
        setToolchainVisible(false);
        setMachineVisible(false);
        setReadinessVisible(false);
        setAgentVisible(false);
        setAgentDraft(null);
        setSourceNetworkView(null);
        setPendingAddPosition(null);
        setPendingConnection(null);
        setPendingSourceFile(null);
        setCatalogExpansion(null);
        setExportPlan(null);
        setValidationEvidence(null);
        setReadiness(null);
        setReadinessError(null);
        setCanvasTool("select");
        setStatus(`Opened ${label} · ${kind} · autosaving in ${session?.project_name ?? "this project"}`);
        return;
      }
      insertImportedGraph(imported, target, `Opened ${label} · ${kind}${exclusions}`);
      setProjectVisible(false);
    } catch (error) {
      setStatus(`Could not open local project — ${errorMessage(error)}`);
      throw error;
    }
  }, [canvasCenter, client, insertImportedGraph, markCanonicalGraph, pendingAddPosition, recoverInputOrigin, restoreGraph, session?.input_origin_warning, session?.project_name, snapshotDocument]);

  const addOperator = useCallback((operator: Operator, position?: { x: number; y: number }, params?: Record<string, ParamValue>) => {
    const liveGraph = graphSnapshotRef.current;
    if (liveGraph.nodes.some((node) => Boolean(node.source_workflow))) {
      setStatus("This pinned workflow uses the whole canvas. Bind its inputs in the workflow inspector or start a new project.");
      return;
    }
    if (opaqueNfcoreFallback(operator)) {
      setStatus(`${operator.title} needs an exact release from the nf-core catalog · refresh the catalog and choose the pinned workflow`);
      return;
    }
    if (operator.palette.includes("Catalog")) {
      const revision = operator.params.revision?.default;
      const isNfcore = operator.id.startsWith("nf.");
      if (isNfcore && !sourceWorkflowCanvasIsEmpty(liveGraph)) {
        const detail = "This pinned workflow uses the whole canvas. Start it in a new or empty project.";
        setCatalogExpansion({ operatorId: operator.id, title: operator.title, phase: "failed", detail });
        setStatus(detail);
        return;
      }
      if (!isNfcore && !operator.expandable) {
        const detail = `${operator.title} has no resolved rule graph in the official catalog yet · Somite did not add an opaque node`;
        setCatalogExpansion({ operatorId: operator.id, title: operator.title, phase: "failed", detail });
        setStatus(detail);
        return;
      }
      if (typeof revision !== "string") {
        const detail = `Could not import ${operator.title} — missing pinned revision`;
        setCatalogExpansion({ operatorId: operator.id, title: operator.title, phase: "failed", detail });
        setStatus(detail);
        return;
      }
      const target = position ?? pendingAddPosition ?? canvasCenter();
      setCatalogExpansion({ operatorId: operator.id, title: operator.title, phase: "resolving" });
      setStatus(isNfcore ? `Resolving and pinning ${operator.title} source…` : `Resolving ${operator.title} into its rule graph…`);
      const workflow = isNfcore
        ? `nf-core/${operator.id.slice(3)}`
        : operator.params.repository?.default;
      if (typeof workflow !== "string") {
        const detail = `Could not import ${operator.title} — missing workflow provenance`;
        setCatalogExpansion({ operatorId: operator.id, title: operator.title, phase: "failed", detail });
        setStatus(detail);
        return;
      }
      void client.expandWorkflow(isNfcore ? "nfcore" : "snakemake", workflow, revision).then((imported) => {
        setCatalogExpansion((current) => current?.operatorId === operator.id ? null : current);
        insertImportedGraph(imported, target, isNfcore ? `Added ${operator.title} ${revision}` : `Expanded ${operator.title} ${revision}${imported.cached ? " · cached" : ""}`, operator.id);
      }).catch((error) => {
        const detail = errorMessage(error);
        setCatalogExpansion((current) => current?.operatorId === operator.id
          ? { operatorId: operator.id, title: operator.title, phase: "failed", detail }
          : current);
        setStatus(`${isNfcore ? "Could not add" : "Could not expand"} ${operator.title} — ${detail}`);
      });
      return;
    }
    setCatalogExpansion(null);
    remember();
    const id = nextNodeId(operator, nodes);
    const graphNode = makeGraphNode(operator, id, position ?? pendingConnection?.position ?? pendingAddPosition ?? canvasCenter(), params);
    const graphNodes = [...nodes.map((node) => node.data.graphNode), graphNode];
    const connected = pendingConnection ? continuationEdge(operator, graphNode, pendingConnection) : null;
    const companion = connected ? pairedCompanion(connected, graphNodes) : null;
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), { ...flowNode(graphNode, operatorMap, operator.id.startsWith("nf.") || operator.id.startsWith("smk.")), selected: true }]);
    if (connected) {
      const additions = [connected, ...(companion ? [companion] : [])]
        .filter((edge) => !edges.some((current) => current.id === edge.id))
        .map((edge) => flowEdge(edge, graphNodes));
      setEdges((current) => additions.reduce((next, edge) => addEdge(edge, next), current));
    }
    setSelectedIds([id]);
    setRecent((current) => [operator.id, ...current.filter((value) => value !== operator.id)].slice(0, 6));
    setPendingAddPosition(null);
    setPendingConnection(null);
    if (connected) setLibraryVisible(false);
    setDirty(true);
    setStatus(connected ? `${id} connected${companion ? " · paired R1 + R2" : ""}` : `Dropped ${id}`);
  }, [canvasCenter, client, edges, insertImportedGraph, nodes, operatorMap, pendingAddPosition, pendingConnection, remember, setEdges, setNodes]);

  const addSource = useCallback((request: SourceRequest) => {
    if (graphSnapshotRef.current.nodes.some((node) => Boolean(node.source_workflow))) {
      setStatus("This pinned workflow uses the whole canvas. Bind public data to its input parameter in the workflow inspector.");
      return;
    }
    const center = canvasCenter();
    const requireOperator = (id: string) => {
      const operator = operatorMap.get(id);
      if (!operator) throw new Error(`${id} operator is missing`);
      return operator;
    };
    try {
      remember();
      const created: SomiteGraphNode[] = [];
      const createdEdges: SomiteEdge[] = [];
      if (request.kind === "sra") {
        const prefetch = requireOperator("sra.prefetch");
        const fasterq = requireOperator("sra.fasterq_dump");
        const prefetchId = nextNodeId(prefetch, [...nodes, ...created.map((node) => flowNode(node, operatorMap))]);
        created.push(makeGraphNode(prefetch, prefetchId, center, { accession: request.value }));
        const fasterqId = nextNodeId(fasterq, [...nodes, ...created.map((node) => flowNode(node, operatorMap))]);
        created.push(makeGraphNode(fasterq, fasterqId, { x: center.x + 240, y: center.y }));
        createdEdges.push({ id: `e-${prefetchId}-sra-${fasterqId}-sra`, from_node: prefetchId, from_port: "sra", to_node: fasterqId, to_port: "sra" });
      } else if (request.kind === "assembly") {
        const download = requireOperator("ncbi.datasets_assembly");
        const unzip = requireOperator("archive.unzip");
        const downloadId = nextNodeId(download, [...nodes, ...created.map((node) => flowNode(node, operatorMap))]);
        created.push(makeGraphNode(download, downloadId, center, { accession: request.value }));
        const unzipId = nextNodeId(unzip, [...nodes, ...created.map((node) => flowNode(node, operatorMap))]);
        created.push(makeGraphNode(unzip, unzipId, { x: center.x + 240, y: center.y }));
        createdEdges.push({ id: `e-${downloadId}-package-${unzipId}-archive`, from_node: downloadId, from_port: "package", to_node: unzipId, to_port: "archive" });
      } else {
        const operator = requireOperator("ensembl.sequence");
        const id = nextNodeId(operator, nodes);
        created.push(makeGraphNode(operator, id, center, { accession: request.value, sequence_type: request.sequenceType ?? request.sequence_type ?? "genomic" }));
      }
      const graphNodes = [...nodes.map((node) => node.data.graphNode), ...created];
      setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...created.map((node) => ({ ...flowNode(node, operatorMap), selected: true }))]);
      setEdges((current) => [...current, ...createdEdges.map((edge) => flowEdge(edge, graphNodes))]);
      setSelectedIds(created.map((node) => node.id));
      setDirty(true);
      setStatus(`${request.value} ready · ${request.result}`);
    } catch (error) {
      setStatus(`Could not add source — ${errorMessage(error)}`);
    }
  }, [canvasCenter, nodes, operatorMap, remember, setEdges, setNodes]);

  const upload = useCallback(async (file: File) => {
    return client.uploadFile(file);
  }, [client]);

  const synchronizeBrowserGraph = useCallback(async () => {
    if (session?.input_origin_warning) {
      setProjectVisible(true);
      setStatus("Confirm the workflow input location before changing a pinned source workflow");
      throw new Error("workflow input location needs confirmation");
    }
    if (acknowledgedGraphRef.current === JSON.stringify(graphSnapshotRef.current)
      && acknowledgedInputOriginIdRef.current === inputOriginIdRef.current) return;
    try {
      await writeBrowserGraph(
        "/api/graph/autosave",
        captureGraphWrite(graphSnapshotRef.current, graphEpochRef.current, inputOriginIdRef.current),
      );
    } catch (error) {
      await reconcileGraphConflict(error);
      throw error;
    }
  }, [reconcileGraphConflict, session?.input_origin_warning, writeBrowserGraph]);

  const persistSourceWorkflowEdit = useCallback(async (nodeId: string, edit: SourceWorkflowSemanticEdit) => {
    await synchronizeBrowserGraph();
    const operation = browserWriteChainRef.current.then(async () => {
      const workflow = graphSnapshotRef.current.nodes.find((node) => node.id === nodeId)?.source_workflow;
      if (!workflow) throw new Error("Selected node is not a source-backed workflow");
      const baseWorkflowRevision = workflow.workflow_revision;
      const requestEpoch = graphEpochRef.current;
      const response = await client.editSourceWorkflow({
        base_state_revision: stateRevisionRef.current,
        workflow_revision: baseWorkflowRevision,
        edits: [edit],
      });
      if (!commitIfCanonicalEpochCurrent(
        requestEpoch,
        () => canonicalEpochRef.current,
        () => {
          stateRevisionRef.current = response.state_revision;
          acknowledgedGraphRef.current = JSON.stringify(response.graph);
        },
      )) {
        setStatus("A newer canvas change arrived while the workflow variant was saving · kept the newer canvas");
        return;
      }
      const currentGraph = graphSnapshotRef.current;
      const mergedGraph = mergeCanonicalSourceWorkflow(currentGraph, response.graph, baseWorkflowRevision);
      if (mergedGraph === currentGraph) {
        setDirty(true);
        setStatus("Canvas changed while the workflow variant was saving · kept your newer canvas");
        return;
      }
      markCanonicalGraph(mergedGraph);
      setWorkflowTitle(mergedGraph.name ?? "Untitled workflow");
      setNodes((current) => {
        const existing = new Map(current.map((node) => [node.id, node]));
        return mergedGraph.nodes.map((graphNode) => {
          const prior = existing.get(graphNode.id);
          if (!prior) return flowNode(graphNode, operatorMap);
          return {
            ...prior,
            position: graphNode.layout,
            data: {
              ...prior.data,
              graphNode,
              title: graphNode.source_workflow ? sourceWorkflowTitle(graphNode.source_workflow) : prior.data.title,
            },
          };
        });
      });
      setEdges(mergedGraph.edges.map((edge) => flowEdge(edge, mergedGraph.nodes)));
      setAnnotations(mergedGraph.annotations ?? []);
      setDirty(true);
    });
    browserWriteChainRef.current = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      await reconcileGraphConflict(error);
      throw error;
    }
  }, [client, markCanonicalGraph, operatorMap, reconcileGraphConflict, setEdges, setNodes, synchronizeBrowserGraph]);

  const editSourceWorkflowBinding = useCallback(async (nodeId: string, key: string, binding: WorkflowBinding | undefined) => {
    await persistSourceWorkflowEdit(nodeId, binding
      ? { kind: "set_parameter", name: key, binding }
      : { kind: "reset_parameter", name: key });
  }, [persistSourceWorkflowEdit]);

  const replaceSourceInvocation = useCallback(async (nodeId: string, invocationId: string, operator: Operator) => {
    if (!operator.revision) throw new Error(`${operator.title} is missing its catalog revision`);
    const params = Object.fromEntries(Object.entries(operator.params)
      .filter(([, spec]) => spec.default !== undefined)
      .map(([name, spec]) => [name, spec.default as ParamValue]));
    setStatus(`Replacing source call with ${operator.title}…`);
    await persistSourceWorkflowEdit(nodeId, {
      kind: "replace_invocation",
      invocation_id: invocationId,
      operator: operator.id,
      operator_revision: operator.revision,
      params,
    });
    setStatus(`${operator.title} added to the variant · connections need checking`);
  }, [persistSourceWorkflowEdit]);

  const resetSourceInvocation = useCallback(async (nodeId: string, invocationId: string) => {
    setStatus("Restoring original source invocation…");
    await persistSourceWorkflowEdit(nodeId, { kind: "reset_invocation", invocation_id: invocationId });
    setStatus("Original source invocation restored");
  }, [persistSourceWorkflowEdit]);

  const promoteSourceInvocation = useCallback(async (nodeId: string, invocationId: string) => {
    await synchronizeBrowserGraph();
    const workflow = graphSnapshotRef.current.nodes.find((node) => node.id === nodeId)?.source_workflow;
    if (!workflow) throw new Error("Selected node is not a source-backed workflow");
    const replacement = workflow.replacements?.find((candidate) => candidate.invocation_id === invocationId);
    if (!replacement) throw new Error("Choose a replacement tool before editing this call on the canvas");
    const requestEpoch = graphEpochRef.current;
    const previousGraph = graphSnapshotRef.current;
    const title = operatorMap.get(replacement.operator)?.title ?? replacement.operator;
    setStatus(`Creating an editable ${title} node…`);

    const operation = browserWriteChainRef.current.then(async () => {
      const response = await client.promoteSourceWorkflow({
        base_state_revision: stateRevisionRef.current,
        workflow_revision: workflow.workflow_revision,
        invocation_id: invocationId,
      });
      if (!commitIfCanonicalEpochCurrent(
        requestEpoch,
        () => canonicalEpochRef.current,
        () => {
          stateRevisionRef.current = response.state_revision;
          acknowledgedGraphRef.current = JSON.stringify(response.graph);
        },
      )) {
        setStatus("A newer canvas change arrived while promotion was running · kept the newer canvas");
        return;
      }
      setHistory((current) => ({ past: [...current.past, snapshotDocument(previousGraph)].slice(-HISTORY_LIMIT), future: [] }));
      markCanonicalGraph(response.graph);
      setSourceNetworkView(null);
      restoreGraph(response.graph, true, true);
      setStatus(`${title} is editable on the canvas · wire its typed inputs, then validate`);
    });
    browserWriteChainRef.current = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      await reconcileGraphConflict(error);
      setStatus(`Could not create the editable node — ${errorMessage(error)}`);
      throw error;
    }
  }, [client, markCanonicalGraph, operatorMap, reconcileGraphConflict, restoreGraph, snapshotDocument, synchronizeBrowserGraph]);

  const restorePinnedSourceWorkflow = useCallback(async () => {
    const origin = graphSnapshotRef.current.variant_origin;
    if (!origin) return;
    const promotedCount = Object.keys(origin.promoted_invocations ?? {}).length;
    if (!window.confirm(`Return to pinned source? This removes the ${promotedCount} promoted node${promotedCount === 1 ? "" : "s"} and native canvas wiring. The original pinned workflow and annotations remain.`)) return;
    await synchronizeBrowserGraph();
    const requestEpoch = graphEpochRef.current;
    const previousGraph = graphSnapshotRef.current;
    setStatus("Returning to the pinned source workflow…");

    const operation = browserWriteChainRef.current.then(async () => {
      const response = await client.restoreSourceWorkflow(stateRevisionRef.current);
      if (!commitIfCanonicalEpochCurrent(
        requestEpoch,
        () => canonicalEpochRef.current,
        () => {
          stateRevisionRef.current = response.state_revision;
          acknowledgedGraphRef.current = JSON.stringify(response.graph);
        },
      )) {
        setStatus("A newer canvas change arrived while the source view was restoring · kept the newer canvas");
        return;
      }
      setHistory((current) => ({ past: [...current.past, snapshotDocument(previousGraph)].slice(-HISTORY_LIMIT), future: [] }));
      markCanonicalGraph(response.graph);
      setSourceNetworkView(null);
      restoreGraph(response.graph, true, true);
      setStatus("Pinned source workflow restored · the native variant is available in Undo");
    });
    browserWriteChainRef.current = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      await reconcileGraphConflict(error);
      setStatus(`Could not restore the pinned source — ${errorMessage(error)}`);
    }
  }, [client, markCanonicalGraph, reconcileGraphConflict, restoreGraph, snapshotDocument, synchronizeBrowserGraph]);

  const attachRequirementFile = useCallback(async (item: ReadinessItem, field: string, file: File) => {
    const sourceNode = graphSnapshotRef.current.nodes.find((node) => node.id === item.node_id && node.source_workflow);
    if (sourceNode?.source_workflow && !sourceNode.source_workflow.capabilities.parameter_edits) {
      setStatus("This source schema is read-only · review its source notes before changing inputs");
      return;
    }
    setStatus(`Importing ${file.name} for ${item.title}…`);
    try {
      const result = await upload(file);
      remember();
      if (sourceNode) {
        await editSourceWorkflowBinding(sourceNode.id, field, { kind: "project_file", path: result.path });
        setStatus(`${item.title} · attached ${result.filename}`);
        return;
      }
      setNodes((current) => current.map((node) => node.id === item.node_id ? {
        ...node,
        data: {
          ...node.data,
          graphNode: {
            ...node.data.graphNode,
            params: { ...(node.data.graphNode.params ?? {}), [field]: result.path },
          },
        },
      } : node));
      setDirty(true);
      setStatus(`${item.title} · attached ${result.filename}`);
    } catch (error) {
      setStatus(`Could not attach ${file.name} — ${errorMessage(error)}`);
    }
  }, [editSourceWorkflowBinding, remember, setNodes, upload]);

  const updatePaperCandidateGraph = useCallback(async (index: number, previousGraph: SomiteGraph, graph: SomiteGraph) => {
    if (!workflowCatalog) throw new Error("operator catalog is not ready");
    const assessment = assessWorkflow(graph, workflowCatalog);
    paperIntakeCoordinator.updateReview((current) => ({
      ...current,
      candidates: current.candidates.map((entry, candidateIndex) => candidateIndex === index ? { ...entry, graph, assessment } : entry),
    }));
    const canvasGraph = paperCanvasUpdate(appliedPaperCandidate, index, previousGraph, graph, graphSnapshotRef.current);
    if (!canvasGraph) {
      if (appliedPaperCandidate === index) setAppliedPaperCandidate(null);
      return false;
    }

    remember();
    const previousNodeIds = new Set(previousGraph.nodes.map((node) => node.id));
    const addedNodeIds = graph.nodes.filter((node) => !previousNodeIds.has(node.id)).map((node) => node.id);
    const added = new Set(addedNodeIds);
    setNodes((current) => {
      const existing = new Map(current.map((node) => [node.id, node]));
      return canvasGraph.nodes.map((graphNode) => {
        const node = existing.get(graphNode.id);
        if (!node) return { ...flowNode(graphNode, operatorMap), selected: added.has(graphNode.id) };
        return {
          ...node,
          position: graphNode.layout,
          selected: addedNodeIds.length ? added.has(graphNode.id) : node.selected,
          data: { ...node.data, graphNode },
        };
      });
    });
    setEdges((current) => {
      const existing = new Map(current.map((edge) => [edge.id, edge]));
      return canvasGraph.edges.map((graphEdge) => {
        const edge = existing.get(graphEdge.id);
        const rebuilt = flowEdge(graphEdge, canvasGraph.nodes);
        return edge ? { ...rebuilt, selected: edge.selected } : rebuilt;
      });
    });
    if (addedNodeIds.length) {
      setSelectedIds(addedNodeIds);
      const addedNodes = graph.nodes.filter((node) => added.has(node.id)).map((node) => flowNode(node, operatorMap));
      window.setTimeout(() => void flow?.fitView({ nodes: addedNodes, padding: .6, duration: 280, maxZoom: 1 }), 0);
    }
    setDirty(true);
    return true;
  }, [appliedPaperCandidate, flow, operatorMap, paperIntakeCoordinator, remember, setEdges, setNodes, workflowCatalog]);

  const updatePaperCandidateParameter = useCallback(async (index: number, item: ReadinessItem, field: string, value: ParamValue) => {
    const candidate = paperReview?.candidates[index];
    if (!candidate) return;
    const graph: SomiteGraph = {
      ...candidate.graph,
      nodes: candidate.graph.nodes.map((node) => node.id === item.node_id ? {
        ...node,
        params: { ...(node.params ?? {}), [field]: value },
      } : node),
    };
    await updatePaperCandidateGraph(index, candidate.graph, graph);
  }, [paperReview, updatePaperCandidateGraph]);

  const usePaperResource = useCallback(async (index: number, result: SourceSearchResult) => {
    const candidate = paperReview?.candidates[index];
    if (!candidate || result.request.kind !== "sra") return;
    const slot = nextPaperReadSlot(candidate);
    if (!slot) {
      setStatus("Every read input in this draft already has a source");
      return;
    }
    const prefetchOperator = operatorMap.get("sra.prefetch");
    const fasterqOperator = operatorMap.get("sra.fasterq_dump");
    if (!prefetchOperator || !fasterqOperator) {
      setStatus("Could not use cited reads — the native SRA recipe is unavailable");
      return;
    }
    const occupied = new Set([...candidate.graph.nodes, ...graphSnapshotRef.current.nodes].map((node) => node.id));
    occupied.delete(slot.id);
    const uniqueId = (base: string) => {
      let id = base;
      let suffix = 2;
      while (occupied.has(id)) id = `${base}-${suffix++}`;
      occupied.add(id);
      return id;
    };
    const prefetch = makeGraphNode(prefetchOperator, uniqueId(`${slot.id}-fetch`), slot.layout, { accession: result.request.value });
    prefetch.note = `Cited paper resource · ${result.request.value} · ${result.provider}`;
    const fasterq = makeGraphNode(fasterqOperator, uniqueId(`${slot.id}-reads`), { x: slot.layout.x + 220, y: slot.layout.y });
    const graph = replacePaperReadSlot(candidate.graph, slot.id, prefetch, fasterq);
    setStatus(`Adding cited run ${result.request.value} to ${candidate.name}…`);
    try {
      const canvasUpdated = await updatePaperCandidateGraph(index, candidate.graph, graph);
      setStatus(`${result.request.value} now supplies ${slot.id} · ${canvasUpdated ? "added to canvas" : "draft updated"} · readiness refreshed`);
    } catch (error) {
      setStatus(`Could not use ${result.request.value} — ${errorMessage(error)}`);
      throw error;
    }
  }, [operatorMap, paperReview, updatePaperCandidateGraph]);

  const attachPaperInput = useCallback(async (index: number, item: ReadinessItem, field: string, file: File) => {
    const key = `${item.id}:${field}`;
    setPaperPreparingField(key);
    setStatus(`Importing ${file.name} for ${item.title}…`);
    try {
      const result = await upload(file);
      await updatePaperCandidateParameter(index, item, field, result.path);
      setStatus(`${item.title} · attached ${result.filename}`);
    } catch (error) {
      setStatus(`Could not prepare ${item.title} — ${errorMessage(error)}`);
    } finally {
      setPaperPreparingField(null);
    }
  }, [updatePaperCandidateParameter, upload]);

  const setPaperInput = useCallback(async (index: number, item: ReadinessItem, field: string, value: string) => {
    if (!value.trim()) return;
    try {
      await updatePaperCandidateParameter(index, item, field, value.trim());
      setStatus(`${item.title} updated`);
    } catch (error) {
      setStatus(`Could not update ${item.title} — ${errorMessage(error)}`);
    }
  }, [updatePaperCandidateParameter]);

  const askAgentAboutPaperItem = useCallback((candidate: PaperCandidate, item: ReadinessItem) => {
    setAgentDraft({ id: Date.now(), message: paperResolutionAgentPrompt(candidate, item) });
    setAgentVisible(true);
    if (!agentSnapshot.connected && !agentDiscovery && !agentDiscoveryLoading) void refreshAgentDiscovery();
  }, [agentDiscovery, agentDiscoveryLoading, agentSnapshot.connected, refreshAgentDiscovery]);

  const installPaperCandidate = useCallback((candidate: PaperCandidate, index: number) => {
    if (!paperCandidateCanApply(paperReview, candidate, paperBusy)) {
      setStatus(paperBusy ? "Wait for the active paper intake to finish" : "This paper did not produce a usable workflow draft");
      return;
    }
    remember();
    const document = paperCandidateDocument(candidate);
    restoreGraph(document, true, true, inputOriginIdRef.current, false);
    const firstNodeId = document.nodes[0]?.id;
    setNodes((current) => current.map((node, nodeIndex) => ({ ...node, selected: nodeIndex === 0 })));
    setSelectedIds(firstNodeId ? [firstNodeId] : []);
    setActivePaperCandidate(index);
    setAppliedPaperCandidate(index);
    setStatus(`Rebuilt ${candidate.name} · ${candidate.graph.nodes.length} nodes · review evidence before running`);
  }, [paperBusy, paperReview, remember, restoreGraph, setNodes]);

  const openPaperIntakeSurface = useCallback(() => {
    setPaperVisible(true);
    setLibraryVisible(false);
    setProjectVisible(false);
  }, []);

  const rebuildPaper = useCallback(async (file: File) => {
    openPaperIntakeSurface();
    await paperIntakeCoordinator.start({ kind: "local", label: file.name, file });
  }, [openPaperIntakeSurface, paperIntakeCoordinator]);

  const retryPaper = useCallback(async () => {
    await paperIntakeCoordinator.retry();
  }, [paperIntakeCoordinator]);

  const cancelPaper = useCallback(() => paperIntakeCoordinator.cancel(), [paperIntakeCoordinator]);

  const openExamplePaper = useCallback(async () => {
    openPaperIntakeSurface();
    await paperIntakeCoordinator.start({ kind: "path", label: "RNA-seq methods example", path: "testdata/papers/cited_resources_methods.txt" });
  }, [openPaperIntakeSurface, paperIntakeCoordinator]);

  const rebuildBiorxivPaper = useCallback(async (paper: PaperSearchResult) => {
    openPaperIntakeSurface();
    await paperIntakeCoordinator.start({ kind: "biorxiv", label: paper.title, id: paper.id });
  }, [openPaperIntakeSurface, paperIntakeCoordinator]);

  const addDroppedFiles = useCallback(async (files: File[], position: { x: number; y: number }) => {
    if (!files.length) return;
    const sourceNode = graphSnapshotRef.current.nodes.find((node) => node.source_workflow);
    if (sourceNode) {
      const workflow = sourceNode.source_workflow;
      if (!workflow || graphSnapshotRef.current.nodes.length !== 1 || graphSnapshotRef.current.edges.length !== 0) {
        setStatus("Source-backed workflows cannot accept native file nodes · open the workflow inspector and bind an input parameter");
        return;
      }
      if (!workflow.capabilities.parameter_edits) {
        setSelectedIds([sourceNode.id]);
        setNodes((current) => current.map((node) => ({ ...node, selected: node.id === sourceNode.id })));
        setStatus("This source schema is read-only · review its source notes in the workflow inspector");
        return;
      }
      if (files.length !== 1) {
        setStatus("Drop one file at a time onto this source-backed workflow · Somite will bind its next required file input");
        return;
      }
      const parameters = editableRequiredSourceFileParameters(workflow);
      if (!parameters.length) {
        setStatus("No unbound required file input remains · open the workflow inspector to replace an existing binding");
        return;
      }
      if (parameters.length > 1) {
        setPendingSourceFile({ nodeId: sourceNode.id, file: files[0], parameterNames: parameters.map((parameter) => parameter.name) });
        setSelectedIds([sourceNode.id]);
        setNodes((current) => current.map((node) => ({ ...node, selected: node.id === sourceNode.id })));
        setReadinessVisible(false);
        setLibraryVisible(false);
        setStatus(`Choose where ${files[0].name} belongs · Somite found ${parameters.length} required file inputs`);
        return;
      }
      const [parameter] = parameters;
      setStatus(`Importing ${files[0].name} for ${parameter.label || parameter.name}…`);
      try {
        const result = await upload(files[0]);
        remember();
        await editSourceWorkflowBinding(sourceNode.id, parameter.name, { kind: "project_file", path: result.path });
        setStatus(`Imported ${result.filename} · bound to ${parameter.label || parameter.name}`);
      } catch (error) {
        setStatus(`Could not bind ${files[0].name} — ${errorMessage(error)}`);
      }
      return;
    }
    setStatus(`Importing ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
    try {
      const plan = planLocalInputs(files);
      const requiredOperatorIds = new Set<string>(plan.map((entry) => entry.kind === "paired_fastq"
        ? "files.import_paired"
        : entry.kind === "fasta" ? "files.import_fasta" : "files.import"));
      for (const operatorId of requiredOperatorIds) {
        if (!operatorMap.has(operatorId)) throw new Error(`${operatorId} operator is unavailable; no files were imported`);
      }
      const uploaded = new Array<UploadResult>(files.length);
      let nextUpload = 0;
      let completedUploads = 0;
      const worker = async () => {
        while (nextUpload < files.length) {
          const index = nextUpload++;
          uploaded[index] = await upload(files[index]!);
          completedUploads += 1;
          setStatus(`Imported ${completedUploads} of ${files.length} file${files.length === 1 ? "" : "s"}…`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));

      const currentGraph = graphSnapshotRef.current;
      if (currentGraph.nodes.some((node) => node.source_workflow)) {
        throw new Error("the canvas became source-backed while files were uploading; uploaded objects were retained but no nodes were added");
      }
      const currentFlowNodes = currentGraph.nodes.map((node) => flowNode(node, operatorMap));
      const created: SomiteGraphNode[] = [];
      for (const [index, entry] of plan.entries()) {
        const operatorId = entry.kind === "paired_fastq"
          ? "files.import_paired"
          : entry.kind === "fasta" ? "files.import_fasta" : "files.import";
        const operator = operatorMap.get(operatorId)!;
        const occupied = [...currentFlowNodes, ...created.map((node) => flowNode(node, operatorMap))];
        const id = nextNodeId(operator, occupied);
        const layout = { x: position.x + (index % 3) * 240, y: position.y + Math.floor(index / 3) * 170 };
        const params: Record<string, ParamValue> = entry.kind === "paired_fastq"
          ? { r1: uploaded[entry.r1]!.path, r2: uploaded[entry.r2]!.path }
          : { path: uploaded[entry.file]!.path };
        created.push(makeGraphNode(operator, id, layout, params));
      }
      remember(currentGraph);
      setNodes((current) => [
        ...current.map((node) => ({ ...node, selected: false })),
        ...created.map((node) => ({ ...flowNode(node, operatorMap), selected: true })),
      ]);
      setSelectedIds(created.map((node) => node.id));
      setRecent((current) => [
        ...requiredOperatorIds,
        ...current.filter((value) => !requiredOperatorIds.has(value)),
      ].slice(0, 6));
      setPendingAddPosition(null);
      setPendingConnection(null);
      setLibraryVisible(false);
      setDirty(true);
      const pairedCount = plan.filter((entry) => entry.kind === "paired_fastq").length;
      setStatus(`Added ${created.length} input node${created.length === 1 ? "" : "s"} from all ${files.length} file${files.length === 1 ? "" : "s"}${pairedCount ? ` · ${pairedCount} verified R1/R2 pair${pairedCount === 1 ? "" : "s"}` : ""}`);
    } catch (error) {
      setStatus(`Could not import files — ${errorMessage(error)}`);
    }
  }, [editSourceWorkflowBinding, operatorMap, remember, setNodes, upload]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (!flow) return;
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: true });
    const operatorId = event.dataTransfer.getData("application/somite-operator");
    if (operatorId) {
      const operator = operatorMap.get(operatorId);
      if (operator) addOperator(operator, position);
      return;
    }
    const droppedFiles = [...event.dataTransfer.files];
    if (droppedFiles.length === 1 && droppedFiles[0].name.toLowerCase().endsWith(".pdf")) {
      void rebuildPaper(droppedFiles[0]);
      return;
    }
    void addDroppedFiles(droppedFiles, position);
  }, [addDroppedFiles, addOperator, flow, operatorMap, rebuildPaper]);

  const onConnect = useCallback(async (connection: { source: string | null; sourceHandle: string | null; target: string | null; targetHandle: string | null }) => {
    if (!connection.source || !connection.sourceHandle || !connection.target || !connection.targetHandle) return;
    const somite: SomiteEdge = { id: `e-${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`, from_node: connection.source, from_port: connection.sourceHandle, to_node: connection.target, to_port: connection.targetHandle };
    const graphNodes = nodes.map((node) => node.data.graphNode);
    const companion = pairedCompanion(somite, graphNodes);
    const additions = [somite, ...(companion ? [companion] : [])].filter((edge) => !edges.some((current) => current.id === edge.id)).map((edge) => flowEdge(edge, graphNodes));
    const connected = additions.reduce((current, edge) => addEdge(edge, current), edges);
    try {
      await client.validateGraph(graphRequest(somiteGraph(workflowTitle, nodes, connected, annotations, variantOrigin)));
      remember();
      setEdges(connected);
      setDirty(true);
      setStatus(companion ? "Connected paired R1 + R2 reads" : `Connected ${connection.sourceHandle} to ${connection.targetHandle}`);
    } catch (error) {
      setStatus(`These ports cannot connect — ${errorMessage(error)}`);
    }
  }, [annotations, client, edges, graphRequest, nodes, remember, setEdges, variantOrigin, workflowTitle]);

  const onConnectStart = useCallback((_: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    const node = nodes.find((candidate) => candidate.id === params.nodeId);
    const direction = params.handleType === "source" ? "out" : params.handleType === "target" ? "in" : null;
    const port = node?.data.graphNode.ports.find((candidate) => candidate.name === params.handleId && candidate.dir === direction);
    connectionStartRef.current = node && port ? { nodeId: node.id, port } : null;
  }, [nodes]);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
    const start = connectionStartRef.current;
    connectionStartRef.current = null;
    if (!start || connectionState.isValid || connectionState.toNode) return;
    const point = eventClientPoint(event);
    if (!point || !flow || !document.elementFromPoint(point.x, point.y)?.closest(".react-flow__pane")) return;
    const position = flow.screenToFlowPosition(point, { snapToGrid: true });
    setPendingConnection({ ...start, position });
    setPendingAddPosition(position);
    setQuery("");
    setProjectVisible(false);
    setPaperVisible(false);
    setLibraryVisible(true);
    setStatus(`Choose a compatible tool for ${start.nodeId}.${start.port.name}`);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [flow]);

  const focusPaperEvidence = useCallback((evidence: PaperEvidence) => {
    if (evidence.target_kind === "node") {
      const node = nodes.find((candidate) => candidate.id === evidence.target_id);
      if (!node) return;
      setNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
      setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
      setSelectedIds([node.id]);
      setStatus(`${node.id} · ${evidence.status} paper evidence`);
      void flow?.fitView({ nodes: [node], padding: 1.2, duration: 260, maxZoom: 1.25 });
      return;
    }
    const edge = edges.find((candidate) => candidate.id === evidence.target_id);
    if (!edge) return;
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === edge.id })));
    setSelectedIds([]);
    const endpoints = nodes.filter((node) => node.id === edge.source || node.id === edge.target);
    setStatus(`${edge.id} · ${evidence.status} paper evidence`);
    if (endpoints.length) void flow?.fitView({ nodes: endpoints, padding: .8, duration: 260, maxZoom: 1.15 });
  }, [edges, flow, nodes, setEdges, setNodes]);

  const save = useCallback(async () => {
    if (session?.input_origin_warning) {
      setProjectVisible(true);
      setStatus("Confirm the workflow input location before saving");
      return;
    }
    setSaving(true);
    setStatus("Validating and saving…");
    try {
      const graph = snapshot();
      await writeBrowserGraph("/api/graph", captureGraphWrite(graph, graphEpochRef.current, inputOriginIdRef.current));
      const stillCurrent = JSON.stringify(graphSnapshotRef.current) === JSON.stringify(graph);
      if (stillCurrent) setDirty(false);
      setStatus(stillCurrent ? "Changes saved" : "Saved earlier changes · newer edits are still autosaving");
    } catch (error) {
      if (await reconcileGraphConflict(error)) return;
      setStatus(`Could not save changes — ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }, [reconcileGraphConflict, session?.input_origin_warning, snapshot, writeBrowserGraph]);

  const toggleToolchain = useCallback(async () => {
    if (session?.input_origin_warning) {
      setProjectVisible(true);
      setStatus("Confirm the workflow input location before exporting");
      return;
    }
    if (toolchainVisible) {
      setToolchainVisible(false);
      return;
    }
    setToolchainVisible(true);
    setMachineVisible(false);
    setAgentVisible(false);
    setLibraryVisible(false);
    setProjectVisible(false);
    setPaperVisible(false);
    setPendingConnection(null);
    setExportLoading(true);
    setStatus("Resolving workflow tools…");
    try {
      const plan = await client.exportPlan(graphRequest());
      setExportPlan(plan);
      const attention = plan.source_setup_count + plan.manual_count + plan.details_count + plan.legacy_count + plan.adapter_count;
      setStatus(`${plan.ready_count} ready · ${plan.installable_count} managed${attention ? ` · ${attention} need your attention` : ""}`);
    } catch (error) {
      setStatus(`Could not resolve export — ${errorMessage(error)}`);
    } finally {
      setExportLoading(false);
    }
  }, [client, graphRequest, session?.input_origin_warning, toolchainVisible]);

  const downloadBundle = useCallback(async () => {
    if (session?.input_origin_warning) {
      setProjectVisible(true);
      setStatus("Confirm the workflow input location before exporting");
      return;
    }
    setExportDownloading(true);
    setStatus("Freezing the Pixi/Nextflow run project…");
    try {
      const blob = await client.downloadExport(graphRequest());
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exportPlan?.filename ?? `${safeWorkflowFilename(workflowTitle)}.somite-run.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`Exported ${anchor.download} · ${exportPlan?.tools.length ?? 0} tool contracts`);
    } catch (error) {
      setStatus(`Could not export workflow — ${errorMessage(error)}`);
    } finally {
      setExportDownloading(false);
    }
  }, [client, exportPlan, graphRequest, session?.input_origin_warning, workflowTitle]);

  const executeGraph = useCallback(async (intent: "run" | "validation") => {
    if (running) return;
    if (session?.input_origin_warning) {
      setProjectVisible(true);
      setStatus(`Confirm the workflow input location before ${intent === "validation" ? "validating" : "running"}`);
      return;
    }
    const requestedKey = semanticKey;
    const graph = snapshot();
    if (intent === "validation") {
      const capability = representativeValidationCapability(graph);
      if (!capability.supported) {
        setStatus(capability.reason);
        if (readiness) setReadinessVisible(true);
        return;
      }
    }
    try {
      if (!workflowCatalog) throw new Error("operator catalog is not ready");
      const latest = assessWorkflow(graph, workflowCatalog);
      if (semanticKeyRef.current !== requestedKey) return;
      setReadiness(latest);
      const itemsByNode = new Map<string, ReadinessItem[]>();
      for (const item of latest.items) itemsByNode.set(item.node_id, [...(itemsByNode.get(item.node_id) ?? []), item]);
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, readinessItems: itemsByNode.get(node.id) ?? [] } })));
      if (latest.state !== "ready") {
        setReadinessVisible(true);
        const first = latest.items[0];
        if (first) focusRequirement(first);
        setStatus(latest.state === "empty" ? "Add at least one tool before running" : `Resolve ${latest.required_count} required item${latest.required_count === 1 ? "" : "s"} before ${intent === "validation" ? "validation" : "running"}`);
        return;
      }
    } catch (error) {
      setStatus(`Could not inspect readiness — ${errorMessage(error)}`);
      return;
    }
    setActiveIntent(intent);
    setStatus(intent === "validation" ? "Binding representative FASTQ fixtures…" : "Freezing the exact Pixi environment…");
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, runState: "queued" } })));
    setEdges((current) => current.map((edge) => ({ ...edge, animated: true, data: intent === "validation" && edge.data ? { ...edge.data, validationState: "queued" } : edge.data })));
    try {
      const started = await client.startRun(intent, graphRequest(graph));
      setActiveRunId(started.run_id);
      let report: RunStatusResponse;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        report = await client.runStatus(started.run_id);
        if (semanticKeyRef.current !== requestedKey) {
          await client.cancelRun(started.run_id).catch(() => undefined);
          setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, runState: "idle" } })));
          setEdges((current) => current.map((edge) => ({ ...edge, animated: false, data: edge.data ? { ...edge.data, validationState: "idle" } : edge.data })));
          setStatus("Graph changed · stale execution stopped and evidence invalidated");
          return;
        }
        setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, runState: report.states[node.id] ?? node.data.runState } })));
        if (intent === "validation") setEdges((current) => current.map((edge) => ({ ...edge, data: edge.data ? { ...edge.data, validationState: edgeLifecycleState(edge.data.somite, report.states) } : edge.data })));
        const counts = Object.values(report.states).reduce<Record<string, number>>((result, state) => ({ ...result, [state]: (result[state] ?? 0) + 1 }), {});
        if (report.phase === "preparing") setStatus(intent === "validation" ? "Freezing the fixture-bound validation closure…" : "Freezing the exact Pixi environment…");
        else if (report.phase === "running") setStatus(`${intent === "validation" ? "Validating" : "Nextflow running"} · ${counts.done ?? 0} done · ${counts.running ?? 0} active · ${counts.queued ?? 0} queued`);
        else if (report.phase === "finalizing") setStatus("Recording scoped evidence receipt…");
        else if (report.phase === "cancelling") setStatus("Stopping Nextflow…");
      } while (!(["completed", "failed", "cancelled"] as const).includes(report.phase as "completed" | "failed" | "cancelled"));

      const counts = Object.values(report.states).reduce<Record<string, number>>((result, state) => ({ ...result, [state]: (result[state] ?? 0) + 1 }), {});
      if (report.phase === "completed" && intent === "validation") setStatus(`Validated with ${report.evidence_receipt?.fixture_digests.length ?? 0} fixture${report.evidence_receipt?.fixture_digests.length === 1 ? "" : "s"} · ${counts.done ?? 0} nodes passed`);
      else if (report.phase === "completed") setStatus(`Run complete · ${counts.done ?? 0} done · ${counts.cached ?? 0} cached`);
      else if (report.phase === "cancelled") setStatus(`${intent === "validation" ? "Validation" : "Run"} cancelled`);
      else setStatus(`${intent === "validation" ? "Validation" : "Run"} failed — ${report.error?.split("\n").at(-1) ?? `exit ${report.exit_code ?? "unknown"}`}`);
    } catch (error) {
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, runState: "failed" } })));
      if (intent === "validation") setEdges((current) => current.map((edge) => ({ ...edge, data: edge.data ? { ...edge.data, validationState: "failed" } : edge.data })));
      setStatus(`${intent === "validation" ? "Validation" : "Run"} failed — ${errorMessage(error)}`);
    } finally {
      setEdges((current) => current.map((edge) => ({ ...edge, animated: false })));
      setActiveRunId(null);
      setActiveIntent(null);
    }
  }, [client, focusRequirement, graphRequest, readiness, running, semanticKey, session?.input_origin_warning, setEdges, setNodes, snapshot, workflowCatalog]);

  const runGraph = useCallback(() => executeGraph("run"), [executeGraph]);
  const validateGraphWithFixtures = useCallback(() => executeGraph("validation"), [executeGraph]);

  const cancelRun = useCallback(async () => {
    if (!activeRunId) return;
    setStatus("Stopping Nextflow…");
    try {
      await client.cancelRun(activeRunId);
    } catch (error) {
      setStatus(`Could not cancel run — ${errorMessage(error)}`);
    }
  }, [activeRunId, client]);

  const beginParamEdit = useCallback((key: string) => {
    const historyKey = `${selectedIds.at(-1) ?? ""}.${key}`;
    if (paramHistoryKeyRef.current === historyKey) return;
    paramHistoryKeyRef.current = historyKey;
    remember();
  }, [remember, selectedIds]);

  const updateParam = useCallback((key: string, value: ParamValue) => {
    const selectedId = selectedIds.at(-1);
    if (!selectedId) return;
    setNodes((current) => current.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, graphNode: { ...node.data.graphNode, params: { ...(node.data.graphNode.params ?? {}), [key]: value } } } } : node));
    setDirty(true);
    setStatus(`Changed ${selectedId}.${key}`);
  }, [selectedIds, setNodes]);

  const updateSourceWorkflowBinding = useCallback(async (key: string, binding: WorkflowBinding | undefined) => {
    const selectedId = selectedIds.at(-1);
    if (!selectedId) return;
    setStatus(`${binding ? "Saving" : "Resetting"} ${key}…`);
    try {
      await editSourceWorkflowBinding(selectedId, key, binding);
      setStatus(`${binding ? "Bound" : "Reset"} ${key} · workflow revision updated`);
    } catch (error) {
      setStatus(`Could not save ${key} — ${errorMessage(error)}`);
      throw error;
    }
  }, [editSourceWorkflowBinding, selectedIds]);

  const browseSourceWorkflowBinding = useCallback(async (key: string, file: File) => {
    const selectedId = selectedIds.at(-1);
    const workflow = graphSnapshotRef.current.nodes.find((node) => node.id === selectedId)?.source_workflow;
    if (!workflow?.capabilities.parameter_edits) {
      const error = new Error("This source schema is read-only; review its source notes before changing inputs");
      setStatus(error.message);
      throw error;
    }
    setStatus(`Importing ${file.name}…`);
    try {
      const result = await upload(file);
      await updateSourceWorkflowBinding(key, { kind: "project_file", path: result.path });
      setStatus(`Imported ${result.filename} · bound to ${key}`);
    } catch (error) {
      setStatus(`Could not bind ${file.name} — ${errorMessage(error)}`);
      throw error;
    }
  }, [selectedIds, updateSourceWorkflowBinding, upload]);

  const bindPendingSourceFile = useCallback(async (key: string) => {
    const pending = pendingSourceFile;
    if (!pending) return;
    await browseSourceWorkflowBinding(key, pending.file);
    setPendingSourceFile((current) => current === pending ? null : current);
  }, [browseSourceWorkflowBinding, pendingSourceFile]);

  const browseParam = useCallback(async (key: string, file: File) => {
    setStatus(`Importing ${file.name}…`);
    try {
      const result = await upload(file);
      beginParamEdit(key);
      updateParam(key, result.path);
      setStatus(`Imported ${result.filename}`);
    } catch (error) {
      setStatus(`Could not import file — ${errorMessage(error)}`);
    }
  }, [beginParamEdit, updateParam, upload]);

  const renameSelected = useCallback((requested: string) => {
    const old = selectedIds.at(-1);
    const next = requested.trim();
    if (!old || next === old) return;
    if (!next) {
      setStatus("Node name cannot be empty");
      return;
    }
    if (nodes.some((node) => node.id === next)) {
      setStatus(`A node named ${next} already exists`);
      return;
    }
    remember();
    setNodes((current) => current.map((node) => node.id === old ? { ...node, id: next, data: { ...node.data, graphNode: { ...node.data.graphNode, id: next } } } : node));
    setEdges((current) => current.map((edge) => {
      const somite = edge.data?.somite;
      if (!somite) return edge;
      const renamed = { ...somite, from_node: somite.from_node === old ? next : somite.from_node, to_node: somite.to_node === old ? next : somite.to_node };
      return { ...edge, id: renamed.id.replaceAll(old, next), source: edge.source === old ? next : edge.source, target: edge.target === old ? next : edge.target, data: { somite: { ...renamed, id: renamed.id.replaceAll(old, next) }, portType: edge.data?.portType ?? "Text", validationState: "idle" } };
    }));
    setSelectedIds((current) => current.map((id) => id === old ? next : id));
    setDirty(true);
    setStatus(`Renamed ${old} to ${next}`);
  }, [nodes, remember, selectedIds, setEdges, setNodes]);

  const duplicateSelected = useCallback(() => {
    if (!selectedIds.length) return;
    if (nodes.some((node) => selectedIds.includes(node.id) && Boolean(node.data.graphNode.source_workflow))) {
      setStatus("A pinned source workflow cannot be duplicated on the same canvas.");
      return;
    }
    remember();
    const selected = new Set(selectedIds);
    const idMap = new Map<string, string>();
    const working = [...nodes];
    const copies: SomiteFlowNode[] = [];
    for (const node of nodes.filter((candidate) => selected.has(candidate.id))) {
      const operator = operatorMap.get(node.data.graphNode.operator);
      if (!operator) continue;
      const id = nextNodeId(operator, working);
      idMap.set(node.id, id);
      const graphNode = { ...node.data.graphNode, id, layout: { x: node.position.x + 40, y: node.position.y + 40 } };
      const copy = { ...flowNode(graphNode, operatorMap, node.data.viewerHidden), selected: true };
      working.push(copy);
      copies.push(copy);
    }
    const graphNodes = [...nodes.map((node) => node.data.graphNode), ...copies.map((node) => node.data.graphNode)];
    const copiedEdges = edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)).map((edge) => {
      const somite = edge.data?.somite;
      if (!somite) return null;
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      if (!source || !target) return null;
      return flowEdge({ ...somite, id: `e-${source}-${somite.from_port}-${target}-${somite.to_port}`, from_node: source, to_node: target }, graphNodes);
    }).filter((edge): edge is SomiteFlowEdge => edge !== null);
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...copies]);
    setEdges((current) => [...current, ...copiedEdges]);
    setSelectedIds(copies.map((node) => node.id));
    setDirty(true);
    setStatus(`Duplicated ${copies.length} node${copies.length === 1 ? "" : "s"}`);
  }, [edges, nodes, operatorMap, remember, selectedIds, setEdges, setNodes]);

  const toggleSelectedViewers = useCallback(() => {
    if (!selectedIds.length) return;
    const selected = new Set(selectedIds);
    const shouldShow = nodes.filter((node) => selected.has(node.id)).some((node) => node.data.viewerHidden);
    setNodes((current) => current.map((node) => selected.has(node.id) ? { ...node, data: { ...node.data, viewerHidden: !shouldShow } } : node));
    setStatus(`${shouldShow ? "Showing" : "Hid"} ${selectedIds.length} selected viewer${selectedIds.length === 1 ? "" : "s"}`);
  }, [nodes, selectedIds, setNodes]);

  const toggleAllViewers = useCallback(() => {
    const shouldShow = nodes.some((node) => node.data.viewerHidden);
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, viewerHidden: !shouldShow } })));
    setStatus(shouldShow ? `Showing all ${nodes.length} node viewers` : `Hid all ${nodes.length} node viewers`);
  }, [nodes, setNodes]);

  const beginAnnotationChange = useCallback(() => remember(), [remember]);

  const updateAnnotation = useCallback((annotation: CanvasAnnotation) => {
    setAnnotations((current) => current.map((item) => item.id === annotation.id ? annotation : item));
    setDirty(true);
  }, []);

  const removeAnnotation = useCallback((id: string) => {
    remember();
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
    setSelectedAnnotationId((current) => current === id ? null : current);
    setDirty(true);
    setStatus("Removed canvas annotation");
  }, [remember]);

  const applyCanvasColor = useCallback((color: CanvasColor) => {
    setActiveCanvasColor(color);
    if (selectedIds.length) {
      remember();
      const selected = new Set(selectedIds);
      setNodes((current) => current.map((node) => selected.has(node.id) ? { ...node, data: { ...node.data, graphNode: { ...node.data.graphNode, color } } } : node));
      setDirty(true);
      setStatus(`Marked ${selectedIds.length} node${selectedIds.length === 1 ? "" : "s"} as ${getCanvasColor(color).label}`);
      return;
    }
    if (selectedAnnotationId) {
      remember();
      setAnnotations((current) => current.map((annotation) => annotation.id === selectedAnnotationId ? { ...annotation, color } : annotation));
      setDirty(true);
    }
  }, [remember, selectedAnnotationId, selectedIds, setNodes]);

  const clearNodeColor = useCallback(() => {
    if (!selectedIds.length) return;
    remember();
    const selected = new Set(selectedIds);
    setNodes((current) => current.map((node) => selected.has(node.id) ? { ...node, data: { ...node.data, graphNode: { ...node.data.graphNode, color: undefined } } } : node));
    setDirty(true);
    setStatus("Cleared node stage color");
  }, [remember, selectedIds, setNodes]);

  const placeCanvasAnnotation = useCallback((event: React.MouseEvent) => {
    if (!flow || (canvasTool !== "sticky" && canvasTool !== "box")) {
      setSelectedAnnotationId(null);
      return;
    }
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: true });
    remember();
    const annotation = createCanvasAnnotation(canvasTool, activeCanvasColor, position, annotations);
    setAnnotations((current) => [...current, annotation]);
    setSelectedAnnotationId(annotation.id);
    setCanvasTool("select");
    setDirty(true);
    setStatus(canvasTool === "sticky" ? "Added a note — start typing" : "Added a stage box");
  }, [activeCanvasColor, annotations, canvasTool, flow, remember]);

  const beginStroke = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (canvasTool !== "pen" || !flow || !(event.target instanceof Element) || !event.target.closest(".react-flow__pane")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const stroke: Extract<CanvasAnnotation, { kind: "stroke" }> = { id: nextAnnotationId("stroke", annotations), kind: "stroke", color: activeCanvasColor, points: [point] };
    remember();
    drawingRef.current = stroke;
    setAnnotations((current) => [...current, stroke]);
    setSelectedAnnotationId(stroke.id);
    setDirty(true);
  }, [activeCanvasColor, annotations, canvasTool, flow, remember]);

  const continueStroke = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const stroke = drawingRef.current;
    if (!stroke || !flow) return;
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const points = appendStrokePoint(stroke.points, point);
    if (points === stroke.points) return;
    const next = { ...stroke, points };
    drawingRef.current = next;
    setAnnotations((current) => current.map((annotation) => annotation.id === next.id ? next : annotation));
  }, [flow]);

  const finishStroke = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const stroke = drawingRef.current;
    if (!stroke) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      const next = { ...stroke, points: [point, { x: point.x + .1, y: point.y + .1 }] };
      setAnnotations((current) => current.map((annotation) => annotation.id === next.id ? next : annotation));
    }
    drawingRef.current = null;
    setStatus("Added a drawing · press Esc to return to Select");
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setProjectVisible(false);
        setPaperVisible(false);
        setLibraryVisible(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (event.key === "F5" || (command && event.key === "Enter")) {
        event.preventDefault();
        void runGraph();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if ((event.key === "Backspace" || event.key === "Delete") && selectedAnnotationId) {
        event.preventDefault();
        removeAnnotation(selectedAnnotationId);
        return;
      }
      if (command && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
      } else if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void flow?.fitView({ padding: .22, duration: 260, maxZoom: 1 });
      } else if (event.key === "Tab") {
        event.preventDefault();
        setProjectVisible(false);
        setPaperVisible(false);
        setLibraryVisible(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (!command && event.key.toLowerCase() === "m") {
        setCanvasTool("pen");
        setSelectedAnnotationId(null);
      } else if (!command && event.key.toLowerCase() === "s") {
        setCanvasTool("sticky");
        setSelectedAnnotationId(null);
      } else if (!command && event.key.toLowerCase() === "b") {
        setCanvasTool("box");
        setSelectedAnnotationId(null);
      } else if (event.key === "Escape") {
        if (sourceNetworkView) {
          exitSourceNetwork(sourceNetworkView.nodeId);
          return;
        }
        setCanvasTool("select");
        setSelectedAnnotationId(null);
        setLibraryVisible(false);
        setProjectVisible(false);
        setMachineVisible(false);
        setPaperVisible(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duplicateSelected, exitSourceNetwork, flow, redo, removeAnnotation, runGraph, save, selectedAnnotationId, sourceNetworkView, undo]);

  const selectedNode = nodes.find((node) => node.id === selectedIds.at(-1)) ?? null;
  const nestedSourceNode = sourceNetworkView ? nodes.find((node) => node.id === sourceNetworkView.nodeId && node.data.graphNode.source_workflow) ?? null : null;
  const selectedOperator = selectedNode ? operatorMap.get(selectedNode.data.graphNode.operator) : undefined;
  const selectedHiddenCount = nodes.filter((node) => selectedIds.includes(node.id) && node.data.viewerHidden).length;
  const allViewersHidden = nodes.length > 0 && nodes.every((node) => node.data.viewerHidden);
  const showCanvasPalette = canvasTool !== "select" || selectedIds.length > 0 || selectedAnnotationId !== null;
  const statusError = /not running|could not|cannot|failed|invalid/i.test(status);
  const readinessStatus = readinessSummary(readiness, running, validationEvidence, readinessError);

  if (!session) {
    return <main className="boot-screen"><div className="brand-mark"><span /><span /><span /><span /></div><span className="spin"><LoaderCircle size={22} aria-hidden="true" /></span><p>{status}</p><small>Run scripts/somite-web from the project to open this graph.</small></main>;
  }

  return (
    <>
      <a className="skip-link" href="#workflow-canvas">Skip to Workflow Canvas</a>
      <main className="app-shell studio-shell">
        <header className="topbar studio-topbar">
          <div className="wordmark">
            <div className="somite-dots" aria-hidden="true"><i /><i /><i /><i /></div>
            <strong>Somite</strong>
            <div className="workflow-identity" title={`${session.project_name} · ${session.graph_path}`}>
              <input
                className="workflow-title-input"
                aria-label="Workflow name"
                value={workflowTitle}
                maxLength={100}
                size={Math.min(52, Math.max(18, workflowTitle.length))}
                spellCheck={false}
                onFocus={startTitleEdit}
                onChange={(event) => {
                  setWorkflowTitle(event.currentTarget.value);
                  setDirty(true);
                  setExportPlan(null);
                }}
                onBlur={finishTitleEdit}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelTitleEdit(event.currentTarget);
                  }
                }}
              />
              <span className="workflow-project">in {session.project_name}</span>
            </div>
            {variantOrigin && <div className="workflow-variant-badge" title="This canvas is a native editable variant of a pinned source workflow">
              <span><strong>Native variant</strong><small>{Object.keys(variantOrigin.promoted_invocations ?? {}).length} promoted call{Object.keys(variantOrigin.promoted_invocations ?? {}).length === 1 ? "" : "s"}</small></span>
              <button type="button" onClick={() => void restorePinnedSourceWorkflow()}>Return to pinned source</button>
            </div>}
            {dirty && <span className="unsaved-dot" title="Unsaved changes" />}
          </div>
          <div className="top-actions studio-actions">
            <button type="button" className="studio-button" onClick={undo} disabled={!history.past.length} title="Undo (Ctrl/Cmd Z)"><Undo2 size={14} aria-hidden="true" /><span>Undo</span></button>
            <button type="button" className="studio-button" onClick={redo} disabled={!history.future.length} title="Redo (Shift Ctrl/Cmd Z)"><Redo2 size={14} aria-hidden="true" /><span>Redo</span></button>
            <button type="button" className="studio-button theme-toggle" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}</button>
            <button type="button" className="studio-button" onClick={() => void save()} disabled={saving || !dirty || inputOriginRecoveryRequired} title={inputOriginBlockedReason ?? "Save workflow"}>{saving ? <span className="spin"><LoaderCircle size={14} /></span> : inputOriginRecoveryRequired ? <CircleAlert size={14} /> : dirty ? <Save size={14} /> : <Check size={14} />}<span>{saving ? "Saving…" : inputOriginRecoveryRequired ? "Paused" : dirty ? "Save" : "Saved"}</span></button>
            <button type="button" className={`studio-button ${toolchainVisible ? "active" : ""}`} onClick={() => void toggleToolchain()} disabled={inputOriginRecoveryRequired} title={inputOriginBlockedReason ?? "Environment and Export"}><PackageOpen size={14} aria-hidden="true" /><span>Export</span></button>
            <button type="button" className="studio-button validation-button" disabled={inputOriginRecoveryRequired || running || !validationCapability.supported} onClick={() => void validateGraphWithFixtures()} title={inputOriginBlockedReason ?? (validationCapability.supported ? "Validate with small representative FASTQ fixtures" : validationCapability.reason)}>{activeIntent === "validation" ? <span className="spin"><LoaderCircle size={14} /></span> : <ShieldCheck size={14} />}<span>{activeIntent === "validation" ? "Validating…" : "Validate"}</span></button>
            <button type="button" className={`run-button ${running ? "is-running" : ""}`} disabled={(!running && inputOriginRecoveryRequired) || (running && !activeRunId)} onClick={() => void (running ? cancelRun() : runGraph())} title={inputOriginBlockedReason ?? (running ? "Cancel active Nextflow run" : "Run workflow (F5 or Ctrl/Cmd Enter)")}>{running ? activeRunId ? <><Square size={12} fill="currentColor" />Cancel</> : <><span className="spin"><LoaderCircle size={14} /></span>Preparing…</> : <><Play size={14} />Run</>}</button>
          </div>
        </header>

        {inputOriginRecoveryRequired && <section className="input-origin-recovery" role="alert" aria-busy={inputOriginRecovering}>
          <CircleAlert size={18} aria-hidden="true" />
          <span><strong>Confirm where this workflow&apos;s files live</strong><small>Somite recovered the canvas, but its saved input location no longer matches. Save, Agent edits, Export, Validate, and Run are paused so relative files cannot come from the wrong folder.</small></span>
          <div>
            <button type="button" className="primary" disabled={inputOriginRecovering} onClick={() => { setLibraryVisible(false); setPaperVisible(false); setToolchainVisible(false); setProjectVisible(true); }}>Choose original workflow</button>
            <button type="button" disabled={inputOriginRecovering} onClick={() => void recoverInputOrigin(inputOriginIdRef.current, "this project folder").catch(() => undefined)}>{inputOriginRecovering ? <><LoaderCircle className="spin" size={12} />Confirming…</> : "Use this project folder"}</button>
          </div>
        </section>}

        <section id="workflow-canvas" aria-label="Workflow Canvas" className={`canvas-wrap studio-canvas tool-${canvasTool}`} onDrop={onDrop} onDragOver={(event) => event.preventDefault()} onPointerDownCapture={beginStroke} onPointerMove={continueStroke} onPointerUp={finishStroke} onPointerCancel={finishStroke} onDoubleClick={(event) => {
          if (canvasTool !== "select" || !flow || !(event.target instanceof Element) || !event.target.closest(".react-flow__pane")) return;
          setPendingConnection(null);
          setPendingAddPosition(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: true }));
          setProjectVisible(false);
          setPaperVisible(false);
          setToolchainVisible(false);
          setLibraryVisible(true);
          window.setTimeout(() => searchInputRef.current?.focus(), 0);
        }} onPointerDown={() => {
          if (libraryVisible) { setLibraryVisible(false); setPendingConnection(null); }
          if (projectVisible) setProjectVisible(false);
          if (machineVisible) setMachineVisible(false);
          if (paperVisible) setPaperVisible(false);
          if (toolchainVisible) setToolchainVisible(false);
        }}>
          {nestedSourceNode && sourceNetworkView ? <NestedSourceCanvas
            graphNode={nestedSourceNode.data.graphNode}
            path={sourceNetworkView.path}
            operators={availableOperators}
            onEnter={(scopeId) => enterSourceNetwork(sourceNetworkView.nodeId, scopeId)}
            onExit={() => exitSourceNetwork(sourceNetworkView.nodeId)}
            onOpenPath={(path) => openSourceNetworkPath(sourceNetworkView.nodeId, path)}
            onReplace={(invocationId, operator) => replaceSourceInvocation(sourceNetworkView.nodeId, invocationId, operator)}
            onPromote={(invocationId) => promoteSourceInvocation(sourceNetworkView.nodeId, invocationId)}
            onReset={(invocationId) => resetSourceInvocation(sourceNetworkView.nodeId, invocationId)}
          /> : <>
          {snapGuides.x !== undefined && <div className="snap-guide vertical" style={{ left: snapGuides.x }} />}
          {snapGuides.y !== undefined && <div className="snap-guide horizontal" style={{ top: snapGuides.y }} />}
          <NestedCanvasContext.Provider value={exploreSourceWorkflow}>
          <ContinuationContext.Provider value={openContinuation}>
          <ReactFlow<SomiteFlowNode, SomiteFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setFlow}
            onNodesChange={(changes) => {
              if (changes.some((change) => change.type === "remove")) remember();
              onNodesChange(changes);
              if (changes.some((change) => change.type === "remove")) setDirty(true);
            }}
            onEdgesChange={(changes) => {
              if (changes.some((change) => change.type === "remove")) remember();
              onEdgesChange(changes);
              if (changes.some((change) => change.type === "remove")) setDirty(true);
            }}
            onNodeDragStart={() => { dragSnapshotRef.current = snapshot(); }}
            onNodeDrag={(_, node) => {
              if (!flow) return;
              const guide = neighborAlignment(node, nodes);
              const canvas = document.getElementById("workflow-canvas")?.getBoundingClientRect();
              if (!canvas) return;
              setSnapGuides({
                x: guide.x === undefined ? undefined : flow.flowToScreenPosition({ x: guide.x, y: 0 }).x - canvas.left,
                y: guide.y === undefined ? undefined : flow.flowToScreenPosition({ x: 0, y: guide.y }).y - canvas.top,
              });
            }}
            onNodeDragStop={(_, node) => {
              const guide = neighborAlignment(node, nodes);
              if (guide.x !== undefined || guide.y !== undefined) {
                setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, position: { x: guide.x ?? candidate.position.x, y: guide.y ?? candidate.position.y } } : candidate));
              }
              setSnapGuides({});
              if (dragSnapshotRef.current) remember(dragSnapshotRef.current);
              dragSnapshotRef.current = null;
              setDirty(true);
            }}
            onConnect={(connection) => void onConnect(connection)}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onPaneClick={placeCanvasAnnotation}
            onSelectionChange={({ nodes: selected }) => {
              const next = selected.map((node) => node.id);
              setSelectedIds((current) => current.length === next.length && current.every((id, index) => id === next[index]) ? current : next);
              if (next.length) setSelectedAnnotationId(null);
              paramHistoryKeyRef.current = null;
            }}
            onMove={(_, viewport) => {
              setZoom((current) => Math.abs(current - viewport.zoom) < .001 ? current : viewport.zoom);
            }}
            fitView
            fitViewOptions={{ padding: .25, maxZoom: 1 }}
            snapToGrid
            snapGrid={SNAP}
            minZoom={.02}
            maxZoom={2.8}
            deleteKeyCode={["Backspace", "Delete"]}
            multiSelectionKeyCode={["Meta", "Control"]}
            selectionOnDrag
            panOnScroll
            zoomOnScroll={false}
            zoomOnDoubleClick={false}
            zoomOnPinch
            zoomActivationKeyCode={["Meta", "Control"]}
            panOnDrag={canvasTool === "select" ? [1, 2] : false}
            nodesDraggable={canvasTool === "select"}
            panActivationKeyCode="Space"
            connectionRadius={28}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Lines} gap={20} size={1} color="var(--grid)" />
            <ViewportPortal>
              <CanvasAnnotations annotations={annotations} zoom={zoom} selectedId={selectedAnnotationId} onSelect={(id) => { setSelectedAnnotationId(id); if (id) { setSelectedIds([]); setNodes((current) => current.map((node) => ({ ...node, selected: false }))); } }} onBeginChange={beginAnnotationChange} onChange={updateAnnotation} onRemove={removeAnnotation} />
            </ViewportPortal>
          </ReactFlow>
          </ContinuationContext.Provider>
          </NestedCanvasContext.Provider>
          <div className="drop-hint"><CloudUpload size={14} aria-hidden="true" />Drop FASTQ pairs, local files, or workflow directories</div>
          </>}
        </section>

        {!sourceNetworkView && <aside className="tool-rail" aria-label="Workspace Tools">
          <button type="button" className={libraryVisible ? "primary active" : "primary"} aria-label="Add to Canvas" title="Add to Canvas" onClick={(event) => { event.stopPropagation(); const opening = !libraryVisible; setProjectVisible(false); setPaperVisible(false); setToolchainVisible(false); setPendingConnection(null); setLibraryVisible(opening); if (opening) window.setTimeout(() => searchInputRef.current?.focus(), 0); }}><Plus size={19} aria-hidden="true" /></button>
          <button type="button" className={projectVisible ? "active" : ""} aria-label="Project" title="Project" onClick={(event) => { event.stopPropagation(); const opening = !projectVisible; setLibraryVisible(false); setPaperVisible(false); setToolchainVisible(false); setPendingConnection(null); setProjectVisible(opening); }}><FolderOpen size={16} aria-hidden="true" /></button>
          <div className="tool-rail-divider" />
          <button type="button" className={paperVisible ? "active" : ""} aria-label="Rebuild from a Paper" title="Paper Reconstruction" onClick={(event) => { event.stopPropagation(); const opening = !paperVisible; setPendingConnection(null); setLibraryVisible(false); setProjectVisible(false); setToolchainVisible(false); setPaperVisible(opening); }}><FileSearch size={16} aria-hidden="true" /></button>
        </aside>}

        {!agentVisible && <button type="button" className="agent-edge-launcher" aria-label="Open Agent" title={agentTransportError ? "Agent connection interrupted" : "Open Agent"} onClick={(event) => { event.stopPropagation(); setAgentDraft(null); setAgentVisible(true); if (!agentSnapshot.connected && !agentDiscovery && !agentDiscoveryLoading) void refreshAgentDiscovery(); }}><Bot size={16} aria-hidden="true" /><span>Agent</span>{(agentSnapshot.connected || agentSnapshot.connecting) && <i className={agentTransportError ? "error" : agentSnapshot.busy ? "busy" : "ready"} />}</button>}

        {!sourceNetworkView && <div className="canvas-toolbar" aria-label="Canvas Tools" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className={libraryVisible ? "primary active" : "primary"} aria-label="Add Anything" title="Add anything (Ctrl K)" onClick={() => { setProjectVisible(false); setPaperVisible(false); setToolchainVisible(false); setPendingConnection(null); setLibraryVisible(true); window.setTimeout(() => searchInputRef.current?.focus(), 0); }}><Plus size={17} aria-hidden="true" /><span>Add</span></button>
          <label className="canvas-tool" title="Import local files"><CloudUpload size={16} aria-hidden="true" /><span>Import files</span><input type="file" multiple aria-label="Import local files" onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void addDroppedFiles(files, canvasCenter()); }} /></label>
          <i className="canvas-toolbar-divider" />
          <button type="button" className={canvasTool === "select" ? "active" : ""} aria-label="Select Tool" title="Select (Esc)" onClick={() => setCanvasTool("select")}><MousePointer2 size={15} aria-hidden="true" /></button>
          <button type="button" className={canvasTool === "pen" ? "active" : ""} aria-label="Pen Tool" title="Pen (M)" onClick={() => { setCanvasTool("pen"); setSelectedAnnotationId(null); }}><PenTool size={15} aria-hidden="true" /></button>
          <button type="button" className={canvasTool === "sticky" ? "active" : ""} aria-label="Sticky Note Tool" title="Sticky note (S)" onClick={() => { setCanvasTool("sticky"); setSelectedAnnotationId(null); }}><StickyNote size={15} aria-hidden="true" /></button>
          <button type="button" className={canvasTool === "box" ? "active" : ""} aria-label="Box Tool" title="Stage box (B)" onClick={() => { setCanvasTool("box"); setSelectedAnnotationId(null); }}><Square size={15} aria-hidden="true" /></button>
          {showCanvasPalette && <div className="canvas-color-palette" aria-label="Canvas colors"><Palette size={13} aria-hidden="true" />{canvasPalette.map((entry) => <button key={entry.color} type="button" className={activeCanvasColor === entry.color ? "active" : ""} style={{ "--swatch": entry.hex } as React.CSSProperties} aria-label={`Use ${entry.label} color`} title={entry.label} onClick={() => applyCanvasColor(entry.color)} />)}{selectedIds.length > 0 && <button type="button" className="clear" aria-label="Clear node color" title="Clear node color" onClick={clearNodeColor}><X size={10} /></button>}</div>}
          <i className="canvas-toolbar-divider" />
          <button type="button" aria-label="Fit Workflow" title="Fit workflow (F)" onClick={() => void flow?.fitView({ padding: .22, duration: 260, maxZoom: 1 })}><Maximize2 size={16} aria-hidden="true" /></button>
          <button type="button" aria-label={allViewersHidden ? "Show All Viewers" : "Hide All Viewers"} title={allViewersHidden ? "Show all viewers" : "Hide all viewers"} disabled={!nodes.length} onClick={toggleAllViewers}>{allViewersHidden ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}</button>
        </div>}

        {libraryVisible && <div className="panel-layer" onPointerDown={(event) => event.stopPropagation()}><LibraryPanel client={client} operators={availableOperators} query={query} filterQuery={deferredQuery} favorites={favorites} recent={recent} categoryOpen={categoryOpen} searchInputRef={searchInputRef} continuation={pendingConnection} catalogExpansion={catalogExpansion} workflowCatalogState={workflowCatalogState} onQuery={setQuery} onClose={() => { setLibraryVisible(false); setPendingConnection(null); setCatalogExpansion(null); }} onAddOperator={addOperator} onAddSource={addSource} onImportFiles={(files) => addDroppedFiles(files, canvasCenter())} onToggleFavorite={(id) => setFavorites((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onToggleCategory={(title, open) => setCategoryOpen((current) => ({ ...current, [title]: open }))} onRetryWorkflowCatalogs={retryWorkflowCatalogs} onDismissCatalogExpansion={() => { setStatus(`${catalogExpansion?.title ?? "Workflow"} was not added · canvas unchanged`); setCatalogExpansion(null); }} /></div>}

        {projectVisible && <div className={`project-layer ${inputOriginRecoveryRequired ? "recovery" : ""}`} onPointerDown={(event) => event.stopPropagation()}><ProjectPanel projectName={session.project_name} graphPath={session.graph_path} recoveryMode={inputOriginRecoveryRequired} onImportProject={importLocalProject} onClose={() => setProjectVisible(false)} /></div>}

        {selectedNode && selectedOperator && <div className="inspector-layer" onPointerDown={(event) => event.stopPropagation()}><InspectorPanel key={selectedNode.id} node={selectedNode.data.graphNode} selectedCount={selectedIds.length} operator={selectedOperator} hiddenViewerCount={selectedHiddenCount} setupCount={selectedNode.data.readinessItems.length} updateParam={updateParam} updateSourceBinding={updateSourceWorkflowBinding} browseSourceBinding={browseSourceWorkflowBinding} pendingSourceFile={pendingSourceFile?.nodeId === selectedNode.id ? pendingSourceFile : undefined} bindPendingSourceFile={bindPendingSourceFile} dismissPendingSourceFile={() => setPendingSourceFile(null)} beginParamEdit={beginParamEdit} browseParam={browseParam} rename={renameSelected} toggleViewers={toggleSelectedViewers} exploreSource={() => exploreSourceWorkflow(selectedNode.id)} close={() => { setSelectedIds([]); flow?.setNodes((current) => current.map((node) => ({ ...node, selected: false }))); }} /></div>}

        {machineVisible && <div className="machine-layer" onPointerDown={(event) => event.stopPropagation()}><MachinePanel profile={system} storage={storage} storageLoading={storageLoading} storageReclaiming={storageReclaiming} storageError={storageError} paperToolsInstalling={paperToolsInstalling} paperToolsError={paperToolsError} onRefreshStorage={refreshStorage} onReclaimRunWork={reclaimFinishedRunWork} onInstallPaperTools={installPaperTools} onClose={() => setMachineVisible(false)} /></div>}

        {toolchainVisible && <div className="toolchain-layer" onPointerDown={(event) => event.stopPropagation()}><ToolchainPanel plan={exportPlan} pixiReady={system?.tools.pixi} loading={exportLoading} downloading={exportDownloading} onDownload={downloadBundle} onClose={() => setToolchainVisible(false)} /></div>}

        {paperVisible && <div className="paper-layer" onPointerDown={(event) => event.stopPropagation()}><PaperPanel client={client} intake={paperIntake} active={activePaperCandidate} applied={appliedPaperCandidate} preparingField={paperPreparingField} onFile={rebuildPaper} onRetry={retryPaper} onCancel={cancelPaper} onExample={openExamplePaper} onReconstruct={rebuildBiorxivPaper} onSelect={setActivePaperCandidate} onApply={(index) => { const candidate = paperReview?.candidates[index]; if (candidate) installPaperCandidate(candidate, index); }} onUseResource={usePaperResource} onAttachInput={attachPaperInput} onSetInput={setPaperInput} onEscalate={askAgentAboutPaperItem} onEvidence={focusPaperEvidence} onClose={() => setPaperVisible(false)} /></div>}

        {readinessVisible && readiness && <div className={`readiness-layer ${agentVisible ? "with-agent" : ""}`} onPointerDown={(event) => event.stopPropagation()}><ReadinessPanel snapshot={readiness} evidence={validationEvidence} validationCapability={validationCapability} onResolve={resolveRequirement} onFocus={focusRequirement} onAttachFile={attachRequirementFile} onAskAssistant={askAssistantAboutRequirement} onClose={() => setReadinessVisible(false)} /></div>}

        {agentVisible && <div className="agent-layer" onPointerDown={(event) => event.stopPropagation()}><AgentPanel key={agentDraft?.id ?? "agent"} snapshot={agentSnapshot} transportError={agentTransportError} blockedReason={inputOriginBlockedReason} discovery={agentDiscovery} discoveryLoading={agentDiscoveryLoading} draft={agentDraft} onRefreshDiscovery={refreshAgentDiscovery} onConnect={connectAgent} onConfig={configureAgent} onPrompt={promptAgent} onCancel={cancelAgent} onDisconnect={disconnectAgent} onPermission={answerAgentPermission} onClose={() => { setAgentVisible(false); setAgentDraft(null); }} /></div>}

        <footer className="statusbar studio-statusbar" aria-live="polite">
          <span className={`engine-light ${statusError ? "error" : ""}`} />
          <span className="status-copy">{status}</span>
          <span className="status-spacer" />
          <button type="button" className={`readiness-status tone-${readinessStatus.tone} ${readinessVisible ? "active" : ""}`} title={readinessStatus.detail} aria-expanded={readinessVisible} onClick={(event) => { event.stopPropagation(); if (readinessError) { setReadinessError(null); setReadinessRetry((current) => current + 1); setStatus("Retrying readiness checks…"); } else if (readiness) setReadinessVisible((visible) => !visible); }}>
            {readinessStatus.tone === "ready" || readinessStatus.tone === "validated" ? <CheckCircle2 size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}{readinessStatus.label}
          </button>
          {sourceNetworkView && nestedSourceNode?.data.graphNode.source_workflow
            ? <><span>{countFormatter.format(projectSourceNetwork(nestedSourceNode.data.graphNode.source_workflow, sourceNetworkView.path).cards.length)} source calls</span><span>1 visible layer</span></>
            : <><span>{countFormatter.format(nodes.length)} nodes</span><span>{countFormatter.format(edges.length)} wires</span></>}
          <button type="button" className={machineVisible ? "active" : ""} onClick={(event) => { event.stopPropagation(); setToolchainVisible(false); setProjectVisible(false); const opening = !machineVisible; setMachineVisible(opening); if (opening) void refreshStorage(); }}><Cpu size={12} aria-hidden="true" />Machine</button>
          {!sourceNetworkView && <div className="zoom-cluster">
            <button type="button" aria-label="Zoom Out" onClick={() => void flow?.zoomOut({ duration: 120 })}><Minus size={13} /></button>
            <button type="button" aria-label="Reset Zoom to 100%" onClick={() => void flow?.zoomTo(1, { duration: 160 })}>{Math.round(zoom * 100)}%</button>
            <button type="button" aria-label="Zoom In" onClick={() => void flow?.zoomIn({ duration: 120 })}><Plus size={13} /></button>
          </div>}
        </footer>
      </main>
    </>
  );
}

export function SomiteApp({ initialQuery = "", serverUrl = "http://localhost:7310" }: { initialQuery?: string; serverUrl?: string }) {
  const client = useMemo(() => createSomiteClient(serverUrl), [serverUrl]);
  return <ReactFlowProvider><SomiteWorkspace key={client.origin} initialQuery={initialQuery} client={client} /></ReactFlowProvider>;
}
