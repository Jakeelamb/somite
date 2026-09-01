import type { WorkflowParameterField } from "./model.ts";
import type {
  Operator,
  ParamSpec,
  ResolutionRecipe,
  ResolutionRecipeKind,
} from "./catalog.ts";
import { OperatorCatalog } from "./catalog.ts";
import type { ParamValue, SomiteGraph, SomiteGraphNode } from "./model.ts";
import { semanticGraphRevision, validateGraph } from "./workflow.ts";

export type ReadinessState = "empty" | "building" | "needs_action" | "ready";
export type RequirementKind = "input" | "parameter" | "managed_resource" | "manual_checkpoint" | "method_details" | "legacy_tool" | "adapter";
export type ResolutionKind = "connect" | "configure" | "use_existing" | "download" | "build" | "attach" | "review" | "setup" | "add_adapter";
export type RequirementInputMode = "connection" | "file" | "text" | "choice" | "guide" | "agent";
export type SupportKind = "input_required" | "managed_tool" | "source_workflow" | "built_in" | "system_tool" | "manual_checkpoint" | "method_details" | "legacy_source" | "adapter";

export type RequirementField = {
  name: string;
  label: string;
  input_mode: RequirementInputMode;
};

export type ReadinessResolution = {
  id: string;
  label: string;
  detail: string;
  kind: ResolutionKind;
  recommended: boolean;
  download_bytes?: number | null;
  stored_bytes?: number | null;
  scientific_effect?: string | null;
  source_url?: string | null;
};

export type ReadinessItem = {
  id: string;
  node_id: string;
  operator_id: string;
  field: string;
  fields: RequirementField[];
  title: string;
  detail: string;
  kind: RequirementKind;
  priority: number;
  escalatable: boolean;
  resource_profile?: string | null;
  resolutions: ReadinessResolution[];
  recipes: ResolutionRecipe[];
};

export type NodeAssessment = {
  node_id: string;
  operator_id: string;
  title: string;
  kind: SupportKind;
  label: string;
  detail: string;
  requires_action: boolean;
  recipes: ResolutionRecipe[];
};

export type WorkflowAssessment = {
  graph_revision: string;
  state: ReadinessState;
  required_count: number;
  items: ReadinessItem[];
  nodes: NodeAssessment[];
};

export type ReadinessSnapshot = WorkflowAssessment;

export type ManagedResourceAvailability = Readonly<{
  reference: string;
  provider_id: string;
  profile: string;
  resolution: string;
  title: string;
  available: boolean;
  detail: string;
  download_bytes: number;
  stored_bytes: number;
  scientific_effect: string;
  source_url: string;
  error?: string;
}>;

export type WorkflowAssessmentContext = Readonly<{
  managed_resources?: readonly ManagedResourceAvailability[];
}>;

export function managedResourceReferenceId(value: unknown) {
  if (typeof value !== "string") return undefined;
  return /^somite-resource:([a-z0-9]+(?:[._-][a-z0-9]+)*)$/.exec(value)?.[1];
}

function emptyResolution(
  id: string,
  label: string,
  detail: string,
  kind: ResolutionKind,
  recommended: boolean,
  sourceUrl: string | null = null,
): ReadinessResolution {
  return {
    id,
    label,
    detail,
    kind,
    recommended,
    download_bytes: null,
    stored_bytes: null,
    scientific_effect: null,
    source_url: sourceUrl,
  };
}

function recipe(spec: ResolutionRecipe): ResolutionRecipe {
  return {
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    version: spec.version,
    kind: spec.kind,
    steps: [...spec.steps],
    parameters: [...spec.parameters],
    source_url: spec.source_url ?? null,
  };
}

function configuredParameter(value: ParamValue | undefined) {
  return value !== undefined && (typeof value !== "string" || value.trim().length > 0);
}

function parameterValue(node: SomiteGraphNode, operator: Operator, parameter: string) {
  return Object.hasOwn(node.params ?? {}, parameter)
    ? node.params?.[parameter]
    : operator.params[parameter]?.default;
}

function sourceParameterInputMode(parameter: WorkflowParameterField): RequirementInputMode {
  if (parameter.format === "file-path") return "file";
  if ((parameter.choices?.length ?? 0) > 0) return "choice";
  return "text";
}

function parameterInputMode(name: string, parameter: ParamSpec, fallback: RequirementInputMode): RequirementInputMode {
  const page = (parameter.page ?? "").toLowerCase();
  return parameter.type === "string" && (name === "path" || name.endsWith("_path") || page.includes("checkpoint"))
    ? "file"
    : fallback;
}

function requirementField(operator: Operator, parameter: string, fallback: RequirementInputMode): RequirementField {
  const spec = operator.params[parameter];
  return {
    name: parameter,
    label: spec?.label ?? parameter,
    input_mode: spec ? parameterInputMode(parameter, spec, fallback) : fallback,
  };
}

function nodePriority(index: number) {
  return Math.min(index, 9);
}

function gapTitle(node: SomiteGraphNode, operator: Operator) {
  if (operator.id === "gap.missing") {
    const tool = node.params?.tool;
    if (typeof tool === "string" && tool.trim()) return tool.trim();
  }
  return operator.title;
}

function assessNode(node: SomiteGraphNode, operator: Operator, resolutionUnresolved: boolean): NodeAssessment {
  const recipes = (operator.resolution?.recipes ?? []).map(recipe);
  const title = gapTitle(node, operator);
  if (operator.id === "gap.missing" && node.ports.length === 0) {
    return {
      node_id: node.id,
      operator_id: node.operator,
      title,
      kind: "adapter",
      label: "Evidence retained",
      detail: "The paper names this executable method, but Somite did not infer ports, arguments, outputs, or a workflow position.",
      requires_action: false,
      recipes,
    };
  }
  const workflow = node.source_workflow;
  if (workflow) {
    const missingParameter = (workflow.parameters ?? []).some((parameter) => parameter.required
      && !parameter.managed
      && parameter.default === undefined
      && !Object.hasOwn(workflow.bindings ?? {}, parameter.name));
    const replacements = workflow.replacements ?? [];
    const requiresAction = missingParameter
      || (workflow.unsupported_required_parameters?.length ?? 0) > 0
      || !workflow.capabilities.exact_execution
      || replacements.length > 0;
    return {
      node_id: node.id,
      operator_id: node.operator,
      title: workflow.source.repository,
      kind: "source_workflow",
      label: replacements.length > 0 ? "Variant needs validation" : requiresAction ? "Setup needed" : "Pinned and ready",
      detail: replacements.length === 0
        ? `${workflow.source.repository} is retained at immutable revision ${workflow.source.requested_revision} with its source-backed outline.`
        : `${workflow.source.repository} keeps immutable revision ${workflow.source.requested_revision} as its base and adds ${replacements.length} user replacement${replacements.length === 1 ? "" : "s"} that must be connection-checked and validated.`,
      requires_action: requiresAction,
      recipes,
    };
  }
  const resolution = operator.resolution;
  if (resolution) {
    const support: Record<typeof resolution.kind, readonly [SupportKind, string]> = {
      manual_checkpoint: ["manual_checkpoint", "Manual output attached"],
      method_details: ["method_details", "Method details attached"],
      legacy_source: ["legacy_source", "Legacy environment reviewed"],
      adapter: ["adapter", "Adapter reviewed"],
    };
    const [kind, completedLabel] = support[resolution.kind];
    return {
      node_id: node.id,
      operator_id: node.operator,
      title,
      kind,
      label: resolutionUnresolved ? resolution.title : completedLabel,
      detail: resolution.detail,
      requires_action: resolutionUnresolved,
      recipes,
    };
  }
  if (operator.id === "gap.missing") {
    return {
      node_id: node.id,
      operator_id: node.operator,
      title,
      kind: "adapter",
      label: "Reviewed adapter required",
      detail: "Package discovery cannot infer typed ports, arguments, or outputs.",
      requires_action: true,
      recipes,
    };
  }
  if (operator.id.startsWith("files.import")) {
    const missing = Object.entries(operator.params).some(([name, parameter]) => parameter.required
      && !configuredParameter(parameterValue(node, operator, name)));
    return {
      node_id: node.id,
      operator_id: node.operator,
      title,
      kind: "input_required",
      label: missing ? "Choose input" : "Input attached",
      detail: "Use a local file or replace this node with a searchable online source.",
      requires_action: missing,
      recipes,
    };
  }
  if (operator.kind === "external" && (operator.pixi?.length ?? 0) > 0) {
    return {
      node_id: node.id,
      operator_id: node.operator,
      title,
      kind: "managed_tool",
      label: "Managed automatically",
      detail: `Somite can resolve ${operator.pixi!.join(", ")} with Pixi.`,
      requires_action: false,
      recipes,
    };
  }
  const support: Record<Operator["kind"], readonly [SupportKind, string, string]> = {
    external: ["system_tool", "System tool required", "This command must already be available on the machine."],
    inprocess: ["built_in", "Built into Somite", "No separate tool installation is needed."],
    reference: ["adapter", "Reviewed adapter required", "This structural reference is not executable yet."],
    source: ["source_workflow", "Source workflow unavailable", "This source operator is missing its pinned workflow instance."],
  };
  const [kind, label, detail] = support[operator.kind];
  return {
    node_id: node.id,
    operator_id: node.operator,
    title,
    kind,
    label,
    detail,
    requires_action: operator.kind === "reference" || operator.kind === "source",
    recipes,
  };
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One deterministic assessment consumed by canvas, export, paper, and Agent surfaces. */
export function assessWorkflow(graph: SomiteGraph, catalog: OperatorCatalog, context: WorkflowAssessmentContext = {}): WorkflowAssessment {
  const graphValidation = validateGraph(graph);
  if (!graphValidation.ok) throw new Error(`invalid graph: ${graphValidation.issue.message}`);
  const catalogValidation = catalog.verifyGraph(graph);
  if (!catalogValidation.ok) throw new Error(`catalog: ${catalogValidation.issue.message}`);

  const boundInputs = new Set(graph.edges.map((edge) => `${edge.to_node}\0${edge.to_port}`));
  const managedResources = new Map((context.managed_resources ?? []).map((resource) => [resource.reference, resource]));
  const items: ReadinessItem[] = [];
  const nodes: NodeAssessment[] = [];

  for (const [nodeIndex, node] of graph.nodes.entries()) {
    const operator = catalog.get(node.operator)!;
    const missingResolutionParameters = (operator.resolution?.parameters ?? [])
      .filter((parameter) => !configuredParameter(parameterValue(node, operator, parameter)));
    const resolutionUnresolved = operator.resolution !== undefined
      && (operator.resolution.parameters.length === 0 || missingResolutionParameters.length > 0);
    nodes.push(assessNode(node, operator, resolutionUnresolved));

    const managedReference = typeof node.params?.path === "string" && managedResourceReferenceId(node.params.path)
      ? node.params.path
      : undefined;
    if (managedReference) {
      const availability = managedResources.get(managedReference);
      if (!availability?.available) {
        const outputProfile = operator.ports.out.find((port) => port.import_param === "path")?.resource_profile;
        const detail = availability?.error
          ? `${availability.title} is not usable on this machine: ${availability.error}`
          : availability
            ? `${availability.title} is configured in this workflow but has not been downloaded and verified on this machine.`
            : "This workflow uses a managed scientific resource that is not known on this machine.";
        items.push({
          id: `managed-reference:${node.id}:path`,
          node_id: node.id,
          operator_id: node.operator,
          field: "path",
          fields: [],
          title: availability?.title ?? "Managed scientific resource",
          detail,
          kind: "managed_resource",
          priority: 30 + nodePriority(nodeIndex),
          escalatable: Boolean(availability),
          resource_profile: availability?.profile ?? outputProfile ?? null,
          resolutions: availability ? [{
            id: availability.resolution,
            label: `Download and verify ${availability.title}`,
            detail: availability.detail,
            kind: "download",
            recommended: true,
            download_bytes: availability.download_bytes,
            stored_bytes: availability.stored_bytes,
            scientific_effect: availability.scientific_effect,
            source_url: availability.source_url,
          }] : [emptyResolution(
            "use-existing",
            "Reconnect resource",
            "Choose a compatible managed resource on this machine.",
            "use_existing",
            true,
          )],
          recipes: [],
        });
      }
    }

    const workflow = node.source_workflow;
    if (workflow) {
      for (const parameter of (workflow.parameters ?? []).filter((candidate) => candidate.required
        && !candidate.managed
        && candidate.default === undefined
        && !Object.hasOwn(workflow.bindings ?? {}, candidate.name))) {
        const inputMode = sourceParameterInputMode(parameter);
        const hidden = parameter.hidden ?? false;
        const editingDisabled = !workflow.capabilities.parameter_edits;
        const label = parameter.label.trim() || parameter.name;
        const described = [parameter.description ?? "", parameter.help ?? ""].find((detail) => detail.trim());
        const detail = described || `${parameter.name} is required by the pinned source workflow before it can run.`;
        items.push({
          id: `source-parameter:${node.id}:${parameter.name}`,
          node_id: node.id,
          operator_id: node.operator,
          field: parameter.name,
          fields: !hidden && !editingDisabled ? [{ name: parameter.name, label, input_mode: inputMode }] : [],
          title: editingDisabled ? `Review required source parameter ${label}` : `Set ${label}`,
          detail: editingDisabled
            ? `${label} is required, but parameter editing is disabled because Somite cannot safely represent the complete pinned source schema. This value will not be guessed or offered through a control that cannot succeed.`
            : hidden
              ? `${label} is required but hidden by the pinned source schema. Somite will not guess or silently bind it.`
              : detail,
          kind: !hidden && !editingDisabled && inputMode === "file" ? "input" : "parameter",
          priority: 10 + nodePriority(nodeIndex),
          escalatable: false,
          resource_profile: null,
          resolutions: [emptyResolution(
            "configure",
            hidden || editingDisabled ? "Source schema review required" : inputMode === "file" ? "Choose from project" : "Configure workflow",
            editingDisabled
              ? "The complete source schema is not safely editable in this release; review the exact upstream schema or use a future typed adapter."
              : hidden
                ? "The source author marked this required parameter hidden; Somite keeps it as an explicit unsupported blocker."
                : `Open ${node.id} and set ${label}.`,
            hidden || editingDisabled ? "review" : "configure",
            !hidden && !editingDisabled,
          )],
          recipes: [],
        });
      }

      for (const parameter of workflow.unsupported_required_parameters ?? []) {
        const label = parameter.label.trim() || parameter.name;
        items.push({
          id: `source-unsupported-parameter:${node.id}:${parameter.name}`,
          node_id: node.id,
          operator_id: node.operator,
          field: parameter.name,
          fields: [],
          title: `Review required source parameter ${label}`,
          detail: `${label} is required by the pinned source, but Somite cannot safely represent its schema contract: ${parameter.reason}. It remains an explicit blocker and will not be guessed.`,
          kind: "parameter",
          priority: 10 + nodePriority(nodeIndex),
          escalatable: false,
          resource_profile: null,
          resolutions: [emptyResolution(
            "review-source-schema",
            "Source schema review required",
            "Use the exact upstream schema or a future typed adapter; this release cannot bind this required value safely.",
            "review",
            false,
          )],
          recipes: [],
        });
      }

      for (const replacement of workflow.replacements ?? []) {
        const replacementOperator = catalog.get(replacement.operator)!;
        const originalCall = (workflow.invocations ?? []).find((invocation) => invocation.id === replacement.invocation_id)?.name
          ?? "the selected source call";
        const requiredInputs = replacementOperator.ports.in.filter((port) => !port.optional).map((port) => port.name);
        const outputs = replacementOperator.ports.out.map((port) => port.name);
        const pixi = (replacementOperator.pixi?.length ?? 0) === 0
          ? "no additional Pixi packages"
          : replacementOperator.pixi!.join(", ");
        items.push({
          id: `source-replacement:${node.id}:${replacement.invocation_id}`,
          node_id: node.id,
          operator_id: replacement.operator,
          field: `replacement:${replacement.invocation_id}`,
          fields: replacementOperator.ports.in.map((port) => ({ name: port.name, label: port.name, input_mode: "connection" })),
          title: `Check ${replacementOperator.title} connections`,
          detail: `${replacementOperator.title} replaces ${originalCall}. Required inputs: ${requiredInputs.length ? requiredInputs.join(", ") : "none"}. Outputs: ${outputs.length ? outputs.join(", ") : "none"}. Pixi: ${pixi}. The edit is retained; connect or confirm the uncertain source channels, then validate with representative data.`,
          kind: "adapter",
          priority: 25 + nodePriority(nodeIndex),
          escalatable: true,
          resource_profile: `variant:${replacement.operator}`,
          resolutions: [
            emptyResolution("connect", "Review connections", "Open the nested canvas and connect or confirm each replacement input and output.", "connect", true),
            emptyResolution("agent", "Ask Agent to help", "Give the Agent the retained source invocation and replacement contract so it can suggest indexing, conversion, and parameter steps.", "add_adapter", false),
          ],
          recipes: [],
        });
      }

      if (!workflow.capabilities.exact_execution) {
        items.push({
          id: `source-environment:${node.id}`,
          node_id: node.id,
          operator_id: node.operator,
          field: "execution_environment",
          fields: [],
          title: "Finish the execution environment",
          detail: "The source and parameters are pinned, but this workflow's task containers or Conda environments are not frozen on this machine yet.",
          kind: "managed_resource",
          priority: 30 + nodePriority(nodeIndex),
          escalatable: false,
          resource_profile: "source-defined-tasks",
          resolutions: [emptyResolution(
            "setup",
            "Execution adapter required",
            "This release can inspect and bind the pinned source, but cannot freeze its task environments yet.",
            "setup",
            false,
          )],
          recipes: [],
        });
      }
      continue;
    }

    if (operator.id === "gap.missing" && node.ports.length === 0) continue;

    const resolution = operator.resolution;
    if (resolution && resolutionUnresolved) {
      const contracts: Record<typeof resolution.kind, readonly [RequirementKind, ResolutionKind, string, number, boolean, RequirementInputMode]> = {
        manual_checkpoint: ["manual_checkpoint", "attach", "attach", 40, false, "file"],
        method_details: ["method_details", "review", "review", 50, true, "agent"],
        legacy_source: ["legacy_tool", "setup", "setup", 60, true, "guide"],
        adapter: ["adapter", "add_adapter", "adapter", 70, true, "agent"],
      };
      const [kind, resolutionKind, id, priority, escalatable, fallbackMode] = contracts[resolution.kind];
      const fields = missingResolutionParameters.map((parameter) => requirementField(operator, parameter, fallbackMode));
      items.push({
        id: `resolution:${node.id}:${id}`,
        node_id: node.id,
        operator_id: node.operator,
        field: fields[0]?.name ?? "operator",
        fields,
        title: resolution.title,
        detail: resolution.detail,
        kind,
        priority: priority + nodePriority(nodeIndex),
        escalatable,
        resource_profile: null,
        resolutions: [emptyResolution(id, resolution.action_label, resolution.detail, resolutionKind, true, resolution.source_url ?? null)],
        recipes: resolution.recipes.map(recipe),
      });
    } else if (!resolution && (operator.kind === "reference" || operator.id === "gap.missing")) {
      items.push({
        id: `resolution:${node.id}:adapter`,
        node_id: node.id,
        operator_id: node.operator,
        field: "operator",
        fields: [],
        title: "Add a reviewed tool contract",
        detail: "This imported workflow reference has no executable Somite contract yet.",
        kind: "adapter",
        priority: 70 + nodePriority(nodeIndex),
        escalatable: true,
        resource_profile: null,
        resolutions: [emptyResolution(
          "adapter",
          "Ask Agent to draft a contract",
          "Use the retained source and typed ports to draft a reviewed operator contract.",
          "add_adapter",
          true,
        )],
        recipes: [{
          id: "reviewed-adapter-v1",
          title: "Reviewed operator contract",
          summary: "Promote this structural reference without guessing its execution semantics.",
          version: "1",
          kind: "adapter_contract",
          steps: [
            "Locate the authoritative tool or workflow source.",
            "Record typed inputs, arguments, outputs, and a representative fixture.",
            "Replace the reference only after the contract validates.",
          ],
          parameters: [],
          source_url: null,
        }],
      });
    }

    for (const port of operator.ports.in) {
      if (port.optional || boundInputs.has(`${node.id}\0${port.name}`)) continue;
      const resource = port.resource;
      if (resource) {
        items.push({
          id: `input:${node.id}:${port.name}`,
          node_id: node.id,
          operator_id: node.operator,
          field: port.name,
          fields: [{ name: port.name, label: resource.title, input_mode: "choice" }],
          title: resource.title,
          detail: resource.detail,
          kind: "managed_resource",
          priority: 30 + nodePriority(nodeIndex),
          escalatable: resource.resolutions.some((candidate) => candidate.scientific_effect !== undefined),
          resource_profile: resource.profile,
          resolutions: resource.resolutions.map((candidate) => ({
            id: candidate.id,
            label: candidate.label,
            detail: candidate.detail,
            kind: candidate.kind,
            recommended: candidate.recommended ?? false,
            download_bytes: candidate.download_bytes ?? null,
            stored_bytes: candidate.stored_bytes ?? null,
            scientific_effect: candidate.scientific_effect ?? null,
            source_url: candidate.source_url ?? null,
          })),
          recipes: [],
        });
      } else {
        const title = `Connect ${port.name}`;
        items.push({
          id: `input:${node.id}:${port.name}`,
          node_id: node.id,
          operator_id: node.operator,
          field: port.name,
          fields: [{ name: port.name, label: title, input_mode: "connection" }],
          title,
          detail: `${node.id}.${port.name} needs one incoming ${port.type} connection.`,
          kind: "input",
          priority: 20 + nodePriority(nodeIndex),
          escalatable: false,
          resource_profile: null,
          resolutions: [emptyResolution("connect", "Connect an input", `Choose a compatible source for ${node.id}.${port.name}.`, "connect", true)],
          recipes: [],
        });
      }
    }

    for (const [name, parameter] of Object.entries(operator.params).sort(([left], [right]) => compareText(left, right))) {
      if (!parameter.required) continue;
      if (resolution?.parameters.includes(name)) continue;
      if (configuredParameter(parameterValue(node, operator, name))) continue;
      const label = parameter.label ?? name;
      const inputMode = parameterInputMode(name, parameter, "text");
      items.push({
        id: `parameter:${node.id}:${name}`,
        node_id: node.id,
        operator_id: node.operator,
        field: name,
        fields: [{ name, label, input_mode: inputMode }],
        title: `Set ${label}`,
        detail: `${node.id}.${name} is required before this workflow can run.`,
        kind: "parameter",
        priority: 10 + nodePriority(nodeIndex),
        escalatable: false,
        resource_profile: null,
        resolutions: [emptyResolution(
          "configure",
          inputMode === "file" ? "Choose file" : "Configure the node",
          `Open ${node.id} and set ${label}.`,
          "configure",
          true,
        )],
        recipes: [],
      });
    }
  }

  items.sort((left, right) => left.priority - right.priority
    || compareText(left.node_id, right.node_id)
    || compareText(left.field, right.field)
    || compareText(left.id, right.id));
  const requiringAction = new Set(items.map((item) => item.node_id));
  for (const node of nodes) node.requires_action ||= requiringAction.has(node.node_id);
  const state: ReadinessState = graph.nodes.length === 0
    ? "empty"
    : items.length === 0
      ? "ready"
      : items.some((item) => item.kind !== "input" && item.kind !== "parameter")
        ? "needs_action"
        : "building";
  return {
    graph_revision: semanticGraphRevision(graph),
    state,
    required_count: items.length,
    items,
    nodes,
  };
}

export type { ResolutionRecipeKind };
