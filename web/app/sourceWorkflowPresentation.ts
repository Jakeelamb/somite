import type {
  Operator,
  ParamValue,
  SomiteGraph,
  SomiteGraphNode,
  SourceCapabilities,
  SourceInvocation,
  SourceScope,
  SourceWorkflowInstance,
  WorkflowBinding,
  WorkflowParameterField,
} from "./types";

export function opaqueNfcoreFallback(operator: Pick<Operator, "id" | "palette">) {
  return operator.id.startsWith("nf.") && !operator.palette.includes("Catalog");
}

export function sourceWorkflowReplacementCandidate(operator: Pick<Operator, "id" | "kind" | "revision">) {
  return Boolean(operator.revision)
    && (operator.kind === "external" || operator.kind === "inprocess")
    && !operator.id.startsWith("nf.")
    && !operator.id.startsWith("smk.");
}

export function sourceWorkflowCanvasIsEmpty(graph: Pick<SomiteGraph, "nodes" | "edges">) {
  return graph.nodes.length === 0 && graph.edges.length === 0;
}

export function sourceWorkflowCanAppendGraph(
  current: Pick<SomiteGraph, "nodes" | "edges">,
  incoming: Pick<SomiteGraph, "nodes">,
) {
  const currentHasSource = current.nodes.some((node) => Boolean(node.source_workflow));
  const incomingHasSource = incoming.nodes.some((node) => Boolean(node.source_workflow));
  return !currentHasSource && (!incomingHasSource || sourceWorkflowCanvasIsEmpty(current));
}

function humanize(value: string) {
  const spaced = value
    .replace(/^nf-core[/:]/i, "")
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return spaced ? spaced.replace(/^\p{Ll}/u, (first) => first.toUpperCase()) : "Workflow";
}

export function sourceWorkflowTitle(workflow: SourceWorkflowInstance) {
  const repository = workflow.source.repository.replace(/\/$/, "");
  const repositoryName = repository.split(/[/:]/).at(-1)?.replace(/\.git$/i, "") ?? repository;
  return humanize(repositoryName);
}

export function sourceWorkflowProvider(workflow: SourceWorkflowInstance) {
  return workflow.source.provider === "nf_core" ? "nf-core" : "Local source";
}

export function sourceWorkflowRevision(workflow: SourceWorkflowInstance) {
  return workflow.source.requested_revision || workflow.source.resolved_revision.slice(0, 12);
}

export function sourceWorkflowSetupLabel(workflow: SourceWorkflowInstance, setupCount: number) {
  if (setupCount > 0) return `${setupCount} setup item${setupCount === 1 ? "" : "s"}`;
  if (!workflow.capabilities.exact_execution || (workflow.parameters ?? []).some((parameter) =>
    parameter.required
    && !parameter.managed
    && parameter.default === undefined
    && !workflow.bindings?.[parameter.name]
  )) return "Setup needed";
  return "Setup complete";
}

export function sourceSpanLabel(span: { path: string; start_line: number; end_line: number }) {
  return `${span.path}:${span.start_line}${span.end_line === span.start_line ? "" : `–${span.end_line}`}`;
}

export function sourceWorkflowRoot(workflow: SourceWorkflowInstance): SourceScope | undefined {
  const scopes = workflow.scopes ?? [];
  return scopes.find((scope) => scope.kind === "entry_workflow") ?? scopes.find((scope) => scope.kind === "workflow") ?? scopes[0];
}

export function sourceWorkflowInvocations(workflow: SourceWorkflowInstance, scopeId: string): SourceInvocation[] {
  return (workflow.invocations ?? []).filter((invocation) => invocation.caller === scopeId);
}

export function sourceWorkflowScope(workflow: SourceWorkflowInstance, scopeId: string): SourceScope | undefined {
  return (workflow.scopes ?? []).find((scope) => scope.id === scopeId);
}

export function sourceScopeTitle(scope: SourceScope) {
  return humanize(scope.title || scope.symbol || scope.id);
}

export function sourceInvocationTitle(invocation: SourceInvocation) {
  return humanize(invocation.name);
}

export function groupedWorkflowParameters(workflow: SourceWorkflowInstance) {
  const groups = new Map<string, WorkflowParameterField[]>();
  for (const parameter of workflow.parameters ?? []) {
    if (parameter.hidden) continue;
    const group = parameter.group.trim() || "Parameters";
    groups.set(group, [...(groups.get(group) ?? []), parameter]);
  }
  return [...groups.entries()].map(([group, parameters]) => ({ group, parameters }));
}

export function hiddenRequiredWorkflowParameters(workflow: SourceWorkflowInstance) {
  return (workflow.parameters ?? []).filter((parameter) =>
    parameter.hidden
    && parameter.required
    && !parameter.managed
    && parameter.default === undefined
    && !workflow.bindings?.[parameter.name]
  );
}

export function editableRequiredSourceFileParameters(workflow: SourceWorkflowInstance) {
  if (!workflow.capabilities.parameter_edits) return [];
  return (workflow.parameters ?? []).filter((parameter) =>
    parameter.required
    && !parameter.hidden
    && !parameter.managed
    && parameter.format?.toLowerCase() === "file-path"
    && !workflow.bindings?.[parameter.name]
  );
}

export function sourceCapabilityRows(capabilities: SourceCapabilities) {
  return [
    { key: "exact_execution", label: "Execution environment", available: capabilities.exact_execution },
    { key: "parameter_edits", label: "Parameters", available: capabilities.parameter_edits },
    { key: "hierarchy_indexed", label: "Source outline", available: capabilities.hierarchy_indexed },
    { key: "structural_edits", label: "Automatic rewiring", available: capabilities.structural_edits },
    { key: "channel_contracts", label: "Channel guidance", available: capabilities.channel_contracts },
    { key: "source_edits", label: "Source patch export", available: capabilities.source_edits },
  ] as const;
}

export function workflowBindingValue(binding: WorkflowBinding | undefined, fallback: ParamValue = "") {
  if (!binding) return fallback;
  return binding.kind === "literal" ? binding.value : binding.path;
}

export function sourceBooleanNeedsExplicitChoice(
  parameter: Pick<WorkflowParameterField, "type" | "default">,
  binding: WorkflowBinding | undefined,
) {
  return parameter.type === "boolean" && parameter.default === undefined && binding === undefined;
}

export function sourceBindingStatus(
  parameter: Pick<WorkflowParameterField, "required" | "default">,
  binding: WorkflowBinding | undefined,
) {
  if (binding) return "Bound to this workflow";
  if (parameter.default !== undefined) return "Using default";
  return parameter.required ? "Not set · required" : "Not set · optional";
}

export function sourceBindingResetLabel(parameter: Pick<WorkflowParameterField, "default">) {
  return parameter.default === undefined ? "Clear value" : "Use default";
}

export function parseSourceNumericDraft(
  parameter: Pick<WorkflowParameterField, "type">,
  draft: string,
): number | undefined {
  if (draft.trim() === "") return undefined;
  const value = Number(draft);
  if (!Number.isFinite(value)) return undefined;
  if (parameter.type === "integer" && !Number.isSafeInteger(value)) return undefined;
  const persisted = JSON.stringify(value);
  if (!persisted || normalizeDecimalDraft(draft) !== normalizeDecimalDraft(persisted)) return undefined;
  return value;
}

function normalizeDecimalDraft(value: string): string | undefined {
  const match = value.trim().match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) return undefined;
  const negative = match[1] === "-";
  const whole = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  const sourceExponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(sourceExponent)) return undefined;
  let digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  const trailingZeros = digits.length - digits.replace(/0+$/, "").length;
  if (trailingZeros) digits = digits.slice(0, -trailingZeros);
  const exponent = sourceExponent - fraction.length + trailingZeros;
  if (!Number.isSafeInteger(exponent)) return undefined;
  return `${negative ? "-" : "+"}${digits}e${exponent}`;
}

export function workflowBinding(
  parameter: WorkflowParameterField,
  value: ParamValue,
  genericPathKind?: "project_file" | "project_directory",
): WorkflowBinding | undefined {
  const format = parameter.format?.toLowerCase() ?? "";
  if (typeof value === "string" && value.trim() === "" && format.includes("path")) return undefined;
  if (format.includes("directory")) return { kind: "project_directory", path: String(value) };
  if (format.includes("file")) return { kind: "project_file", path: String(value) };
  if (format === "path") return genericPathKind ? { kind: genericPathKind, path: String(value) } : undefined;
  return { kind: "literal", value };
}

export function workflowChoiceBinding(
  parameter: WorkflowParameterField,
  choices: ParamValue[],
  selection: string,
  genericPathKind?: "project_file" | "project_directory",
): WorkflowBinding | undefined {
  const index = selection.startsWith("choice:") ? Number(selection.slice("choice:".length)) : Number.NaN;
  const choice = Number.isSafeInteger(index) ? choices[index] : undefined;
  return choice === undefined ? undefined : workflowBinding(parameter, choice, genericPathKind);
}

export function workflowChoiceSelection(choices: ParamValue[], binding: WorkflowBinding | undefined) {
  if (!binding) return "unset";
  const value = binding.kind === "literal" ? binding.value : binding.path;
  // JSON has one numeric domain: transports may turn 1.0 into 1 and -0.0 into
  // 0, so selection follows JSON Schema numeric equality rather than Object.is.
  const index = choices.findIndex((choice) => choice === value);
  return index < 0 ? "unset" : `choice:${index}`;
}

export function workflowChoiceLabel(choice: ParamValue) {
  return typeof choice === "string" ? JSON.stringify(choice) : String(choice);
}

export function withSourceWorkflowBinding(node: SomiteGraphNode, name: string, binding: WorkflowBinding | undefined): SomiteGraphNode {
  // Pure draft helper only. Persisted edits must use the server transaction so
  // `workflow_revision` is recomputed and the returned instance replaces this one.
  if (!node.source_workflow) return node;
  const bindings = { ...(node.source_workflow.bindings ?? {}) };
  if (binding) bindings[name] = binding;
  else delete bindings[name];
  return {
    ...node,
    source_workflow: {
      ...node.source_workflow,
      bindings,
    },
  };
}

export function mergeCanonicalSourceWorkflow(
  current: SomiteGraph,
  canonical: SomiteGraph,
  baseWorkflowRevision: string,
): SomiteGraph {
  if (current.variant_origin && canonical.variant_origin) {
    const currentSource = current.variant_origin.source_node;
    const canonicalSource = canonical.variant_origin.source_node.source_workflow;
    if (!currentSource.source_workflow || !canonicalSource || currentSource.source_workflow.workflow_revision !== baseWorkflowRevision) return current;
    return {
      ...current,
      variant_origin: {
        ...current.variant_origin,
        source_node: { ...currentSource, source_workflow: canonicalSource },
      },
    };
  }
  const currentSources = current.nodes.filter((node) => Boolean(node.source_workflow));
  const canonicalSources = canonical.nodes.filter((node) => Boolean(node.source_workflow));
  const currentSource = currentSources[0];
  const canonicalSource = canonicalSources[0]?.source_workflow;
  if (
    currentSources.length !== 1
    || canonicalSources.length !== 1
    || !currentSource?.source_workflow
    || !canonicalSource
    || currentSource.source_workflow.workflow_revision !== baseWorkflowRevision
  ) return current;
  return {
    ...current,
    nodes: current.nodes.map((node) => node.id === currentSource.id
      ? { ...node, source_workflow: canonicalSource }
      : node),
  };
}
