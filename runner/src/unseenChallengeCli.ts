import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  recordChallenge,
  type ChallengeKind,
  type ChallengeLedger,
  type ChallengeReport,
} from "./unseenChallenge.ts";
import { persistChallengeReport } from "./unseenChallengeLedger.ts";
import { ensurePrivateDirectory } from "./files.ts";

export type UnseenChallengeSelection = ChallengeKind | "all";

export type UnseenChallengeArguments = Readonly<{
  selection: UnseenChallengeSelection;
  kinds: readonly ChallengeKind[];
  dry_run: boolean;
  state_directory?: string;
  report_directory?: string;
}>;

const USAGE = "usage: unseen-challenge.ts [--paper|--workflow|--all] [--state-dir PATH] [--report-dir PATH] [--dry-run]";

function usage(): never {
  throw new Error(USAGE);
}

function directoryValue(value: string | undefined) {
  if (!value || value.startsWith("--") || /[\0\r\n]/.test(value)) usage();
  return value;
}

export function parseUnseenChallengeArguments(argumentsList: readonly string[]): UnseenChallengeArguments {
  let selection: UnseenChallengeSelection | undefined;
  let dryRun = false;
  let stateDirectory: string | undefined;
  let reportDirectory: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (argument === "--paper" || argument === "--workflow" || argument === "--all") {
      if (selection !== undefined) usage();
      selection = argument.slice(2) as UnseenChallengeSelection;
      continue;
    }
    if (argument === "--dry-run") {
      if (dryRun) usage();
      dryRun = true;
      continue;
    }
    if (argument === "--state-dir") {
      if (stateDirectory !== undefined) usage();
      stateDirectory = directoryValue(argumentsList[++index]);
      continue;
    }
    if (argument === "--report-dir") {
      if (reportDirectory !== undefined) usage();
      reportDirectory = directoryValue(argumentsList[++index]);
      continue;
    }
    usage();
  }
  const selected = selection ?? "all";
  const kinds: readonly ChallengeKind[] = selected === "all"
    ? ["paper", "workflow"]
    : [selected];
  return {
    selection: selected,
    kinds,
    dry_run: dryRun,
    ...(stateDirectory === undefined ? {} : { state_directory: stateDirectory }),
    ...(reportDirectory === undefined ? {} : { report_directory: reportDirectory }),
  };
}

export function resolveChallengeDirectory(
  repositoryRoot: string,
  configured: string | undefined,
  fallback: string,
) {
  if (!isAbsolute(repositoryRoot) || /[\0\r\n]/.test(repositoryRoot)) {
    throw new Error("challenge repository root must be one absolute path");
  }
  const selected = configured ?? fallback;
  if (!selected || /[\0\r\n]/.test(selected)) throw new Error("challenge directory must be one exact path");
  if (isAbsolute(selected)) return resolve(selected);
  const root = resolve(repositoryRoot);
  const destination = resolve(root, selected);
  const fromRoot = relative(root, destination);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("relative challenge directory must stay inside the repository");
  }
  return destination;
}

async function ensureChallengeDirectory(path: string) {
  const root = parse(path).root;
  const fromRoot = relative(root, path).split(sep).join("/");
  if (!root || !fromRoot) throw new Error("challenge directory cannot be a filesystem root");
  return ensurePrivateDirectory(root, fromRoot);
}

export async function prepareUnseenChallengeDirectories(
  repositoryRoot: string,
  options: UnseenChallengeArguments,
) {
  const stateDirectory = resolveChallengeDirectory(
    repositoryRoot,
    options.state_directory,
    ".somite/challenges",
  );
  if (!options.dry_run) await ensureChallengeDirectory(stateDirectory);
  const reportDirectory = options.report_directory === undefined && options.dry_run
    ? await mkdtemp(join(tmpdir(), "somite-unseen-challenge-"))
    : await ensureChallengeDirectory(resolveChallengeDirectory(
      repositoryRoot,
      options.report_directory,
      "output/challenges",
    ));
  if (options.report_directory === undefined && options.dry_run) await chmod(reportDirectory, 0o700);
  return {
    state_directory: stateDirectory,
    ledger_path: join(stateDirectory, "ledger.json"),
    report_directory: reportDirectory,
  } as const;
}

export async function advanceChallengeLedger(
  ledger: ChallengeLedger,
  report: ChallengeReport,
  options: Readonly<{ dry_run: boolean; ledger_path: string }>,
) {
  return options.dry_run
    ? recordChallenge(ledger, report)
    : persistChallengeReport(options.ledger_path, report);
}
