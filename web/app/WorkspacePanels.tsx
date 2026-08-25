"use client";

import {
  Check,
  ChevronDown,
  Cpu,
  Download,
  FileSearch,
  FileInput,
  FolderOpen,
  LoaderCircle,
  Play,
  Search,
  Star,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { classifySource, type SourceRequest, type SourceSearchResponse, type SourceSearchResult } from "./sourceBuilder";
import { operatorContinues, type PendingConnection } from "./graphInteractions";
import type {
  SomiteGraphNode,
  Operator,
  ParamSpec,
  ParamValue,
  PaperReview,
  ExportPlan,
  SystemProfile,
} from "./types";
import { OperatorGlyph, portColor } from "./visual";
import { jsonRequest } from "./api";

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
    return operator.palette.includes("Catalog") ? "nf-core Catalog" : "Curated for Somite";
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
  snakemakeCount,
  snakemakeGraphCount,
  snakemakeStatus,
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
  snakemakeCount: number;
  snakemakeGraphCount: number;
  snakemakeStatus: "loading" | "ready" | "offline";
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
  const hasDirectSource = request !== null;
  const [sourceResults, setSourceResults] = useState<SourceSearchResult[]>([]);
  const [sourceSearching, setSourceSearching] = useState(false);
  const [sourceSearched, setSourceSearched] = useState(false);
  const [activeSourceResult, setActiveSourceResult] = useState(0);
  const sections = useMemo(
    () => buildSections(operators, mode, filterQuery, favorites, recent, continuation),
    [continuation, favorites, filterQuery, mode, operators, recent],
  );

  useEffect(() => {
    const query = accession.trim();
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (mode !== "sources" || hasDirectSource || query.length < 2) {
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
        jsonRequest<SourceSearchResponse>(`/api/sources/search?q=${encodeURIComponent(query)}&provider=${provider}`, {
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
  }, [accession, hasDirectSource, mode]);

  const chooseSource = (source: SourceRequest) => {
    onAddSource(source);
    setAccession("");
    setSourceResults([]);
    setActiveSourceResult(0);
  };

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
          <label htmlFor="accession-entry">Search Data or Enter an Accession</label>
          <div className="source-search-input">
            <Search size={13} aria-hidden="true" />
            <input
              id="accession-entry"
              role="combobox"
              aria-autocomplete="list"
              aria-controls="source-search-results"
              aria-expanded={sourceResults.length > 0}
              aria-activedescendant={sourceResults[activeSourceResult] ? `source-result-${sourceResults[activeSourceResult].key}` : undefined}
              autoComplete="off"
              name="accession"
              placeholder="human · mouse RNA-seq · BRCA2 · SRR…"
              spellCheck={false}
              value={accession}
              onChange={(event) => setAccession(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && sourceResults.length) {
                  event.preventDefault();
                  setActiveSourceResult((index) => Math.min(index + 1, sourceResults.length - 1));
                } else if (event.key === "ArrowUp" && sourceResults.length) {
                  event.preventDefault();
                  setActiveSourceResult((index) => Math.max(index - 1, 0));
                } else if (event.key === "Enter") {
                  if (request) chooseSource(request);
                  else if (sourceResults[activeSourceResult]) chooseSource(sourceResults[activeSourceResult].request);
                } else if (event.key === "Escape") {
                  setAccession("");
                }
              }}
            />
            {sourceSearching && <LoaderCircle className="source-search-spinner" size={13} aria-label="Searching NCBI and Ensembl" />}
          </div>
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
              <span>No direct matches · try an organism, assay, gene symbol, or accession</span>
            ) : (
              <span>Reads, reference genomes, assemblies, genes, and stable IDs</span>
            )}
          </div>
          <button type="button" className="source-action" disabled={!request} onClick={() => {
            if (!request) return;
            chooseSource(request);
          }}>
            {request?.action ?? "Choose a Result"}
          </button>
        </div>
      )}

      {mode === "pipelines" && !query && (
        <div className="pipeline-banner">
          <span className="section-kicker">Workflow Engines</span>
          <div><WayfindingMark label="NF" ready={toolReadiness?.nextflow} /><span><strong>Nextflow / nf-core</strong><small>{catalogStatus === "loading" ? "Loading the official catalog…" : catalogStatus === "offline" ? "Catalog offline · local workflows remain" : `${catalogCount} official workflows ready`}</small></span></div>
          <div><WayfindingMark label="SM" ready={toolReadiness?.snakemake} /><span><strong>Snakemake Catalog</strong><small>{snakemakeStatus === "loading" ? "Loading released standardized workflows…" : snakemakeStatus === "offline" ? "Catalog offline · local workflows remain" : `${snakemakeCount} released · ${snakemakeGraphCount} graph-ready`}</small></span></div>
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
                    event.dataTransfer.setData("application/somite-operator", operator.id);
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
      <footer className="library-footer"><span>★ {favorites.size} favorites</span><span>{localCount} local · {catalogStatus === "loading" || snakemakeStatus === "loading" ? "catalog…" : catalogStatus === "offline" && snakemakeStatus === "offline" ? "catalogs offline" : `${catalogCount + snakemakeCount} catalog`}</span></footer>
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
      <div className="paper-intro"><FileSearch size={20} aria-hidden="true" /><span><strong>Rebuild the methods</strong><small>Somite separates paper evidence, inferred wiring, and tools that still need adapters.</small></span></div>
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
  node: SomiteGraphNode;
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
      <div className="migration-note"><Play size={14} aria-hidden="true" /><span>{operator.kind === "reference" ? "Imported workflow structure. Replace or promote this component to a native Somite tool before standalone execution." : "Run uses the native Rust executor and content-addressed cache. Downloads and high-cost tools start only when you explicitly run the graph."}</span></div>
    </section>
  );
}

function isFileParameter(operator: string, key: string) {
  return (operator === "files.import" && key === "path") || (operator === "files.import_paired" && (key === "r1" || key === "r2"));
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
