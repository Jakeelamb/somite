import assert from "node:assert/strict";
import test from "node:test";

import { nextPaperReadSlot, paperAttentionItems, paperCandidateDocument, paperCanvasOwnsCandidate, paperCanvasUpdate, paperResolutionAgentPrompt, paperResourceApplied, paperSupportedCount, replacePaperReadSlot } from "../app/paperResolution.ts";
import type { PaperCandidate, SomiteGraph } from "../app/types.ts";

const candidate: PaperCandidate = {
  name: "Linkage workflow",
  role: "primary",
  assay: "assembly",
  graph: { schema_version: 3, nodes: [], edges: [] },
  warnings: [],
  evidence: [{
    target_kind: "node",
    target_id: "gatk",
    status: "explicit",
    detail: "processed with GATK 3.5",
    source_location: "PDF page 12",
  }],
  assessment: {
    graph_revision: "blake3:test",
    state: "needs_action",
    required_count: 1,
    nodes: [
      { node_id: "bwa", operator_id: "align.bwa", title: "BWA", kind: "managed_tool", label: "Managed automatically", detail: "Pixi", requires_action: false, recipes: [] },
      { node_id: "gatk", operator_id: "method.gatk3_unspecified", title: "GATK", kind: "method_details", label: "Choose method", detail: "Caller missing", requires_action: true, recipes: [] },
    ],
    items: [{
      id: "resolution:gatk:review",
      node_id: "gatk",
      operator_id: "method.gatk3_unspecified",
      field: "operator",
      fields: [],
      title: "Choose GATK method",
      detail: "Caller missing",
      kind: "method_details",
      priority: 50,
      escalatable: true,
      resolutions: [{ id: "review", label: "Review details", detail: "Find the caller", kind: "review", recommended: true }],
      recipes: [{ id: "gatk-v1", title: "Recover method", summary: "Find exact caller", version: "1", kind: "method_selection", steps: ["Read supplement"], parameters: [] }],
    }],
  },
};

test("paper setup is attention-first while supported nodes stay summarized", () => {
  assert.equal(paperAttentionItems(candidate).length, 1);
  assert.equal(paperSupportedCount(candidate), 1);
});

test("paper escalation carries exact evidence, location, choices, and recipes", () => {
  const prompt = paperResolutionAgentPrompt(candidate, candidate.assessment.items[0]);
  assert.match(prompt, /PDF page 12/);
  assert.match(prompt, /processed with GATK 3\.5/);
  assert.match(prompt, /Review details/);
  assert.match(prompt, /Read supplement/);
  assert.match(prompt, /do not make an unsupported scientific substitution/);
});

test("installing a paper candidate replaces the complete workflow document", () => {
  const document = paperCandidateDocument({
    ...candidate,
    name: "Recovered methods workflow",
    graph: {
      ...candidate.graph,
      name: "Extractor draft",
      nodes: [{ id: "fastp", operator: "qc.fastp", operator_revision: "r1", ports: [], params: {}, layout: { x: 0, y: 0 } }],
      annotations: undefined,
      variant_origin: undefined,
    },
  });
  assert.equal(document.name, "Recovered methods workflow");
  assert.deepEqual(document.annotations, []);
  assert.equal(document.variant_origin, undefined);
  assert.deepEqual(document.nodes[0]?.layout, { x: 0, y: 0 });
});

test("a cited run replaces the next local read placeholder without disturbing its consumers", () => {
  const graph = {
    schema_version: 3,
    nodes: [
      { id: "reads", operator: "files.import_paired", operator_revision: "r1", ports: [{ name: "r1", dir: "out" as const, ty: "Fastq" as const }, { name: "r2", dir: "out" as const, ty: "Fastq" as const }], params: {}, layout: { x: 20, y: 40 } },
      { id: "fastp", operator: "qc.fastp", operator_revision: "r2", ports: [], params: {}, layout: { x: 300, y: 40 } },
    ],
    edges: [
      { id: "old-r1", from_node: "reads", from_port: "r1", to_node: "fastp", to_port: "r1" },
      { id: "old-r2", from_node: "reads", from_port: "r2", to_node: "fastp", to_port: "r2" },
    ],
  };
  const candidateWithSlot = { ...candidate, graph };
  assert.equal(nextPaperReadSlot(candidateWithSlot, "paired")?.id, "reads");
  assert.equal(nextPaperReadSlot(candidateWithSlot, "single"), null);
  const prefetch = { id: "reads-fetch", operator: "sra.prefetch", operator_revision: "r3", ports: [{ name: "sra", dir: "out" as const, ty: "Sra" as const }], params: { accession: "SRR123456" }, layout: { x: 20, y: 40 } };
  const fasterq = { id: "reads-fastq", operator: "sra.fasterq_dump", operator_revision: "r4", ports: [{ name: "sra", dir: "in" as const, ty: "Sra" as const }, { name: "r1", dir: "out" as const, ty: "Fastq" as const }, { name: "r2", dir: "out" as const, ty: "Fastq" as const }], params: {}, layout: { x: 240, y: 40 } };
  const replaced = replacePaperReadSlot(graph, "reads", prefetch, fasterq);
  assert.equal(replaced.nodes.some((node) => node.id === "reads"), false);
  assert.deepEqual(replaced.edges.map((edge) => [edge.from_node, edge.from_port, edge.to_node, edge.to_port]), [
    ["reads-fastq", "r1", "fastp", "r1"],
    ["reads-fastq", "r2", "fastp", "r2"],
    ["reads-fetch", "sra", "reads-fastq", "sra"],
  ]);
  assert.equal(paperResourceApplied({ ...candidate, graph: replaced }, "SRR123456"), true);
  const canvas = {
    ...graph,
    nodes: [
      { ...graph.nodes[0], layout: { x: 80, y: 90 }, color: "blue" as const },
      graph.nodes[1],
      { id: "notes-export", operator: "files.import", operator_revision: "r5", ports: [], params: { path: "notes.txt" }, layout: { x: 500, y: 80 } },
    ],
    edges: [...graph.edges, { id: "user-edge", from_node: "fastp", from_port: "report", to_node: "notes-export", to_port: "file" }],
  };
  const synced = paperCanvasUpdate(0, 0, graph, replaced, canvas);
  assert.ok(synced, "an applied paper candidate must update the visible canvas");
  assert.equal(synced.nodes.some((node) => node.id === "reads"), false);
  assert.equal(synced.nodes.some((node) => node.id === "reads-fetch"), true);
  assert.equal(synced.nodes.some((node) => node.id === "notes-export"), true, "unrelated canvas nodes survive");
  assert.equal(synced.edges.some((edge) => edge.id === "user-edge"), true, "unrelated canvas edges survive");
  assert.equal(paperCanvasUpdate(null, 0, graph, replaced, canvas), null, "an off-canvas draft must remain off canvas");

  const deletedCanvas: SomiteGraph = { schema_version: 3, nodes: [], edges: [] };
  assert.equal(paperCanvasOwnsCandidate(graph, deletedCanvas), false);
  assert.equal(paperCanvasUpdate(0, 0, graph, replaced, deletedCanvas), null, "a deleted candidate slice loses canvas ownership");

  const sourceCanvas: SomiteGraph = {
    schema_version: 3,
    nodes: [{
      ...graph.nodes[0],
      id: "pangenome",
      operator: "workflow.source",
      source_workflow: {} as never,
    }],
    edges: [],
  };
  assert.equal(paperCanvasOwnsCandidate(graph, sourceCanvas), false);
  assert.equal(paperCanvasUpdate(0, 0, graph, replaced, sourceCanvas), null, "a stale paper action cannot mix native nodes into a source-owned canvas");
});

test("a cited single-end run replaces only a single-read placeholder", () => {
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "reads", operator: "files.import", operator_revision: "r1", ports: [{ name: "file", dir: "out", ty: "Fastq" }], params: {}, layout: { x: 20, y: 40 } },
      { id: "fastqc", operator: "qc.fastqc", operator_revision: "r2", ports: [], params: {}, layout: { x: 300, y: 40 } },
    ],
    edges: [{ id: "old-reads", from_node: "reads", from_port: "file", to_node: "fastqc", to_port: "reads" }],
  };
  const candidateWithSlot = { ...candidate, graph };
  assert.equal(nextPaperReadSlot(candidateWithSlot, "single")?.id, "reads");
  const prefetch = { id: "reads-fetch", operator: "sra.prefetch", operator_revision: "r3", ports: [{ name: "sra", dir: "out" as const, ty: "Sra" as const }], params: { accession: "SRR123456" }, layout: { x: 20, y: 40 } };
  const fasterq = { id: "reads-fastq", operator: "sra.fasterq_dump_single", operator_revision: "r4", ports: [{ name: "sra", dir: "in" as const, ty: "Sra" as const }, { name: "reads", dir: "out" as const, ty: "Fastq" as const }], params: {}, layout: { x: 240, y: 40 } };
  const replaced = replacePaperReadSlot(graph, "reads", prefetch, fasterq);
  assert.deepEqual(replaced.edges.map((edge) => [edge.from_node, edge.from_port, edge.to_node, edge.to_port]), [
    ["reads-fastq", "reads", "fastqc", "reads"],
    ["reads-fetch", "sra", "reads-fastq", "sra"],
  ]);
});

test("a paired cited run fills both exact downstream roles from an unresolved-layout placeholder", () => {
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "reads", operator: "files.import", operator_revision: "r1", ports: [{ name: "file", dir: "out", ty: "Fastq" }], params: {}, layout: { x: 20, y: 40 } },
      { id: "fastp", operator: "qc.fastp", operator_revision: "r2", ports: [{ name: "r1", dir: "in", ty: "Fastq", union: ["Fastq", "FastqGz"] }, { name: "r2", dir: "in", ty: "Fastq", union: ["Fastq", "FastqGz"], optional: true }], params: {}, layout: { x: 300, y: 40 } },
    ],
    edges: [{ id: "old-reads", from_node: "reads", from_port: "file", to_node: "fastp", to_port: "r1" }],
  };
  const candidateWithSlot = { ...candidate, graph };
  assert.equal(nextPaperReadSlot(candidateWithSlot, "paired")?.id, "reads");
  const prefetch = { id: "reads-fetch", operator: "sra.prefetch", operator_revision: "r3", ports: [{ name: "sra", dir: "out" as const, ty: "Sra" as const }], params: { accession: "SRR123456" }, layout: { x: 20, y: 40 } };
  const fasterq = { id: "reads-fastq", operator: "sra.fasterq_dump", operator_revision: "r4", ports: [{ name: "sra", dir: "in" as const, ty: "Sra" as const }, { name: "r1", dir: "out" as const, ty: "Fastq" as const }, { name: "r2", dir: "out" as const, ty: "Fastq" as const }], params: {}, layout: { x: 240, y: 40 } };
  const replaced = replacePaperReadSlot(graph, "reads", prefetch, fasterq);
  assert.deepEqual(replaced.edges.map((edge) => [edge.from_node, edge.from_port, edge.to_node, edge.to_port]), [
    ["reads-fastq", "r1", "fastp", "r1"],
    ["reads-fastq", "r2", "fastp", "r2"],
    ["reads-fetch", "sra", "reads-fastq", "sra"],
  ]);
});

test("a paired cited run cannot replace an unresolved placeholder feeding a generic one-port consumer", () => {
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "reads", operator: "files.import", operator_revision: "r1", ports: [{ name: "file", dir: "out", ty: "Fastq" }], params: {}, layout: { x: 20, y: 40 } },
      { id: "fastqc", operator: "qc.fastqc", operator_revision: "r2", ports: [{ name: "reads", dir: "in", ty: "Fastq" }], params: {}, layout: { x: 300, y: 40 } },
    ],
    edges: [{ id: "old-reads", from_node: "reads", from_port: "file", to_node: "fastqc", to_port: "reads" }],
  };
  assert.equal(nextPaperReadSlot({ ...candidate, graph }, "paired"), null);
  const prefetch = { id: "reads-fetch", operator: "sra.prefetch", operator_revision: "r3", ports: [{ name: "sra", dir: "out" as const, ty: "Sra" as const }], params: { accession: "SRR123456" }, layout: { x: 20, y: 40 } };
  const fasterq = { id: "reads-fastq", operator: "sra.fasterq_dump", operator_revision: "r4", ports: [{ name: "sra", dir: "in" as const, ty: "Sra" as const }, { name: "r1", dir: "out" as const, ty: "Fastq" as const }, { name: "r2", dir: "out" as const, ty: "Fastq" as const }], params: {}, layout: { x: 240, y: 40 } };
  assert.equal(replacePaperReadSlot(graph, "reads", prefetch, fasterq), graph);
});

test("a paired cited run cannot replace a placeholder when another source already owns a mate role", () => {
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "reads", operator: "files.import", operator_revision: "r1", ports: [{ name: "file", dir: "out", ty: "Fastq" }], params: {}, layout: { x: 20, y: 40 } },
      { id: "other-reads", operator: "files.import", operator_revision: "r1", ports: [{ name: "file", dir: "out", ty: "Fastq" }], params: { path: "mate.fastq" }, layout: { x: 20, y: 160 } },
      { id: "fastp", operator: "qc.fastp", operator_revision: "r2", ports: [{ name: "r1", dir: "in", ty: "Fastq" }, { name: "r2", dir: "in", ty: "Fastq", optional: true }], params: {}, layout: { x: 300, y: 40 } },
    ],
    edges: [
      { id: "old-r1", from_node: "reads", from_port: "file", to_node: "fastp", to_port: "r1" },
      { id: "other-r2", from_node: "other-reads", from_port: "file", to_node: "fastp", to_port: "r2" },
    ],
  };
  assert.equal(nextPaperReadSlot({ ...candidate, graph }, "paired"), null);
  const prefetch = { id: "reads-fetch", operator: "sra.prefetch", operator_revision: "r3", ports: [{ name: "sra", dir: "out" as const, ty: "Sra" as const }], params: { accession: "SRR123456" }, layout: { x: 20, y: 40 } };
  const fasterq = { id: "reads-fastq", operator: "sra.fasterq_dump", operator_revision: "r4", ports: [{ name: "sra", dir: "in" as const, ty: "Sra" as const }, { name: "r1", dir: "out" as const, ty: "Fastq" as const }, { name: "r2", dir: "out" as const, ty: "Fastq" as const }], params: {}, layout: { x: 240, y: 40 } };
  assert.equal(replacePaperReadSlot(graph, "reads", prefetch, fasterq), graph);
});

test("a paired cited run preserves explicit r1 and r2 downstream roles", () => {
  const graph: SomiteGraph = {
    schema_version: 3,
    nodes: [
      { id: "reads", operator: "files.import", operator_revision: "r1", ports: [{ name: "file", dir: "out", ty: "Fastq" }], params: {}, layout: { x: 20, y: 40 } },
      { id: "fastp", operator: "qc.fastp", operator_revision: "r2", ports: [{ name: "r1", dir: "in", ty: "Fastq" }, { name: "r2", dir: "in", ty: "Fastq", optional: true }], params: {}, layout: { x: 300, y: 40 } },
    ],
    edges: [
      { id: "old-r1", from_node: "reads", from_port: "file", to_node: "fastp", to_port: "r1" },
      { id: "old-r2", from_node: "reads", from_port: "file", to_node: "fastp", to_port: "r2" },
    ],
  };
  const candidateWithSlot = { ...candidate, graph };
  assert.equal(nextPaperReadSlot(candidateWithSlot, "paired")?.id, "reads");
  const prefetch = { id: "reads-fetch", operator: "sra.prefetch", operator_revision: "r3", ports: [{ name: "sra", dir: "out" as const, ty: "Sra" as const }], params: { accession: "SRR123456" }, layout: { x: 20, y: 40 } };
  const fasterq = { id: "reads-fastq", operator: "sra.fasterq_dump", operator_revision: "r4", ports: [{ name: "sra", dir: "in" as const, ty: "Sra" as const }, { name: "r1", dir: "out" as const, ty: "Fastq" as const }, { name: "r2", dir: "out" as const, ty: "Fastq" as const }], params: {}, layout: { x: 240, y: 40 } };
  const replaced = replacePaperReadSlot(graph, "reads", prefetch, fasterq);
  assert.deepEqual(replaced.edges.map((edge) => [edge.from_node, edge.from_port, edge.to_node, edge.to_port]), [
    ["reads-fastq", "r1", "fastp", "r1"],
    ["reads-fastq", "r2", "fastp", "r2"],
    ["reads-fetch", "sra", "reads-fastq", "sra"],
  ]);
});
