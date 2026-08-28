"use client";

import { GripHorizontal, X } from "lucide-react";
import { useRef } from "react";
import { canvasColor, strokePath } from "./canvasPresentation";
import type { CanvasAnnotation } from "./types";

type Gesture = {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  annotation: Extract<CanvasAnnotation, { kind: "sticky" | "box" }>;
};

export function CanvasAnnotations({ annotations, zoom, selectedId, onSelect, onBeginChange, onChange, onRemove }: {
  annotations: CanvasAnnotation[];
  zoom: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onBeginChange: () => void;
  onChange: (annotation: CanvasAnnotation) => void;
  onRemove: (id: string) => void;
}) {
  const gesture = useRef<Gesture | null>(null);
  const beginGesture = (event: React.PointerEvent<HTMLElement>, annotation: Extract<CanvasAnnotation, { kind: "sticky" | "box" }>, mode: Gesture["mode"]) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(annotation.id);
    onBeginChange();
    gesture.current = { id: annotation.id, mode, startX: event.clientX, startY: event.clientY, annotation };
  };
  const moveGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active) return;
    event.stopPropagation();
    const dx = (event.clientX - active.startX) / Math.max(zoom, 0.02);
    const dy = (event.clientY - active.startY) / Math.max(zoom, 0.02);
    onChange(active.mode === "move" ? {
      ...active.annotation,
      layout: { x: active.annotation.layout.x + dx, y: active.annotation.layout.y + dy },
    } : {
      ...active.annotation,
      width: Math.max(80, active.annotation.width + dx),
      height: Math.max(60, active.annotation.height + dy),
    });
  };
  const endGesture = (event: React.PointerEvent<HTMLElement>) => {
    if (!gesture.current) return;
    event.stopPropagation();
    gesture.current = null;
  };

  return <>
    <svg className="canvas-strokes" aria-label="Canvas drawings">
      {annotations.filter((annotation): annotation is Extract<CanvasAnnotation, { kind: "stroke" }> => annotation.kind === "stroke").map((annotation) => {
        const color = canvasColor(annotation.color);
        return <g key={annotation.id} className={selectedId === annotation.id ? "selected" : ""} onPointerDown={(event) => { event.stopPropagation(); onSelect(annotation.id); }}>
          <path className="stroke-hit" d={strokePath(annotation.points)} />
          <path className="stroke-mark" d={strokePath(annotation.points)} style={{ stroke: color.hex }} />
        </g>;
      })}
    </svg>
    {annotations.map((annotation) => {
      if (annotation.kind === "stroke") {
        const point = annotation.points[0];
        return selectedId === annotation.id && point ? <button key={`${annotation.id}-remove`} type="button" className="annotation-remove stroke-remove nodrag nopan" style={{ left: point.x, top: point.y }} aria-label={`Delete drawing ${annotation.id}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => onRemove(annotation.id)}><X size={12} /></button> : null;
      }
      const color = canvasColor(annotation.color);
      return <article
        key={annotation.id}
        className={`canvas-annotation ${annotation.kind} ${selectedId === annotation.id ? "selected" : ""} nodrag nopan nowheel`}
        data-color={annotation.color}
        style={{ left: annotation.layout.x, top: annotation.layout.y, width: annotation.width, height: annotation.height, "--annotation-color": color.hex } as React.CSSProperties}
        onPointerDown={(event) => { event.stopPropagation(); onSelect(annotation.id); }}
      >
        <header onPointerDown={(event) => beginGesture(event, annotation, "move")} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture}>
          <GripHorizontal size={13} aria-hidden="true" />
          <span>{annotation.kind === "sticky" ? "Note" : annotation.text || "Section"}</span>
          <button type="button" aria-label={`Delete ${annotation.kind} ${annotation.id}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => onRemove(annotation.id)}><X size={12} /></button>
        </header>
        <textarea
          aria-label={annotation.kind === "sticky" ? `Sticky note ${annotation.id}` : `Box label ${annotation.id}`}
          placeholder={annotation.kind === "sticky" ? "Type a note…" : "Name this stage…"}
          value={annotation.text}
          onFocus={onBeginChange}
          onChange={(event) => onChange({ ...annotation, text: event.target.value.slice(0, 5_000) })}
        />
        <button type="button" className="annotation-resize" aria-label={`Resize ${annotation.kind} ${annotation.id}`} onPointerDown={(event) => beginGesture(event, annotation, "resize")} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture} />
      </article>;
    })}
  </>;
}
