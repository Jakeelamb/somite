import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  advanceChallengeLedger,
  parseUnseenChallengeArguments,
  prepareUnseenChallengeDirectories,
  resolveChallengeDirectory,
} from "../src/unseenChallengeCli.ts";
import {
  decodeChallengeLedger,
  type ChallengeReport,
} from "../src/unseenChallenge.ts";

const digest = (character: string) => `blake3:${character.repeat(64)}`;

function report(
  kind: "paper" | "workflow",
  sourceKey: string,
  character: string,
): ChallengeReport {
  const common = {
    schema_version: 1 as const,
    kind,
    source_key: sourceKey,
    content_digest: digest(character),
    retrieved_at: "2026-09-01T05:00:00.000Z",
    quality: { result: "passed" as const, issues: [] },
  };
  if (kind === "paper") {
    return {
      ...common,
      kind,
      source: {
        provider: "europe_pmc",
        id: "PMC1",
        title: "Fresh paper",
        url: "https://example.invalid/PMC1",
      },
      reconstruction: {
        status: "candidate_built",
        outcome: "drafts_ready",
        candidate_count: 1,
        assays: ["assembly"],
        operators: ["asm.hifiasm"],
        unsupported: [],
        mentions: [],
        workflow_sources: [],
        gaps: [],
        evidence_only_methods: [],
        omitted_methods: [],
        required_actions: 0,
        unresolved_method_inputs: [],
        warnings: [],
      },
    };
  }
  return {
    ...common,
    kind,
    source: {
      provider: "nf_core",
      repository: "https://github.com/nf-core/fresh",
      requested_revision: "1.0.0",
      resolved_revision: character.repeat(40),
      source_digest: digest(character),
      entrypoint: "main.nf",
      file_count: 1,
      source_bytes: 100,
    },
    status: "executable",
    index: { scopes: 2, invocations: 1 },
    semantic_projection: {
      result: "passed",
      indexed_invocations: 1,
      projected_entities: 1,
      projected_relations: 0,
    },
    timings_ms: {
      catalog_discovery: 1,
      source_import: 2,
      semantic_projection: 3,
      total: 6,
    },
    capabilities: {
      exact_execution: true,
      parameter_edits: true,
      hierarchy_indexed: true,
      structural_edits: false,
      channel_contracts: true,
      source_edits: false,
    },
    blockers: [],
    diagnostics: [],
  };
}

test("challenge CLI options preserve scheduled defaults and accept isolated paths", () => {
  assert.deepEqual(parseUnseenChallengeArguments([]), {
    selection: "all",
    kinds: ["paper", "workflow"],
    dry_run: false,
  });
  assert.deepEqual(parseUnseenChallengeArguments([
    "--report-dir", "/tmp/somite-reports",
    "--workflow",
    "--dry-run",
    "--state-dir", "output/private-state",
  ]), {
    selection: "workflow",
    kinds: ["workflow"],
    dry_run: true,
    state_directory: "output/private-state",
    report_directory: "/tmp/somite-reports",
  });
});

test("challenge CLI rejects ambiguous modes and incomplete directory options", () => {
  assert.throws(
    () => parseUnseenChallengeArguments(["--paper", "--all"]),
    /usage: unseen-challenge\.ts/,
  );
  assert.throws(
    () => parseUnseenChallengeArguments(["--state-dir", "--dry-run"]),
    /usage: unseen-challenge\.ts/,
  );
  assert.throws(
    () => parseUnseenChallengeArguments(["--dry-run", "--dry-run"]),
    /usage: unseen-challenge\.ts/,
  );
});

test("challenge directories are absolute or resolve inside the repository", () => {
  assert.equal(
    resolveChallengeDirectory("/workspace/somite", "output/fresh", "output/challenges"),
    "/workspace/somite/output/fresh",
  );
  assert.equal(
    resolveChallengeDirectory("/workspace/somite", "/tmp/fresh", "output/challenges"),
    "/tmp/fresh",
  );
  assert.equal(
    resolveChallengeDirectory("/workspace/somite", undefined, "output/challenges"),
    "/workspace/somite/output/challenges",
  );
  assert.throws(
    () => resolveChallengeDirectory("/workspace/somite", "../outside", "output/challenges"),
    /must stay inside the repository/,
  );
});

test("dry-run defaults to a private temporary report directory without creating repository state", async () => {
  const repository = await mkdtemp(join(tmpdir(), "somite-challenge-cli-repository-"));
  let reportDirectory: string | undefined;
  try {
    const directories = await prepareUnseenChallengeDirectories(
      repository,
      parseUnseenChallengeArguments(["--dry-run"]),
    );
    reportDirectory = directories.report_directory;

    assert.equal(directories.state_directory, join(repository, ".somite", "challenges"));
    assert.equal(directories.ledger_path, join(repository, ".somite", "challenges", "ledger.json"));
    assert.equal(reportDirectory.startsWith(join(tmpdir(), "somite-unseen-challenge-")), true);
    assert.equal((await stat(reportDirectory)).mode & 0o077, 0);
    assert.deepEqual(await readdir(repository), []);
  } finally {
    await rm(repository, { recursive: true, force: true });
    if (reportDirectory) await rm(reportDirectory, { recursive: true, force: true });
  }
});

test("dry-run advances novelty across both challenge kinds without creating a ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "somite-challenge-cli-dry-"));
  const ledgerPath = join(directory, "state-does-not-exist", "ledger.json");
  try {
    let ledger = decodeChallengeLedger();
    ledger = await advanceChallengeLedger(ledger, report("paper", "europe-pmc:PMC1", "a"), {
      dry_run: true,
      ledger_path: ledgerPath,
    });
    ledger = await advanceChallengeLedger(ledger, report("workflow", "nf-core:fresh@1", "b"), {
      dry_run: true,
      ledger_path: ledgerPath,
    });

    assert.deepEqual(ledger.entries.map((entry) => entry.kind), ["paper", "workflow"]);
    await assert.rejects(() => access(ledgerPath), /ENOENT/);
    await assert.rejects(() => access(join(directory, "state-does-not-exist")), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the default ledger transition remains durable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "somite-challenge-cli-persist-"));
  const ledgerPath = join(directory, "ledger.json");
  try {
    const updated = await advanceChallengeLedger(
      decodeChallengeLedger(),
      report("workflow", "nf-core:persistent@1", "c"),
      { dry_run: false, ledger_path: ledgerPath },
    );

    assert.equal(updated.entries[0]?.source_key, "nf-core:persistent@1");
    assert.equal(
      decodeChallengeLedger(await readFile(ledgerPath, "utf8")).entries[0]?.source_key,
      "nf-core:persistent@1",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
