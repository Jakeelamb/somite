import { readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { operatorPorts } from "@somite/workflow/catalog";
import type { OperatorCatalog } from "@somite/workflow/catalog";
import { buildSourceManifest, type FrozenSourceFile } from "@somite/workflow/nextflowSource";
import type { SomiteGraph, SomiteGraphNode, SourceCanvasView, SourceWorkflowInstance } from "@somite/workflow/model";
import { compileNextflow, PINNED_NEXTFLOW_VERSION, PINNED_OPENJDK_VERSION } from "@somite/workflow/nextflow";
import { reconstructPaper } from "@somite/workflow/paper";
import { projectSourceCanvas, validateSourceCanvasView } from "@somite/workflow/sourceCanvas";
import { deriveSourceWorkflow } from "@somite/workflow/sourceWorkflow";
import { topologicalOrder, validateGraph } from "@somite/workflow/workflow";
import { semanticDigest, type BenchmarkQuality } from "./benchmark-core.ts";
import { hasOrderedPath, hasSharedRootBranch, matchingNodes } from "./benchmark-paper-topology.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const [benchmarkId, ...benchmarkArguments] = process.argv.slice(2);
const supported = new Set(["workflow.graph_wide_10k", "canvas.wide_deep_5k", "source.index_8k", "compiler.linear_1k", "paper.gold_text"]);
if (!benchmarkId || !supported.has(benchmarkId)) {
  throw new Error(`usage: benchmark-case.ts ${[...supported].join("|")} [--profile cpu|heap --profile-output ABSOLUTE_PATH]`);
}
const profileKind = benchmarkArguments[0] === "--profile" ? benchmarkArguments[1] : undefined;
const profileOutput = benchmarkArguments[2] === "--profile-output" ? benchmarkArguments[3] : undefined;
const profileRequested = benchmarkArguments.length > 0;
if ((profileKind !== "cpu" && profileKind !== "heap") || !profileOutput || !isAbsolute(profileOutput) || benchmarkArguments.length !== 4) {
  if (profileRequested) throw new Error("benchmark profile arguments are invalid");
}

type CaseResult = Readonly<{
  output_bytes: number;
  stages_ms: Readonly<Record<string, number>>;
  quality: BenchmarkQuality;
}>;

type PaperGoldExpected = Readonly<{
  fixture: string;
  extractVia: string;
  outcome: string;
  tracks: string[];
  entities: string[];
  forbiddenEntities: string[];
  requiredOperators: string[];
  forbiddenOperators: string[];
  unsupported: string[];
  candidates: number;
  paths: string[][];
  branches: Array<{ root: string; arms: string[] }>;
  alternatives: string[][];
  parameters: Array<{ selector: string; name: string; value: string }>;
  minimumEvidence: number;
  minimumEvidenceSupportPct: number;
  exactRuns: string[];
  forbidCollectionReads: boolean;
}>;

class Checks {
  passed = 0;
  total = 0;

  check(condition: unknown, message: string) {
    this.total += 1;
    if (!condition) throw new Error(message);
    this.passed += 1;
  }

  quality(semantic: unknown): BenchmarkQuality {
    return { passed: this.passed === this.total, assertions_passed: this.passed, assertions_total: this.total, semantic_digest: semanticDigest(semantic) };
  }
}

function timed<T>(work: () => T) {
  const started = performance.now();
  const value = work();
  return { value, duration: performance.now() - started };
}

function inspectorPost(session: Session, method: string, parameters: Record<string, unknown> = {}) {
  return new Promise<Record<string, unknown>>((resolvePost, rejectPost) => {
    session.post(method, parameters, (error, value) => error ? rejectPost(error) : resolvePost(value as Record<string, unknown>));
  });
}

async function profileScope<T>(work: () => T): Promise<T> {
  if (!profileRequested) return work();
  const session = new Session();
  session.connect();
  const domain = profileKind === "cpu" ? "Profiler" : "HeapProfiler";
  try {
    await inspectorPost(session, `${domain}.enable`);
    await inspectorPost(session, profileKind === "cpu" ? "Profiler.start" : "HeapProfiler.startSampling");
    let value: T | undefined;
    let failure: unknown;
    try {
      value = work();
    } catch (error) {
      failure = error;
    }
    const stopped = await inspectorPost(session, profileKind === "cpu" ? "Profiler.stop" : "HeapProfiler.stopSampling");
    const profile = stopped.profile;
    if (!profile || typeof profile !== "object") throw new Error("inspector did not return a benchmark profile");
    await writeFile(profileOutput!, JSON.stringify(profile), { flag: "wx", mode: 0o600 });
    if (failure !== undefined) throw failure;
    return value!;
  } finally {
    session.disconnect();
  }
}

function node(id: string): SomiteGraphNode {
  return { id, operator: "gap.missing", operator_revision: "benchmark", ports: [], params: {}, layout: { x: 0, y: 0 } };
}

async function graphWide(): Promise<CaseResult> {
  const graph: SomiteGraph = {
    schema_version: 3,
    name: "Benchmark 10k graph",
    nodes: Array.from({ length: 10_000 }, (_, index) => node(`node-${String(index).padStart(5, "0")}`)),
    edges: [],
  };
  const { validation, order } = await profileScope(() => ({
    validation: timed(() => validateGraph(graph)),
    order: timed(() => topologicalOrder(graph)),
  }));
  const checks = new Checks();
  checks.check(validation.value.ok, validation.value.ok ? "" : validation.value.issue.message);
  checks.check(order.value.length === graph.nodes.length, "topological order lost graph nodes");
  checks.check(order.value[0] === "node-00000" && order.value.at(-1) === "node-09999", "topological order is not deterministic");
  checks.check(JSON.stringify(order.value) === JSON.stringify(graph.nodes.map((graphNode) => graphNode.id)), "topological order changed an interior node");
  const semantic = { valid: validation.value.ok, order_digest: semanticDigest(order.value) };
  return {
    output_bytes: Buffer.byteLength(JSON.stringify(order.value)),
    stages_ms: { validate: validation.duration, topological_order: order.duration },
    quality: checks.quality(semantic),
  };
}

const digest = (character: string) => `blake3:${character.repeat(64)}`;
const span = (line = 1) => ({ path: "main.nf", start_line: line, end_line: line });

function wideWorkflow(): SourceWorkflowInstance {
  return {
    schema_version: 1,
    workflow_revision: digest("a"),
    source: {
      provider: "local",
      repository: "benchmark",
      requested_revision: "benchmark",
      resolved_revision: "b".repeat(64),
      source_digest: digest("b"),
      entrypoint: "main.nf",
      file_count: 1,
      source_bytes: 1,
    },
    scopes: [{ id: "root", title: "Root", kind: "entry_workflow", span: span() }],
    invocations: Array.from({ length: 5_000 }, (_, index) => ({ id: `wide-${index}`, caller: "root", name: `WIDE_${index}`, span: span(index + 1) })),
    replacements: [],
    capabilities: { exact_execution: false, parameter_edits: false, hierarchy_indexed: true, structural_edits: false, channel_contracts: false, source_edits: false },
  };
}

async function canvasWideDeep(): Promise<CaseResult> {
  const wide = wideWorkflow();
  const deep = wideWorkflow();
  deep.invocations = [deep.invocations![0]!];
  const groups: NonNullable<SourceCanvasView["groups"]> = Array.from({ length: 5_000 }, (_, index) => ({
    id: `group-${index}`,
    title: `Group ${index}`,
    parent_group_id: index === 0 ? null : `group-${index - 1}`,
    direct_entity_ids: index === 4_999 ? ["call:wide-0"] : [],
    collapsed: false,
  }));
  const view: SourceCanvasView = { schema_version: 2, source_digest: deep.source.source_digest, groups };
  const { cold, cached, validation, focused } = await profileScope(() => {
    const coldProjection = timed(() => projectSourceCanvas(wide));
    return {
      cold: coldProjection,
      cached: timed(() => {
        let result = coldProjection.value;
        for (let index = 0; index < 50; index += 1) result = projectSourceCanvas(wide);
        return result;
      }),
      validation: timed(() => validateSourceCanvasView(deep, view)),
      focused: timed(() => projectSourceCanvas(deep, view, "group-4999")),
    };
  });
  const checks = new Checks();
  checks.check(cold.value.ok, cold.value.ok ? "" : cold.value.error.message);
  checks.check(cached.value.ok, cached.value.ok ? "" : cached.value.error.message);
  checks.check(validation.value === null, validation.value?.message ?? "deep source canvas view is invalid");
  checks.check(focused.value.ok, focused.value.ok ? "" : focused.value.error.message);
  const wideEntities = cold.value.ok ? cold.value.projection.entities.length : -1;
  const focusedEntities = focused.value.ok ? focused.value.projection.entities.length : -1;
  const breadcrumbs = focused.value.ok ? focused.value.projection.breadcrumbs.length : -1;
  checks.check(wideEntities === 5_000, "wide projection lost source calls");
  checks.check(focusedEntities === 1 && breadcrumbs === 5_000, "deep projection lost its focused entity or breadcrumbs");
  const wideProjection = cold.value.ok ? cold.value.projection : null;
  const cachedProjection = cached.value.ok ? cached.value.projection : null;
  const focusedProjection = focused.value.ok ? focused.value.projection : null;
  checks.check(semanticDigest(wideProjection) === semanticDigest(cachedProjection), "cached projection changed the canvas outcome");
  const semantic = {
    wide_projection_digest: semanticDigest(wideProjection),
    focused_projection_digest: semanticDigest(focusedProjection),
  };
  return {
    output_bytes: Buffer.byteLength(JSON.stringify({ wideProjection, focusedProjection })),
    stages_ms: { cold_projection: cold.duration, cached_projection_50x: cached.duration, deep_validation: validation.duration, focused_projection: focused.duration },
    quality: checks.quality(semantic),
  };
}

async function sourceIndex(): Promise<CaseResult> {
  const source = Array.from({ length: 8_000 }, (_, index) => `process P${String(index).padStart(5, "0")} {}`).join("\n");
  const files: FrozenSourceFile[] = [{ path: "main.nf", mode: 0o100644, bytes: Buffer.from(source) }];
  const localRevision = buildSourceManifest(files).source_digest.slice("blake3:".length);
  const indexed = await profileScope(() => timed(() => deriveSourceWorkflow(files, {
    provider: "local",
    repository: "benchmark-source",
    requested_revision: "benchmark",
    resolved_revision: localRevision,
    entrypoint: "main.nf",
  })));
  const checks = new Checks();
  checks.check(indexed.value.workflow.scopes?.length === 8_000, "source index did not retain every process scope");
  checks.check(indexed.value.workflow.invocations?.length === 0, "source index invented workflow calls");
  checks.check(indexed.value.workflow.capabilities.hierarchy_indexed, "source index did not advertise its proven hierarchy");
  const scopes = indexed.value.workflow.scopes ?? [];
  checks.check(scopes.every((scope, index) => scope.title === `P${String(index).padStart(5, "0")}`), "source index changed a process identity or order");
  checks.check(new Set(scopes.map((scope) => scope.id)).size === scopes.length, "source index duplicated a process identity");
  const semantic = {
    workflow_digest: semanticDigest(indexed.value.workflow),
    manifest_digest: semanticDigest(indexed.value.manifest),
  };
  return {
    output_bytes: Buffer.byteLength(JSON.stringify(indexed.value.workflow)),
    stages_ms: { derive_source_workflow: indexed.duration },
    quality: checks.quality(semantic),
  };
}

async function compilerLinear(): Promise<CaseResult> {
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const readsOperator = catalog.get("files.import_paired")!;
  const fastpOperator = catalog.get("qc.fastp")!;
  const reads: SomiteGraphNode = { id: "reads", operator: readsOperator.id, operator_revision: readsOperator.revision, ports: operatorPorts(readsOperator), params: { r1: "reads_R1.fastq", r2: "reads_R2.fastq" }, layout: { x: 0, y: 0 } };
  const nodes: SomiteGraphNode[] = [reads];
  const edges: SomiteGraph["edges"] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const id = `fastp-${String(index).padStart(4, "0")}`;
    const previous = index === 0 ? reads.id : `fastp-${String(index - 1).padStart(4, "0")}`;
    nodes.push({ id, operator: fastpOperator.id, operator_revision: fastpOperator.revision, ports: operatorPorts(fastpOperator), params: { threads: 4 }, layout: { x: 240 * (index + 1), y: 0 } });
    for (const port of ["r1", "r2"]) edges.push({ id: `${previous}-${port}-${id}`, from_node: previous, from_port: port, to_node: id, to_port: port });
  }
  const graph: SomiteGraph = { schema_version: 3, name: "Compiler benchmark", nodes, edges };
  const compiled = await profileScope(() => timed(() => compileNextflow(graph, catalog, { workflowName: "compiler-benchmark", outputDirectory: "results", platforms: ["linux-64"], nextflowVersion: PINNED_NEXTFLOW_VERSION, openjdkVersion: PINNED_OPENJDK_VERSION })));
  const checks = new Checks();
  const nodeMap = JSON.parse(compiled.value.nodeMapJson) as { nodes: Record<string, unknown> };
  checks.check(Object.keys(nodeMap.nodes).length === 1_001, "compiled node map lost nodes");
  checks.check(compiled.value.mainNf.includes("process SOMITE_FASTP_0999_"), "compiled workflow lost its final process");
  const hasFastp = compiled.value.pixiToml.includes('"fastp"') && compiled.value.pixiToml.includes('channel = "bioconda"');
  checks.check(hasFastp, "compiled environment lost fastp");
  const semantic = { compiled_digest: semanticDigest(compiled.value) };
  const outputBytes = Object.values(compiled.value).reduce((total, value) => total + Buffer.byteLength(value), 0);
  return { output_bytes: outputBytes, stages_ms: { compile_nextflow: compiled.duration }, quality: checks.quality(semantic) };
}

function list(value: string) {
  return value === "-" ? [] : value.split(",").filter(Boolean);
}

async function paperGold(): Promise<CaseResult> {
  const paperRoot = join(repositoryRoot, "testdata", "papers");
  const rows = (await readFile(join(paperRoot, "gold.tsv"), "utf8")).split("\n").filter((line) => line && !line.startsWith("#"));
  const headers = rows.shift()!.split("\t");
  const expected = rows.map((line) => {
    const values = line.split("\t");
    const fields = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? "-"]));
    if (!/^[A-Za-z0-9._-]+$/.test(fields.fixture)) throw new Error("paper gold corpus contains an unsafe fixture path");
    return {
      fixture: fields.fixture,
      extractVia: fields.extract_via,
      outcome: fields.outcome,
      tracks: list(fields.tracks),
      entities: list(fields.expected_entities),
      forbiddenEntities: list(fields.forbidden_entities),
      requiredOperators: list(fields.required_operators),
      forbiddenOperators: list(fields.forbidden_operators),
      unsupported: list(fields.required_unsupported),
      candidates: Number(fields.expected_candidates),
      paths: fields.required_paths === "-" ? [] : fields.required_paths.split(";").map((value) => value.split(">")),
      branches: fields.required_branches === "-" ? [] : fields.required_branches.split(";").map((value) => {
        const [root, arms = ""] = value.split(">");
        return { root, arms: arms.split("|") };
      }),
      alternatives: fields.separate_alternatives === "-" ? [] : fields.separate_alternatives.split(";").map((value) => value.split("|")),
      parameters: fields.parameters === "-" ? [] : fields.parameters.split(";").map((value) => {
        const [subject, parameterValue = ""] = value.split("=");
        const separator = subject.lastIndexOf(":");
        return { selector: subject.slice(0, separator), name: subject.slice(separator + 1), value: parameterValue };
      }),
      minimumEvidence: Number(fields.minimum_evidence_records),
      minimumEvidenceSupportPct: Number(fields.minimum_evidence_support_pct),
      exactRuns: list(fields.exact_runs),
      forbidCollectionReads: fields.forbid_collection_reads === "true",
    };
  });
  const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const texts = await Promise.all(expected.map((item) => readFile(join(paperRoot, item.fixture), "utf8")));
  const reconstructed = await profileScope(() => timed(() => texts.map((text) => reconstructPaper(catalog, text, "text"))));
  const checks = new Checks();
  const semanticCases = expected.map((item, index) => evaluatePaperCase(item, reconstructed.value[index]!, catalog, checks));
  return {
    output_bytes: reconstructed.value.reduce((total, review) => total + Buffer.byteLength(JSON.stringify(review)), 0),
    stages_ms: { reconstruct_gold_corpus: reconstructed.duration },
    quality: checks.quality(semanticCases),
  };
}

function evaluatePaperCase(
  expected: PaperGoldExpected,
  review: ReturnType<typeof reconstructPaper>,
  catalog: OperatorCatalog,
  checks: Checks,
) {
  const entities = new Set(review.mentions.map((mention) => mention.normalized_name));
  const operators = new Set(review.candidates.flatMap((candidate) => candidate.graph.nodes.map((candidateNode) => candidateNode.operator)));
  const unsupported = new Set(review.mentions.filter((mention) => mention.support === "unsupported").map((mention) => mention.normalized_name));
  const tracks = [...new Set(review.candidates.map((candidate) => candidate.assay))].sort();
  checks.check(expected.extractVia === "utf8" && review.extracted_via === "text", `${expected.fixture}: extraction path changed`);
  checks.check(review.outcome === expected.outcome, `${expected.fixture}: reconstruction outcome changed`);
  checks.check(review.candidates.length === expected.candidates, `${expected.fixture}: candidate count changed`);
  checks.check(JSON.stringify(tracks) === JSON.stringify([...expected.tracks].sort()), `${expected.fixture}: assay tracks changed`);
  for (const entity of expected.entities) checks.check(entities.has(entity), `${expected.fixture}: missing entity ${entity}`);
  for (const entity of expected.forbiddenEntities) checks.check(!entities.has(entity), `${expected.fixture}: forbidden entity ${entity}`);
  for (const operator of expected.requiredOperators) checks.check(operators.has(operator), `${expected.fixture}: missing operator ${operator}`);
  for (const operator of expected.forbiddenOperators) checks.check(!operators.has(operator), `${expected.fixture}: forbidden operator ${operator}`);
  for (const entity of expected.unsupported) checks.check(unsupported.has(entity), `${expected.fixture}: missing unsupported evidence ${entity}`);
  for (const path of expected.paths) {
    checks.check(review.candidates.some((candidate) => hasOrderedPath(candidate.graph, path)), `${expected.fixture}: missing path ${path.join(" > ")}`);
  }
  for (const branch of expected.branches) {
    checks.check(review.candidates.some((candidate) => hasSharedRootBranch(candidate.graph, branch.root, branch.arms)), `${expected.fixture}: missing branch ${branch.root} > ${branch.arms.join(" | ")}`);
  }
  for (const alternatives of expected.alternatives) {
    const placements = alternatives.map((selector) => review.candidates.flatMap((candidate, index) => matchingNodes(candidate.graph, selector).length ? [index] : []));
    checks.check(placements.every((indices) => indices.length === 1) && new Set(placements.flat()).size === alternatives.length, `${expected.fixture}: alternative placement changed`);
  }
  for (const parameter of expected.parameters) {
    checks.check(review.candidates.some((candidate) => matchingNodes(candidate.graph, parameter.selector).some((graphNode) => String(graphNode.params?.[parameter.name]) === parameter.value)), `${expected.fixture}: missing parameter ${parameter.selector}:${parameter.name}=${parameter.value}`);
  }
  let expectedEvidence = review.mentions.length;
  let supportedEvidence = review.mentions.filter((mention) => Boolean(mention.evidence.trim()) && mention.evidence.includes(mention.display_name)).length;
  for (const mention of review.mentions) {
    checks.check(Boolean(mention.evidence.trim()) && mention.evidence.includes(mention.display_name), `${expected.fixture}: ${mention.normalized_name} lacks an exact evidence span`);
  }
  for (const candidate of review.candidates) {
    checks.check(catalog.verifyGraph(candidate.graph).ok, `${expected.fixture}: candidate graph is invalid`);
    for (const graphNode of candidate.graph.nodes) {
      expectedEvidence += 1;
      const supported = candidate.evidence.some((record) => record.target_kind === "node" && record.target_id === graphNode.id && Boolean(record.detail.trim()));
      if (supported) supportedEvidence += 1;
      checks.check(supported, `${expected.fixture}: node ${graphNode.id} lacks evidence`);
    }
    for (const edge of candidate.graph.edges) {
      expectedEvidence += 1;
      const supported = candidate.evidence.some((record) => record.target_kind === "edge" && record.target_id === edge.id && Boolean(record.detail.trim()));
      if (supported) supportedEvidence += 1;
      checks.check(supported, `${expected.fixture}: edge ${edge.id} lacks evidence`);
    }
  }
  const evidenceCount = review.mentions.length + review.candidates.reduce((total, candidate) => total + candidate.evidence.length, 0);
  const supportPct = expectedEvidence ? Math.floor(supportedEvidence * 100 / expectedEvidence) : 100;
  checks.check(evidenceCount >= expected.minimumEvidence, `${expected.fixture}: evidence count regressed`);
  checks.check(supportPct >= expected.minimumEvidenceSupportPct, `${expected.fixture}: evidence support regressed`);
  const readRuns = new Set(review.candidates.flatMap((candidate) => candidate.graph.nodes
    .filter((graphNode) => graphNode.operator === "sra.prefetch")
    .map((graphNode) => String(graphNode.params?.accession ?? ""))));
  checks.check(JSON.stringify([...readRuns].sort()) === JSON.stringify([...expected.exactRuns].sort()), `${expected.fixture}: exact run sources changed`);
  if (expected.forbidCollectionReads) checks.check(readRuns.size === 0, `${expected.fixture}: collection citation became a read source`);
  return { fixture: expected.fixture, review };
}

const startedCpu = process.cpuUsage();
const started = performance.now();
const result = benchmarkId === "workflow.graph_wide_10k"
  ? await graphWide()
  : benchmarkId === "canvas.wide_deep_5k"
    ? await canvasWideDeep()
    : benchmarkId === "source.index_8k"
      ? await sourceIndex()
      : benchmarkId === "compiler.linear_1k"
        ? await compilerLinear()
        : await paperGold();
const cpu = process.cpuUsage(startedCpu);
const resource = process.resourceUsage();
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  id: benchmarkId,
  wall_ms: performance.now() - started,
  cpu_user_ms: cpu.user / 1_000,
  cpu_system_ms: cpu.system / 1_000,
  peak_rss_bytes: resource.maxRSS * 1024,
  ...result,
})}\n`);
