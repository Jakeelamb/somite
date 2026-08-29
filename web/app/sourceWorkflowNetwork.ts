import {
  sourceInvocationTitle,
  sourceScopeTitle,
  sourceWorkflowInvocations,
  sourceWorkflowRoot,
  sourceWorkflowScope,
} from "./sourceWorkflowPresentation.ts";
import type { SourceInvocation, SourceInvocationReplacement, SourceScope, SourceWorkflowInstance } from "./types.ts";

export type SourceNetworkCapability = "experimental" | "guided";

export type SourceNetworkCard = {
  id: string;
  invocation: SourceInvocation;
  title: string;
  scope?: SourceScope;
  relation: "invocation";
  capability: SourceNetworkCapability;
  replacement?: SourceInvocationReplacement;
  canEnter: boolean;
};

export type SourceNetworkProjection = {
  path: string[];
  current?: SourceScope;
  breadcrumbs: SourceScope[];
  cards: SourceNetworkCard[];
};

function rootPath(workflow: SourceWorkflowInstance) {
  const root = sourceWorkflowRoot(workflow);
  return root ? [root.id] : [];
}

function visibleCallee(workflow: SourceWorkflowInstance, caller: string, callee: string) {
  return sourceWorkflowInvocations(workflow, caller).some((invocation) => invocation.callee === callee)
    ? sourceWorkflowScope(workflow, callee)
    : undefined;
}

function normalizePath(workflow: SourceWorkflowInstance, requestedPath: string[]) {
  const path = rootPath(workflow);
  if (!path.length || requestedPath[0] !== path[0]) return path;

  for (const scopeId of requestedPath.slice(1)) {
    const caller = path.at(-1);
    if (!caller || !visibleCallee(workflow, caller, scopeId)) return rootPath(workflow);
    path.push(scopeId);
  }
  return path;
}

function sourceNetworkCapability(workflow: SourceWorkflowInstance): SourceNetworkCapability {
  return workflow.capabilities.structural_edits && workflow.capabilities.channel_contracts
    ? "guided"
    : "experimental";
}

export function projectSourceNetwork(
  workflow: SourceWorkflowInstance,
  requestedPath: string[],
): SourceNetworkProjection {
  const path = normalizePath(workflow, requestedPath);
  const currentId = path.at(-1);
  const current = currentId ? sourceWorkflowScope(workflow, currentId) : undefined;
  const breadcrumbs = path
    .map((scopeId) => sourceWorkflowScope(workflow, scopeId))
    .filter((scope): scope is SourceScope => Boolean(scope));
  const capability = sourceNetworkCapability(workflow);
  const cards = current
    ? sourceWorkflowInvocations(workflow, current.id).map((invocation): SourceNetworkCard => {
      const scope = invocation.callee ? sourceWorkflowScope(workflow, invocation.callee) : undefined;
      const replacement = workflow.replacements?.find((candidate) => candidate.invocation_id === invocation.id);
      return {
        id: invocation.id,
        invocation,
        title: scope ? sourceScopeTitle(scope) : sourceInvocationTitle(invocation),
        scope,
        relation: "invocation",
        capability,
        replacement,
        canEnter: Boolean(scope && sourceWorkflowInvocations(workflow, scope.id).length),
      };
    })
    : [];

  return { path, current, breadcrumbs, cards };
}

export function sourceNetworkEnterPath(
  workflow: SourceWorkflowInstance,
  requestedPath: string[],
  scopeId: string,
) {
  const projection = projectSourceNetwork(workflow, requestedPath);
  const caller = projection.current?.id;
  return caller && visibleCallee(workflow, caller, scopeId)
    ? [...projection.path, scopeId]
    : projection.path;
}

export function sourceNetworkExitPath(requestedPath: string[]) {
  return requestedPath.length > 1 ? requestedPath.slice(0, -1) : [];
}
