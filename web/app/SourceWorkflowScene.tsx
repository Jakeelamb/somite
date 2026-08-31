"use client";

import {
  Handle,
  Position,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { BoxSelect, ChevronLeft, CircleAlert, CornerDownLeft, FolderInput, LoaderCircle, Minus, Pencil, Plus, Ungroup, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  editSourceCanvas,
  projectSourceCanvas,
  type SourceCanvasEdit,
  type SourceCanvasEntity,
  type SourceCanvasGroupProjection,
  type SourceCanvasPortal,
  type SourceCanvasProjection,
  type SourceCanvasRelation,
} from "@somite/workflow/sourceCanvas";
import type { Operator } from "@somite/workflow/catalog";
import type { SomiteGraphNode, SourceCanvasView, SourceWorkflowInstance } from "@somite/workflow/model";
import { SourceGraphPreview, sourceProjectionBounds } from "./SourceGraphPreview";
import { sourceSpanLabel, sourceWorkflowReplacementCandidate } from "./sourceWorkflowPresentation";

type EntityData = Record<string, unknown> & {
  entity: SourceCanvasEntity;
  busy: boolean;
  promoted: boolean;
  onReplace: (entity: SourceCanvasEntity) => void;
  onPromote: (entity: SourceCanvasEntity) => void;
  onReset: (entity: SourceCanvasEntity) => void;
};
type HullData = Record<string, unknown> & {
  group: SourceCanvasGroupProjection;
  selected: boolean;
  editing: boolean;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onCollapse: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onEditingDone: () => void;
  onUngroup: (id: string) => void;
};
type PortalData = Record<string, unknown> & {
  portal: Extract<SourceCanvasPortal, { kind: "collapsed_group" }>;
  workflow: SourceWorkflowInstance;
  view?: SourceCanvasView;
  selected: boolean;
  onSelect: (id: string) => void;
  onExpand: (id: string) => void;
  onUngroup: (id: string) => void;
};
type BoundaryData = Record<string, unknown> & {
  portal: Extract<SourceCanvasPortal, { kind: "boundary" }>;
};

type EntityNode = Node<EntityData, "sourceEntity">;
type HullNode = Node<HullData, "sourceGroupHull">;
type PortalNode = Node<PortalData, "sourceGroupPortal">;
type BoundaryNode = Node<BoundaryData, "sourceBoundaryPortal">;
export type SourceFlowNode = EntityNode | HullNode | PortalNode | BoundaryNode;
export type SourceFlowEdge = Edge<{ relation: SourceCanvasRelation }>;

function EntityCard({ data, selected }: NodeProps<EntityNode>) {
  const { entity } = data;
  return (
    <article className={`source-outline-node ${selected ? "is-selected" : ""} ${entity.replacement ? "is-replaced" : ""}`} data-source-entity-id={entity.id} data-source-entity-kind="invocation" aria-label={`Source invocation ${entity.title}`}>
      <Handle className="source-outline-handle" type="target" position={Position.Left} isConnectable={false} />
      <header><span className="source-outline-title"><span>Invocation</span><strong>{entity.title}</strong></span><code>{sourceSpanLabel(entity.span)}</code></header>
      <div className="source-outline-details">
        <span>{entity.callee_definition?.title ?? entity.invocation_name}</span>
        <small>{entity.callee_definition?.kind ?? "source call"}</small>
        {entity.replacement && <span className="source-outline-warning"><CircleAlert size={9} />Connections need checking</span>}
      </div>
      <footer className="source-outline-actions">
        {data.promoted ? <span className="source-outline-promoted">Editable on canvas</span> : <>
          <button type="button" className="nodrag nopan" disabled={data.busy} onClick={() => data.onReplace(entity)}>Replace tool</button>
          {entity.replacement && <button type="button" className="nodrag nopan" disabled={data.busy} onClick={() => data.onReset(entity)}>Reset</button>}
          {entity.replacement && <button type="button" className="source-outline-promote nodrag nopan" disabled={data.busy} onClick={() => data.onPromote(entity)}>{data.busy ? <LoaderCircle size={9} className="spin" /> : null}Make editable</button>}
        </>}
      </footer>
      <Handle className="source-outline-handle" type="source" position={Position.Right} isConnectable={false} />
    </article>
  );
}

function GroupHull({ data }: NodeProps<HullNode>) {
  const { group } = data;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (data.editing) inputRef.current?.focus(); }, [data.editing]);
  const finishRename = (value: string) => {
    const next = value.trim();
    if (next && next !== group.title) data.onRename(group.id, next);
    data.onEditingDone();
  };
  return (
    <section className={`source-group-hull ${data.selected ? "is-selected" : ""}`} data-source-group-id={group.id} data-testid={`source-group-hull-${group.id}`} aria-label={`Expanded group ${group.title}`}>
      <header>
        {data.editing ? <input className="source-group-title-input nodrag nopan" aria-label="Group name" ref={inputRef} defaultValue={group.title} maxLength={120} onBlur={(event) => finishRename(event.currentTarget.value)} onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") { event.currentTarget.value = group.title; data.onEditingDone(); }
        }} /> : <button type="button" className="nodrag nopan" onClick={() => data.onSelect(group.id)}><span>Group · {group.descendant_entity_count} calls</span><strong>{group.title}</strong></button>}
        <span className="source-group-actions">
          <button type="button" className="nodrag nopan" aria-label={`Rename ${group.title}`} onClick={() => data.onEdit(group.id)}><Pencil size={10} /></button>
          <button type="button" className="nodrag nopan" aria-label={`Collapse ${group.title}`} onClick={() => data.onCollapse(group.id)}><Minus size={10} />Collapse</button>
          <button type="button" className="nodrag nopan" aria-label={`Ungroup ${group.title}`} onClick={() => data.onUngroup(group.id)}><Ungroup size={10} /></button>
        </span>
      </header>
    </section>
  );
}

function GroupPortal({ data, selected }: NodeProps<PortalNode>) {
  const { portal } = data;
  return (
    <article className={`source-group-portal ${selected || data.selected ? "is-selected" : ""}`} data-source-group-id={portal.group_id} data-source-group-portal-id={portal.id} data-testid={`source-group-portal-${portal.group_id}`} aria-label={`Collapsed group ${portal.title}`}>
      <Handle className="source-outline-handle" type="target" position={Position.Left} isConnectable={false} />
      <header><span>Container</span><strong>{portal.title}</strong></header>
      <SourceGraphPreview workflow={data.workflow} view={data.view} focusGroupId={portal.group_id} />
      <footer><span>{portal.descendant_entity_count} calls</span><button type="button" className="nodrag nopan" aria-label={`Expand ${portal.title} inline`} onClick={(event) => { event.stopPropagation(); data.onExpand(portal.group_id); }}><Plus size={10} />Expand</button><button type="button" className="nodrag nopan" aria-label={`Ungroup ${portal.title}`} onClick={(event) => { event.stopPropagation(); data.onUngroup(portal.group_id); }}><Ungroup size={10} /></button></footer>
      <Handle className="source-outline-handle" type="source" position={Position.Right} isConnectable={false} />
    </article>
  );
}

function BoundaryPortal({ data }: NodeProps<BoundaryNode>) {
  return <div className="source-boundary-portal" data-source-boundary-id={data.portal.id} aria-label={`${data.portal.title}; outside this container`}><Handle className="source-outline-handle" type="target" position={Position.Left} isConnectable={false} /><span>{data.portal.direction === "in" ? "Input from parent" : "Output to parent"}</span><strong>{data.portal.title}</strong><Handle className="source-outline-handle" type="source" position={Position.Right} isConnectable={false} /></div>;
}

export const sourceNodeTypes = {
  sourceEntity: memo(EntityCard),
  sourceGroupHull: memo(GroupHull),
  sourceGroupPortal: memo(GroupPortal),
  sourceBoundaryPortal: memo(BoundaryPortal),
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function nextGroupId() {
  return `group:${globalThis.crypto.randomUUID()}`;
}

export type SourceWorkflowScene = Readonly<{
  nodes: SourceFlowNode[];
  edges: SourceFlowEdge[];
  projection: SourceCanvasProjection | null;
  bounds: ReturnType<typeof sourceProjectionBounds>;
  view?: SourceCanvasView;
  fatalError: string | null;
  overlays: ReactNode;
  onNodesChange: ReturnType<typeof useNodesState<SourceFlowNode>>[2];
  onEdgesChange: ReturnType<typeof useEdgesState<SourceFlowEdge>>[2];
  onPaneClick: () => void;
  onSelectionChange: (params: OnSelectionChangeParams<SourceFlowNode, SourceFlowEdge>) => void;
  onNodeDragStop: (node: SourceFlowNode) => void;
}>;

export function useSourceWorkflowScene({ graphNode, focusGroupId, operators, promotedInvocationIds, onFocusChange, onViewChange, onReplace, onPromote, onReset }: {
  graphNode: SomiteGraphNode | null;
  focusGroupId: string | null;
  operators: Operator[];
  promotedInvocationIds?: ReadonlySet<string>;
  onFocusChange: (groupId: string | null) => void;
  onViewChange: (view: SourceCanvasView) => void | Promise<void>;
  onReplace: (invocationId: string, operator: Operator) => void | Promise<void>;
  onPromote: (invocationId: string) => void | Promise<void>;
  onReset: (invocationId: string) => void | Promise<void>;
}): SourceWorkflowScene {
  const workflow = graphNode?.source_workflow;
  const [draftState, setDraftState] = useState(() => ({ source: graphNode?.source_canvas, view: graphNode?.source_canvas }));
  const [viewError, setViewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([]);
  const [selectedRelationIds, setSelectedRelationIds] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [replaceEntityId, setReplaceEntityId] = useState<string | null>(null);
  const [replacementQuery, setReplacementQuery] = useState("");
  const [busyInvocationId, setBusyInvocationId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<SourceFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SourceFlowEdge>([]);
  const persistGenerationRef = useRef(0);
  const pendingPersistCountRef = useRef(0);
  const sourceCanvasRef = useRef(graphNode?.source_canvas);
  const latestDraftViewRef = useRef(graphNode?.source_canvas);

  const sourceCanvasChanged = draftState.source !== graphNode?.source_canvas;
  const draftView = sourceCanvasChanged ? graphNode?.source_canvas : draftState.view;
  useEffect(() => {
    sourceCanvasRef.current = graphNode?.source_canvas;
    latestDraftViewRef.current = draftView;
  }, [draftView, graphNode?.source_canvas]);

  const groupIndex = useMemo(() => {
    const parentById = new Map<string, string | null>();
    const childIdsByParent = new Map<string, string[]>();
    for (const group of draftView?.groups ?? []) {
      parentById.set(group.id, group.parent_group_id);
      if (!group.parent_group_id) continue;
      const siblings = childIdsByParent.get(group.parent_group_id) ?? [];
      siblings.push(group.id);
      childIdsByParent.set(group.parent_group_id, siblings);
    }
    return { parentById, childIdsByParent };
  }, [draftView?.groups]);

  const effectiveFocus = focusGroupId && groupIndex.parentById.has(focusGroupId) ? focusGroupId : null;
  const result = useMemo(() => workflow ? projectSourceCanvas(workflow, draftView, effectiveFocus) : null, [draftView, effectiveFocus, workflow]);
  const projection = result?.ok ? result.projection : null;
  const bounds = projection ? sourceProjectionBounds(projection) : null;

  const persist = useCallback(async (view: SourceCanvasView) => {
    const generation = ++persistGenerationRef.current;
    const previous = latestDraftViewRef.current;
    latestDraftViewRef.current = view;
    setDraftState({ source: sourceCanvasRef.current, view });
    pendingPersistCountRef.current += 1;
    setSaving(true);
    setViewError(null);
    try {
      await onViewChange(view);
      return { saved: true, current: generation === persistGenerationRef.current };
    } catch (error) {
      const current = generation === persistGenerationRef.current;
      if (current) {
        latestDraftViewRef.current = previous;
        setDraftState({ source: sourceCanvasRef.current, view: previous });
        setViewError(message(error));
      }
      return { saved: false, current };
    } finally {
      pendingPersistCountRef.current = Math.max(0, pendingPersistCountRef.current - 1);
      if (pendingPersistCountRef.current === 0) setSaving(false);
    }
  }, [onViewChange]);

  const applyEdit = useCallback(async (edit: SourceCanvasEdit, nextFocus = effectiveFocus) => {
    if (!workflow || !projection) return false;
    const edited = editSourceCanvas(workflow, projection.view, edit, nextFocus);
    if (!edited.ok) { setViewError(edited.error.message); return false; }
    if (edited.projection.focus_group_id !== effectiveFocus) onFocusChange(edited.projection.focus_group_id);
    const outcome = await persist(edited.projection.view);
    if (!outcome.saved && outcome.current && nextFocus !== effectiveFocus) onFocusChange(effectiveFocus);
    return outcome.saved;
  }, [effectiveFocus, onFocusChange, persist, projection, workflow]);

  const runSemantic = useCallback(async (invocationId: string, work: () => void | Promise<void>) => {
    setViewError(null);
    setBusyInvocationId(invocationId);
    try { await work(); return true; }
    catch (error) { setViewError(message(error)); return false; }
    finally { setBusyInvocationId(null); }
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedEntityIds([]); setSelectedRelationIds([]); setSelectedGroupIds([]);
    setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
    setEdges((current) => current.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
  }, [setEdges, setNodes]);
  const selectGroup = useCallback((id: string) => {
    setSelectedEntityIds([]); setSelectedRelationIds([]); setSelectedGroupIds([id]);
    setNodes((current) => current.map((node) => ({ ...node, selected: node.type === "sourceGroupPortal" && node.data.portal.group_id === id })));
    setEdges((current) => current.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
  }, [setEdges, setNodes]);
  const handleSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams<SourceFlowNode, SourceFlowEdge>) => {
    const entityIds = selectedNodes.filter((node): node is EntityNode => node.type === "sourceEntity").map((node) => node.id);
    const groupIds = selectedNodes.filter((node): node is PortalNode => node.type === "sourceGroupPortal").map((node) => node.data.portal.group_id);
    const relationIds = selectedEdges.map((edge) => edge.id);
    setSelectedEntityIds((current) => sameIds(current, entityIds) ? current : entityIds);
    setSelectedGroupIds((current) => sameIds(current, groupIds) ? current : groupIds);
    setSelectedRelationIds((current) => sameIds(current, relationIds) ? current : relationIds);
  }, []);

  const dissolveGroup = useCallback(async (id: string) => {
    const nextFocus = effectiveFocus === id ? groupIndex.parentById.get(id) ?? null : effectiveFocus;
    if (await applyEdit({ kind: "dissolve_group", group_id: id }, nextFocus)) { setEditingGroupId(null); clearSelection(); }
  }, [applyEdit, clearSelection, effectiveFocus, groupIndex.parentById]);
  const nestSelection = useCallback(async () => {
    if (!projection || (!selectedEntityIds.length && !selectedRelationIds.length)) return;
    const relationshipIds = [...new Set(projection.relations.filter((relation) => selectedRelationIds.includes(relation.id)).flatMap((relation) => relation.members.map((member) => member.id)))];
    const groupId = nextGroupId();
    if (await applyEdit({ kind: "group_selection", group_id: groupId, title: "New group", entity_ids: selectedEntityIds, relationship_ids: relationshipIds, collapsed: false })) {
      clearSelection(); setEditingGroupId(groupId);
    }
  }, [applyEdit, clearSelection, projection, selectedEntityIds, selectedRelationIds]);

  const replaceEntity = replaceEntityId ? projection?.entities.find((entity) => entity.id === replaceEntityId) : undefined;
  const replacementCandidates = useMemo(() => {
    const query = replacementQuery.trim().toLowerCase();
    return operators.filter(sourceWorkflowReplacementCandidate).filter((operator) => !query || operator.title.toLowerCase().includes(query) || operator.id.toLowerCase().includes(query));
  }, [operators, replacementQuery]);
  const chooseReplacement = useCallback(async (operator: Operator) => {
    if (!replaceEntity || !await runSemantic(replaceEntity.invocation_id, () => onReplace(replaceEntity.invocation_id, operator))) return;
    setReplaceEntityId(null); setReplacementQuery("");
  }, [onReplace, replaceEntity, runSemantic]);

  const sceneNodes = useMemo<SourceFlowNode[]>(() => projection && workflow ? [
    ...projection.groups.map((group): HullNode => ({ id: `hull:${group.id}`, type: "sourceGroupHull", position: { x: group.bounds.x, y: group.bounds.y }, style: { width: group.bounds.width, height: group.bounds.height }, draggable: false, selectable: false, focusable: false, zIndex: -2, data: { group, selected: selectedGroupIds.includes(group.id), editing: editingGroupId === group.id, onSelect: selectGroup, onEdit: (id) => { selectGroup(id); setEditingGroupId(id); }, onCollapse: (id) => { void applyEdit({ kind: "set_collapsed", group_id: id, collapsed: true }); }, onRename: (id, title) => { void applyEdit({ kind: "rename_group", group_id: id, title }); }, onEditingDone: () => setEditingGroupId(null), onUngroup: (id) => { void dissolveGroup(id); } } })),
    ...projection.entities.map((entity): EntityNode => ({ id: entity.id, type: "sourceEntity", position: entity.position, style: { width: entity.bounds.width, height: entity.bounds.height }, zIndex: 3, data: { entity, busy: busyInvocationId === entity.invocation_id, promoted: promotedInvocationIds?.has(entity.invocation_id) ?? false, onReplace: (item) => { setReplaceEntityId(item.id); setReplacementQuery(""); }, onPromote: (item) => { void runSemantic(item.invocation_id, () => onPromote(item.invocation_id)); }, onReset: (item) => { void runSemantic(item.invocation_id, () => onReset(item.invocation_id)); } } })),
    ...projection.portals.map((portal): PortalNode | BoundaryNode => portal.kind === "collapsed_group" ? ({ id: portal.id, type: "sourceGroupPortal", position: portal.position, style: { width: portal.bounds.width, height: portal.bounds.height }, draggable: false, selected: selectedGroupIds.includes(portal.group_id), zIndex: 4, data: { portal, workflow, view: projection.view, selected: selectedGroupIds.includes(portal.group_id), onSelect: selectGroup, onExpand: (id) => { void applyEdit({ kind: "set_collapsed", group_id: id, collapsed: false }); }, onUngroup: (id) => { void dissolveGroup(id); } } }) : ({ id: portal.id, type: "sourceBoundaryPortal", position: portal.position, style: { width: portal.bounds.width, height: portal.bounds.height }, draggable: false, selectable: false, zIndex: 4, data: { portal } })),
  ] : [], [applyEdit, busyInvocationId, dissolveGroup, editingGroupId, onPromote, onReset, projection, promotedInvocationIds, runSemantic, selectGroup, selectedGroupIds, workflow]);
  const sceneEdges = useMemo<SourceFlowEdge[]>(() => projection?.relations.map((relation) => {
    const boundary = relation.from.startsWith("boundary:") || relation.to.startsWith("boundary:");
    return { id: relation.id, source: relation.from, target: relation.to, type: "smoothstep", className: `source-outline-edge relation-${relation.kind} ${relation.proxied ? "is-proxied" : ""} ${boundary ? "is-boundary" : ""}`, selectable: !boundary, focusable: true, ariaLabel: `${relation.member_count} source relation${relation.member_count === 1 ? "" : "s"}; not a typed data wire`, domAttributes: { "data-testid": boundary ? `source-boundary-relation-${relation.id}` : relation.proxied ? `source-proxy-relation-${relation.id}` : `source-relation-${relation.id}` } as unknown as NonNullable<SourceFlowEdge["domAttributes"]>, data: { relation } };
  }) ?? [], [projection?.relations]);
  useEffect(() => { setNodes(sceneNodes); }, [sceneNodes, setNodes]);
  useEffect(() => { setEdges(sceneEdges); }, [sceneEdges, setEdges]);

  const selectionCount = selectedEntityIds.length + selectedRelationIds.length + selectedGroupIds.length;
  const movableItemId = selectedRelationIds.length === 0 && selectedEntityIds.length + selectedGroupIds.length === 1 ? selectedEntityIds[0] ?? selectedGroupIds[0] : undefined;
  const movableEntity = movableItemId ? projection?.entities.find((entity) => entity.id === movableItemId) : undefined;
  const movableGroup = movableItemId ? projection?.view.groups?.find((group) => group.id === movableItemId) : undefined;
  const movableParentId = movableEntity?.direct_group_id ?? movableGroup?.parent_group_id ?? null;
  const canMoveBack = Boolean(movableItemId && projection?.view.move_history?.[movableItemId]?.length);
  const moveTargets = useMemo(() => {
    const groups = projection?.view.groups ?? [];
    if (!movableGroup) return groups.filter((group) => group.id !== movableParentId);
    const blocked = new Set<string>();
    const pending = [movableGroup.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (blocked.has(id)) continue;
      blocked.add(id);
      pending.push(...(groupIndex.childIdsByParent.get(id) ?? []));
    }
    return groups.filter((group) => group.id !== movableParentId && !blocked.has(group.id));
  }, [groupIndex.childIdsByParent, movableGroup, movableParentId, projection?.view.groups]);
  const fatalError = !workflow ? null : result && !result.ok ? result.error.message : null;

  const overlays = <>
    {fatalError && <div className="nested-source-error" role="alert"><CircleAlert size={20} /><strong>Source workflow unavailable</strong><span>{fatalError}</span></div>}
    {selectionCount > 0 && <div className="nested-source-selection" role="toolbar" aria-label="Source frame selection actions"><span><BoxSelect size={12} /><strong>{selectionCount}</strong> selected</span>{(selectedEntityIds.length > 0 || selectedRelationIds.length > 0) && <button type="button" className="primary" aria-label="Nest selection" onClick={() => { void nestSelection(); }}><FolderInput size={11} />Nest selection</button>}{movableItemId && movableParentId && <button type="button" aria-label="Move out one level" onClick={() => { void applyEdit({ kind: "move_out", id: movableItemId }).then((saved) => { if (saved) clearSelection(); }); }}><CornerDownLeft size={11} />Move out</button>}{movableItemId && canMoveBack && <button type="button" aria-label="Move back" onClick={() => { void applyEdit({ kind: "move_back", id: movableItemId }).then((saved) => { if (saved) clearSelection(); }); }}><ChevronLeft size={11} />Move back</button>}{movableItemId && moveTargets.length > 0 && <select aria-label="Move into group" defaultValue="" onChange={(event) => { const target = event.currentTarget.value; event.currentTarget.value = ""; if (target) void applyEdit({ kind: "move_into", id: movableItemId, target_group_id: target }).then((saved) => { if (saved) clearSelection(); }); }}><option value="" disabled>Move into…</option>{moveTargets.map((group) => <option key={group.id} value={group.id}>{group.title}</option>)}</select>}{selectedGroupIds.length === 1 && <button type="button" aria-label="Ungroup" onClick={() => { void dissolveGroup(selectedGroupIds[0]!); }}><Ungroup size={11} />Ungroup</button>}<button type="button" aria-label="Clear selection" onClick={clearSelection}><X size={11} /></button></div>}
    {replaceEntity && <aside className="nested-replacement-picker" aria-label="Replace source invocation"><header><span><strong>Replace source invocation</strong><small>{replaceEntity.title} · choose one pinned tool</small></span><button type="button" aria-label="Close replacement picker" onClick={() => setReplaceEntityId(null)}><X size={13} /></button></header><input type="search" aria-label="Search replacement tools" value={replacementQuery} onChange={(event) => setReplacementQuery(event.target.value)} placeholder="Search compatible catalog tools" /><div>{replacementCandidates.length ? replacementCandidates.map((operator) => <button type="button" key={`${operator.id}@${operator.revision}`} disabled={busyInvocationId === replaceEntity.invocation_id} onClick={() => { void chooseReplacement(operator); }}><span><strong>{operator.title}</strong><code>{operator.id}</code></span><small>{operator.revision?.slice(0, 10)}</small></button>) : <p>No pinned replacement tools match.</p>}</div></aside>}
    {saving && <div className="nested-source-loading" role="status"><span>Saving canvas…</span></div>}
    {viewError && <div className="nested-source-toast" role="alert"><CircleAlert size={11} /><span>{viewError}</span></div>}
  </>;

  return { nodes, edges, projection, bounds, view: draftView, fatalError, overlays, onNodesChange, onEdgesChange, onPaneClick: clearSelection, onSelectionChange: handleSelectionChange, onNodeDragStop: (node) => { if (node.type === "sourceEntity") void applyEdit({ kind: "set_positions", positions: [{ id: node.id, x: node.position.x, y: node.position.y }] }); } };
}
