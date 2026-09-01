import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { FrozenSourceFile } from "@somite/workflow/nextflowSource";
import { renderSourceTaskPixiWorkspace } from "@somite/workflow/sourceTaskPixi";
import { planSourceTaskExecution } from "@somite/workflow/sourceTaskExecution";
import { PixiCache } from "../src/pixiCache.ts";
import { stagePortableSourceTaskExecution } from "../src/sourceTaskRewrite.ts";
import { pixiPlatform } from "../src/system.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoot = join(repositoryRoot, "testdata", "source-workflow", "source-task-execution");

async function fixtureFiles(root = fixtureRoot, prefix = ""): Promise<FrozenSourceFile[]> {
  const files: FrozenSourceFile[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await fixtureFiles(join(root, entry.name), relative));
    else files.push({ path: relative, mode: 0o100644, bytes: await readFile(join(root, entry.name)) });
  }
  return files;
}

async function run(binary: string, args: readonly string[], options: Readonly<{
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}> = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    execFile(binary, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`${binary} ${args.join(" ")} failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      } else resolvePromise({ stdout, stderr });
    });
  });
}

async function findNamedFile(root: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findNamedFile(candidate, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name) return candidate;
  }
  return undefined;
}

test("one real frozen Pixi lock isolates conflicting Samtools tasks and Nextflow activates each existing prefix", { timeout: 20 * 60_000 }, async (context) => {
  assert.notEqual(process.platform, "win32", "source task environment execution requires a supported POSIX host");
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "somite-source-task-pixi-")));
  const cacheParent = await realpath(await mkdtemp(join(tmpdir(), "somite-source-task-pixi-cache-")));
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.SOMITE_PIXI_CACHE_DIR = join(cacheParent, "pixi");
  context.after(async () => {
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(cacheParent, { recursive: true, force: true });
  });

  const decision = planSourceTaskExecution(await fixtureFiles(), "main.nf");
  assert.equal(decision.status, "candidate");
  const platform = pixiPlatform();
  const rendered = renderSourceTaskPixiWorkspace(decision.plan, [platform]);
  const cache = new PixiCache(projectRoot);
  const locked = await cache.lock(rendered.pixi_toml, platform);
  const realized = await cache.realizeWorkspace(locked, platform, rendered.expected_environments);

  assert.deepEqual([...realized.prefixes.keys()], rendered.expected_environments);
  for (const [environment, prefix] of realized.prefixes) {
    assert.equal(await realpath(prefix), prefix, `${environment} must be a verified regular prefix, not a symbolic path`);
    assert.ok((await stat(prefix)).isDirectory());
  }
  const lockText = new TextDecoder().decode(locked.lock);
  for (const environment of rendered.expected_environments) assert.match(lockText, new RegExp(environment));

  const runtimePrefix = realized.prefixes.get(rendered.runtime_environment)!;
  assert.match((await run(join(runtimePrefix, "bin", "bash"), ["--version"])).stdout, /5\.2\.37/);
  assert.match((await run(join(runtimePrefix, "bin", "awk"), ["--version"])).stdout, /5\.4\.1/);
  assert.match((await run(join(runtimePrefix, "bin", "grep"), ["--version"])).stdout, /3\.12/);
  assert.match((await run(join(runtimePrefix, "bin", "ps"), ["--version"])).stdout, /ps from procps-ng/);
  assert.match(lockText, /procps-ng-4\.0\.6-/);
  assert.match((await run(join(runtimePrefix, "bin", "sed"), ["--version"])).stdout, /4\.10/);
  assert.match((await run(join(runtimePrefix, "bin", "nextflow"), ["-version"])).stdout, /26\.04\.6/);
  assert.match((await run(join(runtimePrefix, "bin", "java"), ["-version"])).stderr, /25\.0\.2/);
  assert.match((await run(join(runtimePrefix, "bin", "micromamba"), ["--version"])).stdout, /2\.9\.0/);

  const taskVersions = new Map<string, string>();
  for (const environment of decision.plan.environments) {
    const version = environment.dependencies.find((dependency) => dependency.name === "samtools")?.exact_version;
    assert.ok(version);
    const prefix = realized.prefixes.get(environment.name)!;
    const output = await run(join(prefix, "bin", "samtools"), ["--version"]);
    assert.match(output.stdout.split("\n", 1)[0]!, new RegExp(`^samtools ${version.replaceAll(".", "\\.")}$`));
    taskVersions.set(environment.name, version);
  }
  assert.deepEqual([...taskVersions.values()].sort(), ["1.18", "1.19.2"]);

  const activationRoot = join(projectRoot, "activation-proof");
  const resultsRoot = join(activationRoot, "results");
  const nxfHome = join(projectRoot, "nxf-home");
  const mambaRoot = join(projectRoot, "mamba-root");
  await mkdir(activationRoot);
  await Promise.all([mkdir(resultsRoot), mkdir(nxfHome), mkdir(mambaRoot)]);
  const processes: string[] = [];
  const invocations: string[] = [];
  for (const [index, environment] of decision.plan.environments.entries()) {
    const prefix = realized.prefixes.get(environment.name)!;
    assert.equal(prefix.includes("'"), false);
    const processName = `SAMTOOLS_${index}`;
    const outputName = `samtools_${index}.txt`;
    processes.push([
      `process ${processName} {`,
      `    conda '${prefix}'`,
      `    publishDir '${resultsRoot}', mode: 'copy', overwrite: true`,
      "    output:",
      `    path '${outputName}'`,
      "    script:",
      "    \"\"\"",
      `    samtools --version > ${outputName}`,
      "    \"\"\"",
      "}",
    ].join("\n"));
    invocations.push(`    ${processName}()`);
  }
  await Promise.all([
    writeFile(join(activationRoot, "main.nf"), [
      "nextflow.enable.dsl = 2",
      "",
      ...processes,
      "",
      "workflow {",
      ...invocations,
      "}",
      "",
    ].join("\n")),
    writeFile(join(activationRoot, "nextflow.config"), [
      "conda.enabled = true",
      "conda.useMicromamba = true",
      "process.errorStrategy = 'terminate'",
      "",
    ].join("\n")),
  ]);
  await run(join(runtimePrefix, "bin", "nextflow"), ["run", "main.nf", "-ansi-log", "false"], {
    cwd: activationRoot,
    env: {
      ...process.env,
      PATH: `${join(runtimePrefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      MAMBA_ROOT_PREFIX: mambaRoot,
      NXF_DISABLE_CHECK_LATEST: "true",
      NXF_HOME: nxfHome,
      NXF_OFFLINE: "true",
    },
    timeout: 5 * 60_000,
  });
  for (const [index, environment] of decision.plan.environments.entries()) {
    const firstLine = (await readFile(join(resultsRoot, `samtools_${index}.txt`), "utf8")).split("\n", 1)[0];
    assert.equal(firstLine, `samtools ${taskVersions.get(environment.name)}`);
  }

  const portableRoot = join(projectRoot, "portable-export");
  const portable = stagePortableSourceTaskExecution(await fixtureFiles(), decision.plan);
  await mkdir(portableRoot);
  for (const file of portable.files) {
    const destination = join(portableRoot, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes);
  }
  await Promise.all([
    writeFile(join(portableRoot, "pixi.toml"), rendered.pixi_toml),
    writeFile(join(portableRoot, "pixi.lock"), locked.lock),
    writeFile(join(portableRoot, "somite-task.config"), "conda.enabled = true\nconda.useMicromamba = true\n"),
  ]);
  await run(locked.pixi, ["install", "--all", "--frozen", "--manifest-path", join(portableRoot, "pixi.toml")], {
    cwd: portableRoot,
    timeout: 5 * 60_000,
  });
  await run(locked.pixi, [
    "run",
    "--frozen",
    "--manifest-path",
    join(portableRoot, "pixi.toml"),
    "--",
    "env",
    "-u",
    "CONDA_PREFIX",
    "nextflow",
    "-c",
    "somite-task.config",
    "run",
    "main.nf",
    "-with-conda",
    "-ansi-log",
    "false",
  ], {
    cwd: portableRoot,
    env: { ...process.env, NXF_DISABLE_CHECK_LATEST: "true" },
    timeout: 5 * 60_000,
  });
  for (const [fileName, version] of [["old.txt", "1.18"], ["new.txt", "1.19.2"]] as const) {
    const result = await findNamedFile(join(portableRoot, "work"), fileName);
    assert.ok(result, `${fileName} must be produced through the portable task environment`);
    assert.equal((await readFile(result, "utf8")).split("\n", 1)[0], `samtools ${version}`);
  }
});
