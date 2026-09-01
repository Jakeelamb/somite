import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadOperatorCatalog } from "@somite/workflow/catalog.node";
import { atomicWrite } from "../runner/src/files.ts";
import { NfcoreGateway } from "../runner/src/nfcoreGateway.ts";
import {
  advanceChallengeLedger,
  parseUnseenChallengeArguments,
  prepareUnseenChallengeDirectories,
} from "../runner/src/unseenChallengeCli.ts";
import { readChallengeLedger } from "../runner/src/unseenChallengeLedger.ts";
import {
  NoUnseenChallengeError,
  runUnseenPaperChallenge,
  runUnseenWorkflowChallenge,
  type ChallengeKind,
  type ChallengeReport,
} from "../runner/src/unseenChallenge.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const options = parseUnseenChallengeArguments(process.argv.slice(2));
const kinds: readonly ChallengeKind[] = options.kinds;
const startedAt = new Date().toISOString();
const directories = await prepareUnseenChallengeDirectories(repositoryRoot, options);
const reportDirectory = directories.report_directory;
const ledgerPath = directories.ledger_path;
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
      ledger = await advanceChallengeLedger(ledger, report, {
        dry_run: options.dry_run,
        ledger_path: ledgerPath,
      });
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
  ...(options.dry_run ? { dry_run: true } : {}),
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
