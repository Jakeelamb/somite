import assert from "node:assert/strict";
import test from "node:test";

import { parseGraph } from "../graphCodec.ts";
import {
  GRAPH_SCHEMA_VERSION,
  type CanvasAnnotation,
  type CanvasColor,
  type PortType,
  type SomiteGraph,
  type SomiteGraphNode,
} from "../model.ts";
import { graphStateRevision, topologicalOrder, validateGraph } from "../workflow.ts";

const SEED = 0x50_4f_4d_49;
const VALID_CASES = 64;
const PORT_TYPES: readonly PortType[] = [
  "Sra", "Fastq", "FastqGz", "Fasta", "FastaGz", "Gtf", "GtfGz", "Gff3", "Sam", "Bam", "ReadGroupedBam", "GatkReadyBam", "Bai", "Fai", "Dict",
  "Vcf", "VcfGz", "Bed", "Agp", "Chain", "Table", "Json", "Html", "Image", "Zip", "Directory", "Text", "Preview",
];
const COLORS: readonly CanvasColor[] = ["yellow", "orange", "rose", "violet", "blue", "teal", "green", "gray"];

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return {
    integer(limit: number) {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) % limit;
    },
  };
}

function differentPortType(type: PortType, offset: number) {
  const index = PORT_TYPES.indexOf(type);
  return PORT_TYPES[(index + 1 + offset) % PORT_TYPES.length]!;
}

function annotation(caseIndex: number, random: ReturnType<typeof seededRandom>): CanvasAnnotation {
  const id = `annotation-${caseIndex}`;
  const color = COLORS[caseIndex % COLORS.length]!;
  if (caseIndex % 3 === 2) {
    const points = Array.from({ length: 2 + random.integer(7) }, (_, pointIndex) => ({
      x: caseIndex * 11.25 + pointIndex,
      y: random.integer(2_000) / 10 - 100,
    }));
    return { id, kind: "stroke", color, points };
  }
  return {
    id,
    kind: caseIndex % 3 === 0 ? "sticky" : "box",
    text: `Case ${caseIndex} evidence\nseed ${SEED.toString(16)} 🧬`,
    color,
    layout: { x: random.integer(2_000) / 10 - 100, y: random.integer(2_000) / 10 - 100 },
    width: 80 + random.integer(1_200),
    height: 60 + random.integer(800),
  };
}

function generatedGraph(caseIndex: number): SomiteGraph {
  const random = seededRandom(SEED ^ Math.imul(caseIndex + 1, 0x9e3779b1));
  const nodeCount = 2 + random.integer(5);
  const nodes: SomiteGraphNode[] = [];
  const edges: SomiteGraph["edges"] = [];
  let previousOutput: PortType | undefined;

  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    const output = PORT_TYPES[(caseIndex + nodeIndex * 7) % PORT_TYPES.length]!;
    const ports: SomiteGraphNode["ports"] = [];
    if (previousOutput) {
      const acceptsUnion = (caseIndex + nodeIndex) % 2 === 0;
      ports.push({
        name: "input",
        dir: "in",
        ty: acceptsUnion ? differentPortType(previousOutput, caseIndex) : previousOutput,
        ...(acceptsUnion ? { union: [previousOutput, differentPortType(previousOutput, caseIndex + 3)] } : {}),
        ...((caseIndex + nodeIndex) % 4 === 0 ? { optional: true } : {}),
      });
    }
    ports.push({ name: "output", dir: "out", ty: output });

    const id = `case-${caseIndex}-node-${nodeIndex}`;
    nodes.push({
      id,
      operator: `generated.tool.${nodeIndex}`,
      operator_revision: `blake3:${(caseIndex * 101 + nodeIndex).toString(16).padStart(64, "0")}`,
      ports,
      params: {
        label: `sample-${caseIndex}-${nodeIndex}-β`,
        enabled: (caseIndex + nodeIndex) % 2 === 0,
        threshold: random.integer(10_000) / 37 + 0.125,
        exact_count: Number.MAX_SAFE_INTEGER - caseIndex - nodeIndex,
      },
      layout: {
        x: random.integer(40_000) / 10 - 2_000,
        y: random.integer(40_000) / 10 - 2_000,
      },
      ...((caseIndex + nodeIndex) % 3 === 0 ? { note: `Stage ${nodeIndex}\nreviewed` } : {}),
      ...((caseIndex + nodeIndex) % 4 === 0 ? { color: COLORS[(caseIndex + nodeIndex) % COLORS.length]! } : {}),
    });

    if (nodeIndex > 0) {
      edges.push({
        id: `case-${caseIndex}-edge-${nodeIndex - 1}`,
        from_node: nodes[nodeIndex - 1]!.id,
        from_port: "output",
        to_node: id,
        to_port: "input",
      });
    }
    previousOutput = output;
  }

  return {
    schema_version: GRAPH_SCHEMA_VERSION,
    name: `Seeded graph ${caseIndex} 🧬`,
    nodes,
    edges,
    annotations: [annotation(caseIndex, random)],
  };
}

function mutationBase(): SomiteGraph {
  return {
    schema_version: GRAPH_SCHEMA_VERSION,
    name: "Mutation base",
    nodes: [
      {
        id: "source-a",
        operator: "reads.a",
        operator_revision: "revision-a",
        ports: [{ name: "reads", dir: "out", ty: "Fastq" }],
        params: { label: "a", paired: true, coverage: 12.5 },
        layout: { x: 0, y: 0 },
      },
      {
        id: "source-b",
        operator: "reads.b",
        operator_revision: "revision-b",
        ports: [{ name: "reads", dir: "out", ty: "Fastq" }],
        layout: { x: 0, y: 100 },
      },
      {
        id: "sink",
        operator: "qc",
        operator_revision: "revision-c",
        ports: [
          { name: "reads", dir: "in", ty: "Fastq", union: ["FastqGz"] },
          { name: "report", dir: "out", ty: "Html" },
        ],
        layout: { x: 200, y: 50 },
      },
    ],
    edges: [{ id: "a-to-sink", from_node: "source-a", from_port: "reads", to_node: "sink", to_port: "reads" }],
    annotations: [
      { id: "note", kind: "sticky", text: "Review", color: "yellow", layout: { x: 0, y: 200 }, width: 160, height: 100 },
      { id: "mark", kind: "stroke", color: "blue", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
    ],
  };
}

test("seeded valid Graphs survive JSON transport and the runtime codec", () => {
  const seenPorts = new Set<PortType>();
  const seenParameters = new Set<string>();
  const seenAnnotations = new Set<CanvasAnnotation["kind"]>();
  const seenColors = new Set<CanvasColor>();

  for (let caseIndex = 0; caseIndex < VALID_CASES; caseIndex += 1) {
    const graph = generatedGraph(caseIndex);
    const label = `seed=0x${SEED.toString(16)} case=${caseIndex}`;
    assert.deepEqual(validateGraph(graph), { ok: true }, label);

    const transported = JSON.parse(JSON.stringify(graph)) as unknown;
    const parsed = parseGraph(transported, label);
    assert.deepEqual(parsed, graph, label);
    assert.equal(graphStateRevision(parsed), graphStateRevision(graph), label);
    assert.deepEqual(topologicalOrder(parsed), graph.nodes.map((node) => node.id), label);
    assert.deepEqual(parseGraph(JSON.parse(JSON.stringify(parsed)), `${label} second pass`), parsed, label);

    for (const node of parsed.nodes) {
      for (const port of node.ports) {
        seenPorts.add(port.ty);
        for (const type of port.union ?? []) seenPorts.add(type);
      }
      for (const value of Object.values(node.params ?? {})) seenParameters.add(typeof value);
      if (node.color) seenColors.add(node.color);
    }
    for (const item of parsed.annotations ?? []) {
      seenAnnotations.add(item.kind);
      seenColors.add(item.color);
    }
  }

  assert.deepEqual([...seenPorts].sort(), [...PORT_TYPES].sort());
  assert.deepEqual([...seenParameters].sort(), ["boolean", "number", "string"]);
  assert.deepEqual([...seenAnnotations].sort(), ["box", "sticky", "stroke"]);
  assert.deepEqual([...seenColors].sort(), [...COLORS].sort());
});

test("seeded Graph mutations fail closed at the public runtime boundary", () => {
  assert.deepEqual(validateGraph(mutationBase()), { ok: true });

  const cycle = mutationBase();
  cycle.nodes = [
    { id: "a", operator: "a", operator_revision: "a", ports: [{ name: "in", dir: "in", ty: "Text" }, { name: "out", dir: "out", ty: "Text" }], layout: { x: 0, y: 0 } },
    { id: "b", operator: "b", operator_revision: "b", ports: [{ name: "in", dir: "in", ty: "Text" }, { name: "out", dir: "out", ty: "Text" }], layout: { x: 1, y: 1 } },
  ];
  cycle.edges = [
    { id: "a-b", from_node: "a", from_port: "out", to_node: "b", to_port: "in" },
    { id: "b-a", from_node: "b", from_port: "out", to_node: "a", to_port: "in" },
  ];
  delete cycle.annotations;

  const cases: Array<{ name: string; value: () => unknown; expected: RegExp }> = [
    { name: "unknown graph field", value: () => ({ ...mutationBase(), surprise: true }), expected: /unknown field surprise/ },
    {
      name: "unknown nested field",
      value: () => {
        const graph = mutationBase();
        graph.nodes[0] = { ...graph.nodes[0]!, surprise: true } as SomiteGraphNode;
        return graph;
      },
      expected: /unknown field surprise/,
    },
    {
      name: "unsupported port type",
      value: () => {
        const graph = mutationBase();
        graph.nodes[0]!.ports[0]!.ty = "ReadsMaybe" as PortType;
        return graph;
      },
      expected: /unsupported value/,
    },
    {
      name: "unsafe integer parameter",
      value: () => {
        const graph = mutationBase();
        graph.nodes[0]!.params!.coverage = Number.MAX_SAFE_INTEGER + 1;
        return graph;
      },
      expected: /browser-stable parameter value/,
    },
    {
      name: "negative zero parameter",
      value: () => {
        const graph = mutationBase();
        graph.nodes[0]!.params!.coverage = -0;
        return graph;
      },
      expected: /browser-stable parameter value/,
    },
    {
      name: "non-finite layout",
      value: () => {
        const graph = mutationBase();
        graph.nodes[0]!.layout.x = Number.NaN;
        return graph;
      },
      expected: /must be a finite number/,
    },
    {
      name: "wrong schema",
      value: () => ({ ...mutationBase(), schema_version: GRAPH_SCHEMA_VERSION + 1 }),
      expected: /schema_version 4 != 3/,
    },
    { name: "control character in name", value: () => ({ ...mutationBase(), name: "bad\0name" }), expected: /graph name must be/ },
    {
      name: "unpinned operator",
      value: () => {
        const graph = mutationBase();
        graph.nodes[0]!.operator_revision = "  ";
        return graph;
      },
      expected: /does not pin an operator revision/,
    },
    {
      name: "duplicate id across objects",
      value: () => {
        const graph = mutationBase();
        graph.annotations![0]!.id = "source-a";
        return graph;
      },
      expected: /duplicate id source-a/,
    },
    {
      name: "unknown edge node",
      value: () => {
        const graph = mutationBase();
        graph.edges[0]!.from_node = "missing";
        return graph;
      },
      expected: /unknown node missing/,
    },
    {
      name: "unknown edge port",
      value: () => {
        const graph = mutationBase();
        graph.edges[0]!.from_port = "missing";
        return graph;
      },
      expected: /unknown port source-a\.missing/,
    },
    {
      name: "incompatible port types",
      value: () => {
        const graph = mutationBase();
        graph.nodes[2]!.ports[0] = { name: "reads", dir: "in", ty: "Fasta" };
        return graph;
      },
      expected: /type mismatch/,
    },
    {
      name: "multiple sources for a scalar input",
      value: () => {
        const graph = mutationBase();
        graph.edges.push({ id: "b-to-sink", from_node: "source-b", from_port: "reads", to_node: "sink", to_port: "reads" });
        return graph;
      },
      expected: /multiple edges target scalar input/,
    },
    {
      name: "self edge",
      value: () => {
        const graph = mutationBase();
        graph.edges[0]!.to_node = "source-a";
        return graph;
      },
      expected: /self-edge/,
    },
    { name: "cycle", value: () => cycle, expected: /cycle/ },
    {
      name: "undersized annotation",
      value: () => {
        const graph = mutationBase();
        const note = graph.annotations![0]!;
        if (note.kind !== "stroke") note.width = 79;
        return graph;
      },
      expected: /invalid canvas annotation/,
    },
    {
      name: "one-point stroke",
      value: () => {
        const graph = mutationBase();
        const stroke = graph.annotations![1]!;
        if (stroke.kind === "stroke") stroke.points = [{ x: 0, y: 0 }];
        return graph;
      },
      expected: /invalid canvas annotation/,
    },
  ];

  for (const mutation of cases) {
    assert.throws(
      () => parseGraph(mutation.value(), `seed=0x${SEED.toString(16)} mutation=${mutation.name}`),
      mutation.expected,
      mutation.name,
    );
  }
});
