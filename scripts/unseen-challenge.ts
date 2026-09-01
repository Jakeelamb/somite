import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { atomicWrite, ensurePrivateDirectory } from "../runner/src/files.ts";
import { NfcoreGateway } from "../runner/src/nfcoreGateway.ts";
import { persistChallengeReport, readChallengeLedger } from "../runner/src/unseenChallengeLedger.ts";
import {
  NoUnseenChallengeError,
  runUnseenPaperChallenge,
  runUnseenWorkflowChallenge,
  type ChallengeKind,
  type ChallengeReport,
} from "../runner/src/unseenChallenge.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const argumentsList = process.argv.slice(2);
const supported = new Set(["--paper", "--workflow", "--all"]);
if (argumentsList.some((argument) => !supported.has(argument)) || argumentsList.length > 1) {
  throw new Error("usage: unseen-challenge.ts [--paper|--workflow|--all]");
}
const selection = argumentsList[0] ?? "--all";
const kinds: readonly ChallengeKind[] = selection === "--paper"
  ? ["paper"]
  : selection === "--workflow"
    ? ["workflow"]
    : ["paper", "workflow"];
const startedAt = new Date().toISOString();
const stateDirectory = await ensurePrivateDirectory(repositoryRoot, ".somite/challenges");
const reportDirectory = await ensurePrivateDirectory(repositoryRoot, "output/challenges");
const ledgerPath = join(stateDirectory, "ledger.json");
let ledger = await readChallengeLedger(ledgerPath);
const { catalog } = await loadOperatorCatalog(join(repositoryRoot, "operators"));
const gateway = new NfcoreGateway(repositoryRoot, catalog);
const reports: ChallengeReport[] = [];
const skipped: Array<{ kind: ChallengeKind; reason: string }> = [];
const failures: Array<{ kind: ChallengeKind; error: string }> = [];

for (const kind of kinds) {
  try {
    const report = kind === "paper"
      ? await runUnseenPaperChallenge({ catalog, ledger, retrieved_at: new Date().toISOString() })
      : await runUnseenWorkflowChallenge({ gateway, ledger, retrieved_at: new Date().toISOString() });
    reports.push(report);
    if (report.quality.result === "failed") {
      failures.push({ kind, error: report.quality.issues.join(" ") });
    } else {
      ledger = await persistChallengeReport(ledgerPath, report);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof NoUnseenChallengeError) skipped.push({ kind, reason: message });
    else failures.push({ kind, error: message });
  }
}

const completedAt = new Date().toISOString();
const run = {
  schema_version: 1,
  started_at: startedAt,
  completed_at: completedAt,
  reports,
  skipped,
  failures,
};
const reportName = `${startedAt.replace(/[:.]/g, "-")}.json`;
const reportPath = join(reportDirectory, reportName);
await atomicWrite(reportPath, `${JSON.stringify(run, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  report: reportPath,
  tested: reports.map((report) => ({ kind: report.kind, source: report.source_key, digest: report.content_digest })),
  skipped,
  failures,
}, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
