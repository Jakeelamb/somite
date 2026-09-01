import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { atomicWrite, pathExists, regularFile } from "./files.ts";
import {
  decodeChallengeLedger,
  recordChallenge,
  type ChallengeLedger,
  type ChallengeReport,
} from "./unseenChallenge.ts";

export const MAX_CHALLENGE_LEDGER_BYTES = 16 * 1024 * 1024;
export const MAX_CHALLENGE_LEDGER_ENTRIES = 50_000;
const MAX_LEDGER_LEASE_BYTES = 4 * 1024;
const LEDGER_LEASE_WAIT_MS = 30_000;
const FLOCK_PATH = "/usr/bin/flock";

async function flock(handle: FileHandle, ledgerPath: string) {
  const child = spawn(FLOCK_PATH, [
    "--exclusive",
    "--conflict-exit-code", "75",
    "--wait", String(LEDGER_LEASE_WAIT_MS / 1_000),
    "3",
  ], { stdio: ["ignore", "ignore", "pipe", handle.fd] });
  let stderr = "";
  const errorStream = child.stderr;
  if (!errorStream) {
    child.kill();
    throw new Error("challenge ledger lease did not provide a diagnostic stream");
  }
  errorStream.setEncoding("utf8");
  errorStream.on("data", (chunk: string) => {
    if (stderr.length < MAX_LEDGER_LEASE_BYTES) stderr += chunk.slice(0, MAX_LEDGER_LEASE_BYTES - stderr.length);
  });
  const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", resolvePromise);
  });
  if (code === 0) return;
  if (code === 75) throw new Error(`timed out waiting for challenge ledger transaction ${ledgerPath}`);
  throw new Error(`challenge ledger lease failed with status ${code ?? "signal"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
}

async function acquireLedgerLease(ledgerPath: string) {
  if (process.platform !== "linux") throw new Error("challenge ledger transactions currently require Linux flock");
  const parent = dirname(ledgerPath);
  const handle = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error(`parent of challenge ledger ${ledgerPath} must be a regular directory`);
    await flock(handle, ledgerPath);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function encodeLedger(ledger: ChallengeLedger) {
  if (ledger.entries.length > MAX_CHALLENGE_LEDGER_ENTRIES) {
    throw new Error(`challenge ledger exceeds ${MAX_CHALLENGE_LEDGER_ENTRIES} entries`);
  }
  const encoded = `${JSON.stringify(ledger, null, 2)}\n`;
  if (new TextEncoder().encode(encoded).byteLength > MAX_CHALLENGE_LEDGER_BYTES) {
    throw new Error(`challenge ledger exceeds ${MAX_CHALLENGE_LEDGER_BYTES} bytes`);
  }
  return encoded;
}

export async function readChallengeLedger(ledgerPath: string): Promise<ChallengeLedger> {
  if (!await pathExists(ledgerPath)) return decodeChallengeLedger();
  const bytes = await regularFile(ledgerPath, MAX_CHALLENGE_LEDGER_BYTES, "challenge ledger");
  const ledger = decodeChallengeLedger(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (ledger.entries.length > MAX_CHALLENGE_LEDGER_ENTRIES) {
    throw new Error(`challenge ledger exceeds ${MAX_CHALLENGE_LEDGER_ENTRIES} entries`);
  }
  return ledger;
}

/** Merge one successful challenge report into the latest ledger under a private cross-process lease. */
export async function persistChallengeReport(ledgerPath: string, report: ChallengeReport): Promise<ChallengeLedger> {
  if (!await pathExists(dirname(ledgerPath))) throw new Error(`parent of challenge ledger ${ledgerPath} is missing`);
  const lease = await acquireLedgerLease(ledgerPath);
  try {
    const current = await readChallengeLedger(ledgerPath);
    const updated = decodeChallengeLedger(recordChallenge(current, report));
    await atomicWrite(ledgerPath, encodeLedger(updated));
    return updated;
  } finally {
    await lease.close();
  }
}
