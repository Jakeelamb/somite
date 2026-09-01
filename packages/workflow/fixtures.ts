import type { OperatorCatalog } from "./catalog.ts";
import type { ParamValue, SomiteGraph } from "./model.ts";
import {
  bindRepresentativeSourceFixtures,
  representativeSourcePlan,
  type MaterializedFixture,
  type RepresentativeFixtureSet,
} from "./representativeSources.ts";
import { semanticGraphRevision, validateGraph } from "./workflow.ts";

export type { MaterializedFixture, RepresentativeFixtureSet } from "./representativeSources.ts";

export const REPRESENTATIVE_FASTQ_PACK = "somite.fastq.paired.v1";
export const REPRESENTATIVE_SOURCE_PACK = "somite.sources.representative.v1";
export const SOURCE_PREVIEW_PACK = "somite.source.preview.v1";

export type FixtureBinding = Readonly<{
  fixture_pack: string;
  configuration_digest: string;
  fixture_digests: readonly string[];
  bindings: Readonly<Record<string, string>>;
  graph: SomiteGraph;
  /** Original public retrieval nodes intentionally bypassed by local fixtures. */
  unexercised_nodes?: readonly string[];
  /** Fixture-only parameter values required by the tiny reviewed data pack. */
  parameter_overrides?: Readonly<Record<string, ParamValue>>;
}>;

export type RepresentativeValidationCapability =
  | Readonly<{ supported: true; fixture_pack: typeof REPRESENTATIVE_FASTQ_PACK }>
  | Readonly<{
    supported: true;
    fixture_pack: typeof REPRESENTATIVE_SOURCE_PACK;
    unexercised_nodes: readonly string[];
    parameter_overrides?: Readonly<Record<string, ParamValue>>;
  }>
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

/** The exact fixture capability shared by browser affordances and the runner. */
export function representativeValidationCapability(graph: SomiteGraph): RepresentativeValidationCapability {
  const source = graph.nodes.length === 1 && graph.edges.length === 0 ? graph.nodes[0]?.source_workflow : undefined;
  if (source?.capabilities?.exact_execution) {
    return { supported: true, kind: "source_preview", fixture_pack: SOURCE_PREVIEW_PACK };
  }
  const plan = representativeSourcePlan(graph);
  if (graph.nodes.length > 0 && plan.root_count > 0 && plan.unsupported_roots.length === 0 && plan.requires_source_pack) {
    return {
      supported: true,
      fixture_pack: REPRESENTATIVE_SOURCE_PACK,
      unexercised_nodes: plan.unexercised_nodes,
      ...(plan.parameter_overrides ? { parameter_overrides: plan.parameter_overrides } : {}),
    };
  }
  if (graph.nodes.length > 0 && plan.root_count > 0 && plan.unsupported_roots.length === 0) {
    return { supported: true, fixture_pack: REPRESENTATIVE_FASTQ_PACK };
  }
  const shown = [...new Set(plan.unsupported_roots)].sort();
  const starts = shown.length ? shown.join(", ") : graph.nodes.length ? "no bindable root input" : "an empty canvas";
  return {
    supported: false,
    code: "representative_fixture_unsupported",
    reason: `Representative validation supports reviewed local FASTQ, compressed FASTQ, FASTA, compressed FASTA, BAM, GTF, and GFF3 fixtures plus exact SRA, NCBI assembly, and Ensembl source shapes. This workflow starts with ${starts}; Run can still use its real inputs, but Validate is unavailable until a reviewed fixture adapter exists.`,
    unsupported_roots: shown,
  };
}

/** Bind exact typed local/public roots without doing filesystem or network work. */
export function bindRepresentativeInputs(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  fixtures: RepresentativeFixtureSet,
): FixtureBinding {
  const capability = representativeValidationCapability(graph);
  if (!capability.supported) throw new RepresentativeValidationError(capability);
  if (capability.fixture_pack === REPRESENTATIVE_FASTQ_PACK) return bindRepresentativeFastq(graph, fixtures);
  if (capability.fixture_pack !== REPRESENTATIVE_SOURCE_PACK) {
    throw new Error(`${capability.fixture_pack} is not a native representative fixture binding`);
  }
  return { fixture_pack: REPRESENTATIVE_SOURCE_PACK, ...bindRepresentativeSourceFixtures(graph, catalog, fixtures) };
}

function setStringParameter(graph: SomiteGraph, nodeId: string, parameter: string, value: string) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)!;
  if (typeof node.params?.[parameter] !== "string") throw new Error(`source node ${nodeId} is missing parameter ${parameter}`);
  node.params[parameter] = value;
}

/** Bind one content-addressed local FASTQ pack without doing filesystem work. */
export function bindRepresentativeFastq(
  graph: SomiteGraph,
  fixtures: Readonly<{ readOne: MaterializedFixture; readTwo: MaterializedFixture }>,
): FixtureBinding {
  const validation = validateGraph(graph);
  if (!validation.ok) throw new Error(`invalid graph: ${validation.issue.message}`);
  const capability = representativeValidationCapability(graph);
  if (!capability.supported) throw new RepresentativeValidationError(capability);
  if (capability.fixture_pack !== REPRESENTATIVE_FASTQ_PACK) {
    throw new Error(`${capability.fixture_pack} is not a representative FASTQ binding`);
  }
  const runnable = structuredClone(graph);
  const normalized = structuredClone(graph);
  const digests = new Set<string>();
  const bindings: Record<string, string> = {};

  for (const node of graph.nodes) {
    const hasInbound = graph.edges.some((edge) => edge.to_node === node.id);
    const hasInputPort = node.ports.some((port) => port.dir === "in");
    if (hasInbound || hasInputPort) continue;
    const parameters: readonly (readonly [string, MaterializedFixture])[] = node.operator === "files.import"
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
