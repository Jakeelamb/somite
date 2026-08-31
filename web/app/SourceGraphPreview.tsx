"use client";

import { memo, useMemo } from "react";
import { projectSourceCanvas, type SourceCanvasProjection } from "@somite/workflow/sourceCanvas";
import type { SourceCanvasView, SourceWorkflowInstance } from "@somite/workflow/model";

const MAX_PREVIEW_NODES = 96;
const MAX_PREVIEW_EDGES = 160;

export function sourceProjectionBounds(projection: SourceCanvasProjection) {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  const include = (bounds: { x: number; y: number; width: number; height: number }) => {
    x1 = Math.min(x1, bounds.x);
    y1 = Math.min(y1, bounds.y);
    x2 = Math.max(x2, bounds.x + bounds.width);
    y2 = Math.max(y2, bounds.y + bounds.height);
  };
  for (const entity of projection.entities) include(entity.bounds);
  for (const group of projection.groups) include(group.bounds);
  for (const portal of projection.portals) include(portal.bounds);
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
}

function SourceGraphPreviewBase({ workflow, view, focusGroupId = null }: {
  workflow: SourceWorkflowInstance;
  view?: SourceCanvasView;
  focusGroupId?: string | null;
}) {
  const preview = useMemo(() => {
    const result = projectSourceCanvas(workflow, view, focusGroupId);
    if (!result.ok) return null;
    const bounds = sourceProjectionBounds(result.projection);
    if (!bounds) return null;
    const entities = result.projection.entities.slice(0, MAX_PREVIEW_NODES);
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const relations = result.projection.relations
      .filter((relation) => entityById.has(relation.from) && entityById.has(relation.to))
      .slice(0, MAX_PREVIEW_EDGES);
    return { bounds, entities, entityById, relations };
  }, [focusGroupId, view, workflow]);

  if (!preview) return <div className="source-graph-preview is-empty" aria-hidden="true" />;
  const pad = Math.max(preview.bounds.width, preview.bounds.height) * .045;
  const viewBox = [preview.bounds.x - pad, preview.bounds.y - pad, preview.bounds.width + pad * 2, preview.bounds.height + pad * 2].join(" ");
  return (
    <svg className="source-graph-preview" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <g className="source-preview-relations">
        {preview.relations.map((relation) => {
          const from = preview.entityById.get(relation.from)!;
          const to = preview.entityById.get(relation.to)!;
          return <line key={relation.id} x1={from.bounds.x + from.bounds.width} y1={from.bounds.y + from.bounds.height / 2} x2={to.bounds.x} y2={to.bounds.y + to.bounds.height / 2} />;
        })}
      </g>
      <g className="source-preview-entities">
        {preview.entities.map((entity) => <rect key={entity.id} x={entity.bounds.x} y={entity.bounds.y} width={entity.bounds.width} height={entity.bounds.height} rx="8" />)}
      </g>
    </svg>
  );
}

export const SourceGraphPreview = memo(SourceGraphPreviewBase);
