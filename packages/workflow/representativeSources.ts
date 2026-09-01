import { operatorPorts, type OperatorCatalog } from "./catalog.ts";
import type { ParamValue, SomiteGraph } from "./model.ts";
import { semanticGraphRevision, validateGraph } from "./workflow.ts";

export type MaterializedFixture = Readonly<{ path: string; digest: string }>;

export type RepresentativeFixtureSet = Readonly<{
  readOne: MaterializedFixture;
  readTwo: MaterializedFixture;
  readOneGz?: MaterializedFixture;
  readTwoGz?: MaterializedFixture;
  reference?: MaterializedFixture;
  referenceGz?: MaterializedFixture;
  gtf?: MaterializedFixture;
  gff3?: MaterializedFixture;
  bam?: MaterializedFixture;
}>;

export type RepresentativeSourcePlan = Readonly<{
  root_count: number;
  unsupported_roots: readonly string[];
  requires_source_pack: boolean;
  unexercised_nodes: readonly string[];
  parameter_overrides?: Readonly<Record<string, ParamValue>>;
}>;

export type RepresentativeSourceBinding = Readonly<{
  configuration_digest: string;
  fixture_digests: readonly string[];
  bindings: Readonly<Record<string, string>>;
  graph: SomiteGraph;
  unexercised_nodes: readonly string[];
  parameter_overrides?: Readonly<Record<string, ParamValue>>;
}>;

type LocalFixtureKind =
  | "single_fastq"
  | "paired_fastq"
  | "single_fastq_gz"
  | "paired_fastq_gz"
  | "fasta"
  | "fasta_gz"
  | "gtf"
  | "gff3"
  | "bam";
type AssemblyFixtureOutput = "genome" | "gtf" | "gff3";

type PublicFixtureAdapter =
  | Readonly<{ kind: "sra"; fetch_node: string; conversion_node: string; paired: boolean }>
  | Readonly<{ kind: "ncbi_assembly"; download_node: string; extraction_node: string; outputs: readonly AssemblyFixtureOutput[] }>
  | Readonly<{
    kind: "direct_public";
    source_node: string;
    output_port: string;
    local_operator: "files.import_fasta" | "files.import_gtf";
    local_port: "assembly" | "gtf";
    fixture: "reference" | "gtf";
  }>
  | Readonly<{ kind: "compressed_fasta"; download_node: string; decompression_node: string }>;

function localFixtureKind(node: SomiteGraph["nodes"][number]): LocalFixtureKind | null {
  if (node.operator === "files.import" && typeof node.params?.path === "string") return "single_fastq";
  if (node.operator === "files.import_paired"
    && typeof node.params?.r1 === "string" && typeof node.params?.r2 === "string") return "paired_fastq";
  if (node.operator === "files.import_fastq_gz" && typeof node.params?.path === "string") return "single_fastq_gz";
  if (node.operator === "files.import_paired_gz"
    && typeof node.params?.r1 === "string" && typeof node.params?.r2 === "string") return "paired_fastq_gz";
  if (node.operator === "files.import_fasta" && typeof node.params?.path === "string") return "fasta";
  if (node.operator === "files.import_fasta_gz" && typeof node.params?.path === "string") return "fasta_gz";
  if (node.operator === "files.import_gtf" && typeof node.params?.path === "string") return "gtf";
  if (node.operator === "files.import_gff3" && typeof node.params?.path === "string") return "gff3";
  if (node.operator === "files.import_bam" && typeof node.params?.path === "string") return "bam";
  return null;
}

function outgoingEdges(graph: SomiteGraph, nodeId: string) {
  return graph.edges.filter((edge) => edge.from_node === nodeId);
}

function incomingEdges(graph: SomiteGraph, nodeId: string) {
  return graph.edges.filter((edge) => edge.to_node === nodeId);
}

function sraAdapter(graph: SomiteGraph, fetchNodeId: string): PublicFixtureAdapter | null {
  const fetch = graph.nodes.find((node) => node.id === fetchNodeId);
  if (fetch?.operator !== "sra.prefetch") return null;
  const fetchOutputs = outgoingEdges(graph, fetch.id);
  if (fetchOutputs.length !== 1) return null;
  const link = fetchOutputs[0]!;
  if (link.from_port !== "sra" || link.to_port !== "sra") return null;
  const conversion = graph.nodes.find((node) => node.id === link.to_node);
  const paired = conversion?.operator === "sra.fasterq_dump";
  if (!paired && conversion?.operator !== "sra.fasterq_dump_single") return null;
  if (incomingEdges(graph, conversion.id).length !== 1 || incomingEdges(graph, conversion.id)[0]?.id !== link.id) return null;
  const expectedOutputs = paired ? new Set(["r1", "r2"]) : new Set(["reads"]);
  const usedOutputs = outgoingEdges(graph, conversion.id);
  if (usedOutputs.length === 0 || usedOutputs.some((edge) => !expectedOutputs.has(edge.from_port))) return null;
  return { kind: "sra", fetch_node: fetch.id, conversion_node: conversion.id, paired };
}

function assemblyAdapter(graph: SomiteGraph, downloadNodeId: string): PublicFixtureAdapter | null {
  const download = graph.nodes.find((node) => node.id === downloadNodeId);
  if (download?.operator !== "ncbi.datasets_assembly") return null;
  const downloadOutputs = outgoingEdges(graph, download.id);
  if (downloadOutputs.length !== 1) return null;
  const link = downloadOutputs[0]!;
  if (link.from_port !== "package" || link.to_port !== "package") return null;
  const extraction = graph.nodes.find((node) => node.id === link.to_node);
  if (extraction?.operator !== "ncbi.datasets_extract_assembly") return null;
  const extractionInputs = incomingEdges(graph, extraction.id);
  if (extractionInputs.length !== 1 || extractionInputs[0]?.id !== link.id) return null;
  const usedOutputs = outgoingEdges(graph, extraction.id);
  const supported = new Set<AssemblyFixtureOutput>(["genome", "gtf", "gff3"]);
  if (usedOutputs.length === 0 || usedOutputs.some((edge) => !supported.has(edge.from_port as AssemblyFixtureOutput))) return null;
  return {
    kind: "ncbi_assembly",
    download_node: download.id,
    extraction_node: extraction.id,
    outputs: [...new Set(usedOutputs.map((edge) => edge.from_port as AssemblyFixtureOutput))].sort(),
  };
}

function directPublicAdapter(graph: SomiteGraph, sourceNodeId: string): PublicFixtureAdapter | null {
  const source = graph.nodes.find((node) => node.id === sourceNodeId);
  if (!source) return null;
  const candidate = source.operator === "ensembl.sequence" && source.params?.sequence_type !== "protein"
    ? { output_port: "fasta", local_operator: "files.import_fasta" as const, local_port: "assembly" as const, fixture: "reference" as const }
    : source.operator === "ensembl.gtf"
      ? { output_port: "gtf", local_operator: "files.import_gtf" as const, local_port: "gtf" as const, fixture: "gtf" as const }
      : null;
  if (!candidate) return null;
  const outputs = outgoingEdges(graph, source.id);
  if (outputs.length === 0 || outputs.some((edge) => edge.from_port !== candidate.output_port)) return null;
  const replacementType = candidate.fixture === "reference" ? "Fasta" : "Gtf";
  for (const edge of outputs) {
    const target = graph.nodes.find((node) => node.id === edge.to_node);
    const port = target?.ports.find((item) => item.dir === "in" && item.name === edge.to_port);
    if (!port || (port.ty !== replacementType && !(port.union ?? []).includes(replacementType))) return null;
  }
  return { kind: "direct_public", source_node: source.id, ...candidate };
}

function compressedFastaAdapter(graph: SomiteGraph, downloadNodeId: string): PublicFixtureAdapter | null {
  const download = graph.nodes.find((node) => node.id === downloadNodeId);
  if (download?.operator !== "ensembl.fasta") return null;
  const downloadOutputs = outgoingEdges(graph, download.id);
  if (downloadOutputs.length !== 1) return null;
  const link = downloadOutputs[0]!;
  if (link.from_port !== "fasta" || link.to_port !== "compressed") return null;
  const decompression = graph.nodes.find((node) => node.id === link.to_node);
  if (decompression?.operator !== "archive.gunzip_fasta") return null;
  const decompressionInputs = incomingEdges(graph, decompression.id);
  if (decompressionInputs.length !== 1 || decompressionInputs[0]?.id !== link.id) return null;
  const outputs = outgoingEdges(graph, decompression.id);
  if (outputs.length === 0 || outputs.some((edge) => edge.from_port !== "fasta")) return null;
  return { kind: "compressed_fasta", download_node: download.id, decompression_node: decompression.id };
}

function parameterOverrides(graph: SomiteGraph) {
  return Object.fromEntries(graph.nodes
    .filter((node) => node.operator === "align.star_index"
      && (node.params?.genome_sa_index_nbases === undefined
        || (typeof node.params.genome_sa_index_nbases === "number" && node.params.genome_sa_index_nbases > 1)))
    .map((node) => [`${node.id}.genome_sa_index_nbases`, 1]));
}

function internalPlan(graph: SomiteGraph) {
  const roots = graph.nodes.filter((node) => {
    const hasInbound = graph.edges.some((edge) => edge.to_node === node.id);
    const hasInputPort = node.ports.some((port) => port.dir === "in");
    return !hasInbound && !hasInputPort;
  });
  const adapters: PublicFixtureAdapter[] = [];
  const unsupported: string[] = [];
  let hasTypedBiologicalFixture = false;
  for (const root of roots) {
    const localKind = localFixtureKind(root);
    if (localKind) {
      if (localKind !== "single_fastq" && localKind !== "paired_fastq") hasTypedBiologicalFixture = true;
      continue;
    }
    const adapter = sraAdapter(graph, root.id)
      ?? assemblyAdapter(graph, root.id)
      ?? compressedFastaAdapter(graph, root.id)
      ?? directPublicAdapter(graph, root.id);
    if (adapter) adapters.push(adapter);
    else unsupported.push(root.operator);
  }
  const overrides = parameterOverrides(graph);
  return { roots, adapters, unsupported, hasTypedBiologicalFixture, overrides };
}

/** Recognize only reviewed local/public source shapes; unknown shapes fail closed. */
export function representativeSourcePlan(graph: SomiteGraph): RepresentativeSourcePlan {
  const plan = internalPlan(graph);
  const unexercised = plan.adapters.flatMap((adapter) => adapter.kind === "sra"
    ? [adapter.fetch_node, adapter.conversion_node]
    : adapter.kind === "ncbi_assembly"
      ? [adapter.download_node, adapter.extraction_node]
      : adapter.kind === "compressed_fasta"
        ? [adapter.download_node, adapter.decompression_node]
        : [adapter.source_node]).sort();
  return {
    root_count: plan.roots.length,
    unsupported_roots: plan.unsupported,
    requires_source_pack: plan.adapters.length > 0 || plan.hasTypedBiologicalFixture,
    unexercised_nodes: unexercised,
    ...(Object.keys(plan.overrides).length ? { parameter_overrides: plan.overrides } : {}),
  };
}

function availableNodeId(graph: SomiteGraph, stem: string) {
  const used = new Set(graph.nodes.map((node) => node.id));
  let candidate = `${stem}-fixture`;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${stem}-fixture-${suffix++}`;
  return candidate;
}

function replaceSra(graph: SomiteGraph, adapter: Extract<PublicFixtureAdapter, { kind: "sra" }>, catalog: OperatorCatalog, fixtures: RepresentativeFixtureSet) {
  const operatorId = adapter.paired ? "files.import_paired" : "files.import";
  const operator = catalog.get(operatorId);
  if (!operator) throw new Error(`${operatorId} fixture operator is missing`);
  const conversion = graph.nodes.find((node) => node.id === adapter.conversion_node)!;
  const id = availableNodeId(graph, adapter.conversion_node);
  graph.nodes = graph.nodes.filter((node) => node.id !== adapter.fetch_node && node.id !== adapter.conversion_node).concat({
    id,
    operator: operator.id,
    operator_revision: operator.revision,
    ports: operatorPorts(operator),
    params: adapter.paired ? { r1: fixtures.readOne.path, r2: fixtures.readTwo.path } : { path: fixtures.readOne.path },
    layout: conversion.layout,
    note: "Representative local reads; public SRA retrieval is not exercised",
  });
  graph.edges = graph.edges
    .filter((edge) => edge.from_node !== adapter.fetch_node && edge.to_node !== adapter.fetch_node && edge.to_node !== adapter.conversion_node)
    .map((edge) => edge.from_node === adapter.conversion_node
      ? { ...edge, from_node: id, from_port: adapter.paired ? edge.from_port : "file" }
      : edge);
  return {
    [`${adapter.conversion_node}.${adapter.paired ? "r1" : "reads"}`]: fixtures.readOne.digest,
    ...(adapter.paired ? { [`${adapter.conversion_node}.r2`]: fixtures.readTwo.digest } : {}),
  };
}

function assemblyOutput(output: AssemblyFixtureOutput, fixtures: RepresentativeFixtureSet) {
  if (output === "genome" && fixtures.reference) return { operator: "files.import_fasta", port: "assembly", fixture: fixtures.reference };
  if (output === "gtf" && fixtures.gtf) return { operator: "files.import_gtf", port: "gtf", fixture: fixtures.gtf };
  if (output === "gff3" && fixtures.gff3) return { operator: "files.import_gff3", port: "gff3", fixture: fixtures.gff3 };
  throw new Error(`representative ${output} fixture is unavailable`);
}

function replaceAssembly(graph: SomiteGraph, adapter: Extract<PublicFixtureAdapter, { kind: "ncbi_assembly" }>, catalog: OperatorCatalog, fixtures: RepresentativeFixtureSet) {
  const extraction = graph.nodes.find((node) => node.id === adapter.extraction_node)!;
  const replacements = new Map<AssemblyFixtureOutput, Readonly<{ node: string; port: string }>>();
  const bindings: Record<string, string> = {};
  graph.nodes = graph.nodes.filter((node) => node.id !== adapter.download_node && node.id !== adapter.extraction_node);
  for (const [index, output] of adapter.outputs.entries()) {
    const source = assemblyOutput(output, fixtures);
    const operator = catalog.get(source.operator);
    if (!operator) throw new Error(`${source.operator} fixture operator is missing`);
    const id = availableNodeId(graph, `${adapter.extraction_node}-${output}`);
    graph.nodes.push({
      id,
      operator: operator.id,
      operator_revision: operator.revision,
      ports: operatorPorts(operator),
      params: { path: source.fixture.path },
      layout: { x: extraction.layout.x, y: extraction.layout.y + index * 100 },
      note: "Representative local assembly data; public NCBI retrieval and extraction are not exercised",
    });
    replacements.set(output, { node: id, port: source.port });
    bindings[`${adapter.extraction_node}.${output}`] = source.fixture.digest;
  }
  graph.edges = graph.edges
    .filter((edge) => edge.from_node !== adapter.download_node && edge.to_node !== adapter.download_node && edge.to_node !== adapter.extraction_node)
    .map((edge) => {
      if (edge.from_node !== adapter.extraction_node) return edge;
      const replacement = replacements.get(edge.from_port as AssemblyFixtureOutput)!;
      return { ...edge, from_node: replacement.node, from_port: replacement.port };
    });
  return bindings;
}

function replaceDirect(graph: SomiteGraph, adapter: Extract<PublicFixtureAdapter, { kind: "direct_public" }>, catalog: OperatorCatalog, fixtures: RepresentativeFixtureSet) {
  const fixture = fixtures[adapter.fixture];
  if (!fixture) throw new Error(`representative ${adapter.fixture} fixture is unavailable`);
  const original = graph.nodes.find((node) => node.id === adapter.source_node)!;
  const operator = catalog.get(adapter.local_operator);
  if (!operator) throw new Error(`${adapter.local_operator} fixture operator is missing`);
  graph.nodes = graph.nodes.filter((node) => node.id !== adapter.source_node);
  const id = availableNodeId(graph, adapter.source_node);
  graph.nodes.push({ id, operator: operator.id, operator_revision: operator.revision, ports: operatorPorts(operator), params: { path: fixture.path }, layout: original.layout, note: "Representative local biological data; public retrieval is not exercised" });
  graph.edges = graph.edges.map((edge) => edge.from_node === adapter.source_node ? { ...edge, from_node: id, from_port: adapter.local_port } : edge);
  return { [`${adapter.source_node}.${adapter.output_port}`]: fixture.digest };
}

function replaceCompressedFasta(graph: SomiteGraph, adapter: Extract<PublicFixtureAdapter, { kind: "compressed_fasta" }>, catalog: OperatorCatalog, fixtures: RepresentativeFixtureSet) {
  if (!fixtures.reference) throw new Error("representative reference fixture is unavailable");
  const decompression = graph.nodes.find((node) => node.id === adapter.decompression_node)!;
  const operator = catalog.get("files.import_fasta");
  if (!operator) throw new Error("files.import_fasta fixture operator is missing");
  graph.nodes = graph.nodes.filter((node) => node.id !== adapter.download_node && node.id !== adapter.decompression_node);
  const id = availableNodeId(graph, adapter.decompression_node);
  graph.nodes.push({ id, operator: operator.id, operator_revision: operator.revision, ports: operatorPorts(operator), params: { path: fixtures.reference.path }, layout: decompression.layout, note: "Representative local reference; public download and decompression are not exercised" });
  graph.edges = graph.edges
    .filter((edge) => edge.from_node !== adapter.download_node && edge.to_node !== adapter.download_node && edge.to_node !== adapter.decompression_node)
    .map((edge) => edge.from_node === adapter.decompression_node ? { ...edge, from_node: id, from_port: "assembly" } : edge);
  return { [`${adapter.decompression_node}.fasta`]: fixtures.reference.digest };
}

function replacePublic(graph: SomiteGraph, adapter: PublicFixtureAdapter, catalog: OperatorCatalog, fixtures: RepresentativeFixtureSet) {
  if (adapter.kind === "sra") return replaceSra(graph, adapter, catalog, fixtures);
  if (adapter.kind === "ncbi_assembly") return replaceAssembly(graph, adapter, catalog, fixtures);
  if (adapter.kind === "direct_public") return replaceDirect(graph, adapter, catalog, fixtures);
  return replaceCompressedFasta(graph, adapter, catalog, fixtures);
}

function normalizedFixtures(fixtures: RepresentativeFixtureSet): RepresentativeFixtureSet {
  const normalized = (fixture: MaterializedFixture) => ({ ...fixture, path: `fixture:${fixture.digest}` });
  return {
    readOne: normalized(fixtures.readOne),
    readTwo: normalized(fixtures.readTwo),
    ...(fixtures.readOneGz ? { readOneGz: normalized(fixtures.readOneGz) } : {}),
    ...(fixtures.readTwoGz ? { readTwoGz: normalized(fixtures.readTwoGz) } : {}),
    ...(fixtures.reference ? { reference: normalized(fixtures.reference) } : {}),
    ...(fixtures.referenceGz ? { referenceGz: normalized(fixtures.referenceGz) } : {}),
    ...(fixtures.gtf ? { gtf: normalized(fixtures.gtf) } : {}),
    ...(fixtures.gff3 ? { gff3: normalized(fixtures.gff3) } : {}),
    ...(fixtures.bam ? { bam: normalized(fixtures.bam) } : {}),
  };
}

function localBindings(node: SomiteGraph["nodes"][number], fixtures: RepresentativeFixtureSet): readonly (readonly [string, MaterializedFixture])[] {
  const kind = localFixtureKind(node);
  if (kind === "single_fastq") return [["path", fixtures.readOne]];
  if (kind === "paired_fastq") return [["r1", fixtures.readOne], ["r2", fixtures.readTwo]];
  if (kind === "single_fastq_gz" && fixtures.readOneGz) return [["path", fixtures.readOneGz]];
  if (kind === "paired_fastq_gz" && fixtures.readOneGz && fixtures.readTwoGz) {
    return [["r1", fixtures.readOneGz], ["r2", fixtures.readTwoGz]];
  }
  if (kind === "fasta" && fixtures.reference) return [["path", fixtures.reference]];
  if (kind === "fasta_gz" && fixtures.referenceGz) return [["path", fixtures.referenceGz]];
  if (kind === "gtf" && fixtures.gtf) return [["path", fixtures.gtf]];
  if (kind === "gff3" && fixtures.gff3) return [["path", fixtures.gff3]];
  if (kind === "bam" && fixtures.bam) return [["path", fixtures.bam]];
  if (kind) throw new Error(`representative ${kind} fixture is unavailable`);
  return [];
}

function bindLocalRoots(graph: SomiteGraph, fixtures: RepresentativeFixtureSet) {
  const bindings: Record<string, string> = {};
  for (const node of graph.nodes) {
    const hasInbound = graph.edges.some((edge) => edge.to_node === node.id);
    const hasInputPort = node.ports.some((port) => port.dir === "in");
    if (hasInbound || hasInputPort) continue;
    for (const [parameter, fixture] of localBindings(node, fixtures)) {
      node.params![parameter] = fixture.path;
      bindings[`${node.id}.${parameter}`] = fixture.digest;
    }
  }
  return bindings;
}

function applyParameterOverrides(graph: SomiteGraph, overrides: Readonly<Record<string, ParamValue>>) {
  for (const [binding, value] of Object.entries(overrides)) {
    const separator = binding.lastIndexOf(".");
    const nodeId = binding.slice(0, separator);
    const parameter = binding.slice(separator + 1);
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`fixture parameter node ${nodeId} is missing`);
    node.params = { ...(node.params ?? {}), [parameter]: value };
  }
}

/** Bind all recognized typed roots while preserving the saved graph and evidence identity. */
export function bindRepresentativeSourceFixtures(
  graph: SomiteGraph,
  catalog: OperatorCatalog,
  fixtures: RepresentativeFixtureSet,
): RepresentativeSourceBinding {
  const validation = validateGraph(graph);
  if (!validation.ok) throw new Error(`invalid graph: ${validation.issue.message}`);
  const catalogValidation = catalog.verifyGraph(graph);
  if (!catalogValidation.ok) throw new Error(`invalid graph: ${catalogValidation.issue.message}`);
  const plan = internalPlan(graph);
  const publicPlan = representativeSourcePlan(graph);
  const runnable = structuredClone(graph);
  const normalized = structuredClone(graph);
  const normalizedSet = normalizedFixtures(fixtures);
  const bindings = bindLocalRoots(runnable, fixtures);
  bindLocalRoots(normalized, normalizedSet);
  applyParameterOverrides(runnable, plan.overrides);
  applyParameterOverrides(normalized, plan.overrides);
  for (const adapter of plan.adapters) {
    Object.assign(bindings, replacePublic(runnable, adapter, catalog, fixtures));
    replacePublic(normalized, adapter, catalog, normalizedSet);
  }
  const runnableValidation = catalog.verifyGraph(runnable);
  if (!runnableValidation.ok) throw new Error(`fixture graph: ${runnableValidation.issue.message}`);
  return {
    configuration_digest: semanticGraphRevision(normalized),
    fixture_digests: [...new Set(Object.values(bindings))].sort(),
    bindings: Object.fromEntries(Object.entries(bindings).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    graph: runnable,
    unexercised_nodes: publicPlan.unexercised_nodes,
    ...(publicPlan.parameter_overrides ? { parameter_overrides: publicPlan.parameter_overrides } : {}),
  };
}
