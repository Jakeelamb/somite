"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  CircleAlert,
  CircleStop,
  CloudUpload,
  Cpu,
  Database,
  Download,
  ExternalLink,
  FileSearch,
  FileInput,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  PlugZap,
  Play,
  Search,
  Send,
  Settings2,
  Star,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { clampAgentFrame, type AgentFrame } from "./agentFrame";
import { classifySource, type SourceRequest, type SourceSearchResponse, type SourceSearchResult } from "./sourceBuilder";
import { operatorContinues, type PendingConnection } from "./graphInteractions";
import type {
  AgentConfigOption,
  AgentConfigSelectChoice,
  AgentDiscovery,
  AgentEvent,
  AgentSnapshot,
  ReadinessItem,
  ReadinessSnapshot,
  SomiteGraphNode,
  Operator,
  ParamSpec,
  ParamValue,
  PaperReview,
  PaperResourceResolution,
  PaperSearchResponse,
  PaperSearchResult,
  ExportPlan,
  SystemProfile,
  ValidationEvidenceResponse,
  WorkflowBinding,
  WorkflowParameterField,
} from "./types";
import { OperatorGlyph, portColor } from "./visual";
import { jsonRequest } from "./api";
import { formatResourceBytes } from "./readinessState";
import { nextPaperReadSlot, paperAttentionItems, paperParameterValue, paperResourceApplied, paperSupportedCount } from "./paperResolution";
import { formatPaperElapsed, paperCandidateCanApply, paperIntakeIsBusy, paperIntakePresentation, paperUnsupportedMentions, type PaperIntakeState } from "./paperIntake";
import { paperReadingPresentation } from "./paperReading";
import { catalogExpansionPresentation, type CatalogExpansionActivity } from "./catalogExpansion";
import type { WorkflowCatalogLoadState } from "./backgroundRequests";
import {
  groupedWorkflowParameters,
  hiddenRequiredWorkflowParameters,
  opaqueNfcoreFallback,
  sourceCapabilityRows,
  sourceBindingResetLabel,
  sourceBindingStatus,
  sourceBooleanNeedsExplicitChoice,
  sourceSpanLabel,
  sourceWorkflowProvider,
  sourceWorkflowRevision,
  sourceWorkflowRoot,
  sourceWorkflowSetupLabel,
  sourceWorkflowTitle,
  parseSourceNumericDraft,
  workflowBinding,
  workflowChoiceBinding,
  workflowChoiceLabel,
  workflowChoiceSelection,
  workflowBindingValue,
} from "./sourceWorkflowPresentation";

function groupedAgentEvents(events: AgentEvent[]) {
  return events.reduce<AgentEvent[]>((grouped, event) => {
    const previous = grouped.at(-1);
    if (event.kind === "message" && previous?.kind === "message" && previous.title === event.title) {
      grouped[grouped.length - 1] = { ...event, detail: `${previous.detail ?? ""}${event.detail ?? ""}` };
    } else if (event.kind === "tool" && previous?.kind === "tool" && previous.title === event.title) {
      grouped[grouped.length - 1] = event;
    } else {
      grouped.push(event);
    }
    return grouped;
  }, []);
}

function configChoices(option: AgentConfigOption): AgentConfigSelectChoice[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
}

function storedAgentFrame(): AgentFrame & { collapsed: boolean } {
  const fallback = { left: null, top: 16, width: 360, height: 500, collapsed: false };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem("somite.agent.frame.v1");
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<AgentFrame> & { collapsed?: boolean };
    return {
      left: typeof value.left === "number" ? value.left : fallback.left,
      top: typeof value.top === "number" ? value.top : fallback.top,
      width: typeof value.width === "number" ? Math.min(720, Math.max(300, value.width)) : fallback.width,
      height: typeof value.height === "number" ? Math.min(760, Math.max(320, value.height)) : fallback.height,
      collapsed: Boolean(value.collapsed),
    };
  } catch {
    return fallback;
  }
}

export function AgentPanel({ snapshot, discovery, discoveryLoading, draft, onRefreshDiscovery, onConnect, onConfig, onPrompt, onCancel, onDisconnect, onPermission, onClose }: {
  snapshot: AgentSnapshot;
  discovery: AgentDiscovery | null;
  discoveryLoading: boolean;
  draft?: { id: number; message: string } | null;
  onRefreshDiscovery: () => Promise<void>;
  onConnect: (command: string) => Promise<void>;
  onConfig: (configId: string, value: string | boolean) => Promise<void>;
  onPrompt: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onPermission: (permissionId: string, optionId?: string) => Promise<void>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ offsetX: number; offsetY: number; parent: DOMRect; width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<AgentFrame>(() => storedAgentFrame());
  const [collapsed, setCollapsed] = useState(() => storedAgentFrame().collapsed);
  const [showSettings, setShowSettings] = useState(false);
  const [command, setCommand] = useState("");
  const [agentQuery, setAgentQuery] = useState("");
  const [showCatalog, setShowCatalog] = useState(false);
  const [message, setMessage] = useState(draft?.message ?? "");
  const [submitting, setSubmitting] = useState(false);
  const events = useMemo(() => groupedAgentEvents(snapshot.events), [snapshot.events]);
  const conversation = useMemo(() => events.filter((event) => ["user", "message", "transaction", "permission", "error"].includes(event.kind)), [events]);
  const activity = useMemo(() => events.filter((event) => event.kind === "tool"), [events]);
  const detectedAgents = useMemo(() => discovery?.agents.filter((agent) => agent.availability === "installed") ?? [], [discovery]);
  const catalogAgents = useMemo(() => {
    const query = agentQuery.trim().toLowerCase();
    return (discovery?.agents ?? []).filter((agent) => agent.availability !== "installed" && (!query || `${agent.name} ${agent.description}`.toLowerCase().includes(query)));
  }, [agentQuery, discovery]);

  useEffect(() => {
    window.localStorage.setItem("somite.agent.frame.v1", JSON.stringify({ ...frame, collapsed }));
  }, [collapsed, frame]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const parent = panel?.parentElement;
    if (!panel || !parent) return;
    const clampToParent = () => {
      const bounds = parent.getBoundingClientRect();
      setFrame((current) => {
        const next = clampAgentFrame(current, { width: bounds.width, height: bounds.height }, collapsed);
        return current.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height
          ? current
          : next;
      });
    };

    clampToParent();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(clampToParent);
    observer?.observe(parent);
    window.addEventListener("resize", clampToParent);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", clampToParent);
    };
  }, [collapsed]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || collapsed || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (panel.classList.contains("collapsed")) return;
      const bounds = panel.getBoundingClientRect();
      const width = Math.round(bounds.width);
      const height = Math.round(bounds.height);
      const parentBounds = panel.parentElement?.getBoundingClientRect();
      setFrame((current) => {
        const measured = { ...current, width, height };
        const next = parentBounds
          ? clampAgentFrame(measured, { width: parentBounds.width, height: parentBounds.height }, false)
          : measured;
        return current.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height
          ? current
          : next;
      });
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [collapsed]);

  const submitPrompt = async () => {
    const prompt = message.trim();
    if (!prompt || snapshot.busy) return;
    setSubmitting(true);
    try {
      await onPrompt(prompt);
      setMessage("");
    } catch {
      // The workspace status bar reports the request error.
    } finally {
      setSubmitting(false);
    }
  };
  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest("button, input, select, textarea, summary")) return;
    const panel = panelRef.current;
    const parent = panel?.parentElement;
    if (!panel || !parent) return;
    const rect = panel.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, parent: parentRect, width: rect.width, height: rect.height };
  };
  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const active = dragRef.current;
    if (!active) return;
    const left = Math.max(8, Math.min(active.parent.width - active.width - 8, event.clientX - active.parent.left - active.offsetX));
    const top = Math.max(8, Math.min(active.parent.height - active.height - 8, event.clientY - active.parent.top - active.offsetY));
    setFrame((current) => ({ ...current, left, top }));
  };
  const finishDrag = () => { dragRef.current = null; };
  const eventTitle = (event: AgentEvent) => ({ user: "You", message: "Agent", transaction: "Canvas updated", permission: "Approval needed", error: "Needs attention" } as Record<string, string>)[event.kind] ?? event.title;
  const frameStyle = { top: frame.top, width: frame.width, height: collapsed ? 44 : frame.height, ...(frame.left === null ? { right: 16 } : { left: frame.left }) } as CSSProperties;

  return (
    <section ref={panelRef} className={`floating-panel agent-window ${collapsed ? "collapsed" : ""}`} style={frameStyle} aria-label="Agent">
      <header className="floating-panel-head agent-drag-handle" onPointerDown={beginDrag} onPointerMove={drag} onPointerUp={finishDrag} onPointerCancel={finishDrag}>
        <div><i className={`agent-presence ${snapshot.busy ? "busy" : snapshot.connected ? "ready" : ""}`} /><strong>Agent</strong><span>{snapshot.busy ? "Working…" : snapshot.connected ? "Ready" : snapshot.connecting ? "Connecting…" : "Choose an assistant"}</span></div>
        <nav aria-label="Agent window controls">
          {snapshot.connected && <button type="button" aria-label="Agent settings" title="Settings" className={showSettings ? "active" : ""} onClick={() => { setCollapsed(false); setShowSettings((visible) => !visible); }}><Settings2 size={14} /></button>}
          <button type="button" aria-label={collapsed ? "Expand Agent" : "Collapse Agent"} title={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}</button>
          <button type="button" aria-label="Close Agent" title="Close" onClick={onClose}><X size={15} /></button>
        </nav>
      </header>
      {!collapsed && <div className="agent-body">
        {!snapshot.connected && !snapshot.connecting ? (
          <div className="agent-launcher">
            <div className="agent-launcher-intro">
              <div className="agent-empty-mark"><PlugZap size={17} aria-hidden="true" /></div>
              <div><strong>Choose your Agent</strong><p>Pick one that is already available on this computer.</p></div>
              <button type="button" aria-label="Scan for agents again" title="Scan again" disabled={discoveryLoading} onClick={() => void onRefreshDiscovery()}><LoaderCircle size={14} className={discoveryLoading ? "spin" : ""} /></button>
            </div>
            <section className="agent-launcher-section">
              <div className="agent-card-list">
                {detectedAgents.map((agent) => <button key={agent.id} type="button" className="agent-card" disabled={!agent.command} onClick={() => agent.command && void onConnect(agent.command)}>
                  <i>{agent.name.slice(0, 1).toUpperCase()}</i>
                  <span><strong>{agent.name}</strong><small>Ready on this computer</small></span>
                  <em>Use</em>
                </button>)}
                {!detectedAgents.length && !discoveryLoading && <p className="agent-launcher-empty">No local agents found. Try scanning again or open more options.</p>}
                {discoveryLoading && <div className="agent-launcher-loading"><LoaderCircle size={14} className="spin" />Looking for agents…</div>}
              </div>
            </section>
            <button type="button" className="agent-catalog-toggle" aria-expanded={showCatalog} onClick={() => setShowCatalog((visible) => !visible)}><span>More agents</span><small>Install or connect</small><ChevronDown size={13} /></button>
            {showCatalog && <section className="agent-catalog">
              <label><Search size={13} /><input value={agentQuery} onChange={(event) => setAgentQuery(event.target.value)} placeholder="Search agents…" /></label>
              <div className="agent-card-list compact">
                {catalogAgents.map((agent) => agent.command ? <button key={agent.id} type="button" className="agent-card" onClick={() => void onConnect(agent.command!)}>
                  <i>{agent.name.slice(0, 1).toUpperCase()}</i><span><strong>{agent.name}</strong><small>{agent.description}</small></span><em>Use</em>
                </button> : <a key={agent.id} className="agent-card unavailable" href={agent.website ?? agent.repository} target="_blank" rel="noreferrer">
                  <i>{agent.name.slice(0, 1).toUpperCase()}</i><span><strong>{agent.name}</strong><small>{agent.description}</small></span><em>Install</em>
                </a>)}
              </div>
              <details className="agent-custom"><summary>Connection details</summary><label htmlFor="agent-command">Custom command</label><input id="agent-command" autoComplete="off" spellCheck={false} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="your-agent --acp" onKeyDown={(event) => { if (event.key === "Enter" && command.trim()) void onConnect(command); }} /><button type="button" className="agent-connect-button" disabled={!command.trim()} onClick={() => void onConnect(command)}><PlugZap size={13} />Connect</button><small className="agent-registry-note">{discovery?.registry_status === "live" ? "Online directory" : "Offline directory"}</small></details>
            </section>}
          </div>
        ) : <>
          {showSettings && <section className="agent-settings" aria-label="Agent settings">
            <header><strong>Settings</strong><button type="button" aria-label="Close Agent settings" onClick={() => setShowSettings(false)}><X size={13} /></button></header>
            {snapshot.config_options.length > 0 && <div className="agent-config-options">{snapshot.config_options.map((option) => option.type === "select" ? <label key={option.id} title={option.description}><span>{option.name}</span><select aria-label={option.name} value={option.currentValue} disabled={snapshot.busy} onChange={(event) => void onConfig(option.id, event.target.value)}>{configChoices(option).map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}</select></label> : <label key={option.id} className="boolean" title={option.description}><span>{option.name}</span><input type="checkbox" checked={option.currentValue} disabled={snapshot.busy} onChange={(event) => void onConfig(option.id, event.target.checked)} /></label>)}</div>}
            <button type="button" className="agent-disconnect" onClick={() => void onDisconnect()}>Disconnect {snapshot.agent_name ?? "Agent"}</button>
          </section>}
          <div className="agent-feed" role="log" aria-live="polite">
            {draft && <div className="agent-context-chip"><MessageSquare size={12} /><span>Workflow requirement attached</span></div>}
            {!conversation.length && !snapshot.busy && <div className="agent-starters"><strong>What should we do?</strong>{["Build from my files", "Fix what is missing", "Explain this workflow", "Check if this can run"].map((starter) => <button key={starter} type="button" onClick={() => setMessage(starter)}>{starter}</button>)}</div>}
            {conversation.map((event) => <article key={event.cursor} className={`agent-event ${event.kind}`}>
              <header><i /><strong>{eventTitle(event)}</strong>{event.status && event.kind !== "transaction" && <span>{event.status.replaceAll("_", " ")}</span>}</header>
              {event.detail && <p>{event.detail}</p>}
              {event.kind === "transaction" && <small>Saved as one undoable canvas change.</small>}
              {event.kind === "permission" && event.permission_id && Boolean(event.permission_choices?.length) && <div className="agent-permissions">{(event.permission_choices ?? []).map((choice) => <button key={choice.option_id} type="button" className={choice.kind.startsWith("allow") ? "allow" : "reject"} onClick={() => void onPermission(event.permission_id!, choice.option_id)}>{choice.name}</button>)}<button type="button" className="reject" onClick={() => void onPermission(event.permission_id!)}>Cancel</button></div>}
            </article>)}
            {snapshot.busy && <div className="agent-progress"><LoaderCircle size={13} className="spin" /><span><strong>Working on the workflow</strong><small>{activity.at(-1)?.title ?? "Using the canvas and checking requirements"}</small></span></div>}
            {activity.length > 0 && <details className="agent-activity"><summary><MoreHorizontal size={13} />{snapshot.busy ? `${activity.length} step${activity.length === 1 ? "" : "s"} in progress` : `Completed ${activity.length} step${activity.length === 1 ? "" : "s"}`}</summary><ol>{activity.map((event) => <li key={event.cursor}>{event.title}</li>)}</ol></details>}
          </div>
          <div className="agent-composer">
            <textarea aria-label="Message Agent" rows={3} value={message} disabled={!snapshot.connected} placeholder="Ask Agent to build, explain, or fix this workflow…" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitPrompt(); } }} />
            <div><span>{snapshot.agent_name ?? "Agent"}</span>{snapshot.busy ? <button type="button" className="agent-stop" onClick={() => void onCancel()}><CircleStop size={13} />Stop</button> : <button type="button" aria-label="Send to Agent" disabled={!message.trim() || submitting} onClick={() => void submitPrompt()}><Send size={13} />Send</button>}</div>
          </div>
        </>}
      </div>}
    </section>
  );
}

export function ReadinessPanel({ snapshot, evidence, onResolve, onFocus, onAttachFile, onAskAssistant, onClose }: {
  snapshot: ReadinessSnapshot;
  evidence: ValidationEvidenceResponse | null;
  onResolve: (item: ReadinessItem) => void;
  onFocus: (item: ReadinessItem) => void;
  onAttachFile: (item: ReadinessItem, field: string, file: File) => Promise<void>;
  onAskAssistant: (item: ReadinessItem) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const currentStep = Math.min(step, Math.max(0, snapshot.items.length - 1));
  const current = snapshot.items[currentStep] ?? null;
  const recommended = snapshot.items.flatMap((item) => item.resolutions
    .filter((resolution) => resolution.recommended && resolution.kind !== "connect" && resolution.kind !== "configure")
    .map((resolution) => ({ item, resolution })));
  const receipt = evidence?.receipt;
  const evidenceLabel = receipt?.result === "passed" ? "Validated" : receipt?.result === "failed" ? "Failed" : receipt ? "Inconclusive" : "Not validated";
  const sourceBlocker = current?.operator_id === "workflow.source" && current.fields.length === 0;
  return (
    <section className="floating-panel readiness-window" aria-label="Workflow Readiness">
      <header className="floating-panel-head">
        <div><strong>Readiness</strong><span>deterministic checks</span></div>
        <button type="button" aria-label="Close Readiness" onClick={onClose}><X size={15} /></button>
      </header>
      <div className={`readiness-hero state-${snapshot.state}`}>
        {snapshot.state === "ready" ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
        <div><strong>{snapshot.state === "ready" ? "All requirements are connected" : snapshot.state === "empty" ? "Start with a tool or input" : `${snapshot.required_count} step${snapshot.required_count === 1 ? "" : "s"} to ready`}</strong><span>{snapshot.state === "ready" ? "This graph can enter preparation." : "Somite will guide you through one exact action at a time."}</span></div>
      </div>
      <div className="readiness-scroll">
        {current && <section className="readiness-section readiness-guide">
          <header><strong>Resolve next</strong><span>{currentStep + 1} of {snapshot.required_count}</span></header>
          <article className={`requirement-card kind-${current.kind}`}>
            <button type="button" className="requirement-main" onClick={() => onFocus(current)}>
              <i>{current.kind === "managed_resource" ? <Database size={13} /> : current.kind === "manual_checkpoint" ? <FileInput size={13} /> : <CircleAlert size={13} />}</i>
              <span><strong>{current.title}</strong><code>{current.node_id}.{current.field}</code><small>{current.detail}</small></span>
            </button>
            {current.fields.filter((field) => field.input_mode === "file").map((field) => <label className="requirement-file" key={field.name}>
              <FileInput size={12} /><span><strong>{field.label}</strong><small>Choose from this computer</small></span>
              <input type="file" aria-label={`Choose ${field.label}`} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void onAttachFile(current, field.name, file); }} />
            </label>)}
            {current.resolutions.some((resolution) => resolution.source_url) && <div className="resolution-links">
              {current.resolutions.filter((resolution) => resolution.source_url).map((resolution) => <a key={resolution.id} href={resolution.source_url!} target="_blank" rel="noreferrer"><ExternalLink size={11} />Official guide</a>)}
            </div>}
            {current.kind === "managed_resource" && <div className="resolution-list">
              {current.resolutions.map((resolution) => {
                const download = formatResourceBytes(resolution.download_bytes);
                const stored = formatResourceBytes(resolution.stored_bytes);
                return <div key={resolution.id} className={resolution.recommended ? "recommended" : ""}>
                  <header><strong>{resolution.label}</strong>{resolution.recommended && <em>Recommended</em>}</header>
                  <p>{resolution.detail}</p>
                  {(download || stored) && <small>{download && `${download} download`}{download && stored && " · "}{stored && `${stored} stored`}</small>}
                  {resolution.scientific_effect && <p className="scientific-effect">{resolution.scientific_effect}</p>}
                </div>;
              })}
            </div>}
            {current.recipes.map((recipe) => <details className="resolution-recipe" key={recipe.id}>
              <summary><span><strong>{recipe.title}</strong><small>Reusable recipe · v{recipe.version}</small></span><ChevronDown size={12} /></summary>
              <p>{recipe.summary}</p>
              <ol>{recipe.steps.map((entry) => <li key={entry}>{entry}</li>)}</ol>
              {recipe.source_url && <a href={recipe.source_url} target="_blank" rel="noreferrer"><ExternalLink size={11} />Open recipe source</a>}
            </details>)}
            <div className="requirement-actions">
              {sourceBlocker && <small>This is an explicit source limitation, not an action Somite can complete silently.</small>}
              {!sourceBlocker && !current.fields.some((field) => field.input_mode === "file") && <button type="button" onClick={() => onResolve(current)}>{current.resolutions[0]?.label ?? (current.kind === "parameter" ? "Configure" : current.kind === "managed_resource" ? "Connect existing" : "Connect input")}</button>}
              {current.escalatable && <button type="button" className="secondary" onClick={() => onAskAssistant(current)}><MessageSquare size={12} />Ask Agent</button>}
            </div>
          </article>
          {snapshot.required_count > 1 && <nav className="readiness-steps" aria-label="Readiness steps">
            <button type="button" disabled={currentStep === 0} onClick={() => setStep(Math.max(0, currentStep - 1))}><ChevronLeft size={12} />Previous</button>
            <span>{snapshot.items.map((item, index) => <button key={item.id} type="button" className={index === currentStep ? "active" : ""} aria-label={`Go to readiness step ${index + 1}`} onClick={() => setStep(index)} />)}</span>
            <button type="button" disabled={currentStep === snapshot.items.length - 1} onClick={() => setStep(Math.min(snapshot.items.length - 1, currentStep + 1))}>Next<ChevronRight size={12} /></button>
          </nav>}
        </section>}
        {recommended.length > 0 && <section className="readiness-section recommendations">
          <header><strong>Recommendations</strong><span>rule-based</span></header>
          {recommended.map(({ item, resolution }) => <div key={`${item.id}:${resolution.id}`}><CheckCircle2 size={13} /><span><strong>{resolution.label}</strong><small>{resolution.scientific_effect ?? resolution.detail}</small></span></div>)}
        </section>}
        <section className="readiness-section evidence-readiness">
          <header><strong>Evidence</strong><span>{evidenceLabel}</span></header>
          <div className={receipt?.result === "passed" ? "passed" : receipt?.result === "failed" ? "failed" : "pending"}>
            {receipt?.result === "passed" ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
            <span><strong>{evidenceLabel}</strong><small>{receipt ? `${receipt.scope} · ${receipt.fixture_digests.length} fixture${receipt.fixture_digests.length === 1 ? "" : "s"}` : "Validate with representative fixtures when readiness is clear."}</small></span>
          </div>
        </section>
      </div>
    </section>
  );
}

type LibrarySection = { title: string; operators: Operator[]; open: boolean };

function isSource(operator: Operator) {
  return ["files.", "sheet.", "archive.", "sra.", "ncbi.", "ensembl."].some((prefix) =>
    operator.id.startsWith(prefix),
  );
}

function sectionTitle(operator: Operator) {
  if (isSource(operator)) return "Data & Inputs";
  if (operator.id.startsWith("nf.")) return "Nextflow Workflows";
  if (operator.id.startsWith("smk.")) return "Snakemake Workflows";
  if (operator.id.startsWith("workflow.")) return "Workflow Templates";
  const prefix = operator.id.split(".")[0];
  return ({
    qc: "Quality Control",
    align: "Align & Assemble",
    asm: "Align & Assemble",
    quant: "Measure & Analyze",
    diff: "Measure & Analyze",
    var: "Measure & Analyze",
    class: "Measure & Analyze",
    gap: "Utilities",
  } as Record<string, string>)[prefix] ?? "More Tools";
}

function buildSections(
  operators: Operator[],
  query: string,
  favorites: Set<string>,
  recent: string[],
  continuation?: PendingConnection | null,
): LibrarySection[] {
  const normalized = query.trim().toLowerCase();
  const matches = operators.filter((operator) => !isSource(operator)).filter((operator) => operator.kind !== "source" && !opaqueNfcoreFallback(operator)).filter((operator) => {
    if (continuation && !operatorContinues(operator, continuation)) return false;
    if (normalized) {
      return `${operator.title} ${operator.id} ${operator.palette.join(" ")} ${operator.description ?? ""} ${(operator.topics ?? []).join(" ")}`
        .toLowerCase()
        .includes(normalized);
    }
    return true;
  });
  if (continuation) return [{ title: "Compatible Tools", operators: matches, open: true }];
  if (normalized) return [{ title: "Search Results", operators: matches, open: true }];

  const byId = new Map(operators.map((operator) => [operator.id, operator]));
  const leading: LibrarySection[] = [];
  const favoriteOperators = matches.filter((operator) => favorites.has(operator.id));
  if (favoriteOperators.length) {
    leading.push({ title: "Favorites", operators: favoriteOperators, open: true });
  }
  const recentOperators = recent
    .map((id) => byId.get(id))
    .filter((operator): operator is Operator => Boolean(operator) && matches.includes(operator as Operator));
  if (recentOperators.length) {
    leading.push({ title: "Recent", operators: recentOperators, open: true });
  }
  const grouped = new Map<string, Operator[]>();
  for (const operator of matches) {
    const title = sectionTitle(operator);
    grouped.set(title, [...(grouped.get(title) ?? []), operator]);
  }
  const order = ["Data & Inputs", "Nextflow Workflows", "Quality Control", "Align & Assemble", "Measure & Analyze", "Snakemake Workflows", "Workflow Templates", "Utilities", "More Tools"];
  return [
    ...leading,
    ...[...grouped.entries()].sort(([left], [right]) => order.indexOf(left) - order.indexOf(right)).map(([title, groupedOperators]) => ({
      title,
      operators: groupedOperators,
      open: title === "Data & Inputs" || title === "Quality Control",
    })),
  ];
}

export function LibraryPanel({
  operators,
  query,
  filterQuery,
  favorites,
  recent,
  categoryOpen,
  searchInputRef,
  continuation,
  catalogExpansion,
  workflowCatalogState,
  onQuery,
  onClose,
  onAddOperator,
  onAddSource,
  onImportFiles,
  onToggleFavorite,
  onToggleCategory,
  onRetryWorkflowCatalogs,
  onDismissCatalogExpansion,
}: {
  operators: Operator[];
  query: string;
  filterQuery: string;
  favorites: Set<string>;
  recent: string[];
  categoryOpen: Record<string, boolean>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  continuation?: PendingConnection | null;
  catalogExpansion: CatalogExpansionActivity | null;
  workflowCatalogState: WorkflowCatalogLoadState;
  onQuery: (query: string) => void;
  onClose: () => void;
  onAddOperator: (operator: Operator) => void;
  onAddSource: (request: SourceRequest) => void;
  onImportFiles: (files: File[]) => Promise<void>;
  onToggleFavorite: (id: string) => void;
  onToggleCategory: (title: string, open: boolean) => void;
  onRetryWorkflowCatalogs: () => void;
  onDismissCatalogExpansion: () => void;
}) {
  const request = classifySource(query);
  const libraryOperatorCount = operators.filter((operator) => operator.kind !== "source" && !opaqueNfcoreFallback(operator)).length;
  const nextflowCount = operators.filter((operator) => operator.id.startsWith("nf.") && !opaqueNfcoreFallback(operator)).length;
  const [sourceResults, setSourceResults] = useState<SourceSearchResult[]>([]);
  const [sourceSearching, setSourceSearching] = useState(false);
  const [sourceSearched, setSourceSearched] = useState(false);
  const [activeSourceResult, setActiveSourceResult] = useState(0);
  const sections = useMemo(
    () => buildSections(operators, filterQuery, favorites, recent, continuation),
    [continuation, favorites, filterQuery, operators, recent],
  );

  useEffect(() => {
    const sourceQuery = filterQuery.trim();
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (continuation || sourceQuery.length < 2) {
        setSourceResults([]);
        setSourceSearching(false);
        setSourceSearched(false);
        setActiveSourceResult(0);
        return;
      }
      setSourceResults([]);
      setSourceSearching(true);
      setSourceSearched(false);
      setActiveSourceResult(0);
      let pending = 2;
      for (const provider of ["ncbi", "ensembl"] as const) {
        jsonRequest<SourceSearchResponse>(`/api/sources/search?q=${encodeURIComponent(sourceQuery)}&provider=${provider}`, {
          signal: controller.signal,
        })
          .then((response) => {
            if (controller.signal.aborted) return;
            setSourceResults((current) => [
              ...current.filter((result) => !result.key.startsWith(`${provider}-`) && !(provider === "ncbi" && result.key.startsWith("ncbi-"))),
              ...response.results,
            ]);
          })
          .catch(() => undefined)
          .finally(() => {
            if (controller.signal.aborted) return;
            pending -= 1;
            if (pending === 0) {
              setSourceSearching(false);
              setSourceSearched(true);
            }
          });
      }
    }, 360);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [continuation, filterQuery]);

  const chooseSource = (source: SourceRequest) => {
    onAddSource(source);
    onQuery("");
    setSourceResults([]);
    setActiveSourceResult(0);
  };

  return (
    <section className="floating-panel library-window" aria-label="Operator Library">
      <header className="floating-panel-head">
        <div><strong>Add to canvas</strong><span>{libraryOperatorCount} available</span></div>
        <button type="button" aria-label="Close Library" onClick={onClose}><X size={15} aria-hidden="true" /></button>
      </header>
      <div className="library-toolbar">
        {continuation && <div className="continuation-banner"><span>Continue from</span><strong>{continuation.nodeId}.{continuation.port.name}</strong><em>{continuation.port.ty}</em></div>}
        <div className="studio-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            aria-label="Search everything"
            autoComplete="off"
            name="library-search"
            placeholder="Search tools, data, workflows…  Ctrl K"
            spellCheck={false}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          {query && <button type="button" aria-label="Clear Search" onClick={() => onQuery("")}><X size={13} aria-hidden="true" /></button>}
        </div>
      </div>

      {!continuation && !query.trim() && <section className="input-choices" aria-label="Add input data">
        <header><strong>Start with data</strong><span>Choose where it comes from</span></header>
        <div>
          <label><CloudUpload size={16} aria-hidden="true" /><span><strong>Local files</strong><small>Choose files from this computer</small></span><input type="file" multiple aria-label="Choose local input files" onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; if (files.length) void onImportFiles(files); }} /></label>
          <button type="button" onClick={() => searchInputRef.current?.focus()}><Database size={16} aria-hidden="true" /><span><strong>NCBI & Ensembl</strong><small>Search by organism, name, or accession</small></span></button>
        </div>
      </section>}

      {!continuation && !query.trim() && workflowCatalogState === "loading" && <div className="workflow-catalog-loading" role="status" aria-live="polite">
        <LoaderCircle className="spin" size={14} aria-hidden="true" />
        <span><strong>Loading workflow catalogs…</strong><small>nf-core + Snakemake</small></span>
      </div>}

      {!continuation && !query.trim() && workflowCatalogState === "failed" && <button type="button" className="nextflow-browse workflow-catalog-retry" onClick={onRetryWorkflowCatalogs}>
        <span><strong>Some workflow catalogs are unavailable</strong><small>Loaded results remain available</small></span><em>Retry</em><CircleAlert size={13} aria-hidden="true" />
      </button>}

      {!continuation && !query.trim() && nextflowCount > 0 && <button type="button" className="nextflow-browse" onClick={() => {
        onToggleCategory("Nextflow Workflows", true);
        window.setTimeout(() => document.getElementById("nextflow-workflows")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      }}><span><strong>Browse Nextflow workflows</strong><small>Explore the nf-core catalog</small></span><em>{nextflowCount}</em><ChevronDown size={13} aria-hidden="true" /></button>}

      {!continuation && query.trim() && (request || sourceSearching || sourceSearched || sourceResults.length > 0) && (
        <section className="source-builder unified-source-results" aria-label="Public data results">
          <header><span><strong>Public data</strong><small>NCBI + Ensembl</small></span>{sourceSearching && <LoaderCircle className="source-search-spinner" size={13} aria-label="Searching NCBI and Ensembl" />}</header>
          {sourceResults.length > 0 && (
            <div className="source-results" id="source-search-results" role="listbox" aria-label="Data source results">
              {sourceResults.map((result, index) => (
                <button
                  id={`source-result-${result.key}`}
                  key={result.key}
                  type="button"
                  role="option"
                  aria-selected={index === activeSourceResult}
                  className={index === activeSourceResult ? "active" : ""}
                  onPointerMove={() => setActiveSourceResult(index)}
                  onClick={() => chooseSource(result.request)}
                >
                  <span className="source-result-head"><strong>{result.title}</strong><em>{result.data_kind}</em></span>
                  <code>{result.accession}</code>
                  <small>{result.provider} · {result.description}</small>
                  <span className="source-result-tags">{result.tags.map((tag) => <i key={tag}>{tag}</i>)}</span>
                </button>
              ))}
            </div>
          )}
          <div className={`source-preview ${request ? "valid" : ""}`} aria-live="polite">
            {request ? (
              <><strong>{request.provider}</strong><code>{request.value}</code><span>{request.result}</span></>
            ) : sourceSearching ? (
              <span>Searching live NCBI and Ensembl records…</span>
            ) : sourceSearched && !sourceResults.length ? (
              <span>No public data matches · tools and workflows remain below</span>
            ) : (
              <span>Searching public data alongside the local catalog…</span>
            )}
          </div>
          {request && <button type="button" className="source-action" onClick={() => chooseSource(request)}>{request.action}</button>}
        </section>
      )}

      <div className="operator-sections">
        {sections.map((section) => {
          const open = query ? true : (categoryOpen[section.title] ?? section.open);
          return (
            <section className="operator-section" id={section.title === "Nextflow Workflows" ? "nextflow-workflows" : undefined} key={section.title}>
              <button type="button" className="operator-section-toggle" aria-expanded={open} onClick={() => onToggleCategory(section.title, !open)}>
                <ChevronDown className={open ? "" : "closed"} size={13} aria-hidden="true" />
                <span>{section.title}</span><small>{section.operators.length}</small>
              </button>
              {open && <div className="studio-operator-list">
                {section.operators.map((operator) => {
                  const activity = catalogExpansion?.operatorId === operator.id ? catalogExpansion : null;
                  const presentation = activity ? catalogExpansionPresentation(activity) : null;
                  return (
                    <div className={`studio-operator-row ${activity ? `catalog-${activity.phase}` : ""}`} key={operator.id} draggable={!activity} onDragStart={(event) => {
                      event.dataTransfer.setData("application/somite-operator", operator.id);
                      event.dataTransfer.effectAllowed = "copy";
                    }}>
                      <button type="button" className="operator-add" aria-busy={activity?.phase === "resolving"} disabled={activity?.phase === "resolving"} onClick={() => onAddOperator(operator)}>
                        <span className="operator-icon">{activity?.phase === "resolving" ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <OperatorGlyph operator={operator.id} />}</span>
                        <span><strong>{operator.title}</strong><small>{operator.description || operator.id}</small></span>
                      </button>
                      <button type="button" className={`favorite-button ${favorites.has(operator.id) ? "active" : ""}`} aria-label={`${favorites.has(operator.id) ? "Remove" : "Add"} ${operator.title} ${favorites.has(operator.id) ? "from" : "to"} Favorites`} onClick={() => onToggleFavorite(operator.id)}>
                        <Star size={13} fill={favorites.has(operator.id) ? "currentColor" : "none"} aria-hidden="true" />
                      </button>
                      {activity && presentation && <div className={`catalog-expansion-feedback ${presentation.tone}`} role={activity.phase === "failed" ? "alert" : "status"} aria-live={activity.phase === "failed" ? "assertive" : "polite"}>
                        {activity.phase === "resolving" ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
                        <span><strong>{presentation.headline}</strong><small>{presentation.summary}</small></span>
                        {presentation.detail && <details><summary>Technical details</summary><code>{presentation.detail}</code></details>}
                        {activity.phase === "failed" && <div className="catalog-expansion-actions"><button type="button" onClick={() => onAddOperator(operator)}>Try again</button><button type="button" onClick={onDismissCatalogExpansion}>Dismiss</button></div>}
                      </div>}
                    </div>
                  );
                })}
              </div>}
            </section>
          );
        })}
        {sections.every((section) => section.operators.length === 0) && <p className="panel-empty">No matching tools or workflows.</p>}
      </div>
      <footer className="library-footer"><span>★ {favorites.size} favorites</span><span>Click to add · drag to place</span></footer>
    </section>
  );
}

export function ProjectPanel({ projectName, graphPath, onImportProject, onClose }: {
  projectName: string;
  graphPath: string;
  onImportProject: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="floating-panel project-window" aria-label="Project">
      <header className="floating-panel-head"><div><strong>Project</strong><span>{projectName}</span></div><button type="button" aria-label="Close Project" onClick={onClose}><X size={15} /></button></header>
      <div className="project-current"><span>Current graph</span><strong>{graphPath}</strong><small>Changes are saved into this Somite project.</small></div>
      <form className="project-import" onSubmit={(event) => {
        event.preventDefault();
        const projectPath = path.trim();
        if (!projectPath || importing) return;
        setError("");
        setImporting(true);
        void onImportProject(projectPath)
          .then(() => setPath(""))
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not open project"))
          .finally(() => setImporting(false));
      }}>
        <div className="project-import-title"><FolderOpen size={18} aria-hidden="true" /><span><strong>Open a local project</strong><small>Detect its workflow structure automatically</small></span></div>
        <p>Somite adds the project’s visible workflow structure to this canvas. Unsupported formats fail closed.</p>
        <label><span>Project folder or workflow file</span><input aria-label="Local project folder or workflow file" autoComplete="off" spellCheck={false} placeholder="/path/to/project" value={path} onChange={(event) => setPath(event.target.value)} /></label>
        {error && <p className="project-import-error" role="alert">{error}</p>}
        <button type="submit" disabled={!path.trim() || importing}>{importing ? <><LoaderCircle className="spin" size={13} />Opening project…</> : <><FolderOpen size={13} />Open project</>}</button>
      </form>
    </section>
  );
}

export function MachinePanel({ profile, onClose }: { profile: SystemProfile | null; onClose: () => void }) {
  const memory = profile ? `${(profile.memory_bytes / 1024 ** 3).toFixed(1)} GiB` : "Detecting…";
  const paperReading = profile ? paperReadingPresentation(profile.paper_extraction) : null;
  return (
    <section className="floating-panel machine-window" aria-label="This Machine">
      <header className="floating-panel-head"><div><strong>This Machine</strong><span>Detected locally</span></div><button type="button" aria-label="Close Machine Profile" onClick={onClose}><X size={15} /></button></header>
      <div className="machine-hero"><Cpu size={20} aria-hidden="true" /><span><strong>{profile?.cpu ?? "Detecting hardware…"}</strong><small>{profile?.os ?? "Reading system profile"}</small></span></div>
      <dl className="machine-grid">
        <div><dt>Physical Cores</dt><dd>{profile?.physical_cores ?? "—"}</dd></div>
        <div><dt>Available Workers</dt><dd>{profile?.available_parallelism ?? "—"}</dd></div>
        <div><dt>Logical Threads</dt><dd>{profile?.logical_threads ?? "—"}</dd></div>
        <div><dt>Memory</dt><dd>{memory}</dd></div>
        <div className="machine-gpu"><dt>GPU</dt><dd>{profile?.gpus.join(", ") || "None detected"}</dd></div>
      </dl>
      <section className="paper-reading" aria-label="Paper reading readiness">
        <header className="paper-reading-head">
          <span><strong>Paper reading</strong><small>Checked locally · no agent required</small></span>
          {paperReading && <em>{paperReading.readyToolCount}/{paperReading.tools.length} tools</em>}
        </header>
        <div className="paper-reading-capabilities">
          {(paperReading?.capabilities ?? [
            { key: "native_pdf_text", label: "Native PDF text", ready: false, status: "Checking…" },
            { key: "scanned_pdf_ocr", label: "Scanned PDF OCR", ready: false, status: "Checking…" },
          ]).map((capability) => (
            <div key={capability.key} className={paperReading ? capability.ready ? "ready" : "missing" : "checking"}>
              <span>{capability.label}</span>
              <strong>{paperReading && (capability.ready ? <CheckCircle2 size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />)}{capability.status}</strong>
            </div>
          ))}
        </div>
        {paperReading?.guidance && <p className="paper-reading-guidance"><CircleAlert size={14} aria-hidden="true" /><span>{paperReading.guidance}</span></p>}
        {paperReading && <details className="paper-reading-tools">
          <summary><span>Tool details</span><small>{paperReading.missingToolNames.length ? `${paperReading.missingToolNames.length} missing` : "All available"}</small><ChevronDown size={13} aria-hidden="true" /></summary>
          <div>
            {paperReading.tools.map((tool) => <article key={tool.name} className={tool.available ? "ready" : "missing"}>
              <header><code>{tool.name}</code><span>{tool.status} · {tool.source}</span></header>
              <p>{tool.detail}</p>
              {tool.path && <small title={tool.path}>{tool.path}</small>}
            </article>)}
          </div>
        </details>}
      </section>
    </section>
  );
}

function toolStateLabel(state: ExportPlan["tools"][number]["state"]) {
  return ({
    built_in: "Built in",
    ready: "Ready",
    installable: "Installable",
    system_required: "System tool",
    source_setup: "Execution setup",
    manual_checkpoint: "Manual checkpoint",
    method_details: "Details needed",
    legacy_source: "Legacy setup",
    adapter_needed: "Needs adapter",
  } as const)[state];
}

export function ToolchainPanel({ plan, pixiReady, loading, downloading, onDownload, onClose }: {
  plan: ExportPlan | null;
  pixiReady?: boolean;
  loading: boolean;
  downloading: boolean;
  onDownload: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <section className="floating-panel toolchain-window" aria-label="Environment and Export">
      <header className="floating-panel-head"><div><strong>Environment & Export</strong><span>{plan ? `${plan.tools.length} workflow tools` : "resolving graph"}</span></div><button type="button" aria-label="Close Environment and Export" onClick={onClose}><X size={15} /></button></header>
      <div className="toolchain-intro"><span className="quick-glyph">PK</span><span><strong>Frozen run project</strong><small>Generated Nextflow, exact operators, Pixi lock, and execution identity in one ZIP.</small></span></div>
      <div className="runtime-stack" aria-label="Execution Strategies">
        <div className="preferred"><header><strong>Pixi + Nextflow</strong><span>{pixiReady ? "Pixi ready" : "Pixi required"}</span></header><p>Export resolves the environment now. The included lock and run closure identify the exact target that was compiled.</p></div>
      </div>
      {loading && <div className="toolchain-loading"><span className="loader-mark" />Reading operator requirements…</div>}
      {plan && <>
        <div className={`export-assessment state-${plan.assessment.state}`}>{plan.assessment.required_count > 0 ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}<span><strong>{plan.assessment.required_count > 0 ? `${plan.assessment.required_count} setup step${plan.assessment.required_count === 1 ? "" : "s"} remain` : "Workflow setup is complete"}</strong><small>{plan.assessment.items[0]?.title ?? "The same assessment has cleared Paper, Readiness, and Export."}</small></span></div>
        <div className="toolchain-summary"><span><strong>{plan.ready_count}</strong>ready</span><span><strong>{plan.installable_count}</strong>managed</span>{plan.source_setup_count > 0 && <span className="attention"><strong>{plan.source_setup_count}</strong>execution setup</span>}<span className={plan.manual_count ? "attention" : ""}><strong>{plan.manual_count}</strong>manual</span><span className={plan.details_count ? "attention" : ""}><strong>{plan.details_count}</strong>need details</span><span className={plan.legacy_count ? "attention" : ""}><strong>{plan.legacy_count}</strong>legacy</span>{plan.adapter_count > 0 && <span className="attention"><strong>{plan.adapter_count}</strong>need adapters</span>}</div>
        <div className="tool-list">
          {plan.tools.map((tool) => <article key={tool.operator_id} className={`tool-row state-${tool.state}`}><header><span><strong>{tool.title}</strong><code>{tool.operator_id}</code></span><em>{toolStateLabel(tool.state)}</em></header><p>{tool.packages.join(" · ") || tool.binary || tool.detail}</p></article>)}
          {!plan.tools.length && <p className="panel-empty">This graph has no tool requirements yet.</p>}
        </div>
        <div className="toolchain-format"><span>Includes</span><code>main.nf</code><code>pixi.lock</code><code>run-closure.json</code><code>operators/</code></div>
      </>}
      <button type="button" className="export-action" disabled={!plan || loading || downloading || plan.assessment.required_count > 0} onClick={() => void onDownload()}>{downloading ? <><span className="loader-mark" />Building bundle…</> : plan && plan.assessment.required_count > 0 ? <><CircleAlert size={15} aria-hidden="true" />Resolve setup before export</> : <><Download size={15} aria-hidden="true" />Download {plan?.filename ?? "run bundle"}</>}</button>
      <p className="export-honesty">Somite separates managed tools, manual checkpoints, legacy environments, and missing method details. It will not turn one category into another just because a similarly named package exists.</p>
    </section>
  );
}

function PaperElapsed({ startedAtMs }: { startedAtMs: number }) {
  const [nowMs, setNowMs] = useState(startedAtMs);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAtMs]);

  if (nowMs - startedAtMs < 1_000) return null;
  return <small className="paper-job-elapsed">Elapsed {formatPaperElapsed(startedAtMs, nowMs)}</small>;
}

export function PaperPanel({ intake, active, applied, preparingField, onFile, onRetry, onCancel, onExample, onReconstruct, onSelect, onApply, onUseResource, onAttachInput, onSetInput, onEscalate, onEvidence, onClose }: {
  intake: PaperIntakeState;
  active: number;
  applied: number | null;
  preparingField: string | null;
  onFile: (file: File) => Promise<void>;
  onRetry: () => Promise<void>;
  onCancel: () => void;
  onExample: () => Promise<void>;
  onReconstruct: (paper: PaperSearchResult) => Promise<void>;
  onSelect: (index: number) => void;
  onApply: (index: number) => void;
  onUseResource: (index: number, result: SourceSearchResult) => Promise<void>;
  onAttachInput: (index: number, item: ReadinessItem, field: string, file: File) => Promise<void>;
  onSetInput: (index: number, item: ReadinessItem, field: string, value: string) => Promise<void>;
  onEscalate: (candidate: PaperReview["candidates"][number], item: ReadinessItem) => void;
  onEvidence: (evidence: PaperReview["candidates"][number]["evidence"][number]) => void;
  onClose: () => void;
}) {
  const [paperQuery, setPaperQuery] = useState("");
  const [results, setResults] = useState<PaperSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropError, setDropError] = useState("");
  const [sourceChooserRequest, setSourceChooserRequest] = useState<number | null>(null);
  const [attentionStep, setAttentionStep] = useState(0);
  const [resourceLookup, setResourceLookup] = useState<{ key: string; resolution: PaperResourceResolution | null; error: string }>({ key: "", resolution: null, error: "" });
  const [addingResource, setAddingResource] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const review = intake.current?.review ?? null;
  const runningActivity = intake.activity.status === "running" ? intake.activity : null;
  const running = Boolean(runningActivity);
  const intakeBusy = paperIntakeIsBusy(intake.activity);
  const presentation = paperIntakePresentation(intake);
  const activitySource = intake.activity.status === "idle" ? null : intake.activity.source;
  const selectedPaper = results.find((paper) => paper.id === selectedId) ?? null;
  const candidate = review?.candidates[active];
  const paperResultLabel = review?.outcome === "drafts_ready"
    ? candidate?.assay
    : review?.outcome === "recognized_unsupported"
      ? "Methods retained"
      : review ? "No workflow identified" : "";
  const resourceKey = (review?.resources ?? []).map((resource) => `${resource.accession}:${resource.role}`).join("|");
  const resourceResolution = resourceLookup.key === resourceKey ? resourceLookup.resolution : null;
  const resourceError = resourceLookup.key === resourceKey ? resourceLookup.error : "";
  const resourcesLoading = Boolean(resourceKey) && resourceLookup.key !== resourceKey;
  const evidenceCounts = candidate?.evidence.reduce<Record<string, number>>((counts, evidence) => ({ ...counts, [evidence.status]: (counts[evidence.status] ?? 0) + 1 }), {}) ?? {};
  const attentionItems = paperAttentionItems(candidate);
  const currentAttentionStep = Math.min(attentionStep, Math.max(0, attentionItems.length - 1));
  const currentAttention = attentionItems[currentAttentionStep] ?? null;
  const supportedCount = paperSupportedCount(candidate);
  const unsupportedMentions = paperUnsupportedMentions(review);
  const canApplyCandidate = paperCandidateCanApply(review, candidate, intakeBusy);
  const resolutionCounts = candidate?.assessment.nodes.reduce<Record<string, number>>((counts, node) => node.requires_action ? ({ ...counts, [node.kind]: (counts[node.kind] ?? 0) + 1 }) : counts, {}) ?? {};
  const activityRequestId = intake.activity.status === "idle" ? 0 : intake.activity.requestId;
  const choosingSource = intake.activity.status === "idle" || sourceChooserRequest === activityRequestId;
  const activityArtifact = intake.activity.status === "idle" ? undefined : intake.activity.artifact;
  const currentReceipt = intake.current?.requestId === activityRequestId ? intake.current : null;

  useEffect(() => {
    const resources = review?.resources ?? [];
    const controller = new AbortController();
    if (!resources.length) {
      return () => controller.abort();
    }
    jsonRequest<PaperResourceResolution>("/api/paper/resources/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resources }),
      signal: controller.signal,
    }).then((response) => {
      if (!controller.signal.aborted) setResourceLookup({ key: resourceKey, resolution: response, error: "" });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResourceLookup({ key: resourceKey, resolution: null, error: error instanceof Error ? error.message : "Could not check cited data" });
    });
    return () => controller.abort();
  }, [resourceKey, review?.resources]);

  useEffect(() => {
    const query = paperQuery.trim();
    const controller = new AbortController();
    if (query.length < 2) {
      return () => controller.abort();
    }
    const timer = window.setTimeout(() => {
      jsonRequest<PaperSearchResponse>(`/api/papers/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) setResults(response.results);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setResults([]);
            setSearchError(error instanceof Error ? error.message : "Could not search bioRxiv");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSearching(false);
            setSearched(true);
          }
        });
    }, 420);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [paperQuery]);

  const updatePaperQuery = (value: string) => {
    setPaperQuery(value);
    setSelectedId(null);
    setSearchError("");
    if (value.trim().length < 2) {
      setResults([]);
      setSearching(false);
      setSearched(false);
    } else {
      setSearching(true);
      setSearched(false);
    }
  };

  const acceptsPaper = (file: File) => {
    const name = file.name.toLowerCase();
    return name.endsWith(".pdf") || name.endsWith(".txt") || name.endsWith(".md") || file.type === "application/pdf" || file.type === "text/plain";
  };

  const handlePaperDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current += 1;
    setDropActive(true);
    setDropError("");
  };

  const handlePaperDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };

  const handlePaperDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  };

  const handlePaperDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDropActive(false);
    const files = [...event.dataTransfer.files];
    if (files.length !== 1 || !acceptsPaper(files[0])) {
      setDropError("Drop one PDF or text file.");
      return;
    }
    setDropError("");
    setSourceChooserRequest(null);
    void onFile(files[0]);
  };

  return (
    <section className={`floating-panel paper-window ${dropActive ? "drop-ready" : ""}`} aria-label="Paper Reconstruction" onDragEnter={handlePaperDragEnter} onDragOver={handlePaperDragOver} onDragLeave={handlePaperDragLeave} onDrop={handlePaperDrop}>
      {dropActive && <div className="paper-drop-overlay" aria-live="polite"><FileInput size={24} aria-hidden="true" /><strong>Drop to rebuild this paper</strong><span>PDF, text, or Markdown</span></div>}
      <header className="floating-panel-head"><div><strong>Rebuild from a Paper</strong><span>{intake.activity.status === "idle" ? "methods → graph" : presentation.badge}</span></div><button type="button" aria-label="Close Paper Reconstruction" onClick={onClose}><X size={15} /></button></header>
      {!choosingSource && <button type="button" className="paper-source-switch" onClick={() => setSourceChooserRequest(activityRequestId)}><FileSearch size={13} />Process another paper</button>}
      {choosingSource && <>
        <div className="paper-intro"><FileSearch size={20} aria-hidden="true" /><span><strong>Rebuild the methods</strong><small>Somite separates paper evidence, inferred wiring, managed tools, and exact steps needing your attention.</small></span></div>
        <div className="paper-discovery">
          <label className="paper-search"><Search size={14} aria-hidden="true" /><input aria-label="Search bioRxiv" autoComplete="off" spellCheck={false} placeholder="Search bioRxiv by topic, title, author, or DOI…" value={paperQuery} onChange={(event) => updatePaperQuery(event.target.value)} />{searching && <LoaderCircle className="spin" size={13} aria-label="Searching bioRxiv" />}{paperQuery && !searching && <button type="button" aria-label="Clear bioRxiv search" onClick={() => updatePaperQuery("")}><X size={12} /></button>}</label>
          {results.length > 0 && <div className="paper-search-results" role="listbox" aria-label="bioRxiv papers">
            {results.map((paper) => <button key={paper.id} type="button" role="option" aria-selected={selectedId === paper.id} className={selectedId === paper.id ? "active" : ""} onClick={() => setSelectedId(paper.id)}>
              <strong>{paper.title}</strong><span>{paper.authors || "Authors not listed"}</span><small>{paper.date || "Date not listed"} · {paper.doi}</small><em className={paper.full_text_available ? "ready" : "upload"}>{paper.full_text_available ? "Full text ready" : "PDF needed"}</em>
            </button>)}
          </div>}
          {searched && !results.length && !searchError && <p className="paper-search-empty">No bioRxiv papers matched that search.</p>}
          {searchError && <p className="paper-search-error" role="alert">{searchError}</p>}
          {selectedPaper && <article className="paper-preview">
            <header><span><strong>{selectedPaper.title}</strong><small>Preprint · not peer reviewed</small></span><a href={selectedPaper.url} target="_blank" rel="noreferrer" aria-label="Open paper on bioRxiv"><ExternalLink size={13} /></a></header>
            <p>{selectedPaper.abstract_text || "No abstract is available in the search record."}</p>
            {selectedPaper.full_text_available ? <button type="button" onClick={() => { setSourceChooserRequest(null); void onReconstruct(selectedPaper); }}>{intakeBusy ? "Use this paper instead" : "Rebuild workflow"}</button> : <div className="paper-fulltext-missing"><strong>PDF needed</strong><span>Europe PMC does not have this paper’s full text yet. Upload the PDF below.</span></div>}
          </article>}
        </div>
        <div className="paper-upload-divider"><span>or use a local copy</span></div>
        <label className="paper-upload">
          <FileInput size={15} aria-hidden="true" />
          <span>{intakeBusy ? "Choose another paper to replace this intake" : review ? "Choose or drop another paper" : "Choose or drop PDF or text"}</span>
          <input type="file" accept=".pdf,.txt,.md,text/plain,application/pdf" aria-label="Choose methods paper" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) { setSourceChooserRequest(null); void onFile(file); }
            event.target.value = "";
          }} />
        </label>
        {!review && <button type="button" className="paper-example" onClick={() => { setSourceChooserRequest(null); void onExample(); }}>Try the RNA-seq methods example</button>}
      </>}
      {dropError && <p className="paper-drop-error" role="alert">{dropError}</p>}
      {intake.activity.status !== "idle" && <section className={`paper-job phase-${presentation.tone}`} role={presentation.tone === "error" ? "alert" : undefined} aria-live={presentation.tone === "error" ? "assertive" : undefined}>
        {presentation.tone !== "error" && <span className="paper-job-phase-announcement" role="status" aria-live="polite" aria-atomic="true">{presentation.headline}</span>}
        <header>
          {intakeBusy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : presentation.tone === "ready" ? <CheckCircle2 size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
          <span><strong>{presentation.headline}</strong><small className="paper-job-source" title={activitySource?.label}>{activitySource?.label}</small></span>
          <span className="paper-job-readout">{runningActivity && <PaperElapsed key={runningActivity.requestId} startedAtMs={runningActivity.startedAtMs} />}<em>{presentation.badge}</em></span>
        </header>
        {running && <div className={`paper-job-progress ${presentation.progressPercent === undefined ? "indeterminate" : ""}`} role="progressbar" aria-live="off" aria-label={presentation.headline} aria-valuemin={0} aria-valuemax={100} aria-valuenow={presentation.progressPercent}><i style={presentation.progressPercent === undefined ? undefined : { width: `${presentation.progressPercent}%` }} /></div>}
        <p aria-live="off">{presentation.detail}</p>
        <details className="paper-job-details">
          <summary>Details <ChevronDown size={11} /></summary>
          <dl>
            <div><dt>Phase</dt><dd>{intake.activity.status === "running" ? intake.activity.stage.replaceAll("_", " ") : intake.activity.status}</dd></div>
            {intake.activity.status === "failed" && <div><dt>Code</dt><dd>{intake.activity.code}</dd></div>}
            {activityArtifact && <div><dt>Paper</dt><dd>{activityArtifact.reused ? "cached · " : ""}{formatResourceBytes(activityArtifact.size_bytes)} · {activityArtifact.digest.slice(0, 18)}…</dd></div>}
            {currentReceipt && <div><dt>Extraction</dt><dd>{currentReceipt.review.extracted_via}</dd></div>}
            {currentReceipt?.cache && <div><dt>Cache</dt><dd>{currentReceipt.cache.extraction ? "text reused" : "fresh text"} · {currentReceipt.cache.reconstruction ? "draft reused" : "fresh draft"}</dd></div>}
            {Object.entries(currentReceipt?.durationsMs ?? {}).map(([stage, duration]) => <div key={stage}><dt>{stage.replaceAll("_", " ")}</dt><dd>{duration} ms</dd></div>)}
          </dl>
          {currentReceipt?.review.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </details>
        <div className="paper-job-actions">
          <small>{intake.activity.status === "failed" && !intake.activity.retryable ? "Retrying unchanged will not resolve this issue. Follow the message above, then process the paper again." : presentation.showingPrevious ? "The previous result remains below; its canvas is unchanged." : "The canvas changes only when you accept a draft."}</small>
          {running && <button type="button" onClick={onCancel}>Cancel</button>}
          {(intake.activity.status === "cancelled" || (intake.activity.status === "failed" && intake.activity.retryable)) && <button type="button" onClick={() => void onRetry()}>Try again</button>}
        </div>
      </section>}
      {review && <>
        <div className="paper-meta"><span>Extracted via <strong>{review.extracted_via}</strong></span><span>{paperResultLabel}</span></div>
        {review.outcome === "drafts_ready" && review.candidates.length > 0 && <nav className="paper-candidates" aria-label="Reconstructed Workflows">
          {review.candidates.map((item, index) => <button key={`${item.name}-${index}`} type="button" className={active === index ? "active" : ""} onClick={() => { setAttentionStep(0); onSelect(index); }}><strong>{item.name}</strong><span>{item.role} · {item.graph.nodes.length} nodes{applied === index ? " · on canvas" : ""}</span></button>)}
        </nav>}
        {review.outcome !== "drafts_ready" && <section className={`paper-outcome outcome-${review.outcome}`}>
          <header><CircleAlert size={16} /><span><strong>{review.outcome === "recognized_unsupported" ? "What Somite found" : "No workflow was claimed"}</strong><small>{review.outcome === "recognized_unsupported" ? "Recognized methods are retained without guessed tools or wiring." : "The paper was readable, but it did not yield a reconstructable computational track."}</small></span></header>
          {review.mentions.length > 0 ? <div className="paper-method-mentions">{review.mentions.map((mention, index) => <details key={`${mention.normalized_name}-${mention.source_location ?? index}`}>
            <summary><span><strong>{mention.display_name}</strong><small>{mention.operation_class ?? mention.support}</small></span><em>{mention.source_location ?? "method evidence"}</em><ChevronDown size={11} /></summary>
            <p>{mention.evidence}</p>
          </details>)}</div> : <p>Somite found no method evidence strong enough to turn into an executable draft.</p>}
          {review.warnings.length > 0 && <details className="paper-outcome-notes"><summary>Why no draft was built <ChevronDown size={11} /></summary>{review.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>}
        </section>}
        {review.resources.length > 0 && <section className="paper-resources" aria-label="Cited data">
          <header><span><Database size={16} aria-hidden="true" /><span><strong>Cited data</strong><small>{resourcesLoading ? "Checking NCBI and Ensembl…" : `${review.resources.length} accession${review.resources.length === 1 ? "" : "s"} found in the paper`}</small></span></span>{resourceResolution && <em>{resourceResolution.groups.reduce((count, group) => count + group.results.length, 0)} available item{resourceResolution.groups.reduce((count, group) => count + group.results.length, 0) === 1 ? "" : "s"}</em>}</header>
          {resourcesLoading && <><div className="paper-resource-loading"><LoaderCircle className="spin" size={14} /><span>Resolving cited collections to exact downloadable records</span></div><div className="paper-resource-pending">{review.resources.map((resource) => <span key={resource.accession}><strong>{resource.accession}</strong><small>{resource.source_location ?? resource.role.replaceAll("_", " ")}</small></span>)}</div></>}
          {resourceError && <p className="paper-resource-error" role="alert">Could not check cited data. The paper result is still available. {resourceError}</p>}
          {resourceResolution?.groups.map((group, groupIndex) => {
            const available = group.results.length;
            const collection = ["bioproject", "sra_study", "sra_sample", "sra_experiment"].includes(group.citation.kind);
            return <details className={`paper-resource-group ${available ? "available" : "unavailable"}`} key={group.citation.accession} open={groupIndex === 0 && available > 0 && group.citation.role === "reads"}>
              <summary><span><strong>{group.citation.accession}</strong><small>{group.citation.source_location ?? group.citation.role.replaceAll("_", " ")}</small></span><em>{available ? `${available} ${group.citation.role === "reads" ? "run" : "record"}${available === 1 ? "" : "s"}` : "Not resolved"}</em><ChevronDown size={12} /></summary>
              <p>{group.citation.context}</p>
              {collection && available > 1 && <div className="paper-resource-guidance"><CircleAlert size={13} /><span>This citation is a collection. Choose the exact run used by this workflow; Somite will not silently pick one.</span></div>}
              {group.results.map((result) => {
                const used = paperResourceApplied(candidate, result.request.value);
                const canUseReads = result.request.kind === "sra";
                const noSlot = canUseReads && !nextPaperReadSlot(candidate);
                return <article className="paper-resource-result" key={result.key}>
                  <span><strong>{result.accession}</strong><small>{result.title}</small><em>{result.tags.join(" · ")}</em></span>
                  {canUseReads ? <button type="button" disabled={intakeBusy || used || noSlot || addingResource !== null} onClick={() => {
                    setAddingResource(result.key);
                    void onUseResource(active, result).finally(() => setAddingResource(null));
                  }}>{addingResource === result.key ? "Adding…" : used ? "Used in draft" : !candidate ? "No workflow draft" : noSlot ? "Read inputs filled" : "Use these reads"}</button> : <small className="paper-resource-found">Located in {result.provider}</small>}
                </article>;
              })}
              {!available && <div className="paper-resource-empty">Somite kept this citation and its paper context, but no compatible downloadable record was returned.</div>}
            </details>;
          })}
        </section>}
        {candidate && <div className="paper-review">
          <button type="button" className="paper-apply" disabled={applied === active || !canApplyCandidate} onClick={() => onApply(active)}>{intakeBusy ? "Waiting for current paper intake" : applied === active ? "Workflow is on the canvas" : attentionItems.length ? "Add draft to canvas" : "Use ready workflow on the canvas"}</button>
          {applied !== active && <p className="paper-draft-note">Prepare the known inputs here, then add the reviewed draft when you are ready.</p>}
          {unsupportedMentions.length > 0 && <div className="paper-draft-omissions" role="status"><CircleAlert size={15} /><span><strong>{unsupportedMentions.length} paper method{unsupportedMentions.length === 1 ? " is" : "s are"} not represented in this draft</strong><small>The supported draft remains available. Review the omitted evidence under provenance.</small></span></div>}

          <section className={`paper-guided-setup ${attentionItems.length ? "needs-attention" : "ready"}`}>
            {!currentAttention ? <div className="paper-guided-ready"><CheckCircle2 size={18} /><span><strong>Setup complete</strong><small>Every deterministic requirement is satisfied. Preparation can begin after you add the workflow.</small></span></div> : <>
              <header><span><strong>Resolve next</strong><small>Step {currentAttentionStep + 1} of {attentionItems.length}</small></span><em>{currentAttention.kind.replaceAll("_", " ")}</em></header>
              <div className="paper-attention-copy"><strong>{currentAttention.title}</strong><code>{currentAttention.node_id}.{currentAttention.field}</code><p>{currentAttention.detail}</p></div>
              {currentAttention.fields.map((field) => {
                const value = paperParameterValue(candidate, currentAttention.node_id, field.name);
                const key = `${currentAttention.id}:${field.name}`;
                if (field.input_mode === "file") return <label className={`paper-intake-field ${preparingField === key ? "busy" : ""}`} key={field.name}>
                  <FileInput size={13} /><span><strong>{field.label}</strong><small>{value ? value.split("/").at(-1) : "Choose from this computer"}</small></span><em>{preparingField === key ? "Importing…" : value ? "Replace" : "Choose"}</em>
                  <input type="file" disabled={intakeBusy || preparingField !== null} aria-label={`Choose ${field.label}`} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void onAttachInput(active, currentAttention, field.name, file); }} />
                </label>;
                if (field.input_mode === "text") return <label className="paper-intake-text" key={field.name}><span>{field.label}</span><input defaultValue={value} disabled={intakeBusy} onBlur={(event) => void onSetInput(active, currentAttention, field.name, event.currentTarget.value)} /></label>;
                return null;
              })}
              {currentAttention.fields.some((field) => field.input_mode === "connection" || field.input_mode === "choice") && <button type="button" className="paper-canvas-resolution" disabled={intakeBusy} onClick={() => onApply(active)}>{applied === active ? "Reconnect this input on the canvas" : "Add draft to connect this input"}</button>}
              {currentAttention.resolutions.some((resolution) => resolution.source_url) && <div className="paper-resolution-links">{currentAttention.resolutions.filter((resolution) => resolution.source_url).map((resolution) => <a key={resolution.id} href={resolution.source_url ?? undefined} target="_blank" rel="noreferrer"><ExternalLink size={11} />Official guide</a>)}</div>}
              {currentAttention.recipes.map((recipe) => <details className="paper-recipe" key={recipe.id}>
                <summary><span><strong>{recipe.title}</strong><small>Reusable recipe · v{recipe.version}</small></span><ChevronDown size={12} /></summary>
                <p>{recipe.summary}</p><ol>{recipe.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                {recipe.source_url && <a href={recipe.source_url} target="_blank" rel="noreferrer"><ExternalLink size={11} />Open recipe source</a>}
              </details>)}
              {currentAttention.escalatable && <button type="button" className="paper-agent-escalation" disabled={intakeBusy} onClick={() => onEscalate(candidate, currentAttention)}><MessageSquare size={12} />Ask Agent with this evidence</button>}
              {attentionItems.length > 1 && <nav className="paper-attention-nav" aria-label="Paper setup steps"><button type="button" disabled={currentAttentionStep === 0} onClick={() => setAttentionStep(Math.max(0, currentAttentionStep - 1))}><ChevronLeft size={12} />Back</button><span>{attentionItems.map((item, index) => <button key={item.id} type="button" className={index === currentAttentionStep ? "active" : ""} aria-label={`Go to paper setup step ${index + 1}`} onClick={() => setAttentionStep(index)} />)}</span><button type="button" disabled={currentAttentionStep === attentionItems.length - 1} onClick={() => setAttentionStep(Math.min(attentionItems.length - 1, currentAttentionStep + 1))}>Next<ChevronRight size={12} /></button></nav>}
            </>}
          </section>

          <details className="paper-provenance">
            <summary><span><strong>Evidence & provenance</strong><small>{evidenceCounts.explicit ?? 0} explicit · {evidenceCounts.inferred ?? 0} inferred · {supportedCount} supported</small></span><ChevronDown size={13} /></summary>
            <div className="paper-resolution-summary">
              {supportedCount > 0 && <span className="supported">{supportedCount} supported</span>}
              {(resolutionCounts.input_required ?? 0) > 0 && <span>{resolutionCounts.input_required} inputs</span>}
              {(resolutionCounts.manual_checkpoint ?? 0) > 0 && <span className="attention">{resolutionCounts.manual_checkpoint} manual</span>}
              {(resolutionCounts.method_details ?? 0) > 0 && <span className="attention">{resolutionCounts.method_details} need details</span>}
              {(resolutionCounts.legacy_source ?? 0) > 0 && <span className="attention">{resolutionCounts.legacy_source} legacy</span>}
              {(resolutionCounts.adapter ?? 0) > 0 && <span className="attention">{resolutionCounts.adapter} adapters</span>}
            </div>
            {candidate.warnings.length > 0 && <details className="paper-study-notes"><summary>{candidate.warnings.length} study note{candidate.warnings.length === 1 ? "" : "s"}</summary>{candidate.warnings.map((warning) => <p className="paper-warning" key={warning}>{warning}</p>)}</details>}
            {unsupportedMentions.length > 0 && <details className="paper-omitted-methods">
              <summary><span><strong>Methods not represented in this draft</strong><small>{unsupportedMentions.length} retained paper mention{unsupportedMentions.length === 1 ? "" : "s"}</small></span><ChevronDown size={12} /></summary>
              <div>{unsupportedMentions.map((mention, index) => <article key={`${mention.normalized_name}-${mention.source_location ?? index}`}>
                <header><strong>{mention.display_name}</strong><span>{mention.operation_class ?? "unclassified method"}</span><em>{mention.source_location ?? "paper evidence"}</em></header>
                <p>{mention.evidence}</p>
              </article>)}</div>
            </details>}
            <div className="evidence-list">
              {candidate.evidence.map((evidence, index) => <details key={`${evidence.target_kind}-${evidence.target_id}-${index}`} className={`evidence-item ${evidence.status}`}><summary><i /><strong>{evidence.target_id}</strong><span>{evidence.source_location ?? evidence.status}</span></summary><p>{evidence.detail}</p>{evidence.resolution_label && <small className={`paper-resolution kind-${evidence.resolution_kind}`} title={evidence.resolution_detail}>{evidence.resolution_label}</small>}{applied === active && <button type="button" onClick={() => onEvidence(evidence)}>Show on canvas</button>}</details>)}
              {!candidate.evidence.length && <p className="panel-empty">No method evidence was strong enough to place a tool.</p>}
            </div>
          </details>
        </div>}
      </>}
    </section>
  );
}

type InspectorPanelProps = {
  node: SomiteGraphNode;
  selectedCount: number;
  operator: Operator;
  hiddenViewerCount: number;
  setupCount: number;
  updateParam: (key: string, value: ParamValue) => void;
  updateSourceBinding: (key: string, binding: WorkflowBinding | undefined) => Promise<void>;
  browseSourceBinding: (key: string, file: File) => Promise<void>;
  pendingSourceFile?: { file: File; parameterNames: string[] };
  bindPendingSourceFile: (key: string) => Promise<void>;
  dismissPendingSourceFile: () => void;
  beginParamEdit: (key: string) => void;
  browseParam: (key: string, file: File) => Promise<void>;
  rename: (next: string) => void;
  toggleViewers: () => void;
  exploreSource: () => void;
  close: () => void;
};

export function InspectorPanel(props: InspectorPanelProps) {
  if (props.node.source_workflow) return <SourceWorkflowInspector {...props} />;
  return <OperatorInspectorPanel {...props} />;
}

function SourceWorkflowInspector({ node, setupCount, updateSourceBinding, browseSourceBinding, pendingSourceFile, bindPendingSourceFile, dismissPendingSourceFile, beginParamEdit, exploreSource, close }: InspectorPanelProps) {
  const workflow = node.source_workflow;
  const root = workflow ? sourceWorkflowRoot(workflow) : undefined;
  if (!workflow) return null;

  const parameterGroups = groupedWorkflowParameters(workflow);
  const parameterEditingAvailable = workflow.capabilities.parameter_edits;
  const hiddenRequired = hiddenRequiredWorkflowParameters(workflow);
  const pendingTargets = (workflow.parameters ?? []).filter((parameter) => pendingSourceFile?.parameterNames.includes(parameter.name));

  return (
    <section className="floating-panel inspector-window source-workflow-inspector" aria-label="Source Workflow">
      <header className="inspector-studio-head source-workflow-head">
        <i />
        <div><strong>{sourceWorkflowTitle(workflow)}</strong><code>{sourceWorkflowProvider(workflow)} · {sourceWorkflowRevision(workflow)}</code><span>Source-backed · pinned base{workflow.replacements?.length ? ` · ${workflow.replacements.length} variant edit${workflow.replacements.length === 1 ? "" : "s"}` : ""}</span></div>
        <button type="button" aria-label="Close Source Workflow" onClick={close}><X size={15} /></button>
      </header>
      <div className="source-workflow-scroll">
          <section className="source-workflow-identity">
            <header><span>{sourceWorkflowProvider(workflow)}</span><em>{sourceWorkflowSetupLabel(workflow, setupCount)}</em></header>
            <strong>{workflow.source.repository}</strong>
            <code>{workflow.source.entrypoint} · {workflow.source.resolved_revision.slice(0, 12)}</code>
            <small>{workflow.source.file_count.toLocaleString()} pinned files · {(workflow.source.source_bytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB</small>
          </section>
          <button className="source-outline-open" type="button" disabled={!root} onClick={exploreSource}><FileSearch size={15} aria-hidden="true" /><span><strong>Open editable nested canvas</strong><small>{root ? `${(workflow.scopes ?? []).length} source-anchored scopes · replace tools and explore one layer at a time` : "No source scopes available"}</small></span><ChevronRight size={14} aria-hidden="true" /></button>
          <section className="source-capabilities">
            <header><strong>What you can do</strong><span>Current source contract</span></header>
            <div>{sourceCapabilityRows(workflow.capabilities).map((capability) => <span className={capability.available ? "available" : "unavailable"} key={capability.key}>{capability.available ? <CheckCircle2 size={11} aria-hidden="true" /> : <CircleStop size={11} aria-hidden="true" />}{capability.label}</span>)}</div>
          </section>
          {!parameterEditingAvailable && <section className="source-structure-lock"><CircleStop size={15} aria-hidden="true" /><span><strong>Parameter editing is read-only</strong><small>This source schema contains a constraint Somite cannot evaluate safely. Review the source notes below; no parameter changes will be guessed.</small></span></section>}
          {hiddenRequired.length > 0 && <section className="source-structure-lock"><CircleStop size={15} aria-hidden="true" /><span><strong>Hidden source setup is required</strong><small>{hiddenRequired.map((parameter) => parameter.name).join(", ")} {hiddenRequired.length === 1 ? "is" : "are"} required by the pinned source but intentionally hidden by its schema. Somite keeps the requirement visible without inventing a value.</small></span></section>}
          <section className="source-structure-lock source-variant-guidance"><CircleAlert size={15} aria-hidden="true" /><span><strong>Creative variants are available</strong><small>Replace any source invocation on the nested canvas. Somite preserves uncertain connections as Logic checks, locks chosen tools with Pixi, and uses validation—not contracts—as proof.</small></span></section>
          {pendingSourceFile && <section className="source-drop-target">
            <header><span><strong>Choose this file&apos;s input</strong><small>{pendingSourceFile.file.name}</small></span><button type="button" aria-label="Dismiss dropped file" onClick={dismissPendingSourceFile}><X size={12} /></button></header>
            <p>Somite found several required file inputs, so it will not guess the biological role.</p>
            <div>{pendingTargets.map((parameter) => <button type="button" key={parameter.name} disabled={!parameterEditingAvailable} onClick={() => void bindPendingSourceFile(parameter.name)}><strong>{parameter.label || parameter.name}</strong><small>{parameter.description || parameter.help || parameter.name}</small></button>)}</div>
          </section>}
          <section className="source-binding-groups">
            <header><strong>Pipeline setup</strong><span>{Object.keys(workflow.bindings ?? {}).length} bound</span></header>
            {parameterGroups.map(({ group, parameters }) => <details key={group} open={parameterGroups.length === 1 ? true : undefined}><summary><span>{group}</span><small>{parameters.filter((parameter) => workflow.bindings?.[parameter.name]).length}/{parameters.length}</small><ChevronDown size={12} aria-hidden="true" /></summary><div>{parameters.map((parameter) => <SourceBindingControl key={`${parameter.name}:${workflow.workflow_revision}`} nodeId={node.id} parameter={parameter} binding={workflow.bindings?.[parameter.name]} disabled={!parameterEditingAvailable} beginEdit={() => beginParamEdit(`source:${parameter.name}`)} update={(binding) => updateSourceBinding(parameter.name, binding)} browseFile={(file) => browseSourceBinding(parameter.name, file)} />)}</div></details>)}
            {!parameterGroups.length && <p className="panel-empty">This source exposes no user-bindable parameters.</p>}
          </section>
          {Boolean(workflow.diagnostics?.length) && <details className="source-diagnostics"><summary><CircleAlert size={12} aria-hidden="true" /><span>{workflow.diagnostics?.length} source note{workflow.diagnostics?.length === 1 ? "" : "s"}</span><ChevronDown size={12} aria-hidden="true" /></summary><div>{workflow.diagnostics?.map((diagnostic, index) => <article key={`${diagnostic.code}-${diagnostic.span ? sourceSpanLabel(diagnostic.span) : "workflow"}-${index}`}><strong>{diagnostic.message}</strong><code>{diagnostic.span ? sourceSpanLabel(diagnostic.span) : diagnostic.code}</code></article>)}</div></details>}
      </div>
    </section>
  );
}

function SourceBindingControl({ nodeId, parameter, binding, disabled, beginEdit, update, browseFile }: {
  nodeId: string;
  parameter: WorkflowParameterField;
  binding: WorkflowBinding | undefined;
  disabled: boolean;
  beginEdit: () => void;
  update: (binding: WorkflowBinding | undefined) => Promise<void>;
  browseFile: (file: File) => Promise<void>;
}) {
  const id = `source-parameter-${nodeId}-${parameter.name}`;
  const fallback = parameter.default ?? (parameter.type === "boolean" ? false : "");
  const value = workflowBindingValue(binding, fallback);
  const [draft, setDraft] = useState(String(value));
  const ambiguousPath = parameter.format?.toLowerCase() === "path";
  const [pathKind, setPathKind] = useState<"" | "project_file" | "project_directory">(
    binding?.kind === "project_file" || binding?.kind === "project_directory" ? binding.kind : "",
  );
  const [activity, setActivity] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const save = async (next: WorkflowBinding | undefined) => {
    if (disabled) return;
    setActivity("saving");
    try {
      await update(next);
      setActivity("saved");
    } catch {
      setActivity("error");
    }
  };
  const bind = (next: ParamValue) => save(workflowBinding(parameter, next, pathKind || undefined));
  const choices = parameter.choices ?? [];
  const fileParameter = parameter.format?.toLowerCase() === "file-path" || (ambiguousPath && pathKind === "project_file");
  const unboundBoolean = sourceBooleanNeedsExplicitChoice(parameter, binding);
  const chooseFile = async (file: File) => {
    setActivity("saving");
    try {
      await browseFile(file);
      setActivity("saved");
    } catch {
      setActivity("error");
    }
  };
  if (parameter.managed) {
    return <div className="source-binding-control managed"><span><strong>{parameter.label || parameter.name}</strong><em>Somite-managed</em></span><small>{parameter.description || parameter.help || "Somite binds this value when the frozen run is prepared."}</small></div>;
  }
  return (
    <div className="source-binding-control">
      <label htmlFor={id}>{parameter.label || parameter.name}{parameter.required && <sup>*</sup>}{parameter.format && <em>{parameter.format.replaceAll("_", " ")}</em>}</label>
      {ambiguousPath && <select aria-label={`Path kind for ${parameter.label || parameter.name}`} disabled={disabled || activity === "saving"} value={pathKind} onFocus={beginEdit} onChange={(event) => {
        const next = event.target.value as "" | "project_file" | "project_directory";
        setPathKind(next);
        if (!next && binding) void save(undefined);
        else if (next && binding && draft) void save({ kind: next, path: draft });
      }}><option value="">Choose file or directory…</option><option value="project_file">File in this project</option><option value="project_directory">Directory in this project</option></select>}
      {choices.length ? (
        <select id={id} disabled={disabled || activity === "saving" || (ambiguousPath && !pathKind)} value={workflowChoiceSelection(choices, binding)} onFocus={beginEdit} onChange={(event) => {
          void save(workflowChoiceBinding(parameter, choices, event.target.value, pathKind || undefined));
        }}><option value="unset">{ambiguousPath && !pathKind ? "Choose file or directory first…" : parameter.default === undefined ? "Choose…" : `Default · ${String(parameter.default)}`}</option>{choices.map((choice, index) => <option key={`${index}:${String(choice)}`} value={`choice:${index}`}>{workflowChoiceLabel(choice)}</option>)}</select>
      ) : unboundBoolean ? (
        <select id={id} disabled={disabled || activity === "saving"} value="" onFocus={beginEdit} onChange={(event) => {
          if (event.target.value) void bind(event.target.value === "true");
        }}><option value="">{parameter.required ? "Choose…" : "Not set"}</option><option value="true">Enabled</option><option value="false">Disabled</option></select>
      ) : parameter.type === "boolean" ? (
        <label className="source-binding-toggle" htmlFor={id}><input id={id} type="checkbox" disabled={disabled || activity === "saving"} checked={value === true} onFocus={beginEdit} onChange={(event) => { void bind(event.target.checked); }} /><span>{value === true ? "Enabled" : "Disabled"}</span></label>
      ) : (
        <>
          <div className="source-binding-input-wrap"><input id={id} type={parameter.type === "integer" || parameter.type === "number" ? "number" : "text"} step={parameter.type === "integer" ? 1 : undefined} disabled={disabled || activity === "saving" || (ambiguousPath && !pathKind)} value={draft} min={parameter.minimum} max={parameter.maximum} pattern={parameter.pattern} spellCheck={false} onFocus={beginEdit} onChange={(event) => { setDraft(event.target.value); setActivity("idle"); }} onBlur={() => {
              if (draft === String(value)) return;
              if (draft === "") { void save(undefined); return; }
              const next = parameter.type === "integer" || parameter.type === "number" ? parseSourceNumericDraft(parameter, draft) : draft;
              if (next === undefined) { setActivity("error"); return; }
              void save(workflowBinding(parameter, next, pathKind || undefined));
            }} onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") { setDraft(String(value)); event.currentTarget.blur(); }
            }} />{fileParameter && <label className={`browse-button ${disabled ? "disabled" : ""}`} title={`Choose ${parameter.label || parameter.name}`}><FolderOpen size={12} aria-hidden="true" /><span>Choose</span><input type="file" aria-label={`Choose file for ${parameter.label || parameter.name}`} disabled={disabled || activity === "saving"} onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) { beginEdit(); void chooseFile(file); }
            }} /></label>}</div>
        </>
      )}
      {(parameter.description || parameter.help) && <small>{parameter.description || parameter.help}</small>}
      <span className={`source-binding-status ${activity}`}>{disabled ? "Read-only source parameter" : activity === "saving" ? "Saving…" : activity === "saved" ? "Saved" : activity === "error" ? "Could not save" : sourceBindingStatus(parameter, binding)}</span>
      {!binding && parameter.type === "string" && !parameter.format && !choices.length && <button type="button" disabled={disabled || activity === "saving"} onClick={() => { beginEdit(); void save({ kind: "literal", value: "" }); }}>Set empty value</button>}
      {binding && <button type="button" disabled={disabled || activity === "saving"} onClick={() => { beginEdit(); void save(undefined); }}>{sourceBindingResetLabel(parameter)}</button>}
    </div>
  );
}

function OperatorInspectorPanel({
  node,
  selectedCount,
  operator,
  hiddenViewerCount,
  updateParam,
  beginParamEdit,
  browseParam,
  rename,
  toggleViewers,
  close,
}: InspectorPanelProps) {
  const pages = useMemo(() => {
    const found = [...new Set(Object.values(operator.params).map((spec) => spec.page ?? operator.title))];
    return [...found, "Common"];
  }, [operator]);
  const [page, setPage] = useState(pages[0]);
  const [name, setName] = useState(node.id);
  const visibleOnAll = hiddenViewerCount === 0;
  return (
    <section className="floating-panel inspector-window" aria-label="Node Parameters">
      <header className="inspector-studio-head">
        <i />
        <div><strong>{operator.title}</strong><code>{operator.id}</code>{selectedCount > 1 && <span>{selectedCount} nodes selected</span>}</div>
        <button type="button" aria-label="Close Parameters" onClick={close}><X size={15} /></button>
      </header>
      <div className="rename-control">
        <label htmlFor="node-name">Node Name</label>
        <input id="node-name" autoComplete="off" spellCheck={false} value={name} onChange={(event) => setName(event.target.value)} onBlur={() => rename(name)} onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setName(node.id);
            event.currentTarget.blur();
          }
        }} />
      </div>
      <nav className="parameter-tabs" aria-label="Parameter Pages">
        {pages.map((value) => <button key={value} type="button" className={page === value ? "active" : ""} onClick={() => setPage(value)}>{value}</button>)}
      </nav>
      <div className="parameter-page">
        {page === "Common" ? (
          <>
            <dl className="common-grid"><div><dt>Viewer</dt><dd>{hiddenViewerCount === 0 ? "On" : hiddenViewerCount === selectedCount ? "Off" : "Mixed"}</dd></div><div><dt>Cost</dt><dd>{operator.cost}</dd></div><div><dt>Inputs</dt><dd>{operator.ports.in.length}</dd></div><div><dt>Outputs</dt><dd>{operator.ports.out.length}</dd></div></dl>
            {node.note && <p className="node-note">{node.note}</p>}
            <button type="button" className="viewer-toggle" onClick={toggleViewers}>{visibleOnAll ? "Hide" : "Show"} {selectedCount > 1 ? `${selectedCount} Selected Viewers` : "Viewer"}</button>
          </>
        ) : (
          <>
            {Object.entries(operator.params).filter(([, spec]) => (spec.page ?? operator.title) === page).map(([key, spec]) => (
              <ParameterControl key={key} node={node} name={key} spec={spec} value={node.params?.[key] ?? spec.default ?? ""} update={updateParam} beginEdit={beginParamEdit} browse={browseParam} />
            ))}
            {Object.entries(operator.params).filter(([, spec]) => (spec.page ?? operator.title) === page).length === 0 && <p className="panel-empty">No parameters on this page.</p>}
          </>
        )}
      </div>
      <div className="port-summary">
        <span className="section-kicker">Ports</span>
        {node.ports.map((port) => <div key={`${port.dir}-${port.name}`}><i style={{ background: portColor[port.ty] ?? "#8b949b" }} /><strong>{port.name}</strong><span>{port.ty}</span><small>{port.dir}</small></div>)}
      </div>
      <div className="migration-note"><Play size={14} aria-hidden="true" /><span>{operator.kind === "reference" ? "Imported workflow structure. Add a reviewed tool or source-backed module Adapter before compiling." : "Web Run and Export compile this node through the same frozen Nextflow/Pixi package."}</span></div>
    </section>
  );
}

function isFileParameter(operator: string, key: string) {
  return ((operator.startsWith("files.import") || operator.startsWith("manual.")) && (key === "path" || key.endsWith("_path")))
    || (operator === "files.import_paired" && (key === "r1" || key === "r2"));
}

function ParameterControl({ node, name, spec, value, update, beginEdit, browse }: {
  node: SomiteGraphNode;
  name: string;
  spec: ParamSpec;
  value: ParamValue;
  update: (key: string, value: ParamValue) => void;
  beginEdit: (key: string) => void;
  browse: (key: string, file: File) => Promise<void>;
}) {
  const label = spec.label ?? name;
  const id = `parameter-${node.id}-${name}`;
  if (spec.type === "bool" || spec.type === "boolean") {
    return <label className="parameter-row toggle-row" htmlFor={id}><span>{label}</span><input id={id} name={`${node.id}-${name}`} type="checkbox" checked={Boolean(value)} onFocus={() => beginEdit(name)} onChange={(event) => update(name, event.target.checked)} /></label>;
  }
  const numeric = spec.type === "int" || spec.type === "float" || spec.type === "number";
  return (
    <div className="parameter-row">
      <label htmlFor={id}>{label}{spec.required && <sup>*</sup>}</label>
      <div className="parameter-input-wrap">
        <input id={id} type={numeric ? "number" : "text"} autoComplete="off" inputMode={numeric ? "decimal" : undefined} name={`${node.id}-${name}`} spellCheck={false} value={String(value)} min={spec.min} max={spec.max} onFocus={() => beginEdit(name)} onChange={(event) => update(name, numeric ? Number(event.target.value) : event.target.value)} />
        {isFileParameter(node.operator, name) && <label className="browse-button" title="Choose and import a file"><FolderOpen size={13} aria-hidden="true" /><span>Browse</span><input type="file" aria-label={`Choose file for ${label}`} onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void browse(name, file);
          event.target.value = "";
        }} /></label>}
      </div>
    </div>
  );
}
