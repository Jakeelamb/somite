import type { SomiteGraph } from "./model.ts";
import { semanticGraphRevision, validateGraph } from "./workflow.ts";

export const REPRESENTATIVE_FASTQ_PACK = "somite.fastq.paired.v1";
export const SOURCE_PREVIEW_PACK = "somite.source.preview.v1";

export type MaterializedFastqFixture = Readonly<{ path: string; digest: string }>;

export type FixtureBinding = Readonly<{
  fixture_pack: string;
  configuration_digest: string;
  fixture_digests: readonly string[];
  bindings: Readonly<Record<string, string>>;
  graph: SomiteGraph;
}>;

export type RepresentativeValidationCapability =
  | Readonly<{ supported: true; fixture_pack: typeof REPRESENTATIVE_FASTQ_PACK }>
  | Readonly<{ supported: true; kind: "source_preview"; fixture_pack: typeof SOURCE_PREVIEW_PACK }>
  | Readonly<{ supported: false; code: "representative_fixture_unsupported"; reason: string; unsupported_roots: string[] }>;

export class RepresentativeValidationError extends Error {
  readonly code = "representative_fixture_unsupported" as const;
  readonly capability: Extract<RepresentativeValidationCapability, { supported: false }>;

  constructor(capability: Extract<RepresentativeValidationCapability, { supported: false }>) {
    super(capability.reason);
    this.name = "RepresentativeValidationError";
    this.capability = capability;
  }
}

function representativeSourceParametersAreBindable(node: SomiteGraph["nodes"][number]) {
  if (node.operator === "files.import") return typeof node.params?.path === "string";
  if (node.operator === "files.import_paired") {
    return typeof node.params?.r1 === "string" && typeof node.params?.r2 === "string";
  }
  return false;
}

/** The exact fixture capability shared by browser affordances and the runner. */
export function representativeValidationCapability(graph: SomiteGraph): RepresentativeValidationCapability {
  const source = graph.nodes.length === 1 && graph.edges.length === 0 ? graph.nodes[0]?.source_workflow : undefined;
  if (source?.capabilities?.exact_execution) {
    return { supported: true, kind: "source_preview", fixture_pack: SOURCE_PREVIEW_PACK };
  }
  const roots = graph.nodes.filter((node) => {
    const hasInbound = graph.edges.some((edge) => edge.to_node === node.id);
    const hasInputPort = node.ports.some((port) => port.dir === "in");
    return !hasInbound && !hasInputPort;
  });
  const unsupportedRoots = roots.filter((node) => !representativeSourceParametersAreBindable(node)).map((node) => node.operator);
  if (graph.nodes.length > 0 && roots.length > 0 && unsupportedRoots.length === 0) {
    return { supported: true, fixture_pack: REPRESENTATIVE_FASTQ_PACK };
  }
  const shown = [...new Set(unsupportedRoots)].sort();
  const starts = shown.length ? shown.join(", ") : graph.nodes.length ? "no bindable root input" : "an empty canvas";
  return {
    supported: false,
    code: "representative_fixture_unsupported",
    reason: `Representative validation currently supports workflows rooted in local single or paired FASTQ inputs. This workflow starts with ${starts}; Run can still use its real inputs, but Validate is unavailable until a reviewed fixture adapter exists.`,
    unsupported_roots: shown,
  };
}

function cloneGraph(graph: SomiteGraph) {
  return structuredClone(graph);
}

function setStringParameter(graph: SomiteGraph, nodeId: string, parameter: string, value: string) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)!;
  if (typeof node.params?.[parameter] !== "string") {
    throw new Error(`source node ${nodeId} is missing parameter ${parameter}`);
  }
  node.params![parameter] = value;
}

/** Bind one content-addressed local FASTQ pack without doing filesystem work. */
export function bindRepresentativeFastq(
  graph: SomiteGraph,
  fixtures: Readonly<{ readOne: MaterializedFastqFixture; readTwo: MaterializedFastqFixture }>,
): FixtureBinding {
  const validation = validateGraph(graph);
  if (!validation.ok) throw new Error(`invalid graph: ${validation.issue.message}`);
  const capability = representativeValidationCapability(graph);
  if (!capability.supported) throw new RepresentativeValidationError(capability);
  if (capability.fixture_pack !== REPRESENTATIVE_FASTQ_PACK) {
    throw new Error(`${capability.fixture_pack} is not a representative FASTQ binding`);
  }
  const runnable = cloneGraph(graph);
  const normalized = cloneGraph(graph);
  const digests = new Set<string>();
  const bindings: Record<string, string> = {};

  for (const node of graph.nodes) {
    const hasInbound = graph.edges.some((edge) => edge.to_node === node.id);
    const hasInputPort = node.ports.some((port) => port.dir === "in");
    if (hasInbound || hasInputPort) continue;
    const parameters: readonly (readonly [string, MaterializedFastqFixture])[] = node.operator === "files.import"
      ? [["path", fixtures.readOne]]
      : node.operator === "files.import_paired"
        ? [["r1", fixtures.readOne], ["r2", fixtures.readTwo]]
        : (() => { throw new Error(`source node ${node.id} uses unsupported validation source ${node.operator}`); })();
    for (const [parameter, fixture] of parameters) {
      setStringParameter(runnable, node.id, parameter, fixture.path);
      setStringParameter(normalized, node.id, parameter, `fixture:${fixture.digest}`);
      digests.add(fixture.digest);
      bindings[`${node.id}.${parameter}`] = fixture.digest;
    }
  }
  return {
    fixture_pack: REPRESENTATIVE_FASTQ_PACK,
    configuration_digest: semanticGraphRevision(normalized),
    fixture_digests: [...digests].sort(),
    bindings: Object.fromEntries(Object.entries(bindings).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    graph: runnable,
  };
}
