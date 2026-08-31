import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { OperatorCatalog, type Operator, type PinnedOperator } from "@somite/workflow/catalog";
import { operatorRevision, parseOperator } from "@somite/workflow/catalogCodec";
import { canonicalJsonDigest } from "@somite/workflow/contentIdentity";
import type { SomiteGraph } from "@somite/workflow/model";
import { semanticGraphRevision } from "@somite/workflow/workflow";

import { atomicWrite, ensurePrivateDirectory, pathExists, regularFile } from "./files.ts";
import { RunManager, type RunStatus } from "./jobs.ts";

const MAX_CANDIDATE_BYTES = 1024 * 1024;
const PROJECT_OPERATOR_ID = /^project\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export type OperatorEvidenceSource = Readonly<{
  kind: "official_docs" | "source" | "package_recipe" | "workflow_use";
  url: string;
}>;

export type OperatorProofReceipt = Readonly<{
  schema_version: 1;
  receipt_digest: string;
  candidate_id: string;
  operator_revision: string;
  graph_revision: string;
  run_id: string;
  closure_digest: string | null;
  result: "passed" | "failed";
  finished_at: string;
}>;

export type OperatorCandidate = Readonly<{
  schema_version: 1;
  candidate_id: string;
  operator: PinnedOperator;
  sources: readonly OperatorEvidenceSource[];
  created_at: string;
  status: "draft" | "proven" | "accepted";
  proof?: OperatorProofReceipt;
}>;

type ActiveProof = {
  candidateId: string;
  graphRevision: string;
  manager: RunManager;
  runId: string;
  finalized?: OperatorProofReceipt;
};

function candidateFilename(candidateId: string) {
  return `${candidateId.replaceAll(".", "--")}.json`;
}

function exactHttpsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("operator evidence URLs must be credential-free HTTPS URLs without fragments");
  return url.toString();
}

function normalizedSources(value: readonly OperatorEvidenceSource[]) {
  if (!value.length || value.length > 8) throw new Error("operator candidates require between 1 and 8 authoritative evidence sources");
  const sources = value.map((source) => ({ kind: source.kind, url: exactHttpsUrl(source.url) }));
  if (new Set(sources.map((source) => `${source.kind}:${source.url}`)).size !== sources.length) throw new Error("operator evidence contains a duplicate source");
  return sources;
}

function normalizedCandidateOperator(value: unknown, catalog: OperatorCatalog): PinnedOperator {
  const operator = parseOperator(value, "operator candidate");
  if (!PROJECT_OPERATOR_ID.test(operator.id)) throw new Error("project-local operator ids must start with project. and use lowercase identifier segments");
  if (catalog.get(operator.id)) throw new Error(`operator ${operator.id} already exists in the reviewed catalog`);
  if (operator.kind !== "external") throw new Error("the Operator Workshop currently admits only external executable tools");
  if (!operator.bin?.trim() || operator.argv?.[0] !== operator.bin) throw new Error("an external candidate must declare one binary and use it as argv[0]");
  if (!operator.pixi?.length) throw new Error("an external candidate must declare at least one Pixi package requirement");
  if (!operator.ports.out.length) throw new Error("an external candidate must declare at least one typed output");
  for (const port of operator.ports.out) {
    const output = operator.outputs?.[port.name];
    if (!port.optional && !output) throw new Error(`required output port ${port.name} has no artifact collection contract`);
    if (output && output.type !== port.type) throw new Error(`output ${port.name} type does not match its port`);
  }
  return { ...operator, revision: operatorRevision(operator) };
}

function persistedOperator(operator: PinnedOperator) {
  const { revision: _revision, ...value } = operator;
  return value;
}

export class OperatorWorkshop {
  readonly #root: string;
  readonly #repositoryRoot: string;
  readonly #acceptedDirectory: string;
  readonly #candidateDirectory: string;
  readonly #onAccept: (operator: PinnedOperator) => Promise<void>;
  #catalog: OperatorCatalog;
  readonly #proofs = new Map<string, ActiveProof>();
  readonly #proofReplays = new Map<string, { request: string; proofId: string }>();

  constructor(options: {
    root: string;
    repositoryRoot: string;
    catalog: OperatorCatalog;
    onAccept: (operator: PinnedOperator) => Promise<void>;
  }) {
    this.#root = options.root;
    this.#repositoryRoot = options.repositoryRoot;
    this.#catalog = options.catalog;
    this.#onAccept = options.onAccept;
    this.#acceptedDirectory = join(options.root, ".somite", "operators");
    this.#candidateDirectory = join(options.root, ".somite", "operator-workshop", "candidates");
  }

  updateCatalog(catalog: OperatorCatalog) {
    if (!catalog.isExtensionOf(this.#catalog)) throw new Error("workshop catalog updates must preserve every pinned operator revision");
    this.#catalog = catalog;
  }

  async list() {
    if (!await pathExists(this.#candidateDirectory)) return [];
    const files = (await readdir(this.#candidateDirectory)).filter((file) => file.endsWith(".json")).sort();
    return Promise.all(files.map((file) => this.#read(join(this.#candidateDirectory, file))));
  }

  async draft(value: unknown, sources: readonly OperatorEvidenceSource[]) {
    const operator = normalizedCandidateOperator(value, this.#catalog);
    const candidateId = operator.id;
    const path = join(await ensurePrivateDirectory(this.#root, ".somite/operator-workshop/candidates"), candidateFilename(candidateId));
    const existing = await pathExists(path) ? await this.#read(path) : undefined;
    if (existing) {
      if (existing.operator.revision !== operator.revision) throw new Error(`candidate ${candidateId} already exists with a different contract`);
      return existing;
    }
    const candidate: OperatorCandidate = {
      schema_version: 1,
      candidate_id: candidateId,
      operator,
      sources: normalizedSources(sources),
      created_at: new Date().toISOString(),
      status: "draft",
    };
    await atomicWrite(path, `${JSON.stringify(candidate, null, 2)}\n`);
    return candidate;
  }

  async startProof(candidateId: string, graph: SomiteGraph, idempotencyKey: string) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error("invalid operator proof idempotency key");
    const candidate = await this.get(candidateId);
    if (candidate.status === "accepted") throw new Error("accepted operators do not need another candidate proof");
    const graphRevision = semanticGraphRevision(graph);
    const request = canonicalJsonDigest({ candidate: candidate.operator.revision, graph: graphRevision });
    const replay = this.#proofReplays.get(idempotencyKey);
    if (replay) {
      if (replay.request !== request) throw new Error("operator proof idempotency key was already used for another request");
      return { proof_id: replay.proofId, replayed: true };
    }
    const catalog = new OperatorCatalog([...this.#catalog.values(), candidate.operator]);
    const verified = catalog.verifyGraph(graph);
    if (!verified.ok) throw new Error(verified.issue.message);
    const candidateNodes = graph.nodes.filter((node) => node.operator === candidate.operator.id && node.operator_revision === candidate.operator.revision);
    if (candidateNodes.length !== 1) throw new Error("operator proof graph must contain the exact candidate once");
    const manager = new RunManager(this.#root, this.#repositoryRoot, catalog);
    const started = await manager.start(graph, "run", idempotencyKey);
    const proofId = `operator-proof-${randomUUID()}`;
    this.#proofs.set(proofId, { candidateId, graphRevision, manager, runId: started.run_id });
    this.#proofReplays.set(idempotencyKey, { request, proofId });
    return { proof_id: proofId, replayed: false };
  }

  async proofStatus(proofId: string, waitMs = 0) {
    const proof = this.#proofs.get(proofId);
    if (!proof) throw new Error(`operator proof ${proofId} was not found`);
    const status = await proof.manager.status(proof.runId, waitMs);
    if (TERMINAL.has(status.phase) && !proof.finalized) proof.finalized = await this.#finalize(proof, status);
    return { proof_id: proofId, candidate_id: proof.candidateId, run: status, ...(proof.finalized ? { receipt: proof.finalized } : {}) };
  }

  async accept(candidateId: string) {
    const candidate = await this.get(candidateId);
    if (candidate.status === "accepted") return candidate;
    if (candidate.status !== "proven" || candidate.proof?.result !== "passed") throw new Error("operator candidate needs a passing isolated fixture proof before acceptance");
    await ensurePrivateDirectory(this.#root, ".somite/operators");
    if (this.#catalog.get(candidateId)) throw new Error(`operator ${candidateId} entered the project catalog outside this candidate acceptance`);
    const acceptedPath = join(this.#acceptedDirectory, candidateFilename(candidateId));
    if (await pathExists(acceptedPath)) throw new Error(`operator ${candidateId} already has an unmanaged project catalog file`);
    await atomicWrite(acceptedPath, `${JSON.stringify(persistedOperator(candidate.operator), null, 2)}\n`);
    try {
      await this.#onAccept(candidate.operator);
    } catch (error) {
      await rm(acceptedPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const accepted = { ...candidate, status: "accepted" as const };
    await this.#writeCandidate(accepted);
    return accepted;
  }

  async get(candidateId: string) {
    if (!PROJECT_OPERATOR_ID.test(candidateId)) throw new Error("invalid project-local operator candidate id");
    const path = join(this.#candidateDirectory, candidateFilename(candidateId));
    if (!await pathExists(path)) throw new Error(`operator candidate ${candidateId} was not found`);
    return this.#read(path);
  }

  async shutdown() {
    await Promise.allSettled([...this.#proofs.values()].map((proof) => proof.manager.shutdown()));
  }

  async #finalize(proof: ActiveProof, status: RunStatus) {
    const base = {
      schema_version: 1 as const,
      candidate_id: proof.candidateId,
      operator_revision: (await this.get(proof.candidateId)).operator.revision,
      graph_revision: proof.graphRevision,
      run_id: proof.runId,
      closure_digest: status.closure_digest ?? null,
      result: status.phase === "completed" ? "passed" as const : "failed" as const,
      finished_at: new Date().toISOString(),
    };
    const receipt: OperatorProofReceipt = { ...base, receipt_digest: canonicalJsonDigest(base) };
    const candidate = await this.get(proof.candidateId);
    const updated: OperatorCandidate = receipt.result === "passed"
      ? { ...candidate, status: "proven", proof: receipt }
      : { ...candidate, status: "draft", proof: receipt };
    await this.#writeCandidate(updated);
    await proof.manager.shutdown();
    return receipt;
  }

  async #writeCandidate(candidate: OperatorCandidate) {
    await ensurePrivateDirectory(this.#root, ".somite/operator-workshop/candidates");
    await atomicWrite(join(this.#candidateDirectory, candidateFilename(candidate.candidate_id)), `${JSON.stringify(candidate, null, 2)}\n`);
  }

  async #read(path: string): Promise<OperatorCandidate> {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, MAX_CANDIDATE_BYTES, "operator candidate"))) as OperatorCandidate;
    if (value.schema_version !== 1 || !PROJECT_OPERATOR_ID.test(value.candidate_id) || value.operator.id !== value.candidate_id) throw new Error("stored operator candidate is invalid");
    const operator = normalizedCandidateOperator(persistedOperator(value.operator), new OperatorCatalog([...this.#catalog.values()].filter((item) => item.id !== value.operator.id)));
    if (operator.revision !== value.operator.revision) throw new Error("stored operator candidate revision is invalid");
    return { ...value, operator };
  }
}
