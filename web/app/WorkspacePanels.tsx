"use client";

import {
  Check,
  ChevronDown,
  Cpu,
  Download,
  FileSearch,
  FileInput,
  FolderOpen,
  Play,
  Search,
  Star,
  X,
} from "lucide-react";
import { useMemo, useState, type RefObject } from "react";
import { classifySource, type SourceRequest } from "./sourceBuilder";
import { operatorContinues, type PendingConnection } from "./graphInteractions";
import type {
  AxialGraphNode,
  Operator,
  ParamSpec,
  ParamValue,
  PaperReview,
  ExportPlan,
  SystemProfile,
} from "./types";
import { OperatorGlyph, portColor } from "./visual";

export type LibraryMode = "build" | "sources" | "pipelines";

type LibrarySection = { title: string; operators: Operator[]; open: boolean };

function isSource(operator: Operator) {
  return ["files.", "sheet.", "archive.", "sra.", "ncbi.", "ensembl."].some((prefix) =>
    operator.id.startsWith(prefix),
  );
}

function isPipeline(operator: Operator) {
  return operator.id.startsWith("nf.") || operator.id.startsWith("smk.");
}

function sectionTitle(operator: Operator, mode: LibraryMode) {
  if (mode === "sources") {
    if (operator.id.startsWith("sra.") || operator.id.startsWith("ncbi.")) return "NCBI & SRA";
    if (operator.id.startsWith("ensembl.")) return "Ensembl Accessions";
    return "Local Files";
  }
  if (mode === "pipelines") {
    if (operator.id.startsWith("smk.")) return "Snakemake";
    return operator.palette.includes("Catalog") ? "nf-core Catalog" : "Curated for Axial";
  }
  const prefix = operator.id.split(".")[0];
  return ({
    qc: "Quality",
    align: "Align & Map",
    quant: "Quantify",
    asm: "Assemble",
    diff: "Analyze",
    var: "Analyze",
    class: "Analyze",
    gap: "Utilities",
  } as Record<string, string>)[prefix] ?? "More Tools";
}

function buildSections(
  operators: Operator[],
  mode: LibraryMode,
  query: string,
  favorites: Set<string>,
  recent: string[],
  continuation?: PendingConnection | null,
): LibrarySection[] {
  const normalized = query.trim().toLowerCase();
  const matches = operators.filter((operator) => {
    if (continuation && !operatorContinues(operator, continuation)) return false;
    if (normalized) {
      return `${operator.title} ${operator.id} ${operator.palette.join(" ")} ${operator.description ?? ""} ${(operator.topics ?? []).join(" ")}`
        .toLowerCase()
        .includes(normalized);
    }
    if (continuation) return true;
    if (mode === "sources") return isSource(operator);
    if (mode === "pipelines") return isPipeline(operator);
    return !isSource(operator) && !isPipeline(operator);
  });
  if (continuation) return [{ title: "Compatible Tools", operators: matches, open: true }];
  if (normalized) return [{ title: "Search Results", operators: matches, open: true }];

  const byId = new Map(operators.map((operator) => [operator.id, operator]));
  const leading: LibrarySection[] = [];
  const favoriteOperators = matches.filter((operator) => favorites.has(operator.id));
  if (favoriteOperators.length) {
    leading.push({ title: "Favorites", operators: favoriteOperators, open: true });
  }
  if (mode === "build") {
    const recentOperators = recent
      .map((id) => byId.get(id))
      .filter((operator): operator is Operator => Boolean(operator) && matches.includes(operator as Operator));
    if (recentOperators.length) {
      leading.push({ title: "Recent", operators: recentOperators, open: true });
    }
  }
  const grouped = new Map<string, Operator[]>();
  for (const operator of matches) {
    const title = sectionTitle(operator, mode);
    grouped.set(title, [...(grouped.get(title) ?? []), operator]);
  }
  return [
    ...leading,
    ...[...grouped.entries()].map(([title, groupedOperators]) => ({
      title,
      operators: groupedOperators,
      open: mode !== "build" || title === "Quality",
    })),
  ];
}

export function LibraryPanel({
  operators,
  mode,
  query,
  filterQuery,
  favorites,
  recent,
  categoryOpen,
  searchInputRef,
  toolReadiness,
  localCount,
  catalogCount,
  catalogStatus,
  continuation,
  onMode,
  onQuery,
  onClose,
  onAddOperator,
  onAddSource,
  onToggleFavorite,
  onToggleCategory,
}: {
  operators: Operator[];
  mode: LibraryMode;
  query: string;
  filterQuery: string;
  favorites: Set<string>;
  recent: string[];
  categoryOpen: Record<string, boolean>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  toolReadiness?: SystemProfile["tools"];
  localCount: number;
  catalogCount: number;
  catalogStatus: "loading" | "ready" | "offline";
  continuation?: PendingConnection | null;
  onMode: (mode: LibraryMode) => void;
  onQuery: (query: string) => void;
  onClose: () => void;
  onAddOperator: (operator: Operator) => void;
  onAddSource: (request: SourceRequest) => void;
  onToggleFavorite: (id: string) => void;
  onToggleCategory: (title: string, open: boolean) => void;
}) {
  const [accession, setAccession] = useState("");
  const request = classifySource(accession);
  const sections = useMemo(
    () => buildSections(operators, mode, filterQuery, favorites, recent, continuation),
    [continuation, favorites, filterQuery, mode, operators, recent],
  );

  return (
    <section className="floating-panel library-window" aria-label="Operator Library">
      <header className="floating-panel-head">
        <div><strong>Library</strong><span>{operators.length} tools</span></div>
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
            placeholder="Search everything…  Ctrl K"
            spellCheck={false}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          {query && <button type="button" aria-label="Clear Search" onClick={() => onQuery("")}><X size={13} aria-hidden="true" /></button>}
        </div>
        {!continuation && <nav className="library-tabs" aria-label="Library Modes">
          {(["build", "sources", "pipelines"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-current={mode === value ? "page" : undefined}
              className={mode === value ? "active" : ""}
              onClick={() => onMode(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </nav>}
      </div>

      {!continuation && mode === "build" && !query && (
        <div className="quick-add-grid">
          <span className="section-kicker">Quick Add</span>
          <button type="button" onClick={() => {
            const operator = operators.find((candidate) => candidate.id === "files.import");
            if (operator) onAddOperator(operator);
          }}>
            <FileInput size={16} aria-hidden="true" /><span><strong>Import Reads</strong><small>FASTQ, BAM, VCF or GTF</small></span>
          </button>
          <button type="button" onClick={() => onMode("sources")}>
            <span className="quick-glyph">ID</span><span><strong>Add Accession</strong><small>NCBI or Ensembl stable ID</small></span>
          </button>
          <button type="button" onClick={() => onMode("pipelines")}>
            <span className="quick-glyph">nf</span><span><strong>Find a Pipeline</strong><small>Nextflow & Snakemake</small></span>
          </button>
        </div>
      )}

      {!continuation && mode === "sources" && !query && (
        <div className="source-builder">
          <div className="source-readiness">
            {(["sra", "datasets", "ensembl"] as const).map((tool) => (
              <span key={tool} className={toolReadiness?.[tool] ? "ready" : "missing"}>
                <i />{tool === "sra" ? "SRA" : tool[0].toUpperCase() + tool.slice(1)}
              </span>
            ))}
          </div>
          <label htmlFor="accession-entry">Paste an Accession or Record URL</label>
          <input
            id="accession-entry"
            autoComplete="off"
            name="accession"
            placeholder="SRR… · GCA_/GCF_… · ENSG/ENST/ENSP…"
            spellCheck={false}
            value={accession}
            onChange={(event) => setAccession(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && request) {
                onAddSource(request);
                setAccession("");
              }
            }}
          />
          <div className={`source-preview ${request ? "valid" : ""}`} aria-live="polite">
            {request ? (
              <><strong>{request.provider}</strong><code>{request.value}</code><span>{request.result}</span></>
            ) : (
              <span>NCBI runs and assemblies · Ensembl stable IDs</span>
            )}
          </div>
          <button type="button" className="source-action" disabled={!request} onClick={() => {
            if (!request) return;
            onAddSource(request);
            setAccession("");
          }}>
            {request?.action ?? "Add Source"}
          </button>
        </div>
      )}

      {mode === "pipelines" && !query && (
        <div className="pipeline-banner">
          <span className="section-kicker">Workflow Engines</span>
          <div><WayfindingMark label="NF" ready={toolReadiness?.nextflow} /><span><strong>Nextflow / nf-core</strong><small>{catalogStatus === "loading" ? "Loading the official catalog…" : catalogStatus === "offline" ? "Catalog offline · local workflows remain" : `${catalogCount} official workflows ready`}</small></span></div>
          <div><WayfindingMark label="SM" ready={toolReadiness?.snakemake} /><span><strong>Snakemake</strong><small>Drop a workflow directory onto the canvas</small></span></div>
        </div>
      )}

      <div className="operator-sections">
        {sections.map((section) => {
          const open = query ? true : (categoryOpen[section.title] ?? section.open);
          return (
            <section className="operator-section" key={section.title}>
              <button type="button" className="operator-section-toggle" aria-expanded={open} onClick={() => onToggleCategory(section.title, !open)}>
                <ChevronDown className={open ? "" : "closed"} size={13} aria-hidden="true" />
                <span>{section.title}</span><small>{section.operators.length}</small>
              </button>
              {open && <div className="studio-operator-list">
                {section.operators.map((operator) => (
                  <div className="studio-operator-row" key={operator.id} draggable onDragStart={(event) => {
                    event.dataTransfer.setData("application/axial-operator", operator.id);
                    event.dataTransfer.effectAllowed = "copy";
                  }}>
                    <button type="button" className="operator-add" onClick={() => onAddOperator(operator)}>
                      <span className="operator-icon"><OperatorGlyph operator={operator.id} /></span>
                      <span><strong>{operator.title}</strong><small>{operator.description || operator.id}</small></span>
                    </button>
                    <button type="button" className={`favorite-button ${favorites.has(operator.id) ? "active" : ""}`} aria-label={`${favorites.has(operator.id) ? "Remove" : "Add"} ${operator.title} ${favorites.has(operator.id) ? "from" : "to"} Favorites`} onClick={() => onToggleFavorite(operator.id)}>
                      <Star size={13} fill={favorites.has(operator.id) ? "currentColor" : "none"} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>}
            </section>
          );
        })}
        {sections.every((section) => section.operators.length === 0) && <p className="panel-empty">No matching tools.</p>}
      </div>
      <footer className="library-footer"><span>★ {favorites.size} favorites</span><span>{localCount} local · {catalogStatus === "loading" ? "catalog…" : catalogStatus === "offline" ? "catalog offline" : `${catalogCount} official`}</span></footer>
    </section>
  );
}

function WayfindingMark({ label, ready }: { label: string; ready?: boolean }) {
  return <span className={`wayfinding-mark ${ready ? "ready" : ""}`}>{ready ? <Check size={12} aria-hidden="true" /> : label}</span>;
}

export function MachinePanel({ profile, onClose }: { profile: SystemProfile | null; onClose: () => void }) {
  const memory = profile ? `${(profile.memory_bytes / 1024 ** 3).toFixed(1)} GiB` : "Detecting…";
  return (
    <section className="floating-panel machine-window" aria-label="This Machine">
      <header className="floating-panel-head"><div><strong>This Machine</strong><span>Detected locally</span></div><button type="button" aria-label="Close Machine Profile" onClick={onClose}><X size={15} /></button></header>
      <div className="machine-hero"><Cpu size={20} aria-hidden="true" /><span><strong>{profile?.cpu ?? "Detecting hardware…"}</strong><small>{profile?.os ?? "Reading system profile"}</small></span></div>
      <dl className="machine-grid">
        <div><dt>Physical Cores</dt><dd>{profile?.physical_cores ?? "—"}</dd></div>
        <div><dt>Logical Threads</dt><dd>{profile?.logical_threads ?? "—"}</dd></div>
        <div><dt>Memory</dt><dd>{memory}</dd></div>
        <div><dt>GPU</dt><dd>{profile?.gpus.join(", ") || "None detected"}</dd></div>
      </dl>
    </section>
  );
}

function toolStateLabel(state: ExportPlan["tools"][number]["state"]) {
  return ({
    built_in: "Built in",
    ready: "Ready",
    installable: "Installable",
    system_required: "System tool",
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
      <div className="toolchain-intro"><span className="quick-glyph">PK</span><span><strong>Portable run bundle</strong><small>Graph, operator contracts, tool plan, and launch files in one ZIP.</small></span></div>
      <div className="runtime-stack" aria-label="Execution Strategies">
        <div className="preferred"><header><strong>One Pixi workspace</strong><span>{pixiReady ? "Pixi ready" : "Pixi required"}</span></header><p>One manifest for every tool in this graph. First run resolves packages, creates the lock, and activates the environment.</p></div>
      </div>
      {loading && <div className="toolchain-loading"><span className="loader-mark" />Reading operator requirements…</div>}
      {plan && <>
        <div className="toolchain-summary"><span><strong>{plan.ready_count}</strong>ready</span><span><strong>{plan.installable_count}</strong>installable</span><span className={plan.adapter_count ? "attention" : ""}><strong>{plan.adapter_count}</strong>need adapters</span></div>
        <div className="tool-list">
          {plan.tools.map((tool) => <article key={tool.operator_id} className={`tool-row state-${tool.state}`}><header><span><strong>{tool.title}</strong><code>{tool.operator_id}</code></span><em>{toolStateLabel(tool.state)}</em></header><p>{tool.packages.join(" · ") || tool.binary || tool.detail}</p></article>)}
          {!plan.tools.length && <p className="panel-empty">This graph has no tool requirements yet.</p>}
        </div>
        <div className="toolchain-format"><span>Includes</span><code>pixi.toml</code><code>tools.json</code><code>operators/</code><code>run.sh</code></div>
      </>}
      <button type="button" className="export-action" disabled={!plan || loading || downloading} onClick={() => void onDownload()}>{downloading ? <><span className="loader-mark" />Building bundle…</> : <><Download size={15} aria-hidden="true" />Download {plan?.filename ?? "run bundle"}</>}</button>
      <p className="export-honesty">Finding a package does not define a valid node. Paper-only tools remain “Needs adapter” until ports, arguments, and outputs are reviewed.</p>
    </section>
  );
}

export function PaperPanel({ review, active, loading, onFile, onExample, onActivate, onEvidence, onClose }: {
  review: PaperReview | null;
  active: number;
  loading: boolean;
  onFile: (file: File) => Promise<void>;
  onExample: () => Promise<void>;
  onActivate: (index: number) => void;
  onEvidence: (evidence: PaperReview["candidates"][number]["evidence"][number]) => void;
  onClose: () => void;
}) {
  const candidate = review?.candidates[active];
  const evidenceCounts = candidate?.evidence.reduce<Record<string, number>>((counts, evidence) => ({ ...counts, [evidence.status]: (counts[evidence.status] ?? 0) + 1 }), {}) ?? {};
  return (
    <section className="floating-panel paper-window" aria-label="Paper Reconstruction">
      <header className="floating-panel-head"><div><strong>Paper Drop</strong><span>{review ? `${review.candidates.length} workflow${review.candidates.length === 1 ? "" : "s"}` : "methods → graph"}</span></div><button type="button" aria-label="Close Paper Reconstruction" onClick={onClose}><X size={15} /></button></header>
      <div className="paper-intro"><FileSearch size={20} aria-hidden="true" /><span><strong>Rebuild the methods</strong><small>Axial separates paper evidence, inferred wiring, and tools that still need adapters.</small></span></div>
      <label className={`paper-upload ${loading ? "busy" : ""}`}>
        {loading ? <span className="spin"><LoaderMark /></span> : <FileInput size={15} aria-hidden="true" />}
        <span>{loading ? "Reading methods…" : review ? "Choose another paper" : "Choose PDF or text"}</span>
        <input type="file" accept=".pdf,.txt,.md,text/plain,application/pdf" disabled={loading} aria-label="Choose methods paper" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onFile(file);
          event.target.value = "";
        }} />
      </label>
      {!review && <button type="button" className="paper-example" disabled={loading} onClick={() => void onExample()}>Try the RNA-seq methods example</button>}
      {review && <>
        <div className="paper-meta"><span>Extracted via <strong>{review.extracted_via}</strong></span><span>{candidate?.assay}</span></div>
        <nav className="paper-candidates" aria-label="Reconstructed Workflows">
          {review.candidates.map((item, index) => <button key={`${item.name}-${index}`} type="button" className={active === index ? "active" : ""} onClick={() => onActivate(index)}><strong>{item.name}</strong><span>{item.role} · {item.graph.nodes.length} nodes</span></button>)}
        </nav>
        {candidate && <div className="paper-review">
          <div className="evidence-summary"><span className="explicit"><i />{evidenceCounts.explicit ?? 0} explicit</span><span className="inferred"><i />{evidenceCounts.inferred ?? 0} inferred</span><span className="needs_adapter"><i />{evidenceCounts.needs_adapter ?? 0} need adapters</span></div>
          {candidate.warnings.map((warning) => <p className="paper-warning" key={warning}>{warning}</p>)}
          <div className="evidence-list">
            {candidate.evidence.map((evidence, index) => <button type="button" key={`${evidence.target_kind}-${evidence.target_id}-${index}`} className={`evidence-item ${evidence.status}`} onClick={() => onEvidence(evidence)} aria-label={`Show ${evidence.target_kind} ${evidence.target_id} on canvas`}><header><i /><strong>{evidence.target_id}</strong><span>{evidence.status}</span></header><p>{evidence.detail}</p></button>)}
            {!candidate.evidence.length && <p className="panel-empty">No method evidence was strong enough to place a tool.</p>}
          </div>
        </div>}
      </>}
    </section>
  );
}

function LoaderMark() {
  return <span className="loader-mark" aria-hidden="true" />;
}

export function InspectorPanel({
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
}: {
  node: AxialGraphNode;
  selectedCount: number;
  operator: Operator;
  hiddenViewerCount: number;
  updateParam: (key: string, value: ParamValue) => void;
  beginParamEdit: (key: string) => void;
  browseParam: (key: string, file: File) => Promise<void>;
  rename: (next: string) => void;
  toggleViewers: () => void;
  close: () => void;
}) {
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
      <div className="migration-note"><Play size={14} aria-hidden="true" /><span>Run uses the native Rust executor and content-addressed cache. Downloads and high-cost tools start only when you explicitly run the graph.</span></div>
    </section>
  );
}

function isFileParameter(operator: string, key: string) {
  return (operator === "files.import" && key === "path") || (operator === "files.import_paired" && (key === "r1" || key === "r2"));
}

function ParameterControl({ node, name, spec, value, update, beginEdit, browse }: {
  node: AxialGraphNode;
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
