import assert from "node:assert/strict";
import test from "node:test";

import { parseGraph } from "../graphCodec.ts";
import type { SomiteGraph, SourceCanvasView, SourceWorkflowInstance } from "../model.ts";
import {
  editSourceCanvas,
  projectSourceCanvas,
  validateSourceCanvasView,
  type SourceCanvasEdit,
  type SourceCanvasProjection,
  type SourceCanvasResult,
} from "../sourceCanvas.ts";
import { graphStateRevision, semanticGraphRevision } from "../workflow.ts";

const digest = (character: string) => `blake3:${character.repeat(64)}`;
const span = (path: string, line = 1) => ({ path, start_line: line, end_line: line });

function workflow(): SourceWorkflowInstance {
  return {
    schema_version: 1,
    workflow_revision: digest("a"),
    source: {
      provider: "local",
      repository: "source-workflow",
      requested_revision: "pinned",
      resolved_revision: "b".repeat(64),
      source_digest: digest("b"),
      entrypoint: "main.nf",
      file_count: 7,
      source_bytes: 700,
    },
    scopes: [
      { id: "root", title: "Root", kind: "entry_workflow", span: span("main.nf") },
      { id: "pipeline", title: "Pipeline", kind: "workflow", span: span("pipeline.nf") },
      { id: "nested", title: "Nested", kind: "workflow", span: span("nested.nf") },
      { id: "prepare-process", title: "Prepare", kind: "process", span: span("prepare.nf") },
      { id: "report-process", title: "Report", kind: "process", span: span("report.nf") },
      { id: "align-process", title: "Align", kind: "process", span: span("align.nf") },
      { id: "qc-process", title: "QC", kind: "process", span: span("qc.nf") },
    ],
    invocations: [
      { id: "pipeline", caller: "root", name: "PIPELINE", callee: "pipeline", span: span("main.nf", 4) },
      { id: "prepare", caller: "pipeline", name: "PREPARE", callee: "prepare-process", span: span("pipeline.nf", 4) },
      { id: "nested", caller: "pipeline", name: "NESTED", callee: "nested", span: span("pipeline.nf", 8) },
      { id: "report", caller: "pipeline", name: "REPORT", callee: "report-process", span: span("pipeline.nf", 12) },
      { id: "align", caller: "nested", name: "ALIGN", callee: "align-process", span: span("nested.nf", 4) },
      { id: "qc", caller: "nested", name: "QC", callee: "qc-process", span: span("nested.nf", 8) },
    ],
    replacements: [{ invocation_id: "align", operator: "align.bowtie2", operator_revision: digest("c") }],
    capabilities: {
      exact_execution: false,
      parameter_edits: true,
      hierarchy_indexed: true,
      structural_edits: false,
      channel_contracts: false,
      source_edits: false,
    },
  };
}

function projection(result: SourceCanvasResult): SourceCanvasProjection {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result.projection;
}

function apply(
  source: SourceWorkflowInstance,
  current: SourceCanvasProjection,
  edit: SourceCanvasEdit,
  focusGroupId: string | null = null,
) {
  return projection(editSourceCanvas(source, current.view, edit, focusGroupId));
}

function allEndpointIds(current: SourceCanvasProjection) {
  return new Set([
    ...current.entities.map((entity) => entity.id),
    ...current.portals.map((portal) => portal.id),
  ]);
}

function assertNoDangling(current: SourceCanvasProjection) {
  const ids = allEndpointIds(current);
  for (const relation of current.relations) {
    assert(ids.has(relation.from), `missing relationship source ${relation.from}`);
    assert(ids.has(relation.to), `missing relationship target ${relation.to}`);
    assert.equal(relation.executable, false);
  }
}

function representedRelationshipIds(current: SourceCanvasProjection) {
  const ids: string[] = [];
  for (const relation of current.relations) {
    for (const member of relation.members) ids.push(member.id);
  }
  for (const portal of current.portals) {
    if (portal.kind === "collapsed_group") ids.push(...portal.hidden_relationship_ids);
  }
  return ids.sort();
}

function group(
  source: SourceWorkflowInstance,
  current: SourceCanvasProjection,
  id: string,
  entities: readonly string[],
  parentGroupId?: string | null,
) {
  return apply(source, current, {
    kind: "group_selection",
    group_id: id,
    title: id.toUpperCase(),
    entity_ids: entities,
    ...(parentGroupId !== undefined ? { parent_group_id: parentGroupId } : {}),
  });
}

test("default projection is the complete flat invocation topology with no authored groups", () => {
  const source = workflow();
  const before = JSON.stringify(source);
  const current = projection(projectSourceCanvas(source));

  assert.deepEqual(current.view, { schema_version: 2, source_digest: source.source.source_digest });
  assert.deepEqual(current.entities.map((entity) => entity.id), [
    "call:pipeline", "call:prepare", "call:nested", "call:report", "call:align", "call:qc",
  ]);
  assert.deepEqual(current.relations.map((relation) => relation.id), [
    "relation:pipeline:prepare",
    "relation:pipeline:nested",
    "relation:pipeline:report",
    "relation:nested:align",
    "relation:nested:qc",
  ]);
  assert.equal(current.groups.length, 0);
  assert.equal(current.portals.length, 0);
  assert.deepEqual(current.suggestions.map((suggestion) => suggestion.source_scope_id), ["pipeline", "nested"]);
  assert.equal(current.suggestions.some((suggestion) => current.entities.some((entity) => entity.id === suggestion.id)), false);
  assert.equal(current.entities.find((entity) => entity.id === "call:align")?.replacement?.operator, "align.bowtie2");
  assert.equal(current.entities.find((entity) => entity.id === "call:align")?.callee_definition?.title, "Align");
  assert.equal(current.entities.every((entity) => entity.direct_group_id === null), true);
  assertNoDangling(current);
  assert.equal(JSON.stringify(source), before, "projection must not mutate imported source provenance");
});

test("recursive calls remain visible self-relationships with collision-free encoded ids", () => {
  const source = workflow();
  source.scopes = [{ id: "recursive", title: "Recursive", kind: "entry_workflow", span: span("recursive.nf") }];
  source.invocations = [{
    id: "self:call",
    caller: "recursive",
    name: "SELF",
    callee: "recursive",
    span: span("recursive.nf", 3),
  }];
  source.replacements = [];
  const current = projection(projectSourceCanvas(source));
  assert.deepEqual(current.relations, [{
    id: "relation:self%3Acall:self%3Acall",
    kind: "source_structure",
    executable: false,
    from: "call:self:call",
    to: "call:self:call",
    original_from: "call:self:call",
    original_to: "call:self:call",
    proxied: false,
    span: span("recursive.nf", 3),
    member_count: 1,
    members: [{
      id: "relation:self%3Acall:self%3Acall",
      original_from: "call:self:call",
      original_to: "call:self:call",
      span: span("recursive.nf", 3),
    }],
  }]);
  assertNoDangling(current);
});

test("relationship selection closes over exact endpoints and creates an expanded soft hull by default", () => {
  const source = workflow();
  const flat = projection(projectSourceCanvas(source));
  const grouped = apply(source, flat, {
    kind: "group_selection",
    group_id: "prep-bundle",
    title: "Preparation",
    relationship_ids: ["relation:pipeline:prepare"],
  });

  assert.deepEqual(grouped.view.groups, [{
    id: "prep-bundle",
    title: "Preparation",
    parent_group_id: null,
    direct_entity_ids: ["call:pipeline", "call:prepare"],
    collapsed: false,
  }]);
  assert.equal(grouped.entities.length, flat.entities.length);
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.groups[0]?.collapsed, false);
  assert.equal(grouped.portals.length, 0);

  const collapsed = apply(source, grouped, { kind: "set_collapsed", group_id: "prep-bundle", collapsed: true });
  assert.deepEqual(collapsed.entities.map((entity) => entity.id), ["call:nested", "call:report", "call:align", "call:qc"]);
  assert.deepEqual(collapsed.portals.find((portal) => portal.id === "prep-bundle"), {
    id: "prep-bundle",
    kind: "collapsed_group",
    group_id: "prep-bundle",
    title: "Preparation",
    direct_entity_count: 2,
    descendant_entity_count: 2,
    hidden_relation_count: 1,
    hidden_relationship_ids: ["relation:pipeline:prepare"],
    position: collapsed.portals[0]?.position,
    bounds: collapsed.portals[0]?.bounds,
  });
  assert.deepEqual(representedRelationshipIds(collapsed), flat.relations.map((relation) => relation.id).sort());
  assert.equal(collapsed.relations.filter((relation) => relation.from === "prep-bundle").length, 2);
  assert.equal(collapsed.relations.filter((relation) => relation.from === "prep-bundle").every((relation) => relation.proxied), true);
  assertNoDangling(collapsed);

  const expanded = apply(source, collapsed, { kind: "set_collapsed", group_id: "prep-bundle", collapsed: false });
  assert.deepEqual(expanded.entities.map((entity) => entity.id), flat.entities.map((entity) => entity.id));
  assert.deepEqual(expanded.relations, flat.relations);
});

test("coincident proxy relationships aggregate and retain every original relationship", () => {
  const source = workflow();
  source.scopes = [
    { id: "root", title: "Root", kind: "entry_workflow", span: span("main.nf") },
    { id: "shared", title: "Shared", kind: "workflow", span: span("shared.nf") },
    { id: "leaf", title: "Leaf", kind: "process", span: span("leaf.nf") },
  ];
  source.invocations = [
    { id: "a", caller: "root", name: "A", callee: "shared", span: span("main.nf", 2) },
    { id: "b", caller: "root", name: "B", callee: "shared", span: span("main.nf", 3) },
    { id: "child", caller: "shared", name: "CHILD", callee: "leaf", span: span("shared.nf", 2) },
  ];
  source.replacements = [];
  const flat = projection(projectSourceCanvas(source));
  let current = group(source, flat, "shared-calls", ["call:a", "call:b"]);
  current = apply(source, current, { kind: "set_collapsed", group_id: "shared-calls", collapsed: true });

  assert.equal(current.relations.length, 1);
  assert.deepEqual(current.relations[0], {
    id: "aggregate:source_reference:shared-calls:call%3Achild",
    kind: "source_reference",
    executable: false,
    from: "shared-calls",
    to: "call:child",
    original_from: "call:a",
    original_to: "call:child",
    proxied: true,
    span: span("shared.nf", 2),
    member_count: 2,
    members: [
      { id: "relation:a:child", original_from: "call:a", original_to: "call:child", span: span("shared.nf", 2) },
      { id: "relation:b:child", original_from: "call:b", original_to: "call:child", span: span("shared.nf", 2) },
    ],
  });
  assertNoDangling(current);

  const regrouped = apply(source, current, {
    kind: "group_selection",
    group_id: "displayed-edge-selection",
    title: "Displayed edge selection",
    relationship_ids: [current.relations[0]!.id],
  });
  assert.deepEqual(regrouped.view.groups, [{
    id: "displayed-edge-selection",
    title: "Displayed edge selection",
    parent_group_id: null,
    direct_entity_ids: ["call:a", "call:b", "call:child"],
    collapsed: false,
  }]);
});

test("focused canvas is clean, breadcrumbed, and terminates crossing relationships at boundary portals", () => {
  const source = workflow();
  const flat = projection(projectSourceCanvas(source));
  const grouped = group(source, flat, "nested-focus", ["call:nested"]);
  const focused = projection(projectSourceCanvas(source, grouped.view, "nested-focus"));

  assert.deepEqual(focused.breadcrumbs, [{ id: "nested-focus", title: "NESTED-FOCUS" }]);
  assert.deepEqual(focused.entities.map((entity) => entity.id), ["call:nested"]);
  assert.equal(focused.groups.length, 0);
  assert.deepEqual(focused.portals.map((portal) => portal.id).sort(), [
    "boundary:nested-focus:in", "boundary:nested-focus:out",
  ]);
  assert.equal(focused.relations.find((relation) => relation.from === "boundary:nested-focus:in")?.to, "call:nested");
  const outbound = focused.relations.find((relation) => relation.to === "boundary:nested-focus:out");
  assert.equal(outbound?.member_count, 2);
  const outboundPortal = focused.portals.find((portal) => portal.id === "boundary:nested-focus:out");
  assert.equal(outboundPortal?.kind === "boundary" ? outboundPortal.relation_count : undefined, 2);
  assert.equal(focused.relations.every((relation) => relation.proxied), true);
  assertNoDangling(focused);
});

test("move out stores an exact path, move back consumes it, explicit move into nests groups, and cycles fail", () => {
  const source = workflow();
  let current = projection(projectSourceCanvas(source));
  current = group(source, current, "outer", ["call:nested", "call:align", "call:qc"]);
  current = group(source, current, "inner", ["call:nested", "call:align"], "outer");

  current = apply(source, current, { kind: "move_out", id: "call:nested" });
  assert.deepEqual(current.view.move_history?.["call:nested"], ["inner"]);
  assert.deepEqual(current.view.groups?.find((candidate) => candidate.id === "outer")?.direct_entity_ids, ["call:qc", "call:nested"]);
  current = apply(source, current, { kind: "move_out", id: "call:nested" });
  assert.deepEqual(current.view.move_history?.["call:nested"], ["inner", "outer"]);
  assert.equal(current.entities.find((entity) => entity.id === "call:nested")?.direct_group_id, null);

  current = apply(source, current, { kind: "move_back", id: "call:nested" });
  assert.equal(current.entities.find((entity) => entity.id === "call:nested")?.direct_group_id, "outer");
  current = apply(source, current, { kind: "move_back", id: "call:nested" });
  assert.equal(current.entities.find((entity) => entity.id === "call:nested")?.direct_group_id, "inner");
  assert.equal(current.view.move_history?.["call:nested"], undefined);

  current = apply(source, current, { kind: "move_into", id: "call:report", target_group_id: "outer" });
  assert.equal(current.entities.find((entity) => entity.id === "call:report")?.direct_group_id, "outer");
  let nestedGroup = apply(source, current, { kind: "move_out", id: "inner" });
  assert.equal(nestedGroup.view.groups?.find((candidate) => candidate.id === "inner")?.parent_group_id, null);
  assert.deepEqual(nestedGroup.view.move_history?.inner, ["outer"]);
  nestedGroup = apply(source, nestedGroup, { kind: "move_back", id: "inner" });
  assert.equal(nestedGroup.view.groups?.find((candidate) => candidate.id === "inner")?.parent_group_id, "outer");
  const cycle = editSourceCanvas(source, nestedGroup.view, { kind: "move_into", id: "outer", target_group_id: "inner" });
  assert.equal(cycle.ok, false);
  if (!cycle.ok) assert.equal(cycle.error.code, "group_cycle");

  let singleton = group(source, projection(projectSourceCanvas(source)), "single", ["call:report"]);
  const safe = editSourceCanvas(source, singleton.view, { kind: "move_out", id: "call:report" });
  assert.equal(safe.ok, false);
  if (!safe.ok) assert.match(safe.error.message, /dissolve/i);
});

test("arbitrary mixed-depth selection lifts endpoints to their LCA and prunes emptied groups", () => {
  const source = workflow();
  let current = projection(projectSourceCanvas(source));
  current = group(source, current, "outer", ["call:nested", "call:align", "call:qc"]);
  current = group(source, current, "inner", ["call:nested", "call:align"], "outer");
  current = group(source, current, "mixed", ["call:nested", "call:report"]);

  const mixed = current.view.groups?.find((candidate) => candidate.id === "mixed");
  assert.equal(mixed?.parent_group_id, null);
  assert.deepEqual(mixed?.direct_entity_ids, ["call:nested", "call:report"]);
  assert.deepEqual(current.view.groups?.find((candidate) => candidate.id === "inner")?.direct_entity_ids, ["call:align"]);

  let pruned = projection(projectSourceCanvas(source));
  pruned = group(source, pruned, "temporary", ["call:nested"]);
  pruned = group(source, pruned, "replacement", ["call:nested"], null);
  assert.equal(pruned.view.groups?.some((candidate) => candidate.id === "temporary"), false);
  assert.equal(pruned.view.groups?.some((candidate) => candidate.id === "replacement"), true);
});

test("nested soft hulls strictly contain child hulls and remain derived from persisted entity positions", () => {
  const source = workflow();
  let current = projection(projectSourceCanvas(source));
  current = apply(source, current, {
    kind: "set_positions",
    positions: [
      { id: "call:nested", x: 100, y: 100 },
      { id: "call:align", x: 400, y: 100 },
      { id: "call:qc", x: 250, y: 350 },
    ],
  });
  current = group(source, current, "outer", ["call:nested", "call:align", "call:qc"]);
  current = group(source, current, "inner", ["call:nested", "call:align"], "outer");
  const outer = current.groups.find((candidate) => candidate.id === "outer")!.bounds;
  const inner = current.groups.find((candidate) => candidate.id === "inner")!.bounds;

  assert(outer.x < inner.x);
  assert(outer.y < inner.y);
  assert(outer.x + outer.width > inner.x + inner.width);
  assert(outer.y + outer.height > inner.y + inner.height);
  assert.deepEqual(current.view.positions?.["call:nested"], { x: 100, y: 100 });
  assert.equal("position" in current.view.groups![0]!, false, "group geometry is projection-only");
});

test("dissolve lifts direct entities and child groups one level without changing source relationships", () => {
  const source = workflow();
  const flat = projection(projectSourceCanvas(source));
  let current = group(source, flat, "outer", ["call:nested", "call:align", "call:qc"]);
  current = group(source, current, "inner", ["call:nested", "call:align"], "outer");
  current = group(source, current, "deep", ["call:nested"], "inner");
  const dissolved = projection(editSourceCanvas(
    source,
    current.view,
    { kind: "dissolve_group", group_id: "inner" },
    "inner",
  ));

  assert.equal(dissolved.focus_group_id, "outer", "removing the focused group falls back to its surviving parent");
  assert.equal(dissolved.view.groups?.some((candidate) => candidate.id === "inner"), false);
  assert.equal(dissolved.view.groups?.find((candidate) => candidate.id === "deep")?.parent_group_id, "outer");
  assert.equal(dissolved.entities.find((entity) => entity.id === "call:align")?.direct_group_id, "outer");
  assert.deepEqual(projection(projectSourceCanvas(source, dissolved.view)).relations, flat.relations);
});

test("rename and batched positions persist atomically, clamp edits, and reject non-finite input", () => {
  const source = workflow();
  let current = group(source, projection(projectSourceCanvas(source)), "bundle", ["call:prepare", "call:report"]);
  current = apply(source, current, { kind: "rename_group", group_id: "bundle", title: "Inputs and report" });
  current = apply(source, current, {
    kind: "set_positions",
    positions: [
      { id: "call:prepare", x: 2_000_000, y: -2_000_000 },
      { id: "call:report", x: 12.5, y: 44.25 },
    ],
  });
  assert.equal(current.view.groups?.[0]?.title, "Inputs and report");
  assert.deepEqual(current.view.positions, {
    "call:prepare": { x: 1_000_000, y: -1_000_000 },
    "call:report": { x: 12.5, y: 44.25 },
  });
  const invalid = editSourceCanvas(source, current.view, {
    kind: "set_positions",
    positions: [{ id: "call:report", x: Number.NaN, y: 1 }],
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "invalid_view");
});

test("edits return immutable snapshots that callers can swap directly for undo and redo", () => {
  const source = workflow();
  const before = projection(projectSourceCanvas(source));
  const serializedBefore = JSON.stringify(before.view);
  const after = group(source, before, "undoable", ["call:prepare", "call:report"]);

  assert.equal(JSON.stringify(before.view), serializedBefore);
  assert.equal(projection(projectSourceCanvas(source, before.view)).groups.length, 0, "undo restores the prior snapshot");
  assert.equal(projection(projectSourceCanvas(source, after.view)).groups[0]?.id, "undoable", "redo restores the edited snapshot");

  const invalidBatch = editSourceCanvas(source, after.view, {
    kind: "set_positions",
    positions: [
      { id: "call:prepare", x: 1, y: 2 },
      { id: "call:missing", x: 3, y: 4 },
    ],
  });
  assert.equal(invalidBatch.ok, false);
  assert.equal(after.view.positions, undefined, "a failed atomic edit cannot partially mutate its input snapshot");
});

test("strict view validation rejects stale digests, cycles, duplicate membership, empty groups, and hostile ids", () => {
  const source = workflow();
  const base = { schema_version: 2 as const, source_digest: source.source.source_digest };
  assert.equal(validateSourceCanvasView(source, { ...base, source_digest: digest("z") })?.code, "stale_view");
  assert.equal(validateSourceCanvasView(source, {
    ...base,
    groups: [
      { id: "a", title: "A", parent_group_id: "b", direct_entity_ids: ["call:pipeline"], collapsed: false },
      { id: "b", title: "B", parent_group_id: "a", direct_entity_ids: [], collapsed: false },
    ],
  })?.code, "group_cycle");
  assert.equal(validateSourceCanvasView(source, {
    ...base,
    groups: [
      { id: "a", title: "A", parent_group_id: null, direct_entity_ids: ["call:pipeline"], collapsed: false },
      { id: "b", title: "B", parent_group_id: null, direct_entity_ids: ["call:pipeline"], collapsed: false },
    ],
  })?.code, "duplicate_id");
  assert.equal(validateSourceCanvasView(source, {
    ...base,
    groups: [{ id: "empty", title: "Empty", parent_group_id: null, direct_entity_ids: [], collapsed: false }],
  })?.code, "invalid_view");
  for (const id of ["call:spoof", "boundary:spoof", "relation:spoof", `g${"é".repeat(101)}`]) {
    assert.equal(validateSourceCanvasView(source, {
      ...base,
      groups: [{ id, title: "Hostile", parent_group_id: null, direct_entity_ids: ["call:pipeline"], collapsed: false }],
    })?.code, "invalid_view");
  }
});

test("group ids cannot impersonate rendered hull node ids", () => {
  const source = workflow();
  const error = validateSourceCanvasView(source, {
    schema_version: 2,
    source_digest: source.source.source_digest,
    groups: [
      { id: "safe", title: "Expanded", parent_group_id: null, direct_entity_ids: ["call:pipeline"], collapsed: false },
      { id: "hull:safe", title: "Collapsed", parent_group_id: null, direct_entity_ids: ["call:report"], collapsed: true },
    ],
  });

  assert.equal(error?.code, "invalid_view");
});

test("source canvas round-trips through the strict graph codec and changes state identity only", () => {
  const source = workflow();
  const base: SomiteGraph = {
    schema_version: 3,
    name: "Source",
    nodes: [{
      id: "source",
      operator: "nf.source",
      operator_revision: digest("d"),
      ports: [],
      source_workflow: source,
      layout: { x: 0, y: 0 },
    }],
    edges: [],
  };
  let current = group(source, projection(projectSourceCanvas(source)), "bundle", ["call:prepare", "call:report"]);
  current = apply(source, current, { kind: "set_positions", positions: [{ id: "call:prepare", x: 42, y: 84 }] });
  const withView: SomiteGraph = { ...base, nodes: [{ ...base.nodes[0]!, source_canvas: current.view }] };

  assert.equal(semanticGraphRevision(withView), semanticGraphRevision(base));
  assert.notEqual(graphStateRevision(withView), graphStateRevision(base));
  assert.deepEqual(parseGraph(JSON.parse(JSON.stringify(withView))), withView);
  assert.throws(() => parseGraph({
    ...withView,
    nodes: [{ ...withView.nodes[0], source_canvas: { ...current.view, unknown: true } }],
  }), /unknown field/i);
  assert.throws(() => parseGraph({
    ...withView,
    nodes: [{ ...withView.nodes[0], source_canvas: { ...current.view, schema_version: 1 } }],
  }), /schema_version must be 2/i);
  assert.throws(() => parseGraph({
    ...withView,
    nodes: [{ ...withView.nodes[0], source_canvas: { ...current.view, source_digest: digest("z") } }],
  }), /digest/i);
});

test("iterative validation and projection stay bounded on wide call sets and deep group forests", () => {
  const wide = workflow();
  wide.invocations = [];
  wide.replacements = [];
  for (let index = 0; index < 5_000; index += 1) {
    wide.invocations.push({ id: `wide-${index}`, caller: "root", name: `WIDE_${index}`, span: span("main.nf", index + 1) });
  }
  const wideProjection = projection(projectSourceCanvas(wide));
  assert.equal(wideProjection.entities.length, 5_000);
  assert.equal(wideProjection.relations.length, 0);

  const source = workflow();
  const groups: NonNullable<SourceCanvasView["groups"]> = [];
  const depth = 5_000;
  for (let index = 0; index < depth; index += 1) {
    groups.push({
      id: `g-${index}`,
      title: `Group ${index}`,
      parent_group_id: index === 0 ? null : `g-${index - 1}`,
      direct_entity_ids: index === depth - 1 ? ["call:pipeline"] : [],
      collapsed: false,
    });
  }
  const view: SourceCanvasView = { schema_version: 2, source_digest: source.source.source_digest, groups };
  assert.equal(validateSourceCanvasView(source, view), null);
  const focused = projection(projectSourceCanvas(source, view, `g-${depth - 1}`));
  assert.equal(focused.breadcrumbs.length, depth);
  assert.deepEqual(focused.entities.map((entity) => entity.id), ["call:pipeline"]);

  groups[0]!.parent_group_id = `g-${depth - 1}`;
  assert.equal(validateSourceCanvasView(source, view)?.code, "group_cycle");
});
