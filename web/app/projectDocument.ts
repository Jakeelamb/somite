import type { ProjectOpenResponse, SomiteGraph } from "./types";

export type WorkflowDocument = Readonly<{
  graph: SomiteGraph;
  input_origin_id: string;
}>;

export type WorkflowDocumentHistory = Readonly<{
  past: readonly WorkflowDocument[];
  future: readonly WorkflowDocument[];
}>;

export function workflowDocument(graph: SomiteGraph, inputOriginId: string): WorkflowDocument {
  return { graph, input_origin_id: inputOriginId };
}

export function rememberDocument(
  history: WorkflowDocumentHistory,
  document: WorkflowDocument,
  limit: number,
): WorkflowDocumentHistory {
  return { past: [...history.past.slice(-(limit - 1)), document], future: [] };
}

export function openProjectDocument(
  response: ProjectOpenResponse,
  current: WorkflowDocument,
  history: WorkflowDocumentHistory,
  limit: number,
) {
  if (response.kind !== "somite") return null;
  return {
    document: workflowDocument(response.graph, response.input_origin_id),
    history: rememberDocument(history, current, limit),
  };
}

export function undoDocument(history: WorkflowDocumentHistory, current: WorkflowDocument, limit: number) {
  const document = history.past.at(-1);
  if (!document) return null;
  return {
    document,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, limit),
    },
  };
}

export function redoDocument(history: WorkflowDocumentHistory, current: WorkflowDocument, limit: number) {
  const document = history.future[0];
  if (!document) return null;
  return {
    document,
    history: {
      past: [...history.past, current].slice(-limit),
      future: history.future.slice(1),
    },
  };
}

export function scopedGraphRequest(document: WorkflowDocument) {
  return { graph: document.graph, input_origin_id: document.input_origin_id };
}
