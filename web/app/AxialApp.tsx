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
  CloudUpload,
  Cpu,
  Eye,
  EyeOff,
  FileSearch,
  LoaderCircle,
  Minus,
  Moon,
  PackageOpen,
  Plus,
  Play,
  Redo2,
  Save,
  Sun,
  Undo2,
  Waypoints,
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
  InspectorPanel,
  LibraryPanel,
  MachinePanel,
  PaperPanel,
  ToolchainPanel,
  type LibraryMode,
} from "./WorkspacePanels";
import type { SourceRequest } from "./sourceBuilder";
import { continuationEdge, nextContinuationPosition, type PendingConnection } from "./graphInteractions";
import type {
  AxialEdge,
  AxialGraph,
  AxialGraphNode,
  AxialPort,
  Operator,
  NfcoreCatalog,
  SnakemakeCatalog,
  ParamValue,
  PaperCandidate,
  PaperEvidence,
  PaperReview,
  ExportPlan,
  ProjectSession,
  RunResponse,
  SystemProfile,
  UploadResult,
  WorkflowGraphResponse,
} from "./types";
import { portColor } from "./visual";
import { AXIAL_SERVER, jsonRequest } from "./api";

const SNAP: [number, number] = [20, 20];
const HISTORY_LIMIT = 80;
const READ_ONE_PATTERN = /(?:^|[_.])R?1(?:[_.]|$)/i;
const READ_TWO_PATTERN = /(?:^|[_.])R?2(?:[_.]|$)/i;
const countFormatter = new Intl.NumberFormat();

type AxialNodeData = Record<string, unknown> & {
  graphNode: AxialGraphNode;
  title: string;
  cost: "low" | "high";
  viewerHidden: boolean;
  runState: "idle" | "running" | "cached" | "done" | "failed" | "skipped";
};
type AxialFlowNode = Node<AxialNodeData, "axial">;
type AxialFlowEdge = Edge<{ axial: AxialEdge; portType: string }, "typed">;
type History = { past: AxialGraph[]; future: AxialGraph[] };
type Theme = "dark" | "light";
type ContinueFromPort = (nodeId: string, port: AxialPort) => void;

const ContinuationContext = createContext<ContinueFromPort | null>(null);

function AxialNodeCardBase({ data, selected }: NodeProps<AxialFlowNode>) {
  const { graphNode, title, viewerHidden, runState } = data;
  const inputs = graphNode.ports.filter((port) => port.dir === "in");
  const outputs = graphNode.ports.filter((port) => port.dir === "out");
  return (
    <article className={`axial-node state-${runState} ${selected ? "is-selected" : ""} ${viewerHidden ? "viewer-hidden" : ""}`}>
      <div className="node-floating-title"><i /><span>{title}</span>{runState !== "idle" && <em>{runState}</em>}</div>
      {viewerHidden ? (
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
      <span className={`viewer-flag ${viewerHidden ? "off" : ""}`} title={viewerHidden ? "Viewer hidden" : "Viewer visible"} />
      {!viewerHidden && <span className="node-name">{graphNode.id}</span>}
      <div className="port-column port-inputs">
        {inputs.map((port, index) => <PortHandle key={port.name} nodeId={graphNode.id} port={port} index={index} count={inputs.length} />)}
      </div>
      <div className="port-column port-outputs">
        {outputs.map((port, index) => <PortHandle key={port.name} nodeId={graphNode.id} port={port} index={index} count={outputs.length} />)}
      </div>
    </article>
  );
}

function stringParam(node: AxialGraphNode, key: string) {
  const value = node.params?.[key];
  return typeof value === "string" ? value : "";
}

function NodeViewer({ node, title }: { node: AxialGraphNode; title: string }) {
  const operator = node.operator;
  if (operator === "files.import" || operator === "files.import_directory") {
    const path = stringParam(node, "path");
    const filename = path.split(/[\\/]/).at(-1) || "Choose a file";
    return <div className="viewer-file"><strong>{filename}</strong><span>{path ? "local source" : "file input"}</span><div className="sequence-strip" aria-hidden="true"><i>A</i><i>C</i><i>G</i><i>T</i><i>G</i><i>A</i><i>C</i><i>T</i></div></div>;
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

const AxialNodeCard = memo(AxialNodeCardBase);

function PortHandle({ nodeId, port, index, count }: { nodeId: string; port: AxialPort; index: number; count: number }) {
  const top = `${((index + 1) * 100) / (count + 1)}%`;
  const input = port.dir === "in";
  const continueFrom = useContext(ContinuationContext);
  return (
    <div className={`port-row ${input ? "input" : "output"}`} style={{ top }}>
      <span>{port.name}</span>
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

const nodeTypes = { axial: AxialNodeCard };

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
}: EdgeProps<AxialFlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.42 });
  return <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke: portColor[data?.portType ?? ""] ?? "#8b949b", strokeWidth: selected ? 3 : 2.1, opacity: selected ? 1 : .82 }} />;
}

const TypedEdge = memo(TypedEdgeBase);
const edgeTypes = { typed: TypedEdge };

function flowNode(node: AxialGraphNode, operators: Map<string, Operator>, viewerHidden = false, runState: AxialNodeData["runState"] = "idle"): AxialFlowNode {
  const operator = operators.get(node.operator);
  const importedTitle = node.operator === "workflow.reference" && typeof node.params?.component === "string"
    ? node.params.component.split(":").at(-1)?.replaceAll("_", " ")
    : undefined;
  return {
    id: node.id,
    type: "axial",
    position: node.layout,
    data: { graphNode: node, title: importedTitle ?? operator?.title ?? node.operator, cost: operator?.cost ?? "high", viewerHidden, runState },
  };
}

function edgePortType(edge: AxialEdge, graphNodes: AxialGraphNode[]) {
  return graphNodes.find((node) => node.id === edge.from_node)?.ports.find((port) => port.dir === "out" && port.name === edge.from_port)?.ty ?? "Text";
}

function flowEdge(edge: AxialEdge, graphNodes: AxialGraphNode[]): AxialFlowEdge {
  return {
    id: edge.id,
    source: edge.from_node,
    sourceHandle: edge.from_port,
    target: edge.to_node,
    targetHandle: edge.to_port,
    type: "typed",
    markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13 },
    data: { axial: edge, portType: edgePortType(edge, graphNodes) },
  };
}

function pairedCompanion(edge: AxialEdge, graphNodes: AxialGraphNode[]): AxialEdge | null {
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

function axialGraph(nodes: AxialFlowNode[], edges: AxialFlowEdge[]): AxialGraph {
  return {
    schema_version: 1,
    nodes: nodes.map((node) => ({ ...node.data.graphNode, layout: { x: node.position.x, y: node.position.y } })),
    edges: edges.map((edge) => edge.data?.axial).filter((edge): edge is AxialEdge => Boolean(edge)),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function nextNodeId(operator: Operator, nodes: AxialFlowNode[]) {
  const stem = operator.id.split(".").at(-1)?.replaceAll(/[^a-z0-9]/gi, "") || "node";
  const used = new Set(nodes.map((node) => node.id));
  let index = 1;
  while (used.has(`${stem}${index}`)) index += 1;
  return `${stem}${index}`;
}

function makeGraphNode(operator: Operator, id: string, position: { x: number; y: number }, params: Record<string, ParamValue> = {}): AxialGraphNode {
  const defaults = Object.fromEntries(Object.entries(operator.params).filter(([, spec]) => spec.default !== undefined).map(([key, spec]) => [key, spec.default as ParamValue]));
  return {
    id,
    operator: operator.id,
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

function neighborAlignment(node: AxialFlowNode, nodes: AxialFlowNode[]) {
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

function AxialWorkspace({ initialQuery }: { initialQuery: string }) {
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [system, setSystem] = useState<SystemProfile | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AxialFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<AxialFlowEdge>([]);
  const [flow, setFlow] = useState<ReactFlowInstance<AxialFlowNode, AxialFlowEdge> | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDeferredValue(query);
  const [libraryVisible, setLibraryVisible] = useState(true);
  const [libraryMode, setLibraryMode] = useState<LibraryMode>("build");
  const [machineVisible, setMachineVisible] = useState(false);
  const [toolchainVisible, setToolchainVisible] = useState(false);
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportDownloading, setExportDownloading] = useState(false);
  const [paperVisible, setPaperVisible] = useState(false);
  const [paperReview, setPaperReview] = useState<PaperReview | null>(null);
  const [activePaperCandidate, setActivePaperCandidate] = useState(0);
  const [paperLoading, setPaperLoading] = useState(false);
  const [nfcoreCatalog, setNfcoreCatalog] = useState<NfcoreCatalog | null>(null);
  const [nfcoreStatus, setNfcoreStatus] = useState<"loading" | "ready" | "offline">("loading");
  const [snakemakeCatalog, setSnakemakeCatalog] = useState<SnakemakeCatalog | null>(null);
  const [snakemakeStatus, setSnakemakeStatus] = useState<"loading" | "ready" | "offline">("loading");
  const [categoryOpen, setCategoryOpen] = useState<Record<string, boolean>>({});
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recent, setRecent] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Connecting to the local Axial engine…");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [theme, setTheme] = useState<Theme>("dark");
  const [snapGuides, setSnapGuides] = useState<{ x?: number; y?: number }>({});
  const [pendingAddPosition, setPendingAddPosition] = useState<{ x: number; y: number } | null>(null);
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [libraryStateLoaded, setLibraryStateLoaded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dragSnapshotRef = useRef<AxialGraph | null>(null);
  const paramHistoryKeyRef = useRef<string | null>(null);
  const connectionStartRef = useRef<Pick<PendingConnection, "nodeId" | "port"> | null>(null);

  const availableOperators = useMemo(() => {
    const operators = new Map<string, Operator>();
    for (const operator of session?.operators ?? []) operators.set(operator.id, operator);
    for (const entry of nfcoreCatalog?.entries ?? []) operators.set(entry.operator.id, { ...entry.operator, description: entry.description, topics: entry.topics });
    for (const entry of snakemakeCatalog?.entries ?? []) operators.set(entry.operator.id, { ...entry.operator, description: `${entry.description}${entry.stars ? ` · ★ ${entry.stars}` : ""}${entry.expandable ? " · graph ready" : " · graph pending upstream"}`, topics: entry.topics, expandable: entry.expandable });
    return [...operators.values()];
  }, [nfcoreCatalog, session, snakemakeCatalog]);
  const operatorMap = useMemo(() => new Map(availableOperators.map((operator) => [operator.id, operator])), [availableOperators]);
  const snapshot = useCallback(() => axialGraph(nodes, edges), [edges, nodes]);

  const remember = useCallback((graph = snapshot()) => {
    setHistory((current) => ({ past: [...current.past.slice(-(HISTORY_LIMIT - 1)), graph], future: [] }));
  }, [snapshot]);

  const restoreGraph = useCallback((graph: AxialGraph) => {
    const hidden = new Map(nodes.map((node) => [node.id, node.data.viewerHidden]));
    const states = new Map(nodes.map((node) => [node.id, node.data.runState]));
    setNodes(graph.nodes.map((node) => flowNode(node, operatorMap, hidden.get(node.id) ?? false, states.get(node.id) ?? "idle")));
    setEdges(graph.edges.map((edge) => flowEdge(edge, graph.nodes)));
    setSelectedIds([]);
    setDirty(true);
  }, [nodes, operatorMap, setEdges, setNodes]);

  const undo = useCallback(() => {
    const previous = history.past.at(-1);
    if (!previous) {
      setStatus("Nothing to undo");
      return;
    }
    const current = snapshot();
    setHistory({ past: history.past.slice(0, -1), future: [current, ...history.future].slice(0, HISTORY_LIMIT) });
    restoreGraph(previous);
    setStatus("Undid edit");
  }, [history, restoreGraph, snapshot]);

  const redo = useCallback(() => {
    const next = history.future[0];
    if (!next) {
      setStatus("Nothing to redo");
      return;
    }
    const current = snapshot();
    setHistory({ past: [...history.past, current].slice(-HISTORY_LIMIT), future: history.future.slice(1) });
    restoreGraph(next);
    setStatus("Redid edit");
  }, [history, restoreGraph, snapshot]);

  useEffect(() => {
    const stored = window.localStorage.getItem("axial.theme.v1");
    if (stored !== "light" && stored !== "dark") return;
    const timeout = window.setTimeout(() => setTheme(stored), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("axial.theme.v1", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f7f5" : "#050505");
  }, [theme]);

  useEffect(() => {
    jsonRequest<ProjectSession>("/api/session")
      .then((loaded) => {
        const operators = new Map(loaded.operators.map((operator) => [operator.id, operator]));
        setSession(loaded);
        setNodes(loaded.graph.nodes.map((node) => flowNode(node, operators)));
        setEdges((loaded.graph.edges ?? []).map((edge) => flowEdge(edge, loaded.graph.nodes)));
        setStatus(loaded.recovered_autosave ? "Recovered the last autosave" : "Tab add · drag ports to wire · space-drag pan · F fit");
      })
      .catch((error) => setStatus(`Project engine is not running — ${errorMessage(error)}`));
    jsonRequest<SystemProfile>("/api/system").then(setSystem).catch(() => undefined);
    jsonRequest<NfcoreCatalog>("/api/catalog/nfcore")
      .then((catalog) => { setNfcoreCatalog(catalog); setNfcoreStatus("ready"); })
      .catch(() => setNfcoreStatus("offline"));
    jsonRequest<SnakemakeCatalog>("/api/catalog/snakemake")
      .then((catalog) => { setSnakemakeCatalog(catalog); setSnakemakeStatus("ready"); })
      .catch(() => setSnakemakeStatus("offline"));
  // The React Flow state helpers are not part of this effect's lifecycle.
  // Loading must happen exactly once or a setter identity change can turn the
  // project bootstrap into a fetch -> set state -> fetch render loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem("axial.library.v1");
        if (raw) {
          const stored = JSON.parse(raw) as { mode?: LibraryMode; favorites?: string[]; recent?: string[] };
          if (stored.mode && ["build", "sources", "pipelines"].includes(stored.mode)) setLibraryMode(stored.mode);
          if (Array.isArray(stored.favorites)) setFavorites(new Set(stored.favorites.filter((id): id is string => typeof id === "string")));
          if (Array.isArray(stored.recent)) setRecent(stored.recent.filter((id): id is string => typeof id === "string").slice(0, 6));
        }
      } catch {
        window.localStorage.removeItem("axial.library.v1");
      }
      setLibraryStateLoaded(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!libraryStateLoaded) return;
    window.localStorage.setItem("axial.library.v1", JSON.stringify({ mode: libraryMode, favorites: [...favorites], recent }));
  }, [favorites, libraryMode, libraryStateLoaded, recent]);

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
    if (!dirty || !session) return;
    const graph = snapshot();
    const timeout = window.setTimeout(() => {
      void jsonRequest<{ valid: boolean }>("/api/graph/autosave", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(graph) })
        .catch((error) => setStatus(`Autosave failed — ${errorMessage(error)}`));
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [dirty, nodes, edges, session, snapshot]);

  const canvasCenter = useCallback(() => {
    if (!flow) return { x: 160, y: 160 };
    return flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, { snapToGrid: true });
  }, [flow]);

  const openContinuation = useCallback<ContinueFromPort>((nodeId, port) => {
    if (port.dir === "in" && edges.some((edge) => edge.data?.axial.to_node === nodeId && edge.data.axial.to_port === port.name)) {
      setStatus(`${nodeId}.${port.name} is already connected`);
      return;
    }
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const position = nextContinuationPosition(node.position, port.dir, nodes.map((candidate) => candidate.position));
    setPendingConnection({ nodeId, port, position });
    setPendingAddPosition(position);
    setQuery("");
    setLibraryMode("build");
    setPaperVisible(false);
    setLibraryVisible(true);
    setStatus(`Choose a tool for ${nodeId}.${port.name} · ${port.ty}`);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [edges, nodes]);

  const addOperator = useCallback((operator: Operator, position?: { x: number; y: number }, params?: Record<string, ParamValue>) => {
    if (operator.palette.includes("Catalog")) {
      const revision = operator.params.revision?.default;
      const isNfcore = operator.id.startsWith("nf.");
      if (!isNfcore && !operator.expandable) {
        setStatus(`${operator.title} has no resolved rule graph in the official catalog yet · Axial did not add an opaque node`);
        return;
      }
      if (typeof revision !== "string") {
        setStatus(`Could not import ${operator.title} — missing pinned revision`);
        return;
      }
      const target = position ?? pendingAddPosition ?? canvasCenter();
      setStatus(`Resolving ${operator.title} into its process graph…`);
      const workflow = isNfcore
        ? `nf-core/${operator.id.slice(3)}`
        : operator.params.repository?.default;
      if (typeof workflow !== "string") {
        setStatus(`Could not import ${operator.title} — missing workflow provenance`);
        return;
      }
      void jsonRequest<WorkflowGraphResponse>(isNfcore ? "/api/catalog/nfcore/expand" : "/api/catalog/snakemake/expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, revision }),
      }).then((imported) => {
        remember();
        const occupied = new Set(nodes.map((node) => node.id));
        const idMap = new Map<string, string>();
        for (const source of imported.graph.nodes) {
          let id = source.id;
          let suffix = 2;
          while (occupied.has(id)) id = `${source.id}-${suffix++}`;
          occupied.add(id);
          idMap.set(source.id, id);
        }
        const minX = Math.min(...imported.graph.nodes.map((node) => node.layout.x));
        const minY = Math.min(...imported.graph.nodes.map((node) => node.layout.y));
        const created = imported.graph.nodes.map((source) => ({
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
        const graphNodes = [...nodes.map((node) => node.data.graphNode), ...created];
        const createdFlowNodes = created.map((node) => flowNode(node, operatorMap, true));
        setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...createdFlowNodes]);
        setEdges((current) => [...current, ...createdEdges.map((edge) => flowEdge(edge, graphNodes))]);
        setSelectedIds([]);
        setRecent((current) => [operator.id, ...current.filter((value) => value !== operator.id)].slice(0, 6));
        setLibraryVisible(false);
        setPendingAddPosition(null);
        setDirty(true);
        setStatus(`Expanded ${operator.title} ${revision} · ${created.length} processes · ${createdEdges.length} dependencies${imported.cached ? " · cached" : ""}`);
        window.setTimeout(() => void flow?.fitView({ nodes: createdFlowNodes, padding: 0.16, duration: 520, maxZoom: 0.9 }), 0);
      }).catch((error) => setStatus(`Could not expand ${operator.title} — ${errorMessage(error)}`));
      return;
    }
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
  }, [canvasCenter, edges, flow, nodes, operatorMap, pendingAddPosition, pendingConnection, remember, setEdges, setNodes]);

  const addSource = useCallback((request: SourceRequest) => {
    const center = canvasCenter();
    const requireOperator = (id: string) => {
      const operator = operatorMap.get(id);
      if (!operator) throw new Error(`${id} operator is missing`);
      return operator;
    };
    try {
      remember();
      const created: AxialGraphNode[] = [];
      const createdEdges: AxialEdge[] = [];
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
        created.push(makeGraphNode(operator, id, center, { accession: request.value, sequence_type: request.sequenceType ?? "genomic" }));
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
    const body = new FormData();
    body.append("file", file);
    return jsonRequest<UploadResult>("/api/files", { method: "POST", body });
  }, []);

  const installPaperCandidate = useCallback((candidate: PaperCandidate, index: number) => {
    remember();
    const nextNodes = candidate.graph.nodes.map((node) => flowNode(node, operatorMap));
    setNodes(nextNodes.map((node, nodeIndex) => ({ ...node, selected: nodeIndex === 0 })));
    setEdges(candidate.graph.edges.map((edge) => flowEdge(edge, candidate.graph.nodes)));
    setSelectedIds(nextNodes[0] ? [nextNodes[0].id] : []);
    setActivePaperCandidate(index);
    setDirty(true);
    setStatus(`Rebuilt ${candidate.name} · ${candidate.graph.nodes.length} nodes · review evidence before running`);
    window.setTimeout(() => void flow?.fitView({ padding: .24, duration: 280, maxZoom: 1 }), 0);
  }, [flow, operatorMap, remember, setEdges, setNodes]);

  const rebuildPaper = useCallback(async (file: File) => {
    setPaperVisible(true);
    setLibraryVisible(false);
    setPaperLoading(true);
    setStatus(`Reading ${file.name}…`);
    try {
      const uploaded = await upload(file);
      const review = await jsonRequest<PaperReview>("/api/paper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: uploaded.path }) });
      setPaperReview(review);
      if (review.candidates[0]) installPaperCandidate(review.candidates[0], 0);
      else setStatus(`No workflow candidates were found in ${file.name}`);
    } catch (error) {
      setStatus(`Could not rebuild paper — ${errorMessage(error)}`);
    } finally {
      setPaperLoading(false);
    }
  }, [installPaperCandidate, upload]);

  const openExamplePaper = useCallback(async () => {
    setPaperVisible(true);
    setLibraryVisible(false);
    setPaperLoading(true);
    setStatus("Reading the RNA-seq methods example…");
    try {
      const review = await jsonRequest<PaperReview>("/api/paper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "testdata/papers/rnaseq_methods.txt" }) });
      setPaperReview(review);
      if (review.candidates[0]) installPaperCandidate(review.candidates[0], 0);
    } catch (error) {
      setStatus(`Could not rebuild example — ${errorMessage(error)}`);
    } finally {
      setPaperLoading(false);
    }
  }, [installPaperCandidate]);

  const addDroppedFiles = useCallback(async (files: File[], position: { x: number; y: number }) => {
    if (!files.length) return;
    setStatus(`Importing ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
    try {
      const uploaded = await Promise.all(files.slice(0, 2).map(upload));
      const paired = uploaded.length === 2 && files.some((file) => READ_ONE_PATTERN.test(file.name)) && files.some((file) => READ_TWO_PATTERN.test(file.name));
      if (paired) {
        const operator = operatorMap.get("files.import_paired");
        if (!operator) throw new Error("Paired Reads operator is unavailable");
        const ordered = [...uploaded].sort((a, b) => a.filename.localeCompare(b.filename));
        addOperator(operator, position, { r1: ordered[0].path, r2: ordered[1].path });
      } else {
        const operator = operatorMap.get("files.import");
        if (!operator) throw new Error("Import File operator is unavailable");
        addOperator(operator, position, { path: uploaded[0].path });
      }
    } catch (error) {
      setStatus(`Could not import file — ${errorMessage(error)}`);
    }
  }, [addOperator, operatorMap, upload]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (!flow) return;
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: true });
    const operatorId = event.dataTransfer.getData("application/axial-operator");
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
    const axial: AxialEdge = { id: `e-${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`, from_node: connection.source, from_port: connection.sourceHandle, to_node: connection.target, to_port: connection.targetHandle };
    const graphNodes = nodes.map((node) => node.data.graphNode);
    const companion = pairedCompanion(axial, graphNodes);
    const additions = [axial, ...(companion ? [companion] : [])].filter((edge) => !edges.some((current) => current.id === edge.id)).map((edge) => flowEdge(edge, graphNodes));
    const connected = additions.reduce((current, edge) => addEdge(edge, current), edges);
    try {
      await jsonRequest<{ valid: boolean }>("/api/graph/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(axialGraph(nodes, connected)) });
      remember();
      setEdges(connected);
      setDirty(true);
      setStatus(companion ? "Connected paired R1 + R2 reads" : `Connected ${connection.sourceHandle} to ${connection.targetHandle}`);
    } catch (error) {
      setStatus(`These ports cannot connect — ${errorMessage(error)}`);
    }
  }, [edges, nodes, remember, setEdges]);

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
    setLibraryMode("build");
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
    setSaving(true);
    setStatus("Validating and saving…");
    try {
      await jsonRequest<{ valid: boolean }>("/api/graph", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot()) });
      setDirty(false);
      setStatus("Changes saved");
    } catch (error) {
      setStatus(`Could not save changes — ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }, [snapshot]);

  const toggleToolchain = useCallback(async () => {
    if (toolchainVisible) {
      setToolchainVisible(false);
      return;
    }
    setToolchainVisible(true);
    setMachineVisible(false);
    setLibraryVisible(false);
    setPaperVisible(false);
    setPendingConnection(null);
    setExportLoading(true);
    setStatus("Resolving workflow tools…");
    try {
      const plan = await jsonRequest<ExportPlan>("/api/export/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot()) });
      setExportPlan(plan);
      setStatus(`${plan.ready_count} ready · ${plan.installable_count} installable · ${plan.adapter_count} need adapters`);
    } catch (error) {
      setStatus(`Could not resolve export — ${errorMessage(error)}`);
    } finally {
      setExportLoading(false);
    }
  }, [snapshot, toolchainVisible]);

  const downloadBundle = useCallback(async () => {
    setExportDownloading(true);
    setStatus("Building portable run bundle…");
    try {
      const response = await fetch(`${AXIAL_SERVER}/api/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot()) });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `${response.status} ${response.statusText}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exportPlan?.filename ?? `${session?.project_name ?? "axial-workflow"}.axial.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${anchor.download} · ${exportPlan?.tools.length ?? 0} tool contracts`);
    } catch (error) {
      setStatus(`Could not export workflow — ${errorMessage(error)}`);
    } finally {
      setExportDownloading(false);
    }
  }, [exportPlan, session, snapshot]);

  const runGraph = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setStatus("Running workflow…");
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, runState: "running" } })));
    setEdges((current) => current.map((edge) => ({ ...edge, animated: true })));
    try {
      const report = await jsonRequest<RunResponse>("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot()) });
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, runState: report.states[node.id] ?? "idle" } })));
      const counts = Object.values(report.states).reduce<Record<string, number>>((result, state) => ({ ...result, [state]: (result[state] ?? 0) + 1 }), {});
      const errors = Object.entries(report.errors);
      if (errors.length) setStatus(`Run finished with ${errors.length} error${errors.length === 1 ? "" : "s"} · ${errors[0][0]}: ${errors[0][1]}`);
      else setStatus(`Run complete · ${counts.done ?? 0} done · ${counts.cached ?? 0} cached · ${counts.skipped ?? 0} skipped`);
    } catch (error) {
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, runState: "failed" } })));
      setStatus(`Run failed — ${errorMessage(error)}`);
    } finally {
      setEdges((current) => current.map((edge) => ({ ...edge, animated: false })));
      setRunning(false);
    }
  }, [running, setEdges, setNodes, snapshot]);

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
      const axial = edge.data?.axial;
      if (!axial) return edge;
      const renamed = { ...axial, from_node: axial.from_node === old ? next : axial.from_node, to_node: axial.to_node === old ? next : axial.to_node };
      return { ...edge, id: renamed.id.replaceAll(old, next), source: edge.source === old ? next : edge.source, target: edge.target === old ? next : edge.target, data: { axial: { ...renamed, id: renamed.id.replaceAll(old, next) }, portType: edge.data?.portType ?? "Text" } };
    }));
    setSelectedIds((current) => current.map((id) => id === old ? next : id));
    setDirty(true);
    setStatus(`Renamed ${old} to ${next}`);
  }, [nodes, remember, selectedIds, setEdges, setNodes]);

  const duplicateSelected = useCallback(() => {
    if (!selectedIds.length) return;
    remember();
    const selected = new Set(selectedIds);
    const idMap = new Map<string, string>();
    const working = [...nodes];
    const copies: AxialFlowNode[] = [];
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
      const axial = edge.data?.axial;
      if (!axial) return null;
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      if (!source || !target) return null;
      return flowEdge({ ...axial, id: `e-${source}-${axial.from_port}-${target}-${axial.to_port}`, from_node: source, to_node: target }, graphNodes);
    }).filter((edge): edge is AxialFlowEdge => edge !== null);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
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
        setPaperVisible(false);
        setLibraryVisible(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (event.key === "Escape") {
        setLibraryVisible(false);
        setMachineVisible(false);
        setPaperVisible(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duplicateSelected, flow, redo, runGraph, save, undo]);

  const selectedNode = nodes.find((node) => node.id === selectedIds.at(-1)) ?? null;
  const selectedOperator = selectedNode ? operatorMap.get(selectedNode.data.graphNode.operator) : undefined;
  const selectedHiddenCount = nodes.filter((node) => selectedIds.includes(node.id) && node.data.viewerHidden).length;
  const allViewersHidden = nodes.length > 0 && nodes.every((node) => node.data.viewerHidden);
  const statusError = /not running|could not|cannot|failed|invalid/i.test(status);

  if (!session) {
    return <main className="boot-screen"><div className="brand-mark"><span /><span /><span /><span /></div><span className="spin"><LoaderCircle size={22} aria-hidden="true" /></span><p>{status}</p><small>Run scripts/axial-web from the project to open this graph.</small></main>;
  }

  return (
    <>
      <a className="skip-link" href="#workflow-canvas">Skip to Workflow Canvas</a>
      <main className="app-shell studio-shell">
        <header className="topbar studio-topbar">
          <div className="wordmark"><div className="axial-dots" aria-hidden="true"><i /><i /><i /><i /></div><strong>Axial</strong><span className="project-name">{session.project_name}</span><span className="crumb-slash">/</span><code>{session.graph_path}</code>{dirty && <span className="unsaved-dot" title="Unsaved changes" />}</div>
          <div className="top-actions studio-actions">
            <button type="button" className="studio-button" onClick={undo} disabled={!history.past.length} title="Undo (Ctrl/Cmd Z)"><Undo2 size={14} aria-hidden="true" /><span>Undo</span></button>
            <button type="button" className="studio-button" onClick={redo} disabled={!history.future.length} title="Redo (Shift Ctrl/Cmd Z)"><Redo2 size={14} aria-hidden="true" /><span>Redo</span></button>
            <button type="button" className="studio-button" onClick={toggleAllViewers} disabled={!nodes.length}>{allViewersHidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}<span>{allViewersHidden ? "Show Viewers" : "Hide Viewers"}</span></button>
            <button type="button" className="studio-button theme-toggle" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}</button>
            <button type="button" className="studio-button" onClick={() => void flow?.fitView({ padding: .22, duration: 260, maxZoom: 1 })}>Fit</button>
            <button type="button" className="studio-button" onClick={() => void save()} disabled={saving || !dirty}>{saving ? <span className="spin"><LoaderCircle size={14} /></span> : dirty ? <Save size={14} /> : <Check size={14} />}<span>{saving ? "Saving…" : dirty ? "Save" : "Saved"}</span></button>
            <button type="button" className={`studio-button ${toolchainVisible ? "active" : ""}`} onClick={() => void toggleToolchain()} title="Environment and Export"><PackageOpen size={14} aria-hidden="true" /><span>Export</span></button>
            <button type="button" className="run-button" disabled={running} onClick={() => void runGraph()} title="Run workflow (F5 or Ctrl/Cmd Enter)">{running ? <><span className="spin"><LoaderCircle size={14} /></span>Running…</> : <><Play size={14} />Run</>}</button>
          </div>
        </header>

        <section id="workflow-canvas" aria-label="Workflow Canvas" className="canvas-wrap studio-canvas" onDrop={onDrop} onDragOver={(event) => event.preventDefault()} onDoubleClick={(event) => {
          if (!flow || !(event.target instanceof Element) || !event.target.closest(".react-flow__pane")) return;
          setPendingConnection(null);
          setPendingAddPosition(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: true }));
          setPaperVisible(false);
          setToolchainVisible(false);
          setLibraryMode("build");
          setLibraryVisible(true);
          window.setTimeout(() => searchInputRef.current?.focus(), 0);
        }} onPointerDown={() => {
          if (libraryVisible) { setLibraryVisible(false); setPendingConnection(null); }
          if (machineVisible) setMachineVisible(false);
          if (paperVisible) setPaperVisible(false);
          if (toolchainVisible) setToolchainVisible(false);
        }}>
          {snapGuides.x !== undefined && <div className="snap-guide vertical" style={{ left: snapGuides.x }} />}
          {snapGuides.y !== undefined && <div className="snap-guide horizontal" style={{ top: snapGuides.y }} />}
          <ContinuationContext.Provider value={openContinuation}>
          <ReactFlow<AxialFlowNode, AxialFlowEdge>
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
            onSelectionChange={({ nodes: selected }) => {
              const next = selected.map((node) => node.id);
              setSelectedIds((current) => current.length === next.length && current.every((id, index) => id === next[index]) ? current : next);
              paramHistoryKeyRef.current = null;
            }}
            onMove={(_, viewport) => setZoom((current) => Math.abs(current - viewport.zoom) < .001 ? current : viewport.zoom)}
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
            panOnDrag={[1, 2]}
            panActivationKeyCode="Space"
            connectionRadius={28}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Lines} gap={20} size={1} color="var(--grid)" />
          </ReactFlow>
          </ContinuationContext.Provider>
          <div className="drop-hint"><CloudUpload size={14} aria-hidden="true" />Drop FASTQ pairs, local files, or workflow directories</div>
        </section>

        <aside className="tool-rail" aria-label="Workspace Tools">
          <button type="button" className={libraryVisible ? "primary active" : "primary"} aria-label="Open Library" onClick={(event) => { event.stopPropagation(); setPaperVisible(false); setToolchainVisible(false); setPendingConnection(null); setLibraryVisible((visible) => !visible); }}><Plus size={20} aria-hidden="true" /></button>
          <button type="button" className={libraryVisible && libraryMode === "build" ? "active" : ""} aria-label="Search Tools" title="Build" onClick={(event) => { event.stopPropagation(); setPaperVisible(false); setToolchainVisible(false); setPendingConnection(null); setLibraryMode("build"); setLibraryVisible(true); window.setTimeout(() => searchInputRef.current?.focus(), 0); }}><Waypoints size={15} aria-hidden="true" /></button>
          <button type="button" className={libraryVisible && libraryMode === "sources" ? "active" : ""} aria-label="Add Data Source" title="Sources" onClick={(event) => { event.stopPropagation(); setPaperVisible(false); setToolchainVisible(false); setPendingConnection(null); setLibraryMode("sources"); setLibraryVisible(true); }}><span>ID</span></button>
          <button type="button" className={libraryVisible && libraryMode === "pipelines" ? "active" : ""} aria-label="Find a Workflow" title="Pipelines" onClick={(event) => { event.stopPropagation(); setPaperVisible(false); setToolchainVisible(false); setPendingConnection(null); setLibraryMode("pipelines"); setLibraryVisible(true); }}><span>nf</span></button>
          <button type="button" className={paperVisible ? "active" : ""} aria-label="Rebuild from a Paper" title="Paper Drop" onClick={(event) => { event.stopPropagation(); setPendingConnection(null); setLibraryVisible(false); setToolchainVisible(false); setPaperVisible((visible) => !visible); }}><FileSearch size={15} aria-hidden="true" /></button>
        </aside>

        {libraryVisible && <div className="panel-layer" onPointerDown={(event) => event.stopPropagation()}><LibraryPanel operators={availableOperators} mode={libraryMode} query={query} filterQuery={deferredQuery} favorites={favorites} recent={recent} categoryOpen={categoryOpen} searchInputRef={searchInputRef} toolReadiness={system?.tools} localCount={session.operators.length} catalogCount={nfcoreCatalog?.entries.length ?? 0} catalogStatus={nfcoreStatus} snakemakeCount={snakemakeCatalog?.entries.length ?? 0} snakemakeGraphCount={snakemakeCatalog?.entries.filter((entry) => entry.expandable).length ?? 0} snakemakeStatus={snakemakeStatus} continuation={pendingConnection} onMode={(mode) => { setPendingConnection(null); setLibraryMode(mode); setQuery(""); }} onQuery={setQuery} onClose={() => { setLibraryVisible(false); setPendingConnection(null); }} onAddOperator={addOperator} onAddSource={addSource} onToggleFavorite={(id) => setFavorites((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onToggleCategory={(title, open) => setCategoryOpen((current) => ({ ...current, [title]: open }))} /></div>}

        {selectedNode && selectedOperator && <div className="inspector-layer" onPointerDown={(event) => event.stopPropagation()}><InspectorPanel key={selectedNode.id} node={selectedNode.data.graphNode} selectedCount={selectedIds.length} operator={selectedOperator} hiddenViewerCount={selectedHiddenCount} updateParam={updateParam} beginParamEdit={beginParamEdit} browseParam={browseParam} rename={renameSelected} toggleViewers={toggleSelectedViewers} close={() => { setSelectedIds([]); flow?.setNodes((current) => current.map((node) => ({ ...node, selected: false }))); }} /></div>}

        {machineVisible && <div className="machine-layer" onPointerDown={(event) => event.stopPropagation()}><MachinePanel profile={system} onClose={() => setMachineVisible(false)} /></div>}

        {toolchainVisible && <div className="toolchain-layer" onPointerDown={(event) => event.stopPropagation()}><ToolchainPanel plan={exportPlan} pixiReady={system?.tools.pixi} loading={exportLoading} downloading={exportDownloading} onDownload={downloadBundle} onClose={() => setToolchainVisible(false)} /></div>}

        {paperVisible && <div className="paper-layer" onPointerDown={(event) => event.stopPropagation()}><PaperPanel review={paperReview} active={activePaperCandidate} loading={paperLoading} onFile={rebuildPaper} onExample={openExamplePaper} onActivate={(index) => { const candidate = paperReview?.candidates[index]; if (candidate) installPaperCandidate(candidate, index); }} onEvidence={focusPaperEvidence} onClose={() => setPaperVisible(false)} /></div>}

        <footer className="statusbar studio-statusbar" aria-live="polite">
          <span className={`engine-light ${statusError ? "error" : ""}`} />
          <span className="status-copy">{status}</span>
          <span className="status-spacer" />
          <span>{countFormatter.format(nodes.length)} nodes</span><span>{countFormatter.format(edges.length)} wires</span>
          <button type="button" className={machineVisible ? "active" : ""} onClick={(event) => { event.stopPropagation(); setToolchainVisible(false); setMachineVisible((visible) => !visible); }}><Cpu size={12} aria-hidden="true" />Machine</button>
          <div className="zoom-cluster">
            <button type="button" aria-label="Zoom Out" onClick={() => void flow?.zoomOut({ duration: 120 })}><Minus size={13} /></button>
            <button type="button" aria-label="Reset Zoom to 100%" onClick={() => void flow?.zoomTo(1, { duration: 160 })}>{Math.round(zoom * 100)}%</button>
            <button type="button" aria-label="Zoom In" onClick={() => void flow?.zoomIn({ duration: 120 })}><Plus size={13} /></button>
          </div>
        </footer>
      </main>
    </>
  );
}

export function AxialApp({ initialQuery = "" }: { initialQuery?: string }) {
  return <ReactFlowProvider><AxialWorkspace initialQuery={initialQuery} /></ReactFlowProvider>;
}
