import type {
  CanvasPoint,
  SourceCanvasGroup,
  SourceCanvasView,
  SourceInvocation,
  SourceInvocationReplacement,
  SourceScope,
  SourceSpan,
  SourceWorkflowInstance,
} from "./model.ts";

const MAX_SOURCE_CANVAS_ENTITIES = 100_000;
const MAX_SOURCE_CANVAS_RELATIONS = 200_000;
const MAX_SOURCE_CANVAS_GROUPS = 100_000;
const MAX_MOVE_HISTORY_ENTRIES = 200_000;
const MAX_GROUP_ID_BYTES = 200;
const MAX_GROUP_TITLE_BYTES = 400;
const MAX_CANVAS_COORDINATE = 1_000_000;
const ENTITY_WIDTH = 220;
const ENTITY_HEIGHT = 88;
const PORTAL_WIDTH = 300;
const PORTAL_HEIGHT = 200;
const COLUMN_GAP = 60;
const ROW_GAP = 62;
const HULL_PADDING = 32;
const HULL_HEADER = 36;
const BOUNDARY_GAP = 80;
const UTF8_ENCODER = new TextEncoder();

export type SourceCanvasEdit =
  | Readonly<{
      kind: "group_selection";
      group_id: string;
      title: string;
      entity_ids?: readonly string[];
      relationship_ids?: readonly string[];
      parent_group_id?: string | null;
      collapsed?: boolean;
    }>
  | Readonly<{ kind: "set_collapsed"; group_id: string; collapsed: boolean }>
  | Readonly<{ kind: "rename_group"; group_id: string; title: string }>
  | Readonly<{ kind: "move_out"; id: string }>
  | Readonly<{ kind: "move_back"; id: string }>
  | Readonly<{ kind: "move_into"; id: string; target_group_id: string }>
  | Readonly<{ kind: "dissolve_group"; group_id: string }>
  | Readonly<{
      kind: "set_positions";
      positions: readonly Readonly<{ id: string; x: number; y: number }>[];
    }>;

export type SourceCanvasBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type SourceCanvasCalleeDefinition = Readonly<{
  scope_id: string;
  title: string;
  symbol?: string;
  kind: SourceScope["kind"];
  span: SourceSpan;
}>;

export type SourceCanvasEntity = Readonly<{
  id: string;
  kind: "call";
  title: string;
  invocation_id: string;
  invocation_name: string;
  caller_scope_id: string;
  callee_scope_id?: string;
  callee_definition?: SourceCanvasCalleeDefinition;
  replacement?: SourceInvocationReplacement;
  span: SourceSpan;
  direct_group_id: string | null;
  position: CanvasPoint;
  bounds: SourceCanvasBounds;
}>;

export type SourceCanvasRelationMember = Readonly<{
  id: string;
  original_from: string;
  original_to: string;
  span: SourceSpan;
}>;

export type SourceCanvasRelation = Readonly<{
  id: string;
  kind: "source_structure" | "source_reference";
  executable: false;
  from: string;
  to: string;
  original_from: string;
  original_to: string;
  proxied: boolean;
  span: SourceSpan;
  member_count: number;
  members: readonly SourceCanvasRelationMember[];
}>;

export type SourceCanvasGroupProjection = Readonly<{
  id: string;
  title: string;
  parent_group_id: string | null;
  collapsed: false;
  direct_entity_count: number;
  descendant_entity_count: number;
  bounds: SourceCanvasBounds;
}>;

export type SourceCanvasPortal =
  | Readonly<{
      id: string;
      kind: "collapsed_group";
      group_id: string;
      title: string;
      direct_entity_count: number;
      descendant_entity_count: number;
      hidden_relation_count: number;
      hidden_relationship_ids: readonly string[];
      position: CanvasPoint;
      bounds: SourceCanvasBounds;
    }>
  | Readonly<{
      id: string;
      kind: "boundary";
      group_id: string;
      direction: "in" | "out";
      title: string;
      relation_count: number;
      position: CanvasPoint;
      bounds: SourceCanvasBounds;
    }>;

export type SourceCanvasBreadcrumb = Readonly<{ id: string; title: string }>;

export type SourceCanvasGroupSuggestion = Readonly<{
  id: string;
  title: string;
  source_scope_id: string;
  direct_entity_ids: readonly string[];
}>;

export type SourceCanvasProjection = Readonly<{
  view: SourceCanvasView;
  focus_group_id: string | null;
  breadcrumbs: readonly SourceCanvasBreadcrumb[];
  entities: readonly SourceCanvasEntity[];
  groups: readonly SourceCanvasGroupProjection[];
  portals: readonly SourceCanvasPortal[];
  relations: readonly SourceCanvasRelation[];
  suggestions: readonly SourceCanvasGroupSuggestion[];
}>;

export type SourceCanvasError = Readonly<{
  code:
    | "invalid_workflow"
    | "invalid_view"
    | "stale_view"
    | "unknown_entity"
    | "unknown_relation"
    | "unknown_group"
    | "unknown_focus"
    | "duplicate_id"
    | "group_cycle"
    | "mixed_parent_selection"
    | "already_top_level"
    | "not_moved"
    | "invalid_move"
    | "projection_limit";
  message: string;
  id?: string;
}>;

export type SourceCanvasResult =
  | Readonly<{ ok: true; projection: SourceCanvasProjection }>
  | Readonly<{ ok: false; error: SourceCanvasError }>;

type CanonicalEntity = Readonly<{
  id: string;
  title: string;
  invocation: SourceInvocation;
  callee?: SourceScope;
  replacement?: SourceInvocationReplacement;
}>;

type CanonicalRelation = Readonly<{
  id: string;
  kind: "source_structure" | "source_reference";
  from: string;
  to: string;
  span: SourceSpan;
}>;

type CanonicalCanvas = Readonly<{
  entities: ReadonlyMap<string, CanonicalEntity>;
  entity_ids: readonly string[];
  relations: readonly CanonicalRelation[];
  relation_by_id: ReadonlyMap<string, CanonicalRelation>;
  default_positions: ReadonlyMap<string, CanvasPoint>;
  suggestions: readonly SourceCanvasGroupSuggestion[];
}>;

type PreparedView = Readonly<{
  view: SourceCanvasView;
  groups: ReadonlyMap<string, SourceCanvasGroup>;
  group_children: ReadonlyMap<string, readonly string[]>;
  group_order: readonly string[];
  entity_group: ReadonlyMap<string, string>;
}>;

type MutableBounds = { x1: number; y1: number; x2: number; y2: number };

type CanonicalCacheEntry = Readonly<{
  scopes: SourceWorkflowInstance["scopes"];
  invocations: SourceWorkflowInstance["invocations"];
  replacements: SourceWorkflowInstance["replacements"];
  canvas: CanonicalCanvas | SourceCanvasError;
}>;

const canonicalCache = new WeakMap<Readonly<SourceWorkflowInstance>, CanonicalCacheEntry>();

function error(code: SourceCanvasError["code"], message: string, id?: string): SourceCanvasError {
  return { code, message, ...(id ? { id } : {}) };
}

function hasControl(value: string) {
  return /\p{Cc}/u.test(value);
}

function utf8Bytes(value: string) {
  return UTF8_ENCODER.encode(value).byteLength;
}

function groupIdIsValid(value: string) {
  if (!value.trim() || value.trim() !== value || utf8Bytes(value) > MAX_GROUP_ID_BYTES || hasControl(value)) return false;
  return !["call:", "boundary:", "hull:", "relation:", "aggregate:", "scope-suggestion:", "portal:"]
    .some((prefix) => value.startsWith(prefix));
}

function groupTitleIsValid(value: string) {
  return Boolean(value.trim()) && utf8Bytes(value) <= MAX_GROUP_TITLE_BYTES && !hasControl(value);
}

function coordinateIsValid(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_CANVAS_COORDINATE;
}

function clampCoordinate(value: number) {
  return Math.max(-MAX_CANVAS_COORDINATE, Math.min(MAX_CANVAS_COORDINATE, value));
}

function copySpan(span: SourceSpan): SourceSpan {
  return { path: span.path, start_line: span.start_line, end_line: span.end_line };
}

function copyReplacement(replacement: SourceInvocationReplacement): SourceInvocationReplacement {
  return {
    invocation_id: replacement.invocation_id,
    operator: replacement.operator,
    operator_revision: replacement.operator_revision,
    ...(replacement.params ? { params: { ...replacement.params } } : {}),
  };
}

function includeBounds(target: MutableBounds | undefined, bounds: SourceCanvasBounds): MutableBounds {
  if (!target) {
    return { x1: bounds.x, y1: bounds.y, x2: bounds.x + bounds.width, y2: bounds.y + bounds.height };
  }
  target.x1 = Math.min(target.x1, bounds.x);
  target.y1 = Math.min(target.y1, bounds.y);
  target.x2 = Math.max(target.x2, bounds.x + bounds.width);
  target.y2 = Math.max(target.y2, bounds.y + bounds.height);
  return target;
}

function paddedBounds(bounds: MutableBounds): SourceCanvasBounds {
  return {
    x: bounds.x1 - HULL_PADDING,
    y: bounds.y1 - HULL_PADDING - HULL_HEADER,
    width: bounds.x2 - bounds.x1 + HULL_PADDING * 2,
    height: bounds.y2 - bounds.y1 + HULL_PADDING * 2 + HULL_HEADER,
  };
}

function canonicalCanvas(workflow: Readonly<SourceWorkflowInstance>): CanonicalCanvas | SourceCanvasError {
  const scopes = workflow.scopes ?? [];
  const invocations = workflow.invocations ?? [];
  if (invocations.length > MAX_SOURCE_CANVAS_ENTITIES) {
    return error("projection_limit", `source canvas exceeds ${MAX_SOURCE_CANVAS_ENTITIES} calls`);
  }

  const scopeMap = new Map<string, SourceScope>();
  for (const scope of scopes) {
    if (!scope.id || scopeMap.has(scope.id)) {
      return error("invalid_workflow", `duplicate or empty source scope ${scope.id}`, scope.id);
    }
    scopeMap.set(scope.id, scope);
  }

  const replacementMap = new Map<string, SourceInvocationReplacement>();
  for (const replacement of workflow.replacements ?? []) replacementMap.set(replacement.invocation_id, replacement);

  const entities = new Map<string, CanonicalEntity>();
  const entityIds: string[] = [];
  const inboundByScope = new Map<string, string[]>();
  const entitiesByCaller = new Map<string, string[]>();
  for (const invocation of invocations) {
    if (!invocation.id) return error("invalid_workflow", "source invocation ids must be non-empty");
    const id = `call:${invocation.id}`;
    if (entities.has(id)) return error("invalid_workflow", `duplicate source invocation ${invocation.id}`, id);
    if (!scopeMap.has(invocation.caller)) {
      return error("invalid_workflow", `source invocation ${invocation.id} has unknown caller ${invocation.caller}`, id);
    }
    const callee = invocation.callee ? scopeMap.get(invocation.callee) : undefined;
    if (invocation.callee && !callee) {
      return error("invalid_workflow", `source invocation ${invocation.id} has unknown callee ${invocation.callee}`, id);
    }
    entities.set(id, {
      id,
      title: invocation.name,
      invocation,
      ...(callee ? { callee } : {}),
      ...(replacementMap.get(invocation.id) ? { replacement: replacementMap.get(invocation.id) } : {}),
    });
    entityIds.push(id);
    let callerEntities = entitiesByCaller.get(invocation.caller);
    if (!callerEntities) {
      callerEntities = [];
      entitiesByCaller.set(invocation.caller, callerEntities);
    }
    callerEntities.push(id);
    if (invocation.callee) {
      let inbound = inboundByScope.get(invocation.callee);
      if (!inbound) {
        inbound = [];
        inboundByScope.set(invocation.callee, inbound);
      }
      inbound.push(id);
    }
  }

  const relations: CanonicalRelation[] = [];
  const relationById = new Map<string, CanonicalRelation>();
  for (const childId of entityIds) {
    const child = entities.get(childId)!;
    const parents = inboundByScope.get(child.invocation.caller) ?? [];
    const kind = parents.length > 1 ? "source_reference" as const : "source_structure" as const;
    for (const parentId of parents) {
      const relation: CanonicalRelation = {
        id: `relation:${encodeURIComponent(entities.get(parentId)!.invocation.id)}:${encodeURIComponent(child.invocation.id)}`,
        kind,
        from: parentId,
        to: childId,
        span: copySpan(child.invocation.span),
      };
      if (relationById.has(relation.id)) {
        return error("invalid_workflow", `duplicate source relationship ${relation.id}`, relation.id);
      }
      relationById.set(relation.id, relation);
      relations.push(relation);
      if (relations.length > MAX_SOURCE_CANVAS_RELATIONS) {
        return error("projection_limit", `source canvas exceeds ${MAX_SOURCE_CANVAS_RELATIONS} source relationships`);
      }
    }
  }

  const suggestions: SourceCanvasGroupSuggestion[] = [];
  for (const scope of scopes) {
    const direct = entitiesByCaller.get(scope.id);
    if (!direct || direct.length < 2) continue;
    suggestions.push({
      id: `scope-suggestion:${scope.id}`,
      title: scope.title || scope.symbol || scope.id,
      source_scope_id: scope.id,
      direct_entity_ids: direct.slice(),
    });
  }

  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const rank = new Map<string, number>();
  for (const id of entityIds) {
    adjacency.set(id, []);
    indegree.set(id, 0);
    rank.set(id, 0);
  }
  for (const relation of relations) {
    adjacency.get(relation.from)!.push(relation.to);
    indegree.set(relation.to, (indegree.get(relation.to) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const id of entityIds) if (indegree.get(id) === 0) queue.push(id);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor]!;
    const sourceRank = rank.get(id) ?? 0;
    for (const target of adjacency.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, sourceRank + 1));
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  const rows = new Map<number, number>();
  const defaultPositions = new Map<string, CanvasPoint>();
  for (const id of entityIds) {
    const column = rank.get(id) ?? 0;
    const row = rows.get(column) ?? 0;
    defaultPositions.set(id, {
      x: column * (ENTITY_WIDTH + COLUMN_GAP),
      y: row * (ENTITY_HEIGHT + ROW_GAP),
    });
    rows.set(column, row + 1);
  }

  return {
    entities,
    entity_ids: entityIds,
    relations,
    relation_by_id: relationById,
    default_positions: defaultPositions,
    suggestions,
  };
}

function cachedCanonicalCanvas(workflow: Readonly<SourceWorkflowInstance>) {
  const cached = canonicalCache.get(workflow);
  if (cached
    && cached.scopes === workflow.scopes
    && cached.invocations === workflow.invocations
    && cached.replacements === workflow.replacements) return cached.canvas;
  const canvas = canonicalCanvas(workflow);
  canonicalCache.set(workflow, {
    scopes: workflow.scopes,
    invocations: workflow.invocations,
    replacements: workflow.replacements,
    canvas,
  });
  return canvas;
}

function normalizedView(
  workflow: Readonly<SourceWorkflowInstance>,
  canonical: CanonicalCanvas,
  view?: Readonly<SourceCanvasView>,
): PreparedView | SourceCanvasError {
  const sourceDigest = workflow.source.source_digest;
  const input = view ?? { schema_version: 2 as const, source_digest: sourceDigest };
  if (input.schema_version !== 2) {
    return error("invalid_view", `source canvas schema_version ${input.schema_version} != 2`);
  }
  if (input.source_digest !== sourceDigest) {
    return error("stale_view", "source canvas digest does not match its source workflow");
  }
  const inputGroups = input.groups ?? [];
  if (inputGroups.length > MAX_SOURCE_CANVAS_GROUPS) {
    return error("projection_limit", `source canvas exceeds ${MAX_SOURCE_CANVAS_GROUPS} user groups`);
  }

  const groups = new Map<string, SourceCanvasGroup>();
  const normalizedGroups: SourceCanvasGroup[] = [];
  for (const group of inputGroups) {
    if (!groupIdIsValid(group.id)) {
      return error("invalid_view", `source group id ${group.id} is invalid or uses a reserved namespace`, group.id);
    }
    if (groups.has(group.id) || canonical.entities.has(group.id)) {
      return error("duplicate_id", `duplicate or entity-conflicting source group id ${group.id}`, group.id);
    }
    if (!groupTitleIsValid(group.title)) {
      return error("invalid_view", `source group ${group.id} has an invalid title`, group.id);
    }
    const directEntityIds: string[] = [];
    const localEntities = new Set<string>();
    for (const entityId of group.direct_entity_ids) {
      if (!canonical.entities.has(entityId)) {
        return error("unknown_entity", `source group ${group.id} references unknown entity ${entityId}`, entityId);
      }
      if (localEntities.has(entityId)) {
        return error("duplicate_id", `source group ${group.id} contains duplicate entity ${entityId}`, entityId);
      }
      localEntities.add(entityId);
      directEntityIds.push(entityId);
    }
    const normalized: SourceCanvasGroup = {
      id: group.id,
      title: group.title,
      parent_group_id: group.parent_group_id,
      direct_entity_ids: directEntityIds,
      collapsed: group.collapsed,
    };
    groups.set(normalized.id, normalized);
    normalizedGroups.push(normalized);
  }

  const groupChildren = new Map<string, string[]>();
  const roots: string[] = [];
  for (const group of normalizedGroups) {
    if (group.parent_group_id === null) {
      roots.push(group.id);
      continue;
    }
    if (!groups.has(group.parent_group_id)) {
      return error("unknown_group", `source group ${group.id} has unknown parent ${group.parent_group_id}`, group.parent_group_id);
    }
    let children = groupChildren.get(group.parent_group_id);
    if (!children) {
      children = [];
      groupChildren.set(group.parent_group_id, children);
    }
    children.push(group.id);
  }

  const groupOrder: string[] = [];
  const groupQueue = roots.slice();
  for (let cursor = 0; cursor < groupQueue.length; cursor += 1) {
    const groupId = groupQueue[cursor]!;
    groupOrder.push(groupId);
    for (const child of groupChildren.get(groupId) ?? []) groupQueue.push(child);
  }
  if (groupOrder.length !== normalizedGroups.length) {
    return error("group_cycle", "source canvas group parents contain a cycle");
  }

  const entityGroup = new Map<string, string>();
  for (const group of normalizedGroups) {
    for (const entityId of group.direct_entity_ids) {
      const previous = entityGroup.get(entityId);
      if (previous) {
        return error("duplicate_id", `source entity ${entityId} belongs directly to both ${previous} and ${group.id}`, entityId);
      }
      entityGroup.set(entityId, group.id);
    }
    if (!group.direct_entity_ids.length && !(groupChildren.get(group.id)?.length)) {
      return error("invalid_view", `source group ${group.id} is empty`, group.id);
    }
  }

  const normalizedPositions: Record<string, CanvasPoint> = {};
  for (const [entityId, position] of Object.entries(input.positions ?? {})) {
    if (!canonical.entities.has(entityId)) {
      return error("unknown_entity", `source canvas position references unknown entity ${entityId}`, entityId);
    }
    if (!coordinateIsValid(position.x) || !coordinateIsValid(position.y)) {
      return error("invalid_view", `source canvas position for ${entityId} is outside the finite canvas`, entityId);
    }
    normalizedPositions[entityId] = { x: position.x, y: position.y };
  }

  const normalizedMoveHistoryEntries: Array<[string, string[]]> = [];
  let moveHistoryEntries = 0;
  for (const [itemId, path] of Object.entries(input.move_history ?? {})) {
    if (!canonical.entities.has(itemId) && !groups.has(itemId)) {
      return error("invalid_view", `source canvas move history references unknown item ${itemId}`, itemId);
    }
    if (!path.length) return error("invalid_view", `source canvas move history for ${itemId} is empty`, itemId);
    const copied: string[] = [];
    for (const groupId of path) {
      if (!groups.has(groupId)) {
        return error("unknown_group", `source canvas move history for ${itemId} references unknown group ${groupId}`, groupId);
      }
      copied.push(groupId);
      moveHistoryEntries += 1;
      if (moveHistoryEntries > MAX_MOVE_HISTORY_ENTRIES) {
        return error("projection_limit", `source canvas exceeds ${MAX_MOVE_HISTORY_ENTRIES} move-history entries`);
      }
    }
    normalizedMoveHistoryEntries.push([itemId, copied]);
  }
  const normalizedMoveHistory = Object.fromEntries(normalizedMoveHistoryEntries);

  const normalized: SourceCanvasView = {
    schema_version: 2,
    source_digest: sourceDigest,
    ...(normalizedGroups.length ? { groups: normalizedGroups } : {}),
    ...(Object.keys(normalizedPositions).length ? { positions: normalizedPositions } : {}),
    ...(Object.keys(normalizedMoveHistory).length ? { move_history: normalizedMoveHistory } : {}),
  };
  return { view: normalized, groups, group_children: groupChildren, group_order: groupOrder, entity_group: entityGroup };
}

function entityPosition(canonical: CanonicalCanvas, prepared: PreparedView, id: string) {
  return prepared.view.positions?.[id] ?? canonical.default_positions.get(id)!;
}

function itemParent(prepared: PreparedView, canonical: CanonicalCanvas, id: string): string | null | undefined {
  if (canonical.entities.has(id)) return prepared.entity_group.get(id) ?? null;
  return prepared.groups.get(id)?.parent_group_id;
}

function cloneView(prepared: PreparedView): SourceCanvasView {
  const groups = prepared.view.groups?.map((group) => ({
    id: group.id,
    title: group.title,
    parent_group_id: group.parent_group_id,
    direct_entity_ids: group.direct_entity_ids.slice(),
    collapsed: group.collapsed,
  }));
  const positions = prepared.view.positions
    ? Object.fromEntries(Object.entries(prepared.view.positions).map(([id, position]) => [id, { x: position.x, y: position.y }]))
    : undefined;
  const moveHistory = prepared.view.move_history
    ? Object.fromEntries(Object.entries(prepared.view.move_history).map(([id, path]) => [id, path.slice()]))
    : undefined;
  return {
    schema_version: 2,
    source_digest: prepared.view.source_digest,
    ...(groups?.length ? { groups } : {}),
    ...(positions && Object.keys(positions).length ? { positions } : {}),
    ...(moveHistory && Object.keys(moveHistory).length ? { move_history: moveHistory } : {}),
  };
}

function mutableGroup(view: SourceCanvasView, groupId: string) {
  return view.groups?.find((group) => group.id === groupId);
}

function removeDirectEntity(group: SourceCanvasGroup, entityId: string) {
  const index = group.direct_entity_ids.indexOf(entityId);
  if (index >= 0) group.direct_entity_ids.splice(index, 1);
}

function addDirectEntity(group: SourceCanvasGroup, entityId: string) {
  if (!group.direct_entity_ids.includes(entityId)) group.direct_entity_ids.push(entityId);
}

function clearMoveHistory(view: SourceCanvasView, id: string) {
  if (!view.move_history) return;
  delete view.move_history[id];
  if (!Object.keys(view.move_history).length) delete view.move_history;
}

function pushMoveHistory(view: SourceCanvasView, id: string, groupId: string) {
  if (!view.move_history) view.move_history = {};
  const path = Object.hasOwn(view.move_history, id) ? view.move_history[id] : undefined;
  if (path) path.push(groupId);
  else Object.defineProperty(view.move_history, id, {
    value: [groupId],
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function pruneEmptyGroups(view: SourceCanvasView) {
  const groups = view.groups ?? [];
  if (!groups.length) return;
  const byId = new Map<string, SourceCanvasGroup>();
  const childCounts = new Map<string, number>();
  for (const group of groups) {
    byId.set(group.id, group);
    childCounts.set(group.id, 0);
  }
  for (const group of groups) {
    if (group.parent_group_id) {
      childCounts.set(group.parent_group_id, (childCounts.get(group.parent_group_id) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const group of groups) {
    if (!group.direct_entity_ids.length && childCounts.get(group.id) === 0) queue.push(group.id);
  }
  const removed = new Set<string>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const groupId = queue[cursor]!;
    if (removed.has(groupId)) continue;
    const group = byId.get(groupId)!;
    if (group.direct_entity_ids.length || (childCounts.get(groupId) ?? 0) > 0) continue;
    removed.add(groupId);
    if (group.parent_group_id) {
      const remaining = (childCounts.get(group.parent_group_id) ?? 0) - 1;
      childCounts.set(group.parent_group_id, remaining);
      const parent = byId.get(group.parent_group_id);
      if (parent && !parent.direct_entity_ids.length && remaining === 0) queue.push(parent.id);
    }
  }
  if (!removed.size) return;
  view.groups = groups.filter((group) => !removed.has(group.id));
  if (!view.move_history) return;
  for (const removedId of removed) delete view.move_history[removedId];
  for (const [itemId, path] of Object.entries(view.move_history)) {
    const retained = path.filter((groupId) => !removed.has(groupId));
    if (retained.length) view.move_history[itemId] = retained;
    else delete view.move_history[itemId];
  }
  if (!Object.keys(view.move_history).length) delete view.move_history;
}

function moveItem(
  view: SourceCanvasView,
  prepared: PreparedView,
  canonical: CanonicalCanvas,
  id: string,
  targetGroupId: string | null,
) {
  const currentParent = itemParent(prepared, canonical, id);
  if (currentParent === undefined) return error("invalid_move", `unknown source canvas item ${id}`, id);
  if (targetGroupId !== null && !prepared.groups.has(targetGroupId)) {
    return error("unknown_group", `unknown target source group ${targetGroupId}`, targetGroupId);
  }
  if (currentParent === targetGroupId) return null;
  if (canonical.entities.has(id)) {
    if (currentParent) removeDirectEntity(mutableGroup(view, currentParent)!, id);
    if (targetGroupId) addDirectEntity(mutableGroup(view, targetGroupId)!, id);
    return null;
  }
  const group = mutableGroup(view, id);
  if (!group) return error("invalid_move", `unknown source canvas item ${id}`, id);
  if (targetGroupId === id) return error("group_cycle", `source group ${id} cannot contain itself`, id);
  group.parent_group_id = targetGroupId;
  return null;
}

function applyEdit(
  canonical: CanonicalCanvas,
  prepared: PreparedView,
  edit: SourceCanvasEdit,
): SourceCanvasView | SourceCanvasError {
  const next = cloneView(prepared);
  if (!next.groups) next.groups = [];

  if (edit.kind === "group_selection") {
    if (!groupIdIsValid(edit.group_id)) {
      return error("invalid_view", `source group id ${edit.group_id} is invalid or uses a reserved namespace`, edit.group_id);
    }
    if (canonical.entities.has(edit.group_id) || prepared.groups.has(edit.group_id)) {
      return error("duplicate_id", `duplicate source group id ${edit.group_id}`, edit.group_id);
    }
    if (!groupTitleIsValid(edit.title)) return error("invalid_view", `source group ${edit.group_id} has an invalid title`, edit.group_id);
    const selected = new Set<string>();
    for (const entityId of edit.entity_ids ?? []) {
      if (!canonical.entities.has(entityId)) return error("unknown_entity", `unknown source entity ${entityId}`, entityId);
      selected.add(entityId);
    }
    for (const relationId of edit.relationship_ids ?? []) {
      const relation = canonical.relation_by_id.get(relationId);
      if (!relation) return error("unknown_relation", `unknown source relationship ${relationId}`, relationId);
      selected.add(relation.from);
      selected.add(relation.to);
    }
    if (!selected.size) return error("invalid_view", "a source group requires at least one selected entity");

    const ordered: string[] = [];
    const directlySelected = new Map<string, number>();
    let rootSelected = 0;
    for (const entityId of canonical.entity_ids) {
      if (!selected.has(entityId)) continue;
      const entityParent = prepared.entity_group.get(entityId) ?? null;
      if (entityParent) directlySelected.set(entityParent, (directlySelected.get(entityParent) ?? 0) + 1);
      else rootSelected += 1;
      ordered.push(entityId);
    }
    const selectedBelow = new Map(directlySelected);
    for (let index = prepared.group_order.length - 1; index >= 0; index -= 1) {
      const groupId = prepared.group_order[index]!;
      const parentId = prepared.groups.get(groupId)!.parent_group_id;
      if (parentId) selectedBelow.set(parentId, (selectedBelow.get(parentId) ?? 0) + (selectedBelow.get(groupId) ?? 0));
    }
    let inferredParent: string | null = null;
    if (!rootSelected) {
      for (const groupId of prepared.group_order) {
        if (selectedBelow.get(groupId) === ordered.length) inferredParent = groupId;
      }
    }
    let parent = edit.parent_group_id === undefined ? inferredParent : edit.parent_group_id;
    if (parent && !prepared.groups.has(parent)) return error("unknown_group", `unknown source group ${parent}`, parent);
    if (parent && selectedBelow.get(parent) !== ordered.length) {
      return error("mixed_parent_selection", `source group ${parent} is not a common ancestor of the selected entities`, parent);
    }
    for (const currentGroup of next.groups) {
      let write = 0;
      for (const entityId of currentGroup.direct_entity_ids) {
        if (!selected.has(entityId)) currentGroup.direct_entity_ids[write++] = entityId;
      }
      currentGroup.direct_entity_ids.length = write;
    }
    next.groups.push({
      id: edit.group_id,
      title: edit.title,
      parent_group_id: parent,
      direct_entity_ids: ordered,
      collapsed: edit.collapsed ?? false,
    });
    if (next.move_history) {
      for (const entityId of ordered) delete next.move_history[entityId];
      if (!Object.keys(next.move_history).length) delete next.move_history;
    }
    pruneEmptyGroups(next);
  } else if (edit.kind === "set_collapsed") {
    const group = mutableGroup(next, edit.group_id);
    if (!group) return error("unknown_group", `unknown source group ${edit.group_id}`, edit.group_id);
    group.collapsed = edit.collapsed;
  } else if (edit.kind === "rename_group") {
    const group = mutableGroup(next, edit.group_id);
    if (!group) return error("unknown_group", `unknown source group ${edit.group_id}`, edit.group_id);
    if (!groupTitleIsValid(edit.title)) return error("invalid_view", `source group ${edit.group_id} has an invalid title`, edit.group_id);
    group.title = edit.title;
  } else if (edit.kind === "move_out") {
    const parent = itemParent(prepared, canonical, edit.id);
    if (parent === undefined) return error("invalid_move", `unknown source canvas item ${edit.id}`, edit.id);
    if (parent === null) return error("already_top_level", `${edit.id} is already at the outermost level`, edit.id);
    const parentGroup = prepared.groups.get(parent)!;
    const movingLastEntity = canonical.entities.has(edit.id)
      && parentGroup.direct_entity_ids.length === 1
      && !(prepared.group_children.get(parent)?.length);
    const movingOnlyChild = prepared.groups.has(edit.id)
      && !parentGroup.direct_entity_ids.length
      && prepared.group_children.get(parent)?.length === 1;
    if (movingLastEntity || movingOnlyChild) {
      return error("invalid_move", `moving ${edit.id} out would empty ${parent}; dissolve the group instead`, edit.id);
    }
    const target = prepared.groups.get(parent)!.parent_group_id;
    const issue = moveItem(next, prepared, canonical, edit.id, target);
    if (issue) return issue;
    pushMoveHistory(next, edit.id, parent);
  } else if (edit.kind === "move_back") {
    const path = next.move_history && Object.hasOwn(next.move_history, edit.id)
      ? next.move_history[edit.id]
      : undefined;
    if (!path?.length) return error("not_moved", `${edit.id} has no saved group to return to`, edit.id);
    const target = path[path.length - 1]!;
    const issue = moveItem(next, prepared, canonical, edit.id, target);
    if (issue) return issue;
    path.pop();
    if (!path.length) clearMoveHistory(next, edit.id);
    pruneEmptyGroups(next);
  } else if (edit.kind === "move_into") {
    if (!prepared.groups.has(edit.target_group_id)) {
      return error("unknown_group", `unknown target source group ${edit.target_group_id}`, edit.target_group_id);
    }
    const issue = moveItem(next, prepared, canonical, edit.id, edit.target_group_id);
    if (issue) return issue;
    clearMoveHistory(next, edit.id);
    pruneEmptyGroups(next);
  } else if (edit.kind === "dissolve_group") {
    const group = mutableGroup(next, edit.group_id);
    const current = prepared.groups.get(edit.group_id);
    if (!group || !current) return error("unknown_group", `unknown source group ${edit.group_id}`, edit.group_id);
    const parentId = current.parent_group_id;
    if (parentId) {
      const parent = mutableGroup(next, parentId)!;
      for (const entityId of group.direct_entity_ids) parent.direct_entity_ids.push(entityId);
    }
    for (const child of next.groups) {
      if (child.parent_group_id === edit.group_id) child.parent_group_id = parentId;
    }
    next.groups = next.groups.filter((candidate) => candidate.id !== edit.group_id);
    if (next.move_history) {
      delete next.move_history[edit.group_id];
      for (const [itemId, path] of Object.entries(next.move_history)) {
        const retained = path.filter((groupId) => groupId !== edit.group_id);
        if (retained.length) next.move_history[itemId] = retained;
        else delete next.move_history[itemId];
      }
      if (!Object.keys(next.move_history).length) delete next.move_history;
    }
  } else {
    if (!next.positions) next.positions = {};
    for (const position of edit.positions) {
      if (!canonical.entities.has(position.id)) return error("unknown_entity", `unknown source entity ${position.id}`, position.id);
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
        return error("invalid_view", `source canvas position for ${position.id} must be finite`, position.id);
      }
      next.positions[position.id] = { x: clampCoordinate(position.x), y: clampCoordinate(position.y) };
    }
  }

  if (!next.groups.length) delete next.groups;
  if (next.positions && !Object.keys(next.positions).length) delete next.positions;
  return next;
}

function normalizeDisplayedRelationshipSelection(
  canonical: CanonicalCanvas,
  prepared: PreparedView,
  edit: SourceCanvasEdit,
  focusGroupId: string | null,
): SourceCanvasEdit | SourceCanvasError {
  if (edit.kind !== "group_selection" || !edit.relationship_ids?.length) return edit;
  let visibleRelations: ReadonlyMap<string, SourceCanvasRelation> | undefined;
  const canonicalIds: string[] = [];
  for (const relationshipId of edit.relationship_ids) {
    if (canonical.relation_by_id.has(relationshipId)) {
      canonicalIds.push(relationshipId);
      continue;
    }
    if (!visibleRelations) {
      const current = projection(canonical, prepared, focusGroupId);
      if ("code" in current) return current;
      const indexed = new Map<string, SourceCanvasRelation>();
      for (const relation of current.relations) indexed.set(relation.id, relation);
      visibleRelations = indexed;
    }
    const displayed = visibleRelations.get(relationshipId);
    if (!displayed) return error("unknown_relation", `unknown source relationship ${relationshipId}`, relationshipId);
    for (const member of displayed.members) canonicalIds.push(member.id);
  }
  return { ...edit, relationship_ids: canonicalIds };
}

function projection(
  canonical: CanonicalCanvas,
  prepared: PreparedView,
  focusGroupId: string | null,
): SourceCanvasProjection | SourceCanvasError {
  if (focusGroupId && !prepared.groups.has(focusGroupId)) {
    return error("unknown_focus", `unknown focused source group ${focusGroupId}`, focusGroupId);
  }

  const scopedGroups = new Set<string>();
  if (focusGroupId) {
    const focusQueue = [focusGroupId];
    for (let cursor = 0; cursor < focusQueue.length; cursor += 1) {
      const groupId = focusQueue[cursor]!;
      scopedGroups.add(groupId);
      for (const child of prepared.group_children.get(groupId) ?? []) focusQueue.push(child);
    }
  } else {
    for (const groupId of prepared.group_order) scopedGroups.add(groupId);
  }

  const groupRepresentative = new Map<string, string | null>();
  const groupVisible = new Set<string>();
  for (const groupId of prepared.group_order) {
    if (!scopedGroups.has(groupId)) continue;
    if (groupId === focusGroupId) {
      groupRepresentative.set(groupId, null);
      continue;
    }
    const group = prepared.groups.get(groupId)!;
    const parentRepresentative = group.parent_group_id && scopedGroups.has(group.parent_group_id)
      ? groupRepresentative.get(group.parent_group_id) ?? null
      : null;
    const representative = parentRepresentative ?? (group.collapsed ? group.id : null);
    groupRepresentative.set(groupId, representative);
    if (representative === null) groupVisible.add(groupId);
  }

  const inside = new Set<string>();
  const representative = new Map<string, string>();
  for (const entityId of canonical.entity_ids) {
    const directGroup = prepared.entity_group.get(entityId) ?? null;
    const isInside = focusGroupId === null
      || directGroup === focusGroupId
      || (directGroup !== null && scopedGroups.has(directGroup));
    if (!isInside) continue;
    inside.add(entityId);
    const proxy = directGroup ? groupRepresentative.get(directGroup) ?? null : null;
    representative.set(entityId, proxy ?? entityId);
  }

  const entityBounds = new Map<string, SourceCanvasBounds>();
  for (const entityId of canonical.entity_ids) {
    const position = entityPosition(canonical, prepared, entityId);
    entityBounds.set(entityId, { x: position.x, y: position.y, width: ENTITY_WIDTH, height: ENTITY_HEIGHT });
  }

  const groupBounds = new Map<string, SourceCanvasBounds>();
  const descendantCounts = new Map<string, number>();
  for (let index = prepared.group_order.length - 1; index >= 0; index -= 1) {
    const groupId = prepared.group_order[index]!;
    const group = prepared.groups.get(groupId)!;
    let bounds: MutableBounds | undefined;
    let count = group.direct_entity_ids.length;
    for (const entityId of group.direct_entity_ids) bounds = includeBounds(bounds, entityBounds.get(entityId)!);
    for (const childId of prepared.group_children.get(groupId) ?? []) {
      const childBounds = groupBounds.get(childId);
      if (childBounds) bounds = includeBounds(bounds, childBounds);
      count += descendantCounts.get(childId) ?? 0;
    }
    if (!bounds) bounds = { x1: 0, y1: 0, x2: ENTITY_WIDTH, y2: ENTITY_HEIGHT };
    groupBounds.set(groupId, paddedBounds(bounds));
    descendantCounts.set(groupId, count);
  }

  const visibleEntities: SourceCanvasEntity[] = [];
  for (const entityId of canonical.entity_ids) {
    if (!inside.has(entityId) || representative.get(entityId) !== entityId) continue;
    const entity = canonical.entities.get(entityId)!;
    const position = entityPosition(canonical, prepared, entityId);
    visibleEntities.push({
      id: entity.id,
      kind: "call",
      title: entity.title,
      invocation_id: entity.invocation.id,
      invocation_name: entity.invocation.name,
      caller_scope_id: entity.invocation.caller,
      ...(entity.invocation.callee ? { callee_scope_id: entity.invocation.callee } : {}),
      ...(entity.callee ? {
        callee_definition: {
          scope_id: entity.callee.id,
          title: entity.callee.title,
          ...(entity.callee.symbol ? { symbol: entity.callee.symbol } : {}),
          kind: entity.callee.kind,
          span: copySpan(entity.callee.span),
        },
      } : {}),
      ...(entity.replacement ? { replacement: copyReplacement(entity.replacement) } : {}),
      span: copySpan(entity.invocation.span),
      direct_group_id: prepared.entity_group.get(entityId) ?? null,
      position: { x: position.x, y: position.y },
      bounds: { ...entityBounds.get(entityId)! },
    });
  }

  const hiddenRelations = new Map<string, string[]>();
  const relationBuckets = new Map<string, CanonicalRelation[]>();
  let incomingBoundary = false;
  let outgoingBoundary = false;
  const incomingBoundaryId = focusGroupId ? `boundary:${focusGroupId}:in` : "";
  const outgoingBoundaryId = focusGroupId ? `boundary:${focusGroupId}:out` : "";
  for (const relation of canonical.relations) {
    const fromInside = inside.has(relation.from);
    const toInside = inside.has(relation.to);
    if (!fromInside && !toInside) continue;
    let from: string;
    let to: string;
    if (fromInside) from = representative.get(relation.from)!;
    else {
      from = incomingBoundaryId;
      incomingBoundary = true;
    }
    if (toInside) to = representative.get(relation.to)!;
    else {
      to = outgoingBoundaryId;
      outgoingBoundary = true;
    }
    if (from === to && (from !== relation.from || to !== relation.to || relation.from !== relation.to)) {
      let hidden = hiddenRelations.get(from);
      if (!hidden) {
        hidden = [];
        hiddenRelations.set(from, hidden);
      }
      hidden.push(relation.id);
      continue;
    }
    const key = `${relation.kind}\u0000${from}\u0000${to}`;
    let bucket = relationBuckets.get(key);
    if (!bucket) {
      bucket = [];
      relationBuckets.set(key, bucket);
    }
    bucket.push(relation);
  }

  const relations: SourceCanvasRelation[] = [];
  let incomingRelationCount = 0;
  let outgoingRelationCount = 0;
  for (const bucket of relationBuckets.values()) {
    const first = bucket[0]!;
    const from = inside.has(first.from) ? representative.get(first.from)! : incomingBoundaryId;
    const to = inside.has(first.to) ? representative.get(first.to)! : outgoingBoundaryId;
    const members: SourceCanvasRelationMember[] = [];
    for (const member of bucket) {
      members.push({
        id: member.id,
        original_from: member.from,
        original_to: member.to,
        span: copySpan(member.span),
      });
    }
    if (from === incomingBoundaryId) incomingRelationCount += members.length;
    if (to === outgoingBoundaryId) outgoingRelationCount += members.length;
    relations.push({
      id: members.length === 1 ? first.id : `aggregate:${first.kind}:${encodeURIComponent(from)}:${encodeURIComponent(to)}`,
      kind: first.kind,
      executable: false,
      from,
      to,
      original_from: first.from,
      original_to: first.to,
      proxied: from !== first.from || to !== first.to || members.length > 1,
      span: copySpan(first.span),
      member_count: members.length,
      members,
    });
  }

  const groupProjections: SourceCanvasGroupProjection[] = [];
  const portals: SourceCanvasPortal[] = [];
  for (const groupId of prepared.group_order) {
    if (!scopedGroups.has(groupId) || groupId === focusGroupId) continue;
    const group = prepared.groups.get(groupId)!;
    const groupBoundsValue = groupBounds.get(groupId)!;
    const projectedRepresentative = groupRepresentative.get(groupId) ?? null;
    if (projectedRepresentative !== null && projectedRepresentative !== groupId) continue;
    if (projectedRepresentative === groupId) {
      const canonicalBounds = groupBoundsValue;
      const position = {
        x: canonicalBounds.x + canonicalBounds.width / 2 - PORTAL_WIDTH / 2,
        y: canonicalBounds.y + canonicalBounds.height / 2 - PORTAL_HEIGHT / 2,
      };
      portals.push({
        id: group.id,
        kind: "collapsed_group",
        group_id: group.id,
        title: group.title,
        direct_entity_count: group.direct_entity_ids.length,
        descendant_entity_count: descendantCounts.get(group.id) ?? 0,
        hidden_relation_count: hiddenRelations.get(group.id)?.length ?? 0,
        hidden_relationship_ids: hiddenRelations.get(group.id)?.slice() ?? [],
        position,
        bounds: { x: position.x, y: position.y, width: PORTAL_WIDTH, height: PORTAL_HEIGHT },
      });
    } else if (groupVisible.has(groupId)) {
      groupProjections.push({
        id: group.id,
        title: group.title,
        parent_group_id: group.parent_group_id,
        collapsed: false,
        direct_entity_count: group.direct_entity_ids.length,
        descendant_entity_count: descendantCounts.get(group.id) ?? 0,
        bounds: { ...groupBoundsValue },
      });
    }
  }

  let visibleBounds: MutableBounds | undefined;
  for (const entity of visibleEntities) visibleBounds = includeBounds(visibleBounds, entity.bounds);
  for (const portal of portals) visibleBounds = includeBounds(visibleBounds, portal.bounds);
  for (const group of groupProjections) visibleBounds = includeBounds(visibleBounds, group.bounds);
  const canvasBounds = visibleBounds ?? { x1: 0, y1: 0, x2: ENTITY_WIDTH, y2: ENTITY_HEIGHT };
  if (focusGroupId && incomingBoundary) {
    const position = { x: canvasBounds.x1 - BOUNDARY_GAP - PORTAL_WIDTH, y: canvasBounds.y1 };
    portals.push({
      id: incomingBoundaryId,
      kind: "boundary",
      group_id: focusGroupId,
      direction: "in",
      title: "From parent",
      relation_count: incomingRelationCount,
      position,
      bounds: { x: position.x, y: position.y, width: PORTAL_WIDTH, height: PORTAL_HEIGHT },
    });
  }
  if (focusGroupId && outgoingBoundary) {
    const position = { x: canvasBounds.x2 + BOUNDARY_GAP, y: canvasBounds.y1 };
    portals.push({
      id: outgoingBoundaryId,
      kind: "boundary",
      group_id: focusGroupId,
      direction: "out",
      title: "To parent",
      relation_count: outgoingRelationCount,
      position,
      bounds: { x: position.x, y: position.y, width: PORTAL_WIDTH, height: PORTAL_HEIGHT },
    });
  }

  const breadcrumbs: SourceCanvasBreadcrumb[] = [];
  if (focusGroupId) {
    const reversed: SourceCanvasBreadcrumb[] = [];
    let cursor: string | null = focusGroupId;
    while (cursor) {
      const group: SourceCanvasGroup = prepared.groups.get(cursor)!;
      reversed.push({ id: group.id, title: group.title });
      cursor = group.parent_group_id;
    }
    for (let index = reversed.length - 1; index >= 0; index -= 1) breadcrumbs.push(reversed[index]!);
  }

  return {
    view: prepared.view,
    focus_group_id: focusGroupId,
    breadcrumbs,
    entities: visibleEntities,
    groups: groupProjections,
    portals,
    relations,
    suggestions: canonical.suggestions,
  };
}

/** Validate persisted group presentation without projecting the visible canvas. */
export function validateSourceCanvasView(
  workflow: Readonly<SourceWorkflowInstance>,
  view: Readonly<SourceCanvasView>,
): SourceCanvasError | null {
  const canonical = cachedCanonicalCanvas(workflow);
  if ("code" in canonical) return canonical;
  const prepared = normalizedView(workflow, canonical, view);
  return "code" in prepared ? prepared : null;
}

/** Project the full flat source-call graph, or one ephemeral focused group. */
export function projectSourceCanvas(
  workflow: Readonly<SourceWorkflowInstance>,
  view?: Readonly<SourceCanvasView>,
  focusGroupId: string | null = null,
): SourceCanvasResult {
  const canonical = cachedCanonicalCanvas(workflow);
  if ("code" in canonical) return { ok: false, error: canonical };
  const prepared = normalizedView(workflow, canonical, view);
  if ("code" in prepared) return { ok: false, error: prepared };
  const projected = projection(canonical, prepared, focusGroupId);
  return "code" in projected ? { ok: false, error: projected } : { ok: true, projection: projected };
}

/** Apply one atomic user-authored grouping edit and return its complete projection. */
export function editSourceCanvas(
  workflow: Readonly<SourceWorkflowInstance>,
  view: Readonly<SourceCanvasView>,
  edit: SourceCanvasEdit,
  focusGroupId: string | null = null,
): SourceCanvasResult {
  const canonical = cachedCanonicalCanvas(workflow);
  if ("code" in canonical) return { ok: false, error: canonical };
  const prepared = normalizedView(workflow, canonical, view);
  if ("code" in prepared) return { ok: false, error: prepared };
  if (focusGroupId && !prepared.groups.has(focusGroupId)) {
    return { ok: false, error: error("unknown_focus", `unknown focused source group ${focusGroupId}`, focusGroupId) };
  }
  const normalizedEdit = normalizeDisplayedRelationshipSelection(canonical, prepared, edit, focusGroupId);
  if ("code" in normalizedEdit) return { ok: false, error: normalizedEdit };
  const edited = applyEdit(canonical, prepared, normalizedEdit);
  if ("code" in edited) return { ok: false, error: edited };
  const next = normalizedView(workflow, canonical, edited);
  if ("code" in next) return { ok: false, error: next };
  let projectedFocus = focusGroupId;
  while (projectedFocus && !next.groups.has(projectedFocus)) {
    projectedFocus = prepared.groups.get(projectedFocus)?.parent_group_id ?? null;
  }
  const projected = projection(canonical, next, projectedFocus);
  return "code" in projected ? { ok: false, error: projected } : { ok: true, projection: projected };
}
