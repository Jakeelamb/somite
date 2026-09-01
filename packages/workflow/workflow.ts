import type {
  CanvasAnnotation,
  ParamValue,
  PortType,
  SomiteGraph,
  SomiteGraphNode,
  SomitePort,
  SourceSpan,
  SourceWorkflowInstance,
  WorkflowParameterField,
} from "./model.ts";
import { GRAPH_SCHEMA_VERSION } from "./model.ts";
import { canonicalJsonDigest, jsonDigest } from "./contentIdentity.ts";
import { validateSourceCanvasView } from "./sourceCanvas.ts";

export const MAX_EXACT_JSON_INTEGER = 9_007_199_254_740_991;
export const MAX_EXACT_JSON_INTEGER_BOUND = MAX_EXACT_JSON_INTEGER - 1;
export const MAX_GRAPH_NAME_CHARS = 100;
export const MAX_ANNOTATION_TEXT_CHARS = 5_000;
export const MAX_STROKE_POINTS = 10_000;
export const MAX_SOURCE_PATH_BYTES = 4 * 1024;
export const MAX_SOURCE_LABEL_BYTES = 4 * 1024;
export const MAX_SOURCE_PROFILES = 64;
export const MAX_SOURCE_PROFILE_BYTES = 256;
export const MAX_SOURCE_PROFILE_TOTAL_BYTES = 4 * 1024;

export type WorkflowIssueCode =
  | "schema"
  | "invalid_graph_name"
  | "unpinned_operator"
  | "duplicate_id"
  | "unknown_node"
  | "unknown_port"
  | "direction"
  | "type"
  | "cycle"
  | "self_edge"
  | "multiple_inputs"
  | "invalid_annotation"
  | "invalid_source_workflow"
  | "invalid_source_canvas"
  | "invalid_parameter_value"
  | "invalid_variant_origin";

export type WorkflowIssue = Readonly<{
  code: WorkflowIssueCode;
  message: string;
}>;

export type WorkflowValidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; issue: WorkflowIssue }>;

function valid(): WorkflowValidation {
  return { ok: true };
}

function invalid(code: WorkflowIssueCode, message: string): WorkflowValidation {
  return { ok: false, issue: { code, message } };
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function hasControl(value: string) {
  return /\p{Cc}/u.test(value);
}

function annotationTextIsValid(value: string) {
  return [...value].length <= MAX_ANNOTATION_TEXT_CHARS
    && ![...value].some((character) => character !== "\n" && character !== "\t" && hasControl(character));
}

function pointIsValid(point: { x: number; y: number }) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function annotationIsValid(annotation: CanvasAnnotation) {
  if (annotation.kind === "stroke") {
    return annotation.points.length >= 2
      && annotation.points.length <= MAX_STROKE_POINTS
      && annotation.points.every(pointIsValid);
  }
  return annotationTextIsValid(annotation.text)
    && pointIsValid(annotation.layout)
    && Number.isFinite(annotation.width)
    && Number.isFinite(annotation.height)
    && annotation.width >= 80
    && annotation.height >= 60
    && annotation.width <= 4_000
    && annotation.height <= 4_000;
}

export function compatiblePortTypes(source: PortType, target: PortType, targetUnion: readonly PortType[] = []) {
  return source === target || targetUnion.includes(source);
}

function port(node: SomiteGraphNode, name: string, direction: "in" | "out"): SomitePort | undefined {
  return node.ports.find((candidate) => candidate.name === name && candidate.dir === direction);
}

function parameterValueIsTransportStable(value: ParamValue) {
  if (typeof value !== "number") return typeof value === "string" || typeof value === "boolean";
  if (!Number.isFinite(value) || Object.is(value, -0)) return false;
  return !Number.isInteger(value) || Number.isSafeInteger(value);
}

function hasCycle(graph: Pick<SomiteGraph, "nodes" | "edges">) {
  const adjacent = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of graph.nodes) {
    adjacent.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    const targets = adjacent.get(edge.from_node) ?? [];
    targets.push(edge.to_node);
    adjacent.set(edge.from_node, targets);
    indegree.set(edge.to_node, (indegree.get(edge.to_node) ?? 0) + 1);
  }
  const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const current = queue.shift()!;
    seen += 1;
    for (const target of adjacent.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return seen !== graph.nodes.length;
}

export function topologicalOrder(graph: Pick<SomiteGraph, "nodes" | "edges">) {
  const adjacent = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    adjacent.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    const targets = adjacent.get(edge.from_node) ?? [];
    targets.push(edge.to_node);
    adjacent.set(edge.from_node, targets);
    indegree.set(edge.to_node, (indegree.get(edge.to_node) ?? 0) + 1);
  }
  const queue = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right));
  const ordered: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    ordered.push(current);
    const targets = [...(adjacent.get(current) ?? [])].sort((left, right) => left.localeCompare(right));
    for (const target of targets) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return ordered;
}

export function validateGraph(graph: SomiteGraph): WorkflowValidation {
  if (graph.schema_version !== GRAPH_SCHEMA_VERSION) {
    return invalid("schema", `schema_version ${graph.schema_version} != ${GRAPH_SCHEMA_VERSION}`);
  }
  if (graph.name !== undefined) {
    const trimmed = graph.name.trim();
    if (!trimmed || [...graph.name].length > MAX_GRAPH_NAME_CHARS || hasControl(graph.name)) {
      return invalid(
        "invalid_graph_name",
        `graph name must be 1 to ${MAX_GRAPH_NAME_CHARS} characters and contain no control characters`,
      );
    }
  }

  const ids = new Set<string>();
  const nodes = new Map<string, SomiteGraphNode>();
  for (const node of graph.nodes) {
    if (!node.operator_revision.trim()) {
      return invalid("unpinned_operator", `node ${node.id} does not pin an operator revision`);
    }
    if (ids.has(node.id)) return invalid("duplicate_id", `duplicate id ${node.id}`);
    ids.add(node.id);
    nodes.set(node.id, node);
    for (const [parameter, value] of Object.entries(node.params ?? {})) {
      if (!parameterValueIsTransportStable(value)) {
        return invalid(
          "invalid_parameter_value",
          `node ${node.id} parameter ${parameter} is not stable through browser JSON`,
        );
      }
    }
    if (node.source_workflow) {
      const issue = validateSourceWorkflow(node.source_workflow);
      if (issue) {
        return invalid("invalid_source_workflow", `node ${node.id} has invalid source workflow: ${issue}`);
      }
    }
    if (node.source_canvas && !node.source_workflow) {
      return invalid("invalid_source_canvas", `node ${node.id} has a source canvas without a source workflow`);
    }
    if (node.source_canvas && node.source_workflow) {
      const issue = validateSourceCanvasView(node.source_workflow, node.source_canvas);
      if (issue) {
        return invalid("invalid_source_canvas", `node ${node.id} has invalid source canvas: ${issue.message}`);
      }
    }
  }

  const boundInputs = new Set<string>();
  for (const edge of graph.edges) {
    if (ids.has(edge.id)) return invalid("duplicate_id", `duplicate id ${edge.id}`);
    ids.add(edge.id);
    if (edge.from_node === edge.to_node) return invalid("self_edge", `self-edge ${edge.id}`);
    const sourceNode = nodes.get(edge.from_node);
    if (!sourceNode) return invalid("unknown_node", `unknown node ${edge.from_node}`);
    const targetNode = nodes.get(edge.to_node);
    if (!targetNode) return invalid("unknown_node", `unknown node ${edge.to_node}`);
    const sourcePort = port(sourceNode, edge.from_port, "out");
    if (!sourcePort) return invalid("unknown_port", `unknown port ${edge.from_node}.${edge.from_port}`);
    const targetPort = port(targetNode, edge.to_port, "in");
    if (!targetPort) return invalid("unknown_port", `unknown port ${edge.to_node}.${edge.to_port}`);
    if (sourcePort.dir !== "out" || targetPort.dir !== "in") {
      return invalid("direction", `edge ${edge.id} expects out→in`);
    }
    if (!compatiblePortTypes(sourcePort.ty, targetPort.ty, targetPort.union)) {
      return invalid(
        "type",
        `type mismatch ${edge.from_node}.${edge.from_port}:${sourcePort.ty} → ${edge.to_node}.${edge.to_port}:${targetPort.ty}`,
      );
    }
    const input = `${edge.to_node}\u0000${edge.to_port}`;
    if (boundInputs.has(input)) {
      return invalid("multiple_inputs", `multiple edges target scalar input ${edge.to_node}.${edge.to_port}`);
    }
    boundInputs.add(input);
  }

  for (const annotation of graph.annotations ?? []) {
    if (ids.has(annotation.id)) return invalid("duplicate_id", `duplicate id ${annotation.id}`);
    ids.add(annotation.id);
    if (!annotationIsValid(annotation)) {
      return invalid("invalid_annotation", `invalid canvas annotation ${annotation.id}`);
    }
  }

  if (graph.variant_origin) {
    if (graph.nodes.some((node) => node.source_workflow)) {
      return invalid("invalid_variant_origin", "invalid native workflow variant origin: a native variant cannot execute source-backed Nodes");
    }
    const sourceNode = graph.variant_origin.source_node;
    if (!sourceNode.source_workflow) {
      return invalid("invalid_variant_origin", "invalid native workflow variant origin: the retained source Node has no source workflow");
    }
    if (!sourceNode.operator_revision.trim()) {
      return invalid("invalid_variant_origin", "invalid native workflow variant origin: the retained source Node has no pinned Operator revision");
    }
    const sourceIssue = validateSourceWorkflow(sourceNode.source_workflow);
    if (sourceIssue) return invalid("invalid_variant_origin", `invalid native workflow variant origin: ${sourceIssue}`);
    if (sourceNode.source_canvas) {
      const issue = validateSourceCanvasView(sourceNode.source_workflow, sourceNode.source_canvas);
      if (issue) return invalid("invalid_variant_origin", `invalid native workflow variant source canvas: ${issue.message}`);
    }
    const invocations = new Set((sourceNode.source_workflow.invocations ?? []).map((invocation) => invocation.id));
    const promotedNodes = new Set<string>();
    for (const [invocation, node] of Object.entries(graph.variant_origin.promoted_invocations ?? {})) {
      if (!invocations.has(invocation)) {
        return invalid("invalid_variant_origin", `invalid native workflow variant origin: unknown promoted source invocation ${invocation}`);
      }
      if (!nodes.has(node)) {
        return invalid("invalid_variant_origin", `invalid native workflow variant origin: promoted invocation ${invocation} references missing Node ${node}`);
      }
      if (promotedNodes.has(node)) {
        return invalid("invalid_variant_origin", `invalid native workflow variant origin: multiple source invocations map to Node ${node}`);
      }
      promotedNodes.add(node);
    }
  }

  if (hasCycle(graph)) return invalid("cycle", "cycle");
  return valid();
}

function validDigest(value: string) {
  return /^blake3:[0-9a-f]{64}$/.test(value);
}

function canonicalGitObjectId(value: string) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function safeRelativePath(value: string) {
  if (!value.trim() || utf8Bytes(value) > MAX_SOURCE_PATH_BYTES || value.includes("\\") || hasControl(value) || value.startsWith("/")) {
    return false;
  }
  const parts = value.split("/");
  return parts.some((part) => part.length > 0) && parts.every((part) => part !== ".." && part !== ".");
}

function validateSpan(span: SourceSpan) {
  return safeRelativePath(span.path) && Number.isInteger(span.start_line) && span.start_line > 0
    && Number.isInteger(span.end_line) && span.end_line >= span.start_line;
}

function schemaEqual(left: ParamValue, right: ParamValue) {
  return typeof left === "number" && typeof right === "number" ? left === right : left === right;
}

function validateParameterValue(parameter: WorkflowParameterField, value: ParamValue): string | null {
  if (!parameterValueIsTransportStable(value)) {
    return `parameter ${parameter.name} is not stable through browser JSON`;
  }
  const validType = parameter.type === "string" ? typeof value === "string"
    : parameter.type === "boolean" ? typeof value === "boolean"
      : parameter.type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
        : parameter.type === "number" ? typeof value === "number" : false;
  if (!validType) return `parameter ${parameter.name} has the wrong value type`;
  if (parameter.type === "integer" && typeof value === "number") {
    if (parameter.minimum !== undefined && value < parameter.minimum) return `parameter ${parameter.name} is outside its numeric bounds`;
    if (parameter.maximum !== undefined && value > parameter.maximum) return `parameter ${parameter.name} is outside its numeric bounds`;
  }
  if (parameter.type === "number" && typeof value === "number") {
    if (!Number.isFinite(value)
      || (parameter.minimum !== undefined && value < parameter.minimum)
      || (parameter.maximum !== undefined && value > parameter.maximum)) {
      return `parameter ${parameter.name} is outside its numeric bounds`;
    }
  }
  if ((parameter.choices?.length ?? 0) > 0 && !parameter.choices!.some((choice) => schemaEqual(choice, value))) {
    return `parameter ${parameter.name} is not an allowed choice`;
  }
  if (parameter.pattern && typeof value === "string") {
    if (![...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code <= 126;
    })) return `parameter ${parameter.name} violates its string pattern`;
    try {
      if (!new RegExp(parameter.pattern).test(value)) return `parameter ${parameter.name} violates its string pattern`;
    } catch {
      return `parameter ${parameter.name} has an invalid string pattern`;
    }
  }
  return null;
}

function validatePathChoice(parameter: WorkflowParameterField, path: string) {
  if ((parameter.choices?.length ?? 0) > 0
    && !parameter.choices!.some((choice) => typeof choice === "string" && choice === path)) {
    return `parameter ${parameter.name} is not an allowed path choice`;
  }
  return null;
}

export function validateSourceWorkflow(workflow: SourceWorkflowInstance): string | null {
  if (workflow.schema_version !== 1) return `schema_version ${workflow.schema_version} != 1`;
  if (!validDigest(workflow.workflow_revision) || !validDigest(workflow.source.source_digest)) {
    return "workflow and source revisions must be full blake3 digests";
  }
  for (const [field, value] of [
    ["repository", workflow.source.repository],
    ["requested_revision", workflow.source.requested_revision],
    ["resolved_revision", workflow.source.resolved_revision],
  ] as const) {
    if (!value.trim() || hasControl(value) || utf8Bytes(value) > MAX_SOURCE_LABEL_BYTES) {
      return `${field} must be bounded, non-empty, and contain no control characters`;
    }
  }
  if ((workflow.source.provider === "nf_core" || workflow.source.provider === "github")
    && !canonicalGitObjectId(workflow.source.resolved_revision)) {
    return `${workflow.source.provider === "nf_core" ? "nf-core" : "GitHub"} resolved_revision must be a canonical lowercase full Git object ID`;
  }
  if (workflow.source.provider === "local"
    && workflow.source.resolved_revision !== workflow.source.source_digest.slice("blake3:".length)) {
    return "local resolved_revision must equal the exact frozen source BLAKE3 identity";
  }
  if (!safeRelativePath(workflow.source.entrypoint)) return "entrypoint must be a safe relative path";
  if (!Number.isInteger(workflow.source.file_count) || workflow.source.file_count <= 0
    || !Number.isSafeInteger(workflow.source.source_bytes) || workflow.source.source_bytes <= 0) {
    return "source manifest must contain at least one non-empty file";
  }

  const profiles = workflow.profiles ?? [];
  const profileBytes = profiles.reduce((total, profile) => total + utf8Bytes(profile), 0);
  if (profiles.length > MAX_SOURCE_PROFILES || profileBytes > MAX_SOURCE_PROFILE_TOTAL_BYTES
    || profiles.some((profile) => !profile.trim() || hasControl(profile) || utf8Bytes(profile) > MAX_SOURCE_PROFILE_BYTES)) {
    return "profiles must be bounded, non-empty, and contain no control characters";
  }

  const parameters = workflow.parameters ?? [];
  const parameterNames = new Set<string>();
  for (const parameter of parameters) {
    if (!parameter.name.trim() || hasControl(parameter.name) || parameterNames.has(parameter.name)) {
      return "parameter names must be unique, non-empty, and printable";
    }
    parameterNames.add(parameter.name);
    if (parameter.pattern !== undefined) {
      if (parameter.type !== "string" || hasControl(parameter.pattern)) return `parameter ${parameter.name} has an invalid string pattern`;
      try {
        new RegExp(parameter.pattern);
      } catch {
        return `parameter ${parameter.name} has an invalid string pattern`;
      }
    }
    const bounds = [parameter.minimum, parameter.maximum].filter((value): value is number => value !== undefined);
    if (bounds.some((bound) => !Number.isFinite(bound) || Object.is(bound, -0)
      || bound < -MAX_EXACT_JSON_INTEGER_BOUND || bound > MAX_EXACT_JSON_INTEGER_BOUND)
      || (parameter.minimum !== undefined && parameter.maximum !== undefined && parameter.minimum > parameter.maximum)) {
      return `parameter ${parameter.name} has invalid numeric bounds`;
    }
    if (parameter.type === "integer" && bounds.some((bound) => !Number.isSafeInteger(bound))) {
      return `integer parameter ${parameter.name} has a bound outside the exact JSON integer domain`;
    }
    const pathParameter = parameter.format === "file-path" || parameter.format === "directory-path" || parameter.format === "path";
    if (parameter.default !== undefined) {
      if (pathParameter && (typeof parameter.default !== "string" || !safeRelativePath(parameter.default))) {
        return `parameter ${parameter.name} has an unsafe project path default`;
      }
      const issue = validateParameterValue(parameter, parameter.default);
      if (issue) return issue;
    }
    for (const choice of parameter.choices ?? []) {
      if (pathParameter && (typeof choice !== "string" || !safeRelativePath(choice))) {
        return `parameter ${parameter.name} has an unsafe project path choice`;
      }
      const issue = validateParameterValue(parameter, choice);
      if (issue) return issue;
    }
  }

  const unsupportedNames = new Set<string>();
  for (const parameter of workflow.unsupported_required_parameters ?? []) {
    if (!parameter.name.trim() || hasControl(parameter.name)
      || !parameter.label.trim() || hasControl(parameter.label)
      || !parameter.group.trim() || hasControl(parameter.group)
      || !parameter.reason.trim() || hasControl(parameter.reason)
      || unsupportedNames.has(parameter.name) || parameterNames.has(parameter.name)) {
      return "unsupported required parameter contracts must be unique, non-empty, printable, and distinct from editable parameters";
    }
    unsupportedNames.add(parameter.name);
  }

  for (const [name, binding] of Object.entries(workflow.bindings ?? {})) {
    const parameter = parameters.find((candidate) => candidate.name === name);
    if (!parameter) return `binding ${name} has no parameter contract`;
    if (binding.kind === "project_file") {
      if (parameter.type !== "string" || (parameter.format !== "file-path" && parameter.format !== "path")) {
        return `binding ${name} is not declared as a file path`;
      }
      if (!safeRelativePath(binding.path)) return `binding ${name} has an invalid project file path`;
      const issue = validatePathChoice(parameter, binding.path);
      if (issue) return issue;
    } else if (binding.kind === "project_directory") {
      if (parameter.type !== "string" || (parameter.format !== "directory-path" && parameter.format !== "path")) {
        return `binding ${name} is not declared as a directory path`;
      }
      if (!safeRelativePath(binding.path)) return `binding ${name} has an invalid project directory path`;
      const issue = validatePathChoice(parameter, binding.path);
      if (issue) return issue;
    } else {
      if (parameter.format === "file-path" || parameter.format === "directory-path" || parameter.format === "path") {
        return `binding ${name} requires an explicit project path binding`;
      }
      const issue = validateParameterValue(parameter, binding.value);
      if (issue) return issue;
    }
  }

  const scopes = workflow.scopes ?? [];
  const scopeIds = new Set<string>();
  for (const scope of scopes) {
    if (!scope.id.trim() || scopeIds.has(scope.id)) return "scope ids must be unique and non-empty";
    scopeIds.add(scope.id);
    if (!validateSpan(scope.span)) return "source spans require a safe path and ordered one-based lines";
  }
  const invocationIds = new Set<string>();
  for (const invocation of workflow.invocations ?? []) {
    if (!invocation.id.trim() || invocationIds.has(invocation.id)) return "invocation ids must be unique and non-empty";
    invocationIds.add(invocation.id);
    if (!scopeIds.has(invocation.caller)) return `invocation ${invocation.id} has an unknown caller`;
    if (invocation.callee !== undefined && !scopeIds.has(invocation.callee)) return `invocation ${invocation.id} has an unknown callee`;
    if (!validateSpan(invocation.span)) return "source spans require a safe path and ordered one-based lines";
  }
  const replacements = new Set<string>();
  for (const replacement of workflow.replacements ?? []) {
    if (!invocationIds.has(replacement.invocation_id)) return `replacement has unknown invocation ${replacement.invocation_id}`;
    if (replacements.has(replacement.invocation_id)) return `invocation ${replacement.invocation_id} has more than one replacement`;
    replacements.add(replacement.invocation_id);
    if (!replacement.operator.trim() || utf8Bytes(replacement.operator) > MAX_SOURCE_LABEL_BYTES
      || hasControl(replacement.operator) || !validDigest(replacement.operator_revision)
      || Object.entries(replacement.params ?? {}).some(([name, value]) => !name.trim() || hasControl(name) || !parameterValueIsTransportStable(value))) {
      return `replacement for ${replacement.invocation_id} has an invalid operator contract`;
    }
  }
  return null;
}

function semanticGraphMaterial(graph: SomiteGraph) {
  return {
    schema_version: graph.schema_version,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      operator: node.operator,
      operator_revision: node.operator_revision,
      ports: node.ports.map((port) => ({
        name: port.name,
        dir: port.dir,
        ty: port.ty,
        ...(port.union?.length ? { union: port.union } : {}),
        ...(port.optional ? { optional: true } : {}),
      })),
      params: Object.fromEntries(Object.entries(node.params ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      source_workflow: node.source_workflow ? {
        schema_version: node.source_workflow.schema_version,
        workflow_revision: node.source_workflow.workflow_revision,
        source: {
          provider: node.source_workflow.source.provider,
          repository: node.source_workflow.source.repository,
          requested_revision: node.source_workflow.source.requested_revision,
          resolved_revision: node.source_workflow.source.resolved_revision,
          source_digest: node.source_workflow.source.source_digest,
          entrypoint: node.source_workflow.source.entrypoint,
          file_count: node.source_workflow.source.file_count,
          source_bytes: node.source_workflow.source.source_bytes,
        },
        profiles: node.source_workflow.profiles ?? [],
        bindings: Object.fromEntries(Object.entries(node.source_workflow.bindings ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      } : null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...graph.edges]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => ({
        id: edge.id,
        from_node: edge.from_node,
        from_port: edge.from_port,
        to_node: edge.to_node,
        to_port: edge.to_port,
      })),
  };
}

export function semanticGraphKey(graph: SomiteGraph) {
  return JSON.stringify(semanticGraphMaterial(graph));
}

/** Stable executable graph identity locked by the shared parity fixtures. */
export function semanticGraphRevision(graph: SomiteGraph) {
  return jsonDigest(semanticGraphMaterial(graph));
}

/** Full editable canvas identity for compare-and-swap persistence. */
export function graphStateRevision(graph: SomiteGraph) {
  const validation = validateGraph(graph);
  if (!validation.ok) throw new Error(`invalid graph: ${validation.issue.message}`);
  return canonicalJsonDigest(graph);
}
