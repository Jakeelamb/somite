import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  NEXTFLOW_PLUGIN_STORE_LIMITS,
  NextflowPluginCacheError,
  freezeNextflowPluginStore,
  type NextflowPluginInstaller,
} from "../src/nextflowPluginCache.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "somite-plugin-cache-"));
  const runtime = join(root, "runtime");
  const cacheRoot = join(root, "cache");
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(cacheRoot, { mode: 0o700 });
  const manifestPath = join(runtime, "pixi.toml");
  await writeFile(manifestPath, "[workspace]\nname = 'plugin-runtime'\n", { mode: 0o600 });
  await writeFile(join(runtime, "pixi.lock"), "version: 6\n", { mode: 0o600 });
  return { root, cacheRoot, runtime: { pixi: "/opt/pixi", manifestPath } };
}

function successfulInstaller(calls: Array<Parameters<NextflowPluginInstaller>[0]>): NextflowPluginInstaller {
  return async (invocation) => {
    calls.push(invocation);
    const spec = invocation.args.at(-1)!;
    const store = invocation.env.NXF_PLUGINS_DIR;
    assert.ok(store);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const directory = join(store, spec);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "plugin.jar"), `frozen:${spec}\n`, { mode: 0o644 });
    return { code: 0, signal: null, stdout: "installed\n", stderr: "" };
  };
}

const requirements = [
  { id: "nf-schema", version: "2.7.2", spec: "nf-schema@2.7.2" },
  { id: "nf-core-utils", version: "1.2.3", spec: "nf-core-utils@1.2.3" },
] as const;

test("freezes exact plugins once, publishes deterministic content, and verifies cache hits", async (context) => {
  const setup = await fixture();
  context.after(() => rm(setup.root, { recursive: true, force: true }));
  const calls: Array<Parameters<NextflowPluginInstaller>[0]> = [];
  const installer = successfulInstaller(calls);
  const input = {
    requirements,
    runtime: setup.runtime,
    cacheRoot: setup.cacheRoot,
    platform: "linux-64",
    signal: new AbortController().signal,
  } as const;

  const [first, joined] = await Promise.all([
    freezeNextflowPluginStore(input, installer),
    freezeNextflowPluginStore(input, installer),
  ]);
  assert.equal(calls.length, 2, "concurrent identical freezes must share one installation");
  assert.equal(first.cached, false);
  assert.equal(joined.digest, first.digest);
  assert.match(first.digest, /^blake3:[a-f0-9]{64}$/);
  assert.equal(first.manifest.store_digest, first.digest);
  assert.deepEqual(first.manifest.requirements.map((entry) => entry.spec), [
    "nf-core-utils@1.2.3",
    "nf-schema@2.7.2",
  ]);
  assert.deepEqual(first.files.map((entry) => entry.path), [
    "nf-core-utils@1.2.3/plugin.jar",
    "nf-schema@2.7.2/plugin.jar",
  ]);
  for (const call of calls) {
    assert.deepEqual(call.args.slice(0, 6), [
      "run", "--frozen", "--manifest-path", setup.runtime.manifestPath, "--", "nextflow",
    ]);
    assert.deepEqual(call.args.slice(6, 9), ["plugin", "install", call.args.at(-1)]);
    assert.equal(call.command, setup.runtime.pixi);
    assert.equal(call.cwd, setup.runtime.manifestPath.slice(0, setup.runtime.manifestPath.lastIndexOf("/")));
    assert.ok(call.env.NXF_PLUGINS_DIR);
    assert.ok(call.env.NXF_HOME);
    assert.notEqual(call.env.NXF_HOME, call.env.NXF_PLUGINS_DIR);
    assert.equal(relative(setup.cacheRoot, call.env.NXF_PLUGINS_DIR!).startsWith(".."), false);
  }
  assert.equal(new TextDecoder().decode(first.files[0]!.bytes), "frozen:nf-core-utils@1.2.3\n");

  const cached = await freezeNextflowPluginStore(input, async () => {
    throw new Error("a verified cache hit must not execute Pixi");
  });
  assert.equal(cached.cached, true);
  assert.equal(cached.digest, first.digest);
  assert.deepEqual(cached.manifest, first.manifest);
  assert.deepEqual(cached.files.map((entry) => [...entry.bytes]), first.files.map((entry) => [...entry.bytes]));
});

test("plugin installation scrubs ambient Nextflow policy before applying its private store", async (context) => {
  const setup = await fixture();
  context.after(() => rm(setup.root, { recursive: true, force: true }));
  const names = ["NXF_CONFIG", "NXF_OFFLINE", "NXF_PLUGINS_ALLOWED", "NXF_PLUGINS_DEFAULT", "NXF_SYNTAX_PARSER"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    NXF_CONFIG: "/tmp/ambient-nextflow.config",
    NXF_OFFLINE: "true",
    NXF_PLUGINS_ALLOWED: "ambient",
    NXF_PLUGINS_DEFAULT: "true",
    NXF_SYNTAX_PARSER: "v1",
  });
  context.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  let received: Parameters<NextflowPluginInstaller>[0] | undefined;
  const installer = successfulInstaller([]);
  await freezeNextflowPluginStore({
    requirements: requirements.slice(0, 1),
    runtime: setup.runtime,
    cacheRoot: setup.cacheRoot,
    platform: "linux-64",
    signal: new AbortController().signal,
  }, async (invocation) => {
    received = invocation;
    return installer(invocation);
  });
  assert.ok(received);
  for (const name of names) assert.equal(received.env[name], undefined, `${name} leaked into plugin installation`);
  assert.ok(received.env.NXF_HOME);
  assert.ok(received.env.NXF_PLUGINS_DIR);
});

test("fails closed when a cached plugin file is corrupted", async (context) => {
  const setup = await fixture();
  context.after(() => rm(setup.root, { recursive: true, force: true }));
  let calls = 0;
  const installer: NextflowPluginInstaller = async (invocation) => {
    calls += 1;
    const store = invocation.env.NXF_PLUGINS_DIR!;
    await mkdir(join(store, "nf-schema@2.7.2"), { recursive: true });
    await writeFile(join(store, "nf-schema@2.7.2", "plugin.jar"), "original");
    return { code: 0, signal: null, stdout: "", stderr: "" };
  };
  const input = {
    requirements: requirements.slice(0, 1),
    runtime: setup.runtime,
    cacheRoot: setup.cacheRoot,
    platform: "linux-64",
    signal: new AbortController().signal,
  };
  const frozen = await freezeNextflowPluginStore(input, installer);
  await writeFile(join(frozen.cache_path, "store", frozen.files[0]!.path), "tampered");
  await assert.rejects(
    freezeNextflowPluginStore(input, installer),
    (error) => error instanceof NextflowPluginCacheError && error.code === "plugin_cache_corrupt",
  );
  assert.equal(calls, 1, "corruption must not be silently replaced with mutable network state");
});

test("rejects unsafe and oversized plugin-store output before publication", async (context) => {
  const setup = await fixture();
  context.after(() => rm(setup.root, { recursive: true, force: true }));
  const input = {
    requirements: requirements.slice(0, 1),
    runtime: setup.runtime,
    platform: "linux-64",
    signal: new AbortController().signal,
  };

  await assert.rejects(
    freezeNextflowPluginStore({ ...input, cacheRoot: join(setup.cacheRoot, "symlink") }, async (invocation) => {
      await symlink(setup.runtime.manifestPath, join(invocation.env.NXF_PLUGINS_DIR!, "plugin.jar"));
      return { code: 0, signal: null, stdout: "", stderr: "" };
    }),
    (error) => error instanceof NextflowPluginCacheError
      && error.code === "plugin_store_invalid" && /symbolic link/.test(error.message),
  );

  await assert.rejects(
    freezeNextflowPluginStore({ ...input, cacheRoot: join(setup.cacheRoot, "portable") }, async (invocation) => {
      await writeFile(join(invocation.env.NXF_PLUGINS_DIR!, "bad\\name"), "unsafe");
      return { code: 0, signal: null, stdout: "", stderr: "" };
    }),
    (error) => error instanceof NextflowPluginCacheError
      && error.code === "plugin_store_invalid" && /portable/.test(error.message),
  );

  await assert.rejects(
    freezeNextflowPluginStore({ ...input, cacheRoot: join(setup.cacheRoot, "oversized") }, async (invocation) => {
      const path = join(invocation.env.NXF_PLUGINS_DIR!, "huge.jar");
      await writeFile(path, "");
      await truncate(path, NEXTFLOW_PLUGIN_STORE_LIMITS.maximum_file_bytes + 1);
      return { code: 0, signal: null, stdout: "", stderr: "" };
    }),
    (error) => error instanceof NextflowPluginCacheError
      && error.code === "plugin_store_invalid" && /maximum file size/.test(error.message),
  );
});

test("validates exact requirements, reports installer failure, and honors cancellation", async (context) => {
  const setup = await fixture();
  context.after(() => rm(setup.root, { recursive: true, force: true }));
  let calls = 0;
  const base = {
    runtime: setup.runtime,
    cacheRoot: setup.cacheRoot,
    platform: "linux-64",
    signal: new AbortController().signal,
  };
  const never: NextflowPluginInstaller = async () => {
    calls += 1;
    throw new Error("must not run");
  };
  await assert.rejects(
    freezeNextflowPluginStore({ ...base, requirements: [{ id: "nf-schema", version: "2.7.2", spec: "nf-schema@latest" }] }, never),
    (error) => error instanceof NextflowPluginCacheError && error.code === "plugin_requirement_invalid",
  );
  await assert.rejects(
    freezeNextflowPluginStore({ ...base, requirements: [
      { id: "nf-schema", version: "2.7.2", spec: "nf-schema@2.7.2" },
      { id: "nf-schema", version: "2.8.0", spec: "nf-schema@2.8.0" },
    ] }, never),
    (error) => error instanceof NextflowPluginCacheError && error.code === "plugin_requirement_invalid",
  );
  assert.equal(calls, 0);

  await assert.rejects(
    freezeNextflowPluginStore({ ...base, cacheRoot: join(setup.cacheRoot, "failure"), requirements: requirements.slice(0, 1) }, async () => ({
      code: 17,
      signal: null,
      stdout: "",
      stderr: "plugin registry unavailable\n",
    })),
    (error) => error instanceof NextflowPluginCacheError
      && error.code === "plugin_install_failed"
      && /nf-schema@2\.7\.2/.test(error.message)
      && /plugin registry unavailable/.test(error.message),
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    freezeNextflowPluginStore({ ...base, cacheRoot: join(setup.cacheRoot, "cancelled"), requirements: requirements.slice(0, 1), signal: controller.signal }, never),
    (error) => error instanceof NextflowPluginCacheError && error.code === "plugin_freeze_cancelled",
  );
  assert.equal(calls, 0);

  assert.equal((await readFile(setup.runtime.manifestPath, "utf8")).startsWith("[workspace]"), true);
});
