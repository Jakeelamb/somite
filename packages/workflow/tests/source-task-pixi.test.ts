import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { byteDigest, canonicalJsonDigest } from "../contentIdentity.ts";
import type { FrozenSourceFile } from "../nextflowSource.ts";
import {
  CONDA_DEFAULTS_UNIX_CHANNELS,
  PINNED_BASH_VERSION,
  PINNED_COREUTILS_VERSION,
  PINNED_GAWK_VERSION,
  PINNED_GREP_VERSION,
  PINNED_MICROMAMBA_VERSION,
  PINNED_PROCPS_VERSION,
  PINNED_SED_VERSION,
  renderSourceTaskPixiWorkspace,
} from "../sourceTaskPixi.ts";
import {
  planSourceTaskExecution,
  type SourceTaskExecutionPlan,
} from "../sourceTaskExecution.ts";

const encoder = new TextEncoder();
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../testdata/source-workflow/source-task-execution");

function sourceFile(filePath: string, text: string): FrozenSourceFile {
  return { path: filePath, mode: 0o100644, bytes: encoder.encode(text) };
}

async function fixtureFiles(root = fixtureRoot, prefix = ""): Promise<FrozenSourceFile[]> {
  const files: FrozenSourceFile[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await fixtureFiles(path.join(root, entry.name), relative));
    else files.push({ path: relative, mode: 0o100644, bytes: await readFile(path.join(root, entry.name)) });
  }
  return files;
}

async function candidatePlan() {
  const decision = planSourceTaskExecution(await fixtureFiles(), "main.nf");
  assert.equal(decision.status, "candidate");
  return decision.plan;
}

function rehash(plan: SourceTaskExecutionPlan): SourceTaskExecutionPlan {
  const { plan_digest: _digest, ...base } = plan;
  return { ...base, plan_digest: canonicalJsonDigest(base) };
}

test("renders one deterministic isolated Pixi feature and environment per reachable task environment", async () => {
  const plan = await candidatePlan();
  const rendered = renderSourceTaskPixiWorkspace(plan, ["linux-64"]);

  assert.equal(PINNED_MICROMAMBA_VERSION, "2.9.0");
  assert.equal(PINNED_BASH_VERSION, "5.2.37");
  assert.equal(PINNED_COREUTILS_VERSION, "9.11");
  assert.equal(PINNED_GAWK_VERSION, "5.4.1");
  assert.equal(PINNED_GREP_VERSION, "3.12");
  assert.equal(PINNED_PROCPS_VERSION, "4.0.6");
  assert.equal(PINNED_SED_VERSION, "4.10");
  assert.deepEqual(rendered, renderSourceTaskPixiWorkspace(plan, ["linux-64"]));
  assert.equal(rendered.source_plan_digest, plan.plan_digest);
  assert.equal(rendered.manifest_digest, byteDigest(encoder.encode(rendered.pixi_toml)));
  assert.deepEqual(rendered.expected_environments, [
    "default",
    "task-976c241cd065489066c6cfcdc97a417feaf3963f2ff07a15951cf7e2e9f98dbd",
    "task-9b6dc87d63e80ba499432da60c740fddce04fa1dc7bd096cddf86d3b166ed397",
  ]);
  assert.equal(rendered.pixi_toml, `[workspace]
name = "somite-source-tasks"
channels = ["conda-forge", "bioconda"]
channel-priority = "strict"
platforms = ["linux-64"]

[dependencies]
"bash" = "==5.2.37"
"coreutils" = "==9.11"
"gawk" = "==5.4.1"
"grep" = "==3.12"
"micromamba" = "==2.9.0"
"nextflow" = "==26.04.6"
"openjdk" = "==25.0.2"
"sed" = "==4.10"

[target.linux-64.dependencies]
"procps-ng" = "==4.0.6"

[feature.task-976c241cd065489066c6cfcdc97a417feaf3963f2ff07a15951cf7e2e9f98dbd]
channels = ["conda-forge", "bioconda"]
channel-priority = "strict"

[feature.task-976c241cd065489066c6cfcdc97a417feaf3963f2ff07a15951cf7e2e9f98dbd.dependencies]
"samtools" = { version = "1.19.2.*", channel = "bioconda" }

[feature.task-9b6dc87d63e80ba499432da60c740fddce04fa1dc7bd096cddf86d3b166ed397]
channels = ["conda-forge", "bioconda"]
channel-priority = "strict"

[feature.task-9b6dc87d63e80ba499432da60c740fddce04fa1dc7bd096cddf86d3b166ed397.dependencies]
"samtools" = { version = "1.18.*", channel = "bioconda" }

[environments]
task-976c241cd065489066c6cfcdc97a417feaf3963f2ff07a15951cf7e2e9f98dbd = { features = ["task-976c241cd065489066c6cfcdc97a417feaf3963f2ff07a15951cf7e2e9f98dbd"], no-default-feature = true }
task-9b6dc87d63e80ba499432da60c740fddce04fa1dc7bd096cddf86d3b166ed397 = { features = ["task-9b6dc87d63e80ba499432da60c740fddce04fa1dc7bd096cddf86d3b166ed397"], no-default-feature = true }
`);
});

test("preserves build and channel MatchSpec fields and rejects unrepresentable source dependencies", async () => {
  const base = await candidatePlan();
  assert.throws(
    () => renderSourceTaskPixiWorkspace(base, ["linux-riscv64"]),
    /unsupported source task Pixi platform/,
  );
  const withBuild = structuredClone(base) as SourceTaskExecutionPlan;
  const dependency = withBuild.environments[0]!.dependencies[0]!;
  Object.assign(dependency, {
    match_spec: "bioconda::samtools=1.19.2=h50ea8bc_1",
    constraint: "=1.19.2=h50ea8bc_1",
    exact_build: "h50ea8bc_1",
  });
  const rendered = renderSourceTaskPixiWorkspace(rehash(withBuild), ["linux-64"]);
  assert.match(rendered.pixi_toml, /"samtools" = \{ version = "1\.19\.2\.\*", channel = "bioconda", build = "h50ea8bc_1" \}/);

  const exactBuild = structuredClone(base) as SourceTaskExecutionPlan;
  Object.assign(exactBuild.environments[0]!.dependencies[0]!, {
    match_spec: "bioconda::samtools==1.19.2=h50ea8bc_1",
    constraint: "==1.19.2=h50ea8bc_1",
    exact_build: "h50ea8bc_1",
  });
  assert.match(
    renderSourceTaskPixiWorkspace(rehash(exactBuild), ["linux-64"]).pixi_toml,
    /"samtools" = \{ version = "==1\.19\.2", channel = "bioconda", build = "h50ea8bc_1" \}/,
  );

  const absentChannel = structuredClone(base) as SourceTaskExecutionPlan;
  Object.assign(absentChannel.environments[0]!.dependencies[0]!, {
    channel: "private",
    match_spec: "private::samtools=1.19.2",
  });
  assert.throws(
    () => renderSourceTaskPixiWorkspace(rehash(absentChannel), ["linux-64"]),
    /channel private is absent from its task environment channel order/,
  );

  const divergentOrder = structuredClone(base) as SourceTaskExecutionPlan;
  Object.assign(divergentOrder.environments[0]!, { channels: ["bioconda", "conda-forge"] });
  const divergent = renderSourceTaskPixiWorkspace(rehash(divergentOrder), ["linux-64"]);
  assert.match(divergent.pixi_toml, new RegExp(
    `\\[feature\\.${divergentOrder.environments[0]!.name}\\]\\nchannels = \\["bioconda", "conda-forge"\\]\\nchannel-priority = "strict"`,
  ));
  assert.match(divergent.pixi_toml, new RegExp(
    `\\[feature\\.${divergentOrder.environments[1]!.name}\\]\\nchannels = \\["conda-forge", "bioconda"\\]\\nchannel-priority = "strict"`,
  ));

  const ambiguousEquality = structuredClone(base) as SourceTaskExecutionPlan;
  const ambiguousDependency = ambiguousEquality.environments[0]!.dependencies[0]!;
  delete (ambiguousDependency as { exact_version?: string }).exact_version;
  Object.assign(ambiguousDependency, {
    constraint: "=1.18|=1.19",
    match_spec: "bioconda::samtools=1.18|=1.19",
  });
  assert.throws(
    () => renderSourceTaskPixiWorkspace(rehash(ambiguousEquality), ["linux-64"]),
    /cannot be represented as one proven Pixi VersionSpec/,
  );
});

test("keeps task solve input equal to the source environment without support-package injection", () => {
  const files = [
    sourceFile("main.nf", [
      "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }",
      "workflow { TOOL() }",
      "",
    ].join("\n")),
    sourceFile("environment.yml", [
      "channels: [bioconda, conda-forge]",
      "dependencies:",
      "  - coreutils=8.30",
      "  - samtools=1.19.2",
      "",
    ].join("\n")),
  ];
  const decision = planSourceTaskExecution(files, "main.nf");
  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));

  const rendered = renderSourceTaskPixiWorkspace(decision.plan, ["linux-64"]);

  assert.match(rendered.pixi_toml, /channels = \["bioconda", "conda-forge"\]/);
  assert.match(rendered.pixi_toml, /"coreutils" = \{ version = "8\.30\.\*" \}/);
  assert.doesNotMatch(rendered.pixi_toml, /"bash" = \{/);
  assert.doesNotMatch(rendered.pixi_toml, /\[feature\.[^.]+\.target\./);
  assert.deepEqual(decision.plan.environments[0]?.channels, ["bioconda", "conda-forge"]);
  assert.equal(decision.plan.environments[0]?.dependencies[0]?.name, "coreutils");
});

test("expands the source-proven Conda defaults multichannel only in Unix Pixi solve input", () => {
  const files = [
    sourceFile("main.nf", [
      "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }",
      "workflow { TOOL() }",
      "",
    ].join("\n")),
    sourceFile("environment.yml", [
      "channels:",
      "  - bioconda",
      "  - defaults",
      "  - conda-forge",
      "dependencies:",
      "  - samtools=1.19.2",
      "",
    ].join("\n")),
  ];
  const decision = planSourceTaskExecution(files, "main.nf");
  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));
  const sourcePlanDigest = decision.plan.plan_digest;
  assert.deepEqual(decision.plan.environments[0]?.channels, ["bioconda", "defaults", "conda-forge"]);

  const rendered = renderSourceTaskPixiWorkspace(decision.plan, ["linux-64"]);

  assert.deepEqual(CONDA_DEFAULTS_UNIX_CHANNELS, [
    "https://repo.anaconda.com/pkgs/main",
    "https://repo.anaconda.com/pkgs/r",
  ]);
  assert.match(rendered.pixi_toml, /channels = \["bioconda", "https:\/\/repo\.anaconda\.com\/pkgs\/main", "https:\/\/repo\.anaconda\.com\/pkgs\/r", "conda-forge"\]/);
  assert.doesNotMatch(rendered.pixi_toml, /conda\.anaconda\.org\/defaults/);
  assert.deepEqual(decision.plan.environments[0]?.channels, ["bioconda", "defaults", "conda-forge"]);
  assert.equal(decision.plan.plan_digest, sourcePlanDigest, "rendering must not rewrite frozen source provenance");
  assert.equal(rendered.source_plan_digest, sourcePlanDigest);
});

test("blocks ambiguous defaults expansion and explicit defaults MatchSpecs", () => {
  const workflow = sourceFile("main.nf", [
    "process TOOL { conda \"${moduleDir}/environment.yml\"; script: \"\"\"true\"\"\" }",
    "workflow { TOOL() }",
    "",
  ].join("\n"));
  const collision = planSourceTaskExecution([
    workflow,
    sourceFile("environment.yml", [
      "channels:",
      "  - defaults",
      "  - https://repo.anaconda.com/pkgs/main",
      "dependencies:",
      "  - python=3.11.9",
      "",
    ].join("\n")),
  ], "main.nf");
  assert.equal(collision.status, "candidate", JSON.stringify(collision, null, 2));
  assert.throws(
    () => renderSourceTaskPixiWorkspace(collision.plan, ["linux-64"]),
    /ambiguous after expanding Conda defaults: duplicate https:\/\/repo\.anaconda\.com\/pkgs\/main/,
  );

  const explicit = planSourceTaskExecution([
    workflow,
    sourceFile("environment.yml", [
      "channels: [defaults]",
      "dependencies: [defaults::python=3.11.9]",
      "",
    ].join("\n")),
  ], "main.nf");
  assert.equal(explicit.status, "candidate", JSON.stringify(explicit, null, 2));
  assert.equal(explicit.plan.environments[0]?.dependencies[0]?.channel, "defaults");
  assert.throws(
    () => renderSourceTaskPixiWorkspace(explicit.plan, ["linux-64"]),
    /explicit defaults:: MatchSpec, which cannot be represented as one Pixi channel/,
  );
});

test("accepts source-provenanced config closure and exact Nextflow plugins", async () => {
  const files = [
    ...await fixtureFiles(),
    {
      path: "nextflow.config",
      mode: 0o100644 as const,
      bytes: encoder.encode("plugins { id 'nf-schema@2.7.2' }\n"),
    },
  ];
  const decision = planSourceTaskExecution(files, "main.nf");
  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));

  const rendered = renderSourceTaskPixiWorkspace(decision.plan, ["linux-64"]);
  assert.deepEqual(decision.plan.config_closure.paths, ["nextflow.config"]);
  assert.deepEqual(decision.plan.nextflow_plugins, [{
    name: "nf-schema",
    version: "2.7.2",
    requirement: "nf-schema@2.7.2",
    spans: [{ path: "nextflow.config", start_line: 1, end_line: 1 }],
  }]);
  assert.equal(rendered.source_plan_digest, decision.plan.plan_digest);
});

test("accepts canonical Conda-profile provenance and rejects forged channel evidence", async () => {
  const files = [
    ...await fixtureFiles(),
    {
      path: "nextflow.config",
      mode: 0o100644 as const,
      bytes: encoder.encode("profiles {\n  conda {\n    conda.channels = ['conda-forge', 'bioconda']\n  }\n}\n"),
    },
  ];
  const decision = planSourceTaskExecution(files, "main.nf");
  assert.equal(decision.status, "candidate", JSON.stringify(decision, null, 2));
  assert.equal(decision.plan.config_closure.conda_channel_order?.origin, "profile");
  assert.equal(decision.plan.config_closure.conda_profile?.name, "conda");
  assert.doesNotThrow(() => renderSourceTaskPixiWorkspace(decision.plan, ["linux-64"]));

  const missingProfile = structuredClone(decision.plan) as SourceTaskExecutionPlan;
  delete (missingProfile.config_closure as { conda_profile?: unknown }).conda_profile;
  assert.throws(
    () => renderSourceTaskPixiWorkspace(rehash(missingProfile), ["linux-64"]),
    /refers to a missing Conda profile/,
  );

  const invalidProvenance = structuredClone(decision.plan) as SourceTaskExecutionPlan;
  Object.assign(invalidProvenance.config_closure.conda_channel_order!.expression_provenance, {
    digest: "blake3:forged",
  });
  assert.throws(
    () => renderSourceTaskPixiWorkspace(rehash(invalidProvenance), ["linux-64"]),
    /expression provenance is invalid/,
  );
});

test("rejects stale or malformed config and plugin plan metadata before rendering", async () => {
  const plan = await candidatePlan();
  assert.throws(
    () => renderSourceTaskPixiWorkspace({
      ...plan,
      config_closure: { paths: ["nextflow.config"], includes: [] },
    }, ["linux-64"]),
    /does not match its content digest/,
  );

  const unsafePath = rehash({
    ...plan,
    config_closure: { paths: ["../nextflow.config"], includes: [] },
  });
  assert.throws(
    () => renderSourceTaskPixiWorkspace(unsafePath, ["linux-64"]),
    /unsafe config path/,
  );

  const unresolved = structuredClone(plan) as unknown as Record<string, unknown>;
  unresolved.config_closure = {
    paths: ["conf/runtime.config", "nextflow.config"],
    includes: [{
      expression: "params.runtime_config",
      span: { path: "nextflow.config", start_line: 1, end_line: 1 },
      status: "unresolved",
      resolved_path: "conf/runtime.config",
      parameters: [],
      environment: [],
    }],
  };
  assert.throws(
    () => renderSourceTaskPixiWorkspace(rehash(unresolved as unknown as SourceTaskExecutionPlan), ["linux-64"]),
    /not execution-closed/,
  );

  const nonFinite = structuredClone(plan) as unknown as Record<string, unknown>;
  nonFinite.config_closure = {
    paths: ["nextflow.config"],
    includes: [{
      expression: "params.runtime_config ? '/dev/null' : '/dev/null'",
      span: { path: "nextflow.config", start_line: 1, end_line: 1 },
      status: "ignored",
      resolved_path: "/dev/null",
      parameters: [{ name: "runtime_config", value: Number.NaN }],
      environment: [],
    }],
  };
  assert.throws(
    () => renderSourceTaskPixiWorkspace(rehash(nonFinite as unknown as SourceTaskExecutionPlan), ["linux-64"]),
    /is not one bounded scalar/,
  );

  const ambientEnvironment = structuredClone(plan) as unknown as Record<string, unknown>;
  ambientEnvironment.config_closure = {
    paths: ["nextflow.config"],
    includes: [{
      expression: "System.getenv('HOME') ? '/dev/null' : '/dev/null'",
      span: { path: "nextflow.config", start_line: 1, end_line: 1 },
      status: "ignored",
      resolved_path: "/dev/null",
      parameters: [],
      environment: [{ name: "HOME", value: "/tmp/forged" }],
    }],
  };
  assert.throws(
    () => renderSourceTaskPixiWorkspace(rehash(ambientEnvironment as unknown as SourceTaskExecutionPlan), ["linux-64"]),
    /unproven environment binding/,
  );

  const inexactPlugin = rehash({
    ...plan,
    config_closure: { paths: ["nextflow.config"], includes: [] },
    nextflow_plugins: [{
      name: "nf-schema",
      version: ">=2.7.0",
      requirement: "nf-schema@>=2.7.0",
      spans: [{ path: "nextflow.config", start_line: 1, end_line: 1 }],
    }],
  } as unknown as SourceTaskExecutionPlan);
  assert.throws(
    () => renderSourceTaskPixiWorkspace(inexactPlugin, ["linux-64"]),
    /not one exact requirement/,
  );
});
