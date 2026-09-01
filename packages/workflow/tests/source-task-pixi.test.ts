import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { byteDigest, canonicalJsonDigest } from "../contentIdentity.ts";
import type { FrozenSourceFile } from "../nextflowSource.ts";
import {
  PINNED_MICROMAMBA_VERSION,
  renderSourceTaskPixiWorkspace,
} from "../sourceTaskPixi.ts";
import {
  planSourceTaskExecution,
  type SourceTaskExecutionPlan,
} from "../sourceTaskExecution.ts";

const encoder = new TextEncoder();
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../testdata/source-workflow/source-task-execution");

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
platforms = ["linux-64"]

[dependencies]
"micromamba" = "==2.9.0"
"nextflow" = "==26.04.6"
"openjdk" = "==25.0.2"

[feature.task-976c241cd065489066c6cfcdc97a417feaf3963f2ff07a15951cf7e2e9f98dbd.dependencies]
"samtools" = { version = "1.19.2.*", channel = "bioconda" }

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
    /channel private is absent from the frozen workspace channel order/,
  );

  const divergentOrder = structuredClone(base) as SourceTaskExecutionPlan;
  Object.assign(divergentOrder.environments[0]!, { channels: ["bioconda", "conda-forge"] });
  assert.throws(
    () => renderSourceTaskPixiWorkspace(rehash(divergentOrder), ["linux-64"]),
    /channel order differs from the frozen workspace channel order/,
  );

  const ambiguousEquality = structuredClone(base) as SourceTaskExecutionPlan;
  Object.assign(ambiguousEquality.environments[0]!.dependencies[0]!, {
    constraint: "=1.18|=1.19",
    exact_version: undefined,
    match_spec: "bioconda::samtools=1.18|=1.19",
  });
  assert.throws(
    () => renderSourceTaskPixiWorkspace(rehash(ambiguousEquality), ["linux-64"]),
    /cannot be represented as one proven Pixi VersionSpec/,
  );
});
