import { join } from "node:path";

import { canonicalJsonValue } from "@somite/workflow/contentIdentity";
import {
  createEvidenceReceipt,
  emptyEvidenceIndex,
  insertEvidence,
  type EvidenceIndex,
  type EvidenceReceipt,
  type EvidenceResult,
} from "@somite/workflow/linker";
import { atomicWrite, ensurePrivateDirectory, immutableWrite, pathExists, regularFile } from "./files.ts";

const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const DIGEST = /^blake3:[0-9a-f]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function digest(value: unknown, label: string) {
  const parsed = text(value, label);
  if (!DIGEST.test(parsed)) throw new Error(`${label} must be a BLAKE3 digest`);
  return parsed;
}

function result(value: unknown, label: string): EvidenceResult {
  if (value !== "passed" && value !== "failed" && value !== "inconclusive") {
    throw new Error(`${label} is not an evidence result`);
  }
  return value;
}

function strings(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => digest(item, `${label}[${index}]`));
}

function results(value: unknown, label: string) {
  return Object.fromEntries(Object.entries(record(value, label)).map(([key, item]) => [key, result(item, `${label}.${key}`)]));
}

function decodeReceipt(value: unknown): EvidenceReceipt {
  const source = record(value, "evidence receipt");
  const recordedAt = source.recorded_at_unix_ms;
  if (!Number.isSafeInteger(recordedAt) || (recordedAt as number) < 0) {
    throw new Error("evidence receipt recorded_at_unix_ms must be a non-negative integer");
  }
  const observed = source.observed_closure_digest;
  if (observed !== undefined && observed !== null) digest(observed, "evidence receipt observed_closure_digest");
  const rebuilt = createEvidenceReceipt({
    recorded_at_unix_ms: recordedAt as number,
    subject_digest: digest(source.subject_digest, "evidence receipt subject_digest"),
    ...(observed !== undefined ? { observed_closure_digest: observed as string | null } : {}),
    kind: text(source.kind, "evidence receipt kind"),
    scope: text(source.scope, "evidence receipt scope"),
    configuration_digest: digest(source.configuration_digest, "evidence receipt configuration_digest"),
    fixture_digests: strings(source.fixture_digests, "evidence receipt fixture_digests"),
    verifier: text(source.verifier, "evidence receipt verifier"),
    result: result(source.result, "evidence receipt result"),
    node_results: results(source.node_results, "evidence receipt node_results"),
    edge_results: results(source.edge_results, "evidence receipt edge_results"),
    artifact_digests: strings(source.artifact_digests, "evidence receipt artifact_digests"),
    log_digests: strings(source.log_digests, "evidence receipt log_digests"),
  });
  if (digest(source.receipt_digest, "evidence receipt receipt_digest") !== rebuilt.receipt_digest) {
    throw new Error("evidence receipt does not match its content address");
  }
  return rebuilt;
}

function decodeIndex(value: unknown): EvidenceIndex {
  const source = record(value, "evidence index");
  if (source.schema_version !== 1 || !Array.isArray(source.receipts)) throw new Error("unsupported evidence index schema");
  const receipts = source.receipts.map(decodeReceipt);
  if (new Set(receipts.map((receipt) => receipt.receipt_digest)).size !== receipts.length) {
    throw new Error("evidence index contains duplicate receipts");
  }
  return { schema_version: 1, receipts };
}

function encoded(value: unknown) {
  return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}

export class EvidenceStore {
  readonly #projectRoot: string;
  readonly #root: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
    this.#root = join(projectRoot, ".somite", "evidence");
  }

  async index() {
    await ensurePrivateDirectory(this.#projectRoot, ".somite/evidence");
    const path = join(this.#root, "index.json");
    if (!await pathExists(path)) return emptyEvidenceIndex();
    try {
      return decodeIndex(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await regularFile(path, MAX_INDEX_BYTES, "evidence index"))));
    } catch (error) {
      throw new Error(`evidence index is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async forSubject(subjectDigest: string) {
    const index = await this.index();
    return index.receipts.filter((receipt) => receipt.subject_digest === subjectDigest);
  }

  async append(receipt: EvidenceReceipt, packageEvidenceDirectory: string) {
    const previous = this.#writes;
    let release!: () => void;
    this.#writes = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      await this.#append(receipt, packageEvidenceDirectory);
    } finally {
      release();
    }
  }

  async #append(receipt: EvidenceReceipt, packageEvidenceDirectory: string) {
    const validated = decodeReceipt(receipt);
    await ensurePrivateDirectory(this.#projectRoot, ".somite/evidence/receipts");
    const receiptPath = join(this.#root, "receipts", `${validated.receipt_digest.slice("blake3:".length)}.json`);
    const receiptBytes = encoded(validated);
    if (await pathExists(receiptPath)) {
      const existing = await regularFile(receiptPath, MAX_RECEIPT_BYTES, "evidence receipt");
      if (new TextDecoder().decode(existing) !== receiptBytes) throw new Error("stored evidence receipt does not match its content address");
    } else {
      await immutableWrite(receiptPath, receiptBytes).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        const existing = await regularFile(receiptPath, MAX_RECEIPT_BYTES, "evidence receipt");
        if (new TextDecoder().decode(existing) !== receiptBytes) throw new Error("stored evidence receipt does not match its content address");
      });
    }

    const next = insertEvidence(await this.index(), validated);
    await atomicWrite(join(this.#root, "index.json"), encoded(next));
    await atomicWrite(join(packageEvidenceDirectory, "index.json"), encoded(next));
  }
}
