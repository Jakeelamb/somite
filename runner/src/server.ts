import { lstat, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { AgentTransactionError, applyGraphTransaction, parseGraphTransaction, type AgentTransactionResult } from "@somite/workflow/agentTransaction";
import { assessWorkflow } from "@somite/workflow/assessment";
import { planFrozenPackage } from "@somite/workflow/bundle";
import { OperatorCatalog, operatorPorts, type PinnedOperator } from "@somite/workflow/catalog";
import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import { parseGraph, parseParameterRecord, parseWorkflowBinding } from "@somite/workflow/graphCodec";
import { RepresentativeValidationError } from "@somite/workflow/fixtures";
import type { SomiteGraph } from "@somite/workflow/model";
import { paperAccessionKind, reconstructPaper, type PaperResourceCitation } from "@somite/workflow/paper";
import {
  applySourceWorkflowEdits,
  promoteSourceInvocation,
  restoreSourceWorkflow,
  sourceWorkflowEditResponse,
  type SourceWorkflowEdit,
} from "@somite/workflow/sourceWorkflow";
import { graphStateRevision, semanticGraphRevision } from "@somite/workflow/workflow";
import { SOMITE_VERSION } from "@somite/workflow/version";
import { atomicWrite, containedPath, ensurePrivateDirectory, pathExists, regularDirectory, regularFile } from "./files.ts";
import { discoverAgents } from "./agentDiscovery.ts";
import { AgentManager, AgentManagerError } from "./agentManager.ts";
import { InputOriginError, InputOrigins } from "./inputOrigins.ts";
import { RunManager } from "./jobs.ts";
import { LiteratureGateway } from "./literatureGateway.ts";
import { NfcoreGateway } from "./nfcoreGateway.ts";
import { PaperExtractionError } from "./paperExtractor.ts";
import { paperIntakeConfigFromEnvironment } from "./paperConfig.ts";
import { PaperManager } from "./paperManager.ts";
import { PaperStoreError } from "./paperStore.ts";
import { PaperToolchainError } from "./paperToolchain.ts";
import { ProjectGateway, ProjectGatewayError } from "./projectGateway.ts";
import { SnakemakeGateway } from "./snakemakeGateway.ts";
import { SourceSearchGateway } from "./sourceSearchGateway.ts";
import { SourceWorkflowTrustError, verifyGraphSourceWorkflowTrust } from "./sourceWorkflowTrust.ts";
import { executablePath, pixiPlatform } from "./system.ts";
import { UploadError, UploadStore } from "./uploadStore.ts";
import { detectHardwareProfile } from "./hardwareProfile.ts";
import { ProductionInputError } from "./productionGraph.ts";
import { WorkflowAdmissionError } from "./workflowAdmission.ts";
import { MAX_WORKFLOW_DOCUMENT_BYTES, MAX_WORKFLOW_REQUEST_BYTES } from "./workflowLimits.ts";

const MAX_GENERIC_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_PORT = 7310;
const MAX_TRANSACTION_REPLAYS = 256;

type ProjectState = {
  root: string;
  graphPath: string;
  autosavePath: string;
  repositoryRoot: string;
  catalog: OperatorCatalog;
  catalogRevision: string;
  operators: PinnedOperator[];
  availableBinaries: Set<string>;
  runs: RunManager;
  nfcore: NfcoreGateway;
  snakemake: SnakemakeGateway;
  projects: ProjectGateway;
  inputOrigins: InputOrigins;
  sourceSearch: SourceSearchGateway;
  uploads: UploadStore;
  papers: PaperManager;
  literature: LiteratureGateway;
  graph: SomiteGraph;
  recoveredAutosave: boolean;
  autosaveRecoveryWarning: string | null;
  writeChain: Promise<void>;
  allowedOrigin: string;
  agentCapability: string;
  agent: AgentManager;
  transactionReplays: Map<string, { requestDigest: string; result: AgentTransactionResult; sequence: number }>;
  transactionSequence: number;
};

function rememberTransactionReplay(
  state: ProjectState,
  idempotencyKey: string,
  requestDigest: string,
  result: AgentTransactionResult,
) {
  state.transactionSequence += 1;
  state.transactionReplays.set(idempotencyKey, { requestDigest, result, sequence: state.transactionSequence });
  if (state.transactionReplays.size <= MAX_TRANSACTION_REPLAYS) return;
  const oldest = [...state.transactionReplays].reduce((candidate, entry) => (
    !candidate || entry[1].sequence < candidate[1].sequence ? entry : candidate
  ), undefined as [string, { requestDigest: string; result: AgentTransactionResult; sequence: number }] | undefined);
  if (oldest) state.transactionReplays.delete(oldest[0]);
}

function json(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(`${JSON.stringify(value)}\n`, { ...init, headers });
}

function errorResponse(status: number, message: string, extra: Record<string, unknown> = {}) {
  return json({ error: message, ...extra }, { status });
}

function normalizedAllowedOrigin(origin: string) {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("origin must use HTTP or HTTPS");
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("origin must not contain credentials, a path, query, or fragment");
    return url.origin;
  } catch {
    throw new Error("SOMITE_ALLOWED_ORIGIN must be one exact HTTP or HTTPS origin");
  }
}

function allowedOrigin(request: Request, state: ProjectState) {
  const origin = request.headers.get("origin");
  return origin && origin === state.allowedOrigin ? origin : null;
}

function withCors(request: Request, response: Response, state: ProjectState) {
  const origin = allowedOrigin(request, state);
  if (origin === null) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requestIsMutation(request: Request) {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

async function requestBytes(request: Request, maximumBytes = MAX_GENERIC_REQUEST_BYTES) {
  const announced = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(announced) && announced > maximumBytes) throw new HttpError(413, "request is too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) throw new HttpError(413, "request is too large");
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function requestJson(request: Request, maximumBytes = MAX_GENERIC_REQUEST_BYTES) {
  const bytes = await requestBytes(request, maximumBytes);
  if (!bytes.byteLength) throw new HttpError(400, "JSON body is required");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function requestWorkflowJson(request: Request) {
  return requestJson(request, MAX_WORKFLOW_REQUEST_BYTES);
}

class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function migrateGraph(value: unknown, catalog: OperatorCatalog) {
  try {
    return parseGraph(value);
  } catch (originalError) {
    const raw = object(value, "graph");
    if (raw.schema_version !== 1 && raw.schema_version !== 2) throw originalError;
    if (!Array.isArray(raw.nodes)) throw originalError;
    const migrated = {
      ...raw,
      schema_version: 3,
      nodes: raw.nodes.map((candidate) => {
        const node = object(candidate, "graph node");
        if (typeof node.operator !== "string") throw originalError;
        const operator = catalog.get(node.operator);
        if (!operator) throw originalError;
        return {
          ...node,
          operator_revision: operator.revision,
          ports: operatorPorts(operator),
        };
      }),
    };
    return parseGraph(migrated);
  }
}

async function readGraph(path: string, catalog: OperatorCatalog) {
  const bytes = await regularFile(path, MAX_WORKFLOW_DOCUMENT_BYTES, "workflow graph");
  return migrateGraph(JSON.parse(new TextDecoder().decode(bytes)), catalog);
}

function encodeGraph(graph: SomiteGraph) {
  const encoded = `${JSON.stringify(graph, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > MAX_WORKFLOW_DOCUMENT_BYTES) {
    throw new HttpError(413, `workflow graph exceeds ${MAX_WORKFLOW_DOCUMENT_BYTES} bytes`);
  }
  return encoded;
}

async function readVerifiedProjectGraph(root: string, catalog: OperatorCatalog, path: string) {
  const graph = await readGraph(path, catalog);
  const verified = catalog.verifyGraph(graph);
  if (!verified.ok) throw new Error(verified.issue.message);
  await verifyGraphSourceWorkflowTrust(root, catalog, graph);
  return graph;
}

function autosaveRecoveryWarning(error: unknown, openedSavedGraph: boolean) {
  const reason = error instanceof SyntaxError
    ? "is not valid JSON"
    : `could not be validated: ${error instanceof Error ? error.message : String(error)}`;
  return `Autosave ${reason}. ${openedSavedGraph ? "Opened the saved workflow instead." : "Started a new untitled workflow instead."}`;
}

function autosavePath(root: string, graphPath: string) {
  const defaultGraph = join(root, ".somite", "web.somite.json");
  if (resolve(graphPath) === resolve(defaultGraph)) return join(root, ".somite", "autosave.somite.json");
  const suffix = extname(graphPath);
  return suffix
    ? `${graphPath.slice(0, -suffix.length)}.autosave.somite.json`
    : `${graphPath}.autosave.somite.json`;
}

export type ServerOptions = {
  projectRoot?: string;
  graph?: string;
  port?: number;
  host?: string;
  allowedOrigin?: string;
  agentCapability?: string;
};

async function projectGraphPath(root: string, path: string, label: string) {
  const destination = containedPath(root, path);
  const parent = dirname(destination);
  await regularDirectory(parent, `${label} parent`);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== resolve(parent)) throw new Error(`${label} parent must not contain a symbolic link`);
  const fromRoot = relative(root, canonicalParent);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} must stay inside the canonical project root`);
  }
  if (await pathExists(destination)) {
    const metadata = await lstat(destination);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  }
  return destination;
}

async function initializeProject(serverUrl: string, options: ServerOptions): Promise<ProjectState> {
  const paperConfiguration = paperIntakeConfigFromEnvironment();
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const requestedRoot = resolve(options.projectRoot ?? process.env.SOMITE_PROJECT_ROOT ?? repositoryRoot);
  const root = await realpath(requestedRoot);
  await regularDirectory(root, "project root");
  const projectState = await ensurePrivateDirectory(root, ".somite");
  const configuredGraph = options.graph ?? process.env.SOMITE_GRAPH ?? process.argv[2];
  const graphPath = await projectGraphPath(root, configuredGraph ?? join(projectState, "web.somite.json"), "workflow graph");
  const catalogLoaded = await loadOperatorCatalog(join(repositoryRoot, "operators"));
  const recovery = await projectGraphPath(root, autosavePath(root, graphPath), "workflow autosave");
  let graph: SomiteGraph;
  let recoveredAutosave = false;
  let recoveryWarning: string | null = null;
  if (await pathExists(recovery)) {
    try {
      graph = await readVerifiedProjectGraph(root, catalogLoaded.catalog, recovery);
      recoveredAutosave = true;
    } catch (recoveryError) {
      const savedGraphExists = await pathExists(graphPath);
      if (savedGraphExists) {
        graph = await readVerifiedProjectGraph(root, catalogLoaded.catalog, graphPath);
      } else {
        graph = { schema_version: 3, name: "Untitled workflow", nodes: [], edges: [] };
        await atomicWrite(graphPath, encodeGraph(graph));
      }
      recoveryWarning = autosaveRecoveryWarning(recoveryError, savedGraphExists);
    }
  } else if (await pathExists(graphPath)) {
    graph = await readVerifiedProjectGraph(root, catalogLoaded.catalog, graphPath);
  } else {
    graph = { schema_version: 3, name: "Untitled workflow", nodes: [], edges: [] };
    await atomicWrite(graphPath, encodeGraph(graph));
  }
  const availableBinaries = new Set<string>();
  await Promise.all([...catalogLoaded.catalog.values()].map(async (operator) => {
    if (operator.bin && await executablePath(root, operator.bin)) availableBinaries.add(operator.bin);
  }));
  const configuredCapability = options.agentCapability ?? process.env.SOMITE_AGENT_CAPABILITY;
  if (configuredCapability !== undefined && !/^[a-f0-9]{64}$/.test(configuredCapability)) {
    throw new Error("SOMITE_AGENT_CAPABILITY must contain exactly 64 lowercase hexadecimal characters");
  }
  const agentCapability = configuredCapability ?? randomBytes(32).toString("hex");
  const snakemake = new SnakemakeGateway(root, catalogLoaded.catalog);
  const inputOrigins = await InputOrigins.open(root, graphPath, dirname(graphPath), graph);
  return {
    root,
    graphPath,
    autosavePath: recovery,
    repositoryRoot,
    catalog: catalogLoaded.catalog,
    catalogRevision: catalogLoaded.revision,
    operators: [...catalogLoaded.catalog.values()].filter((operator) => !operator.id.startsWith("nf.") && !operator.id.startsWith("smk.")),
    availableBinaries,
    runs: new RunManager(root, repositoryRoot, catalogLoaded.catalog, dirname(graphPath)),
    nfcore: new NfcoreGateway(root, catalogLoaded.catalog),
    snakemake,
    projects: new ProjectGateway(root, catalogLoaded.catalog, snakemake),
    inputOrigins,
    sourceSearch: new SourceSearchGateway(),
    uploads: new UploadStore(root),
    papers: new PaperManager(root, catalogLoaded.catalog, catalogLoaded.revision, paperConfiguration),
    literature: new LiteratureGateway(root),
    graph,
    recoveredAutosave,
    autosaveRecoveryWarning: recoveryWarning,
    writeChain: Promise.resolve(),
    allowedOrigin: normalizedAllowedOrigin(options.allowedOrigin ?? process.env.SOMITE_ALLOWED_ORIGIN ?? "http://localhost:3000"),
    agentCapability,
    agent: new AgentManager(serverUrl, agentCapability, undefined, root),
    transactionReplays: new Map(),
    transactionSequence: 0,
  };
}

function displayedPath(root: string, path: string) {
  const shown = relative(root, path);
  return shown && !shown.startsWith("..") && !isAbsolute(shown) ? shown : path;
}

function knownFields(value: Record<string, unknown>, label: string, allowed: readonly string[]) {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).find((field) => !fields.has(field));
  if (unknown) throw new HttpError(400, `${label} has unknown field ${unknown}`);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label} must be a non-empty string`);
  return value;
}

function scopedGraph(state: ProjectState, value: unknown, label: string) {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!candidate || !("graph" in candidate) || "schema_version" in candidate) {
    return {
      graph: parseGraph(value),
      inputOriginId: state.inputOrigins.currentId,
      inputLocation: state.inputOrigins.location(),
    };
  }
  knownFields(candidate, label, ["graph", "input_origin_id"]);
  const inputOriginId = candidate.input_origin_id === undefined
    ? state.inputOrigins.currentId
    : requiredString(candidate.input_origin_id, "input_origin_id");
  return {
    graph: parseGraph(candidate.graph),
    inputOriginId,
    inputLocation: state.inputOrigins.location(inputOriginId),
  };
}

/** Canvas concurrency identity includes the runner-owned input base as well as portable graph bytes. */
function projectStateRevision(
  state: ProjectState,
  graph = state.graph,
  inputOriginId = state.inputOrigins.currentId,
) {
  return canonicalJsonDigest({
    graph_state_revision: graphStateRevision(graph),
    input_location: state.inputOrigins.location(inputOriginId),
  });
}

async function commitAutosavedGraph(
  state: ProjectState,
  graph: SomiteGraph,
  inputOriginId = state.inputOrigins.currentId,
  canonical = false,
) {
  const encoded = encodeGraph(graph);
  if (canonical) await atomicWrite(state.graphPath, encoded);
  await atomicWrite(state.autosavePath, encoded);
  await state.inputOrigins.record(inputOriginId, graph);
  state.graph = graph;
}

function parseSourceWorkflowEdits(value: unknown): SourceWorkflowEdit[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new HttpError(400, "source workflow transaction must contain between 1 and 64 edits");
  }
  return value.map((candidate, index): SourceWorkflowEdit => {
    const edit = object(candidate, `edits[${index}]`);
    const kind = requiredString(edit.kind, `edits[${index}].kind`);
    if (kind === "set_parameter") {
      knownFields(edit, `edits[${index}]`, ["kind", "name", "binding"]);
      return {
        kind,
        name: requiredString(edit.name, `edits[${index}].name`),
        binding: parseWorkflowBinding(edit.binding, `edits[${index}].binding`),
      };
    }
    if (kind === "reset_parameter") {
      knownFields(edit, `edits[${index}]`, ["kind", "name"]);
      return { kind, name: requiredString(edit.name, `edits[${index}].name`) };
    }
    if (kind === "replace_invocation") {
      knownFields(edit, `edits[${index}]`, ["kind", "invocation_id", "operator", "operator_revision", "params"]);
      return {
        kind,
        invocation_id: requiredString(edit.invocation_id, `edits[${index}].invocation_id`),
        operator: requiredString(edit.operator, `edits[${index}].operator`),
        operator_revision: requiredString(edit.operator_revision, `edits[${index}].operator_revision`),
        params: parseParameterRecord(edit.params, `edits[${index}].params`),
      };
    }
    if (kind === "reset_invocation") {
      knownFields(edit, `edits[${index}]`, ["kind", "invocation_id"]);
      return { kind, invocation_id: requiredString(edit.invocation_id, `edits[${index}].invocation_id`) };
    }
    throw new HttpError(400, `edits[${index}].kind is not supported`);
  });
}

async function mutateGraph(state: ProjectState, baseStateRevision: string, mutate: (graph: SomiteGraph) => SomiteGraph) {
  let response: ReturnType<typeof sourceWorkflowEditResponse> | undefined;
  const operation = state.writeChain.then(async () => {
    const currentRevision = projectStateRevision(state);
    if (baseStateRevision !== currentRevision) throw new HttpError(409, "canvas changed since this edit started", { state_revision: currentRevision });
    const graph = mutate(structuredClone(state.graph));
    const verified = state.catalog.verifyGraph(graph);
    if (!verified.ok) throw new HttpError(400, verified.issue.message);
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, graph);
    await commitAutosavedGraph(state, graph);
    response = { ...sourceWorkflowEditResponse(graph), state_revision: projectStateRevision(state) };
  });
  state.writeChain = operation.catch(() => undefined);
  await operation;
  return response!;
}

function requireAgentCapability(request: Request, state: ProjectState) {
  if (request.headers.get("x-somite-mcp-capability") !== state.agentCapability) {
    throw new HttpError(403, "Somite agent capability is required");
  }
}

function addTerms(terms: Set<string>, value: string | undefined) {
  if (!value) return;
  for (const term of value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) terms.add(term);
}

function operatorTerms(operator: PinnedOperator) {
  const terms = new Set<string>();
  addTerms(terms, operator.id);
  addTerms(terms, operator.title);
  for (const value of [...operator.palette, ...(operator.pixi ?? [])]) addTerms(terms, value);
  addTerms(terms, operator.bin);
  for (const [name, parameter] of Object.entries(operator.params)) {
    addTerms(terms, name);
    addTerms(terms, parameter.type);
    addTerms(terms, parameter.label);
    addTerms(terms, parameter.page);
  }
  for (const port of [...operator.ports.in, ...operator.ports.out]) {
    addTerms(terms, port.name);
    addTerms(terms, port.type);
    for (const union of port.union ?? []) addTerms(terms, union);
    if (port.resource) {
      addTerms(terms, port.resource.profile);
      addTerms(terms, port.resource.title);
      addTerms(terms, port.resource.detail);
      for (const resolution of port.resource.resolutions) {
        addTerms(terms, resolution.label);
        addTerms(terms, resolution.detail);
        addTerms(terms, resolution.scientific_effect);
      }
    }
  }
  for (const [name, output] of Object.entries(operator.outputs ?? {})) {
    addTerms(terms, name);
    addTerms(terms, output.glob);
    addTerms(terms, output.type);
  }
  if (!operator.ports.in.length && operator.ports.out.length) addTerms(terms, "source input entry local data");
  if (operator.palette.some((palette) => palette.toLowerCase() === "files")) addTerms(terms, "file files path local source input");
  if ([...operator.ports.in, ...operator.ports.out].some((port) => port.type.toLowerCase() === "fastq")) {
    addTerms(terms, "fastq read reads sequence sequences");
  }
  if (operator.ports.out.some((port) => port.name === "r1") && operator.ports.out.some((port) => port.name === "r2")) {
    addTerms(terms, "paired pair mate mates r1 r2");
  }
  return terms;
}

function searchAgentCatalog(state: ProjectState, query: string, limit: number, cursor: string | null) {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 120 || /[\p{Cc}\p{Cf}]/u.test(trimmed)) throw new HttpError(400, "catalog query must contain 1 to 120 printable characters");
  const queryTerms = new Set<string>();
  addTerms(queryTerms, trimmed);
  const terms = [...queryTerms].sort();
  const prefix = `somite-catalog-v1-${state.catalogRevision.replace(/^blake3:/, "")}-`;
  const offset = cursor === null ? 0 : cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "invalid catalog cursor");
  let matches = state.operators.flatMap((operator) => {
    if (operator.kind === "source" || operator.id.startsWith("nf.") || operator.id.startsWith("smk.")) return [];
    const known = operatorTerms(operator);
    const matchedTerms = terms.filter((term) => known.has(term) || (term.length >= 3 && [...known].some((candidate) => candidate.startsWith(term))));
    if (!matchedTerms.length || (terms.length > 1 && matchedTerms.length < 2)) return [];
    const exact = matchedTerms.filter((term) => known.has(term)).length;
    const complete = matchedTerms.length === terms.length;
    const first = terms[0]!;
    const starts = operator.id.toLowerCase().startsWith(first) || operator.title.toLowerCase().startsWith(first);
    return [{ ...operator, score: matchedTerms.length * 100 + exact * 10 + (complete ? 50 : 0) + (starts ? 25 : 0), matched_terms: matchedTerms }];
  });
  if (terms.length > 1 && matches.some((match) => match.matched_terms.length === terms.length)) {
    matches = matches.filter((match) => match.matched_terms.length === terms.length);
  }
  matches.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  if (offset > matches.length) throw new HttpError(400, "invalid catalog cursor");
  const boundedLimit = Math.max(1, Math.min(50, Number.isSafeInteger(limit) ? limit : 12));
  const nextOffset = offset + boundedLimit;
  return {
    query: trimmed,
    catalog_revision: state.catalogRevision,
    total_matches: matches.length,
    next_cursor: nextOffset < matches.length ? `${prefix}${nextOffset}` : null,
    matches: matches.slice(offset, nextOffset),
  };
}

async function applyAgentGraphTransaction(state: ProjectState, value: unknown) {
  const request = parseGraphTransaction(value);
  const requestDigest = canonicalJsonDigest(request);
  let response: (AgentTransactionResult & { replayed: boolean }) | undefined;
  const operation = state.writeChain.then(async () => {
    const replay = state.transactionReplays.get(request.idempotency_key);
    if (replay) {
      if (replay.requestDigest !== requestDigest) throw new HttpError(409, "idempotency key was already used for a different request");
      await verifyGraphSourceWorkflowTrust(state.root, state.catalog, replay.result.graph);
      response = { ...replay.result, replayed: true };
      return;
    }
    const previousStateRevision = projectStateRevision(state);
    if (request.base_state_revision !== previousStateRevision) {
      throw new HttpError(409, `transaction base ${request.base_state_revision} is stale; current state revision is ${previousStateRevision}`, {
        code: "stale_transaction",
        state_revision: previousStateRevision,
      });
    }
    const nativeResult = applyGraphTransaction(
      state.graph,
      state.catalog,
      { ...request, base_state_revision: graphStateRevision(state.graph) },
      `transaction-${randomUUID()}`,
    );
    const result: AgentTransactionResult = {
      ...nativeResult,
      previous_state_revision: previousStateRevision,
      state_revision: projectStateRevision(state, nativeResult.graph),
    };
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, result.graph);
    await commitAutosavedGraph(state, result.graph);
    rememberTransactionReplay(state, request.idempotency_key, requestDigest, result);
    response = { ...result, replayed: false };
  });
  state.writeChain = operation.catch(() => undefined);
  try {
    await operation;
  } catch (error) {
    if (error instanceof AgentTransactionError) {
      throw new HttpError(error.code === "stale_transaction" ? 409 : 422, error.message, { code: error.code, state_revision: projectStateRevision(state) });
    }
    throw error;
  }
  if (!response!.replayed) state.agent.recordTransaction(response!);
  return response!;
}

function agentEditFields(body: Record<string, unknown>) {
  const baseStateRevision = requiredString(body.base_state_revision, "base_state_revision");
  const idempotencyKey = requiredString(body.idempotency_key, "idempotency_key");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new HttpError(400, "idempotency key must contain 8 to 128 ASCII letters, numbers, hyphens, or underscores");
  const summary = requiredString(body.summary, "summary").trim();
  if ([...summary].length > 240 || /[\p{Cc}\p{Cf}]/u.test(summary)) throw new HttpError(400, "transaction summary must contain between 1 and 240 printable characters");
  return { baseStateRevision, idempotencyKey, summary };
}

async function commitAgentMutation(
  state: ProjectState,
  request: { baseStateRevision: string; idempotencyKey: string; summary: string; requestDigest: string },
  mutate: (graph: SomiteGraph) => SomiteGraph,
) {
  let response: (AgentTransactionResult & { replayed: boolean }) | undefined;
  const operation = state.writeChain.then(async () => {
    const replay = state.transactionReplays.get(request.idempotencyKey);
    if (replay) {
      if (replay.requestDigest !== request.requestDigest) throw new HttpError(409, "idempotency key was already used for a different request");
      await verifyGraphSourceWorkflowTrust(state.root, state.catalog, replay.result.graph);
      response = { ...replay.result, replayed: true };
      return;
    }
    const previousStateRevision = projectStateRevision(state);
    if (request.baseStateRevision !== previousStateRevision) throw new HttpError(409, "canvas changed since this edit started", { state_revision: previousStateRevision });
    const graph = mutate(structuredClone(state.graph));
    const verified = state.catalog.verifyGraph(graph);
    if (!verified.ok) throw new HttpError(422, verified.issue.message);
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, graph);
    const result: AgentTransactionResult = {
      transaction_id: `transaction-${randomUUID()}`,
      previous_state_revision: previousStateRevision,
      state_revision: projectStateRevision(state, graph),
      graph_revision: semanticGraphRevision(graph),
      summary: request.summary,
      graph,
    };
    await commitAutosavedGraph(state, graph);
    rememberTransactionReplay(state, request.idempotencyKey, request.requestDigest, result);
    response = { ...result, replayed: false };
  });
  state.writeChain = operation.catch(() => undefined);
  await operation;
  if (!response!.replayed) state.agent.recordTransaction(response!);
  return response!;
}

async function resolveAgentNfcore(state: ProjectState, value: unknown) {
  const body = object(value, "agent nf-core import");
  knownFields(body, "agent nf-core import", ["workflow", "revision", "base_state_revision", "idempotency_key", "summary"]);
  const fields = agentEditFields(body);
  const workflow = requiredString(body.workflow, "workflow");
  const revision = requiredString(body.revision, "revision");
  const requestDigest = canonicalJsonDigest(body);
  await state.writeChain;
  const replay = state.transactionReplays.get(fields.idempotencyKey);
  if (replay) {
    if (replay.requestDigest !== requestDigest) throw new HttpError(409, "idempotency key was already used for a different request");
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, replay.result.graph);
    return { ...replay.result, replayed: true };
  }
  const currentRevision = projectStateRevision(state);
  if (fields.baseStateRevision !== currentRevision) throw new HttpError(409, "canvas changed since this import started", { state_revision: currentRevision });
  if (state.graph.nodes.length || state.graph.edges.length) throw new HttpError(422, "source workflow import requires an empty canvas");
  const imported = await state.nfcore.import(workflow, revision);
  return commitAgentMutation(state, { ...fields, requestDigest }, (current) => ({
    ...imported.graph,
    ...(current.name ? { name: current.name } : {}),
    ...(current.annotations?.length ? { annotations: current.annotations } : {}),
  }));
}

async function editAgentSourceWorkflow(state: ProjectState, value: unknown) {
  const body = object(value, "agent source workflow edit");
  knownFields(body, "agent source workflow edit", ["base_state_revision", "workflow_revision", "idempotency_key", "summary", "edits"]);
  const fields = agentEditFields(body);
  const workflowRevision = requiredString(body.workflow_revision, "workflow_revision");
  const edits = parseSourceWorkflowEdits(body.edits);
  return commitAgentMutation(state, { ...fields, requestDigest: canonicalJsonDigest(body) }, (graph) => {
    const sources = graph.nodes.filter((node) => node.source_workflow);
    if (sources.length !== 1 || graph.nodes.length !== 1 || graph.edges.length) throw new HttpError(422, "current canvas does not contain one editable source workflow");
    const source = sources[0]!;
    return { ...graph, nodes: [{ ...source, source_workflow: applySourceWorkflowEdits(source.source_workflow!, workflowRevision, edits) }] };
  });
}

async function promoteAgentSourceWorkflow(state: ProjectState, value: unknown) {
  const body = object(value, "agent source workflow promotion");
  knownFields(body, "agent source workflow promotion", ["base_state_revision", "workflow_revision", "invocation_id", "idempotency_key", "summary"]);
  const fields = agentEditFields(body);
  const workflowRevision = requiredString(body.workflow_revision, "workflow_revision");
  const invocationId = requiredString(body.invocation_id, "invocation_id");
  return commitAgentMutation(state, { ...fields, requestDigest: canonicalJsonDigest(body) }, (graph) => promoteSourceInvocation(
    graph,
    workflowRevision,
    invocationId,
    state.catalog,
  ));
}

async function saveAgentPromptGraph(state: ProjectState, value: unknown) {
  const body = object(value, "agent prompt");
  knownFields(body, "agent prompt", ["message", "base_state_revision", "graph", "input_origin_id"]);
  const message = requiredString(body.message, "message");
  state.agent.preflightPrompt(message);
  const baseStateRevision = requiredString(body.base_state_revision, "base_state_revision");
  const graph = parseGraph(body.graph);
  const inputOriginId = body.input_origin_id === undefined
    ? state.inputOrigins.currentId
    : requiredString(body.input_origin_id, "input_origin_id");
  state.inputOrigins.location(inputOriginId);
  const verified = state.catalog.verifyGraph(graph);
  if (!verified.ok) throw new HttpError(400, verified.issue.message);
  let stateRevision = "";
  const operation = state.writeChain.then(async () => {
    const currentRevision = projectStateRevision(state);
    if (baseStateRevision !== currentRevision) throw new HttpError(409, "canvas changed since this prompt started", { state_revision: currentRevision });
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, graph);
    await commitAutosavedGraph(state, graph, inputOriginId);
    stateRevision = projectStateRevision(state);
  });
  state.writeChain = operation.catch(() => undefined);
  await operation;
  await state.agent.prompt(message);
  return { valid: true, state_revision: stateRevision };
}

async function saveGraph(state: ProjectState, request: Request, canonical: boolean) {
  const body = object(await requestWorkflowJson(request), "graph write");
  knownFields(body, "graph write", ["base_state_revision", "graph", "input_origin_id"]);
  if (typeof body.base_state_revision !== "string") throw new HttpError(400, "base_state_revision must be a string");
  const graph = parseGraph(body.graph);
  const inputOriginId = body.input_origin_id === undefined
    ? state.inputOrigins.currentId
    : requiredString(body.input_origin_id, "input_origin_id");
  state.inputOrigins.location(inputOriginId);
  const catalogResult = state.catalog.verifyGraph(graph);
  if (!catalogResult.ok) throw new HttpError(400, catalogResult.issue.message);
  let responseRevision = "";
  const operation = state.writeChain.then(async () => {
    const currentRevision = projectStateRevision(state);
    if (body.base_state_revision !== currentRevision) {
      throw new HttpError(409, "canvas changed since this edit started", { state_revision: currentRevision });
    }
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, graph);
    await commitAutosavedGraph(state, graph, inputOriginId, canonical);
    responseRevision = projectStateRevision(state);
  });
  state.writeChain = operation.catch(() => undefined);
  await operation;
  return json({ valid: true, state_revision: responseRevision });
}

function paperResource(value: unknown, index: number): PaperResourceCitation {
  const resource = object(value, `resources[${index}]`);
  knownFields(resource, `resources[${index}]`, ["accession", "kind", "role", "context", "source_location"]);
  const accession = requiredString(resource.accession, `resources[${index}].accession`).toUpperCase();
  const kinds = new Set(["sra_study", "sra_sample", "sra_experiment", "sra_run", "bioproject", "biosample", "assembly", "ensembl"]);
  const roles = new Set(["reads", "reference", "annotation", "sample_metadata", "unknown"]);
  if (typeof resource.kind !== "string" || !kinds.has(resource.kind)) throw new HttpError(400, `resources[${index}].kind is invalid`);
  const detectedKind = paperAccessionKind(accession);
  if (!detectedKind) throw new HttpError(400, `resources[${index}].accession is not a supported biological accession`);
  if (detectedKind !== resource.kind) {
    throw new HttpError(400, `resources[${index}].kind must be ${detectedKind} for ${accession}`);
  }
  if (typeof resource.role !== "string" || !roles.has(resource.role)) throw new HttpError(400, `resources[${index}].role is invalid`);
  if (typeof resource.context !== "string" || resource.context.length > 1_000) throw new HttpError(400, `resources[${index}].context is invalid`);
  if (resource.source_location !== undefined && (typeof resource.source_location !== "string" || resource.source_location.length > 100)) throw new HttpError(400, `resources[${index}].source_location is invalid`);
  return {
    accession,
    kind: resource.kind as PaperResourceCitation["kind"],
    role: resource.role as PaperResourceCitation["role"],
    context: resource.context,
    ...(typeof resource.source_location === "string" ? { source_location: resource.source_location } : {}),
  };
}

async function resolvePaperResources(state: ProjectState, value: unknown) {
  const body = object(value, "paper resource request");
  knownFields(body, "paper resource request", ["resources"]);
  if (!Array.isArray(body.resources) || body.resources.length > 32) throw new HttpError(400, "resources must be an array of at most 32 citations");
  const resources = body.resources.map(paperResource);
  const groups = [];
  for (const citation of resources) {
    const provider = citation.kind === "ensembl" ? "ensembl" : "ncbi";
    const query = provider === "ncbi" && (citation.role === "reference" || citation.role === "annotation")
      ? `${citation.accession} genome assembly`
      : citation.accession;
    try {
      const response = await state.sourceSearch.search(provider, query);
      groups.push({ citation, provider, status: response.results.length ? "available" : "unavailable", results: response.results.slice(0, 24) });
    } catch {
      groups.push({ citation, provider, status: "unavailable", results: [] });
    }
  }
  return { groups };
}

async function systemProfile(state: ProjectState) {
  const [hardware, pixi, prefetch, datasets, nextflow, snakemake, paperExtraction] = await Promise.all([
    detectHardwareProfile(),
    executablePath(state.root, "pixi"),
    executablePath(state.root, "prefetch"),
    executablePath(state.root, "datasets"),
    executablePath(state.root, "nextflow"),
    executablePath(state.root, "snakemake"),
    state.papers.paperTools.preflight(),
  ]);
  return {
    ...hardware,
    tools: {
      pixi: Boolean(pixi),
      sra: Boolean(prefetch),
      datasets: Boolean(datasets),
      ensembl: true,
      nextflow: Boolean(nextflow),
      snakemake: Boolean(snakemake),
    },
    paper_extraction: paperExtraction,
  };
}

async function route(request: Request, state: ProjectState): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, runtime: "typescript", version: SOMITE_VERSION });
  }
  if (request.method === "GET" && url.pathname === "/api/session") {
    await state.writeChain;
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, state.graph);
    return json({
      project_name: basename(state.root) || "Somite project",
      graph_path: displayedPath(state.root, state.graphPath),
      graph: state.graph,
      operators: state.operators,
      recovered_autosave: state.recoveredAutosave,
      autosave_recovery_warning: state.autosaveRecoveryWarning,
      input_origin_warning: state.inputOrigins.warning,
      input_origin_id: state.inputOrigins.currentId,
      agent_cursor: 0,
      state_revision: projectStateRevision(state),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/agent/discover") {
    return json(await discoverAgents(state.root));
  }
  if (request.method === "POST" && url.pathname === "/api/agent/connect") {
    const body = object(await requestJson(request), "agent connection");
    knownFields(body, "agent connection", ["command"]);
    return json(await state.agent.connect(requiredString(body.command, "command")));
  }
  if (request.method === "POST" && url.pathname === "/api/agent/prompt") {
    return json(await saveAgentPromptGraph(state, await requestJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/agent/config") {
    const body = object(await requestJson(request), "agent configuration");
    knownFields(body, "agent configuration", ["config_id", "value"]);
    if (typeof body.value !== "string" && typeof body.value !== "boolean") throw new HttpError(400, "configuration value must be a string or boolean");
    return json(await state.agent.configure(requiredString(body.config_id, "config_id"), body.value));
  }
  if (request.method === "POST" && url.pathname === "/api/agent/cancel") {
    await state.agent.cancel();
    return new Response(null, { status: 204 });
  }
  if (request.method === "POST" && url.pathname === "/api/agent/disconnect") {
    await state.agent.disconnect();
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET" && url.pathname === "/api/agent/events") {
    const after = Number(url.searchParams.get("after") ?? 0);
    return json(state.agent.snapshot(Number.isSafeInteger(after) && after >= 0 ? after : 0, projectStateRevision(state)));
  }
  if (request.method === "GET" && url.pathname === "/api/agent/transcript") {
    return json(state.agent.transcript());
  }
  const permissionMatch = url.pathname.match(/^\/api\/agent\/permissions\/([^/]+)$/);
  if (request.method === "POST" && permissionMatch) {
    const body = object(await requestJson(request), "agent permission");
    knownFields(body, "agent permission", ["option_id"]);
    if (body.option_id !== undefined && typeof body.option_id !== "string") throw new HttpError(400, "option_id must be a string");
    state.agent.answerPermission(decodeURIComponent(permissionMatch[1]), body.option_id as string | undefined);
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET" && url.pathname === "/api/agent/graph") {
    requireAgentCapability(request, state);
    await state.writeChain;
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, state.graph);
    return json({
      state_revision: projectStateRevision(state),
      graph_revision: semanticGraphRevision(state.graph),
      graph: state.graph,
    });
  }
  if (request.method === "GET" && url.pathname === "/api/agent/catalog") {
    requireAgentCapability(request, state);
    return json(searchAgentCatalog(
      state,
      url.searchParams.get("q") ?? "",
      Number(url.searchParams.get("limit") ?? 12),
      url.searchParams.get("cursor"),
    ));
  }
  if (request.method === "POST" && url.pathname === "/api/agent/transactions") {
    requireAgentCapability(request, state);
    return json(await applyAgentGraphTransaction(state, await requestJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/agent/source-workflows/nfcore/resolve") {
    requireAgentCapability(request, state);
    return json(await resolveAgentNfcore(state, await requestJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/agent/source-workflows/edit") {
    requireAgentCapability(request, state);
    return json(await editAgentSourceWorkflow(state, await requestJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/agent/source-workflows/promote") {
    requireAgentCapability(request, state);
    return json(await promoteAgentSourceWorkflow(state, await requestJson(request)));
  }
  if (request.method === "GET" && url.pathname === "/api/agent/readiness") {
    requireAgentCapability(request, state);
    await state.writeChain;
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, state.graph);
    return json(assessWorkflow(state.graph, state.catalog));
  }
  if (request.method === "POST" && url.pathname === "/api/agent/compile") {
    requireAgentCapability(request, state);
    await requestJson(request);
    await state.writeChain;
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, state.graph);
    return json(await state.runs.compile(
      state.graph,
      { archiveName: state.graph.name ?? basename(state.root), platform: pixiPlatform() },
      state.inputOrigins.location(),
    ));
  }
  if (request.method === "GET" && url.pathname === "/api/agent/evidence") {
    requireAgentCapability(request, state);
    const subject = url.searchParams.get("subject") ?? semanticGraphRevision(state.graph);
    if (!subject || subject.length > 160 || /[\p{Cc}\p{Cf}]/u.test(subject)) throw new HttpError(400, "evidence subject digest is invalid");
    return json(await state.runs.evidence(subject));
  }
  if (request.method === "GET" && url.pathname === "/api/system") return json(await systemProfile(state));
  if (request.method === "POST" && url.pathname === "/api/paper-tools/ocr/install") {
    const body = object(await requestJson(request), "paper OCR setup request");
    knownFields(body, "paper OCR setup request", []);
    return json(await state.papers.paperTools.installManaged());
  }
  if (request.method === "GET" && url.pathname === "/api/storage") return json(await state.runs.storage());
  if (request.method === "POST" && url.pathname === "/api/storage/dehydrate-runs") {
    const body = object(await requestJson(request), "run cleanup request");
    knownFields(body, "run cleanup request", ["run_ids"]);
    if (!Array.isArray(body.run_ids) || body.run_ids.length < 1 || body.run_ids.length > 256
      || body.run_ids.some((runId) => typeof runId !== "string")) {
      throw new HttpError(400, "run_ids must contain between 1 and 256 run identifiers");
    }
    try {
      return json(await state.runs.dehydrateRuns(body.run_ids as string[]));
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "GET" && url.pathname === "/api/catalog/nfcore") {
    try {
      return json(await state.nfcore.catalog());
    } catch (error) {
      throw new HttpError(502, `nf-core catalog is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (request.method === "GET" && url.pathname === "/api/catalog/snakemake") {
    try {
      return json(await state.snakemake.catalogResponse());
    } catch (error) {
      throw new HttpError(502, `Snakemake catalog is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (request.method === "GET" && url.pathname === "/api/source-workflows/nfcore/search") {
    const limit = Number(url.searchParams.get("limit") ?? 12);
    try {
      return json(await state.nfcore.search(
        url.searchParams.get("q") ?? "",
        Number.isSafeInteger(limit) ? limit : 12,
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(message.includes("query must") ? 400 : 502, message);
    }
  }
  if (request.method === "POST" && (url.pathname === "/api/catalog/nfcore/expand" || url.pathname === "/api/source-workflows/nfcore/resolve")) {
    const body = object(await requestJson(request), "nf-core source request");
    knownFields(body, "nf-core source request", ["workflow", "revision"]);
    try {
      return json(await state.nfcore.import(
        requiredString(body.workflow, "workflow"),
        requiredString(body.revision, "revision"),
      ));
    } catch (error) {
      if (error instanceof SourceWorkflowTrustError) throw error;
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/catalog/snakemake/expand") {
    const body = object(await requestJson(request), "Snakemake workflow request");
    knownFields(body, "Snakemake workflow request", ["workflow", "revision"]);
    try {
      return json(await state.snakemake.expand(
        requiredString(body.workflow, "workflow"),
        requiredString(body.revision, "revision"),
      ));
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/workflows/snakemake/import") {
    const body = object(await requestJson(request), "local Snakemake workflow request");
    knownFields(body, "local Snakemake workflow request", ["path", "targets"]);
    try {
      return json(await state.snakemake.importLocal(requiredString(body.path, "path"), body.targets));
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/projects/open") {
    const opened = await state.projects.open(await requestJson(request));
    if (opened.kind !== "somite") return json(opened);
    const inputOriginId = await state.inputOrigins.registerOpenedGraph(opened.input_base);
    const { input_base: _inputBase, ...response } = opened;
    return json({ ...response, input_origin_id: inputOriginId });
  }
  if (request.method === "GET" && url.pathname === "/api/sources/search") {
    const provider = url.searchParams.get("provider");
    if (provider !== "ncbi" && provider !== "ensembl") throw new HttpError(400, "provider must be ncbi or ensembl");
    try {
      return json(await state.sourceSearch.search(provider, url.searchParams.get("q") ?? ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("search query must")) throw new HttpError(400, message);
      throw new HttpError(502, `public data search failed: ${message}`);
    }
  }
  if (request.method === "GET" && url.pathname === "/api/papers/search") {
    try {
      return json(await state.literature.search(url.searchParams.get("q") ?? ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(message.includes("query must") ? 400 : 502, message);
    }
  }
  if (request.method === "POST" && url.pathname === "/api/paper/resources/resolve") {
    return json(await resolvePaperResources(state, await requestJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/papers/intakes") {
    const body = object(await requestJson(request), "paper intake request");
    knownFields(body, "paper intake request", ["digest"]);
    try {
      return json(await state.papers.start(requiredString(body.digest, "digest"), url.searchParams.get("idempotency_key") ?? undefined), { status: 202 });
    } catch (error) {
      if (error instanceof PaperStoreError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(message.includes("idempotency") ? 400 : message.includes("capacity") ? 429 : 422, message);
    }
  }
  const paperCancel = url.pathname.match(/^\/api\/papers\/intakes\/([^/]+)\/cancel$/);
  if (request.method === "POST" && paperCancel) {
    try {
      return json(await state.papers.cancel(decodeURIComponent(paperCancel[1])));
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : String(error));
    }
  }
  const paperStatus = url.pathname.match(/^\/api\/papers\/intakes\/([^/]+)$/);
  if (request.method === "GET" && paperStatus) {
    const wait = Number(url.searchParams.get("wait_ms") ?? 0);
    try {
      return json(await state.papers.status(decodeURIComponent(paperStatus[1]), Number.isFinite(wait) ? wait : 0));
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/paper") {
    const body = object(await requestJson(request), "paper request");
    knownFields(body, "paper request", ["path"]);
    const source = await state.papers.store.resolveProjectPath(requiredString(body.path, "path"));
    try {
      const extracted = await state.papers.extract(source.bytes, source.mediaKind);
      return json(reconstructPaper(state.catalog, extracted.text, extracted.extractedVia));
    } catch (error) {
      if (error instanceof PaperExtractionError) throw new HttpError(422, error.message, { code: error.code, retryable: error.retryable });
      throw error;
    }
  }
  if (request.method === "POST" && url.pathname === "/api/papers/biorxiv/reconstruct") {
    const body = object(await requestJson(request), "bioRxiv reconstruction request");
    knownFields(body, "bioRxiv reconstruction request", ["id"]);
    try {
      const text = await state.literature.fullText(requiredString(body.id, "id"));
      return json(reconstructPaper(state.catalog, text, "jats"));
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/source-workflows/edit") {
    const body = object(await requestJson(request), "source workflow edit");
    knownFields(body, "source workflow edit", ["base_state_revision", "workflow_revision", "edits"]);
    const baseStateRevision = requiredString(body.base_state_revision, "base_state_revision");
    const workflowRevision = requiredString(body.workflow_revision, "workflow_revision");
    const edits = parseSourceWorkflowEdits(body.edits);
    try {
      return json(await mutateGraph(state, baseStateRevision, (graph) => {
        const sources = graph.nodes.filter((node) => node.source_workflow);
        if (sources.length !== 1 || graph.nodes.length !== 1 || graph.edges.length) throw new Error("source workflow edits require one source-backed node and no edges");
        const source = sources[0]!;
        const edited = applySourceWorkflowEdits(source.source_workflow!, workflowRevision, edits);
        return { ...graph, nodes: [{ ...source, source_workflow: edited }] };
      }));
    } catch (error) {
      if (error instanceof HttpError || error instanceof SourceWorkflowTrustError) throw error;
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/source-workflows/promote") {
    const body = object(await requestJson(request), "source workflow promotion");
    knownFields(body, "source workflow promotion", ["base_state_revision", "workflow_revision", "invocation_id"]);
    try {
      return json(await mutateGraph(
        state,
        requiredString(body.base_state_revision, "base_state_revision"),
        (graph) => promoteSourceInvocation(
          graph,
          requiredString(body.workflow_revision, "workflow_revision"),
          requiredString(body.invocation_id, "invocation_id"),
          state.catalog,
        ),
      ));
    } catch (error) {
      if (error instanceof HttpError || error instanceof SourceWorkflowTrustError) throw error;
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/source-workflows/restore") {
    const body = object(await requestJson(request), "source workflow restore");
    knownFields(body, "source workflow restore", ["base_state_revision"]);
    try {
      return json(await mutateGraph(
        state,
        requiredString(body.base_state_revision, "base_state_revision"),
        (graph) => restoreSourceWorkflow(graph, state.catalog),
      ));
    } catch (error) {
      if (error instanceof HttpError || error instanceof SourceWorkflowTrustError) throw error;
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "PUT" && url.pathname === "/api/graph") return saveGraph(state, request, true);
  if (request.method === "PUT" && url.pathname === "/api/graph/autosave") return saveGraph(state, request, false);
  if (request.method === "POST" && url.pathname === "/api/graph/validate") {
    const { graph } = scopedGraph(state, await requestWorkflowJson(request), "graph validation request");
    const verified = state.catalog.verifyGraph(graph);
    if (!verified.ok) throw new HttpError(400, verified.issue.message);
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, graph);
    return json({ valid: true });
  }
  if (request.method === "POST" && url.pathname === "/api/export/plan") {
    const { graph } = scopedGraph(state, await requestWorkflowJson(request), "export plan request");
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, graph);
    return json(planFrozenPackage(graph, state.catalog, {
      archiveName: graph.name ?? basename(state.root),
      platform: pixiPlatform(),
    }, (binary) => state.availableBinaries.has(binary)));
  }
  if (request.method === "POST" && url.pathname === "/api/export") {
    const { graph, inputLocation } = scopedGraph(state, await requestWorkflowJson(request), "export request");
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, graph);
    const exported = await state.runs.export(graph, {
      archiveName: graph.name ?? basename(state.root),
      platform: pixiPlatform(),
    }, inputLocation);
    return new Response(exported.bytes, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${exported.filename}"`,
      },
    });
  }
  if (request.method === "POST" && (url.pathname === "/api/runs" || url.pathname === "/api/validations")) {
    const { graph, inputLocation } = scopedGraph(state, await requestWorkflowJson(request), "run request");
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, graph);
    try {
      const started = await state.runs.start(
        graph,
        url.pathname === "/api/validations" ? "validation" : "run",
        url.searchParams.get("idempotency_key") ?? undefined,
        inputLocation,
      );
      return json(started, { status: 202 });
    } catch (error) {
      if (error instanceof WorkflowAdmissionError || error instanceof ProductionInputError || error instanceof RepresentativeValidationError) throw error;
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/validations/status") {
    const { graph } = scopedGraph(state, await requestWorkflowJson(request), "validation status request");
    await verifyGraphSourceWorkflowTrust(state.root, state.catalog, graph);
    try {
      return json(await state.runs.validationStatus(graph));
    } catch (error) {
      if (error instanceof RepresentativeValidationError) throw error;
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }
  const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    try {
      return json(await state.runs.cancel(decodeURIComponent(cancelMatch[1])));
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : String(error));
    }
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch) {
    const wait = Number(url.searchParams.get("wait_ms") ?? 0);
    try {
      return json(await state.runs.status(
        decodeURIComponent(runMatch[1]),
        Number.isFinite(wait) && wait > 0 ? wait : 0,
      ));
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : String(error));
    }
  }
  throw new HttpError(404, "route not found");
}

function nodeRequest(request: IncomingMessage) {
  const origin = `http://${request.headers.host ?? `127.0.0.1:${DEFAULT_PORT}`}`;
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers as HeadersInit,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(new URL(request.url ?? "/", origin), init);
}

function uploadRequest(request: IncomingMessage) {
  const origin = `http://${request.headers.host ?? `127.0.0.1:${DEFAULT_PORT}`}`;
  return new Request(new URL(request.url ?? "/", origin), {
    method: request.method,
    headers: request.headers as HeadersInit,
  });
}

function loopbackAuthority(authority: string | null) {
  if (!authority) return false;
  try {
    const hostname = new URL(`http://${authority}`).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function authorizeRequest(request: Request, state: ProjectState) {
  if (!loopbackAuthority(request.headers.get("host"))) throw new HttpError(403, "Somite accepts requests only through its loopback runner");
  const origin = request.headers.get("origin");
  if (origin && origin !== state.allowedOrigin) throw new HttpError(403, "request origin is not the Somite browser");
  if (request.method === "OPTIONS" && origin === null) throw new HttpError(403, "browser preflight requires the Somite origin");
  const authenticatedMcp = request.headers.get("x-somite-mcp-capability") === state.agentCapability;
  if (requestIsMutation(request) && origin === null && request.headers.get("x-somite-request") !== "local" && !authenticatedMcp) {
    throw new HttpError(403, "originless mutations require an explicit local capability");
  }
}

async function send(response: Response, destination: ServerResponse) {
  destination.statusCode = response.status;
  response.headers.forEach((value, key) => destination.setHeader(key, value));
  if (!response.body) {
    destination.end();
    return;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    source.on("error", rejectPromise);
    destination.on("error", rejectPromise);
    destination.on("finish", resolvePromise);
    source.pipe(destination);
  });
}

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env.SOMITE_PORT ?? DEFAULT_PORT);
  const host = options.host ?? process.env.SOMITE_HOST ?? "127.0.0.1";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Somite runner port must be an integer from 1 to 65535");
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host)) throw new Error("Somite runner must bind to a loopback host");
  const loopbackHost = host === "::1" ? "[::1]" : host;
  const state = await initializeProject(`http://${loopbackHost}:${port}`, options);
  const server = createServer(async (incoming, outgoing) => {
    const pathname = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? `127.0.0.1:${port}`}`).pathname;
    const isFileUpload = incoming.method === "POST" && pathname === "/api/files";
    const isPaperUpload = incoming.method === "POST" && pathname === "/api/papers/uploads";
    const request = isFileUpload || isPaperUpload ? uploadRequest(incoming) : nodeRequest(incoming);
    let response: Response;
    try {
      authorizeRequest(request, state);
      if (isFileUpload) {
        response = json(await state.uploads.receive(incoming));
      } else if (isPaperUpload) {
        response = json(await state.papers.store.receive(incoming));
      } else response = await route(request, state);
    } catch (error) {
      response = error instanceof HttpError
        ? errorResponse(error.status, error.message, error.extra)
        : error instanceof SourceWorkflowTrustError
          ? errorResponse(422, error.message, { code: error.code })
        : error instanceof WorkflowAdmissionError
          ? errorResponse(422, error.message, { code: "workflow_not_ready", assessment: error.assessment })
        : error instanceof ProductionInputError
          ? errorResponse(422, error.message, { code: error.code })
        : error instanceof RepresentativeValidationError
          ? errorResponse(422, error.message, { code: error.code, capability: error.capability })
        : error instanceof ProjectGatewayError
          ? errorResponse(
            error.code === "project_ambiguous" ? 409
              : error.code === "project_request_invalid" || error.code === "project_path_invalid" ? 400 : 422,
            error.message,
            { code: error.code },
          )
        : error instanceof InputOriginError
          ? errorResponse(400, error.message, { code: error.code })
        : error instanceof AgentManagerError
          ? errorResponse(error.code === "already_connected" || error.code === "busy" ? 409 : error.code === "not_connected" ? 404 : 400, error.message, { code: error.code })
        : error instanceof PaperStoreError
          ? errorResponse(error.status, error.message, { code: error.code })
        : error instanceof PaperToolchainError
          ? errorResponse(
            error.code === "paper_tool_install_busy" ? 409
              : error.code === "paper_command_invalid" || error.code === "paper_directory_unavailable" ? 400 : 422,
            error.message,
            { code: error.code, retryable: error.retryable },
          )
        : error instanceof UploadError
          ? errorResponse(error.status, error.message)
          : errorResponse(500, error instanceof Error ? error.message : String(error));
    }
    await send(withCors(request, response, state), outgoing).catch(() => outgoing.destroy());
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, resolvePromise);
  });
  process.stdout.write(`Somite TypeScript runner listening at http://${host}:${port}\n`);
  let closing: Promise<void> | undefined;
  return {
    server,
    url: `http://${loopbackHost}:${port}`,
    close() {
      if (closing) return closing;
      closing = (async () => {
        const serverClosed = new Promise<void>((resolvePromise, rejectPromise) => {
          server.close((error) => error ? rejectPromise(error) : resolvePromise());
        });
        await Promise.allSettled([
          state.runs.shutdown(),
          state.papers.shutdown(),
          state.agent.disconnect().catch(() => undefined),
        ]);
        server.closeAllConnections();
        await serverClosed;
      })();
      return closing;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const running = await startServer();
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    void running.close().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => stop(130));
  process.once("SIGTERM", () => stop(143));
  if (process.platform !== "win32") process.once("SIGHUP", () => stop(129));
}
