"use client";

import { Check, CircleAlert, ExternalLink, FlaskConical, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { SomiteClient } from "./api";
import type { OperatorCandidate } from "./types";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sourceLabel(kind: OperatorCandidate["sources"][number]["kind"]) {
  return ({ official_docs: "Docs", source: "Source", package_recipe: "Package", workflow_use: "Workflow" })[kind];
}

export function OperatorWorkshopPanel({ client, onAccepted, onClose }: {
  client: SomiteClient;
  onAccepted: (candidate: OperatorCandidate) => Promise<void>;
  onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<OperatorCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setCandidates(await client.operatorCandidates());
      setError(null);
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(true), 4_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const accept = async (candidate: OperatorCandidate) => {
    setAccepting(candidate.candidate_id);
    try {
      const accepted = await client.acceptOperatorCandidate(candidate.candidate_id);
      setCandidates((current) => current.map((item) => item.candidate_id === accepted.candidate_id ? accepted : item));
      setError(null);
      await onAccepted(accepted);
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setAccepting(null);
    }
  };

  return <section className="floating-panel operator-workshop-window" aria-label="Project tools">
    <header className="floating-panel-head">
      <div><FlaskConical size={15} aria-hidden="true" /><strong>Project tools</strong><span>{candidates.length || "None yet"}</span></div>
      <nav>
        <button type="button" aria-label="Refresh project tools" title="Refresh" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
        <button type="button" aria-label="Close project tools" title="Close" onClick={onClose}><X size={15} /></button>
      </nav>
    </header>
    <div className="operator-workshop-body">
      <div className="operator-workshop-intro"><strong>Teach Somite a missing tool</strong><p>Ask Agent to research its real command, package, typed files, and a tiny proof. Nothing joins this project until the proof passes and you accept it.</p></div>
      {error && <div className="operator-workshop-error" role="status"><CircleAlert size={14} /><span>{error}</span></div>}
      {loading && !candidates.length ? <div className="operator-workshop-empty"><LoaderCircle className="spin" size={16} />Checking project tools…</div>
        : !candidates.length ? <div className="operator-workshop-empty"><FlaskConical size={18} /><strong>No candidates</strong><span>Open Agent and ask it to add the missing tool.</span></div>
          : <div className="operator-candidate-list">{candidates.map((candidate) => {
            const passed = candidate.proof?.result === "passed";
            return <article key={candidate.candidate_id} className={`operator-candidate status-${candidate.status}`}>
              <header><span><strong>{candidate.operator.title}</strong><small>{candidate.candidate_id}</small></span><em>{candidate.status === "accepted" ? "In project" : passed ? "Proof passed" : candidate.proof ? "Proof failed" : "Needs proof"}</em></header>
              <p>{candidate.operator.description ?? "A project-local executable contract researched and tested by Agent."}</p>
              <div className="operator-candidate-contract"><span>{candidate.operator.pixi?.join(", ")}</span><span>{candidate.operator.ports.in.length} in · {candidate.operator.ports.out.length} out</span></div>
              <div className="operator-candidate-sources">{candidate.sources.map((source) => <a key={`${source.kind}:${source.url}`} href={source.url} target="_blank" rel="noreferrer">{sourceLabel(source.kind)}<ExternalLink size={10} /></a>)}</div>
              {candidate.status === "proven" && <button type="button" className="operator-accept" disabled={accepting === candidate.candidate_id} onClick={() => void accept(candidate)}>{accepting === candidate.candidate_id ? <><LoaderCircle className="spin" size={13} />Accepting…</> : <><Check size={13} />Accept into this project</>}</button>}
              {candidate.status === "accepted" && <div className="operator-accepted"><Check size={12} />Available in Add and to Agent</div>}
            </article>;
          })}</div>}
    </div>
  </section>;
}
