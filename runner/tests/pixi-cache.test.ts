import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { PixiCache, pixiEnvironmentCacheRoot } from "../src/pixiCache.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "somite-pixi-cache-"));
  const bin = join(root, "bin");
  const projects = join(root, "projects");
  const cache = join(root, "cache");
  await mkdir(bin);
  await mkdir(projects);
  const pixi = join(bin, "pixi");
  const log = join(bin, "invocations.jsonl");
  const installGate = join(root, "install.gate");
  await writeFile(pixi, `#!/usr/bin/env node
import { access, appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const manifest = args[args.indexOf("--manifest-path") + 1];
const manifestText = await readFile(manifest, "utf8");
const environmentTable = manifestText.match(/\\[environments\\]([\\s\\S]*?)(?:\\n\\[|$)/)?.[1] ?? "";
const declared = [...environmentTable.matchAll(/^([a-z0-9][a-z0-9_-]*)\\s*=/gmi)].map((match) => match[1]);
const environments = args.includes("--all") && declared.length ? declared : ["default"];
const prefixes = environments.map((environment) => join(dirname(manifest), ".pixi", "envs", environment));
await appendFile(${JSON.stringify(log)}, JSON.stringify({ command: args[0], args, manifest, prefixes }) + "\\n");
if (args[0] === "lock") {
  await writeFile(join(dirname(manifest), "pixi.lock"), "version: 6\\n");
  process.exit(0);
}
if (args[0] === "install") {
  if (prefixes.some((prefix) => Buffer.byteLength(prefix) > 255)) {
    process.stderr.write("target prefix cannot be longer than the placeholder prefix\\n");
    process.exit(1);
  }
  while (true) {
    try {
      await access(${JSON.stringify(installGate)});
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      break;
    }
  }
  for (const prefix of prefixes) {
    const executableDirectory = join(prefix, "bin");
    const executable = join(executableDirectory, "pixi-fixture-tool");
    await mkdir(executableDirectory, { recursive: true });
    await writeFile(executable, "#!/bin/sh\\necho pixi-fixture-tool\\n");
    await chmod(executable, 0o755);
  }
  process.exit(0);
}
process.exit(2);
`, "utf8");
  await chmod(pixi, 0o755);

  const deepProject = async (name: string) => {
    const directory = join(
      projects,
      name,
      "a".repeat(72),
      "b".repeat(72),
      "c".repeat(72),
    );
    await mkdir(directory, { recursive: true });
    return directory;
  };
  return { root, cache, installGate, log, path: `${bin}${delimiter}${process.env.PATH ?? ""}`, deepProject };
}

async function waitUntil<T>(read: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition was not met within ${timeoutMs} ms`);
}

async function readJsonWhenPresent(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

test("deep projects share one short content-addressed Pixi environment while retaining local locks", async () => {
  const setup = await fixture();
  const previousPath = process.env.PATH;
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.PATH = setup.path;
  process.env.SOMITE_PIXI_CACHE_DIR = setup.cache;
  try {
    const firstProject = await setup.deepProject("first");
    const secondProject = await setup.deepProject("second");
    const firstCache = new PixiCache(firstProject);
    const secondCache = new PixiCache(secondProject);
    const manifest = "[workspace]\nname='deep-project'\nchannels=['conda-forge']\nplatforms=['linux-64']\n";
    const [firstLock, secondLock] = await Promise.all([
      firstCache.lock(manifest, "linux-64"),
      secondCache.lock(manifest, "linux-64"),
    ]);

    const [firstManifest, secondManifest] = await Promise.all([
      firstCache.environment(firstLock, "linux-64"),
      secondCache.environment(secondLock, "linux-64"),
    ]);
    assert.equal(firstManifest, secondManifest, "the same lock must resolve across projects");
    assert.ok(firstManifest.startsWith(`${setup.cache}/`), firstManifest);
    assert.ok(Buffer.byteLength(join(dirname(firstManifest), ".pixi", "envs", "default")) <= 255);

    const manifestHex = firstLock.manifest_digest.slice("blake3:".length);
    await lstat(join(firstProject, ".somite", "pixi", "locks", "linux-64", manifestHex, "pixi.lock"));
    await lstat(join(secondProject, ".somite", "pixi", "locks", "linux-64", manifestHex, "pixi.lock"));
    await assert.rejects(lstat(join(firstProject, ".somite", "pixi", "environments")), { code: "ENOENT" });
    await assert.rejects(lstat(join(secondProject, ".somite", "pixi", "environments")), { code: "ENOENT" });

    const invocations = (await readFile(setup.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.filter(({ command }) => command === "lock").length, 2);
    const installs = invocations.filter(({ command }) => command === "install");
    assert.equal(installs.length, 1);
    assert.deepEqual(installs[0].args.slice(0, 4), ["install", "--environment", "default", "--frozen"]);
    assert.equal((await readdir(join(setup.cache, "v3", "linux-64"))).length, 1);
    assert.equal((await lstat(setup.cache)).mode & 0o077, 0, "the shared cache root must remain private");
  } finally {
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("one frozen Pixi workspace realizes and verifies every requested named environment", async () => {
  const setup = await fixture();
  const previousPath = process.env.PATH;
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.PATH = setup.path;
  process.env.SOMITE_PIXI_CACHE_DIR = setup.cache;
  try {
    const project = await setup.deepProject("named-environments");
    const cache = new PixiCache(project);
    const manifest = [
      "[workspace]",
      "name='named-environments'",
      "channels=['conda-forge']",
      "platforms=['linux-64']",
      "",
      "[feature.runtime.dependencies]",
      "nextflow='*'",
      "",
      "[feature.samtools_old.dependencies]",
      "samtools='==1.18'",
      "",
      "[feature.samtools_new.dependencies]",
      "samtools='==1.19.2'",
      "",
      "[environments]",
      "default={features=['runtime'], no-default-feature=true}",
      "env_old={features=['samtools_old'], no-default-feature=true}",
      "env_new={features=['samtools_new'], no-default-feature=true}",
      "",
    ].join("\n");
    const locked = await cache.lock(manifest, "linux-64");
    const [realized, concurrent] = await Promise.all([
      cache.realizeWorkspace(locked, "linux-64", ["env_old", "default", "env_new"]),
      cache.realizeWorkspace(locked, "linux-64", ["env_old", "default", "env_new"]),
    ]);

    assert.deepEqual([...realized.prefixes.keys()], ["default", "env_new", "env_old"]);
    assert.notEqual(realized.prefixes, concurrent.prefixes, "callers must not share a mutable prefix map");
    for (const [environment, prefix] of realized.prefixes) {
      assert.equal(prefix, join(dirname(realized.manifestPath), ".pixi", "envs", environment));
      await lstat(prefix);
    }
    const invocations = (await readFile(setup.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const installs = invocations.filter(({ command }) => command === "install");
    assert.equal(installs.length, 1);
    assert.equal(installs[0].args.includes("--all"), true);
    assert.deepEqual(installs[0].prefixes.map((prefix: string) => prefix.split("/").at(-1)).sort(), ["default", "env_new", "env_old"]);
  } finally {
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("named Pixi environments reject unsafe, duplicate, and missing prefixes", async () => {
  const setup = await fixture();
  const previousPath = process.env.PATH;
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.PATH = setup.path;
  process.env.SOMITE_PIXI_CACHE_DIR = setup.cache;
  try {
    const project = await setup.deepProject("named-environment-errors");
    const cache = new PixiCache(project);
    const locked = await cache.lock([
      "[workspace]",
      "name='named-environment-errors'",
      "platforms=['linux-64']",
      "[environments]",
      "default={no-default-feature=true}",
      "",
    ].join("\n"), "linux-64");
    await assert.rejects(cache.realizeWorkspace(locked, "linux-64", []), /between 1 and 512/);
    await assert.rejects(cache.realizeWorkspace(locked, "linux-64", ["../outside"]), /invalid Pixi environment name/);
    await assert.rejects(cache.realizeWorkspace(locked, "linux-64", ["default", "default"]), /duplicate Pixi environment name/);
    await assert.rejects(
      cache.realizeWorkspace(locked, "linux-64", ["default", "missing"]),
      /installed Pixi environment missing/,
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("a source-owned Pixi lock is adopted byte-for-byte without solving it again", async () => {
  const setup = await fixture();
  const previousPath = process.env.PATH;
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.PATH = setup.path;
  process.env.SOMITE_PIXI_CACHE_DIR = setup.cache;
  try {
    const project = await setup.deepProject("adopted");
    const cache = new PixiCache(project);
    const manifest = new TextEncoder().encode("[workspace]\nname='adopted'\nplatforms=['linux-64']\n");
    const lock = new TextEncoder().encode("version: 6\nenvironments: {}\n");
    const adopted = await cache.adoptLock(manifest, lock);
    assert.deepEqual(adopted.manifest, manifest);
    assert.deepEqual(adopted.lock, lock);
    await cache.environment(adopted, "linux-64");
    const invocations = (await readFile(setup.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.some(({ command }) => command === "lock"), false);
    assert.equal(invocations.filter(({ command }) => command === "install").length, 1);
  } finally {
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("the environment cache fails closed when content-addressed material is changed", async () => {
  const setup = await fixture();
  const previousPath = process.env.PATH;
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.PATH = setup.path;
  process.env.SOMITE_PIXI_CACHE_DIR = setup.cache;
  try {
    const project = await setup.deepProject("integrity");
    const cache = new PixiCache(project);
    const manifest = "[workspace]\nname='integrity'\nplatforms=['linux-64']\n";
    const locked = await cache.lock(manifest, "linux-64");
    const cachedManifest = await cache.environment(locked, "linux-64");
    await writeFile(cachedManifest, "[workspace]\nname='changed'\n", "utf8");

    await assert.rejects(
      cache.environment(locked, "linux-64"),
      /does not match its manifest/,
    );
    const invocations = (await readFile(setup.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.filter(({ command }) => command === "install").length, 1, "corrupt entries must not be silently reinstalled or trusted");
  } finally {
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("an active builder is never reaped because its wall-clock age exceeds the build limit", async () => {
  const setup = await fixture();
  const previousPath = process.env.PATH;
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.PATH = setup.path;
  process.env.SOMITE_PIXI_CACHE_DIR = setup.cache;
  try {
    const project = await setup.deepProject("old-active-builder");
    const cache = new PixiCache(project);
    const locked = await cache.lock("[workspace]\nname='old-active-builder'\nplatforms=['linux-64']\n", "linux-64");
    const manifestPath = await cache.environment(locked, "linux-64");
    const destination = dirname(manifestPath);
    const markerPath = join(destination, "building.json");
    const sentinelPath = join(destination, "active-builder-sentinel");
    await rm(join(destination, "environment.json"));
    await writeFile(markerPath, `${JSON.stringify({
      builder_id: "active-builder",
      pid: process.pid,
      started_at_unix_ms: 0,
    })}\n`);
    await writeFile(sentinelPath, "owned by active builder\n");
    await utimes(destination, new Date(0), new Date(0));
    await writeFile(setup.installGate, "wait\n");

    const controller = new AbortController();
    const waiting = cache.environment(locked, "linux-64", controller.signal);
    setTimeout(() => controller.abort(), 180);
    await assert.rejects(waiting, /operation cancelled/);
    assert.equal(await readFile(sentinelPath, "utf8"), "owned by active builder\n");

    const invocations = (await readFile(setup.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.filter(({ command }) => command === "install").length, 1, "waiting for an active builder must not start a replacement install");
  } finally {
    await rm(setup.installGate, { force: true });
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("a failed old builder cannot remove a replacement cache entry it no longer owns", async () => {
  const setup = await fixture();
  const previousPath = process.env.PATH;
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.PATH = setup.path;
  process.env.SOMITE_PIXI_CACHE_DIR = setup.cache;
  try {
    const project = await setup.deepProject("replacement-owner");
    const seedCache = new PixiCache(project);
    const locked = await seedCache.lock("[workspace]\nname='replacement-owner'\nplatforms=['linux-64']\n", "linux-64");
    const seededManifest = await seedCache.environment(locked, "linux-64");
    const destination = dirname(seededManifest);
    await rm(destination, { recursive: true });
    await writeFile(setup.installGate, "wait\n");

    const firstController = new AbortController();
    const firstCache = new PixiCache(project);
    const first = firstCache.environment(locked, "linux-64", firstController.signal);
    void first.catch(() => undefined);
    const firstMarker = await waitUntil(() => readJsonWhenPresent(join(destination, "building.json")));
    if (process.platform === "linux") assert.match(String(firstMarker.process_identity), /^linux-proc-start:\d+$/);
    await writeFile(join(destination, "building.json"), `${JSON.stringify({
      ...firstMarker,
      pid: 2_147_483_647,
      started_at_unix_ms: 0,
    })}\n`);
    await utimes(destination, new Date(0), new Date(0));

    const secondController = new AbortController();
    const secondCache = new PixiCache(project);
    const second = secondCache.environment(locked, "linux-64", secondController.signal);
    void second.catch(() => undefined);
    const replacementMarker = await waitUntil(async () => {
      const marker = await readJsonWhenPresent(join(destination, "building.json"));
      return marker && marker.started_at_unix_ms !== 0 ? marker : undefined;
    });
    const sentinelPath = join(destination, "replacement-builder-sentinel");
    await writeFile(sentinelPath, "owned by replacement builder\n");

    firstController.abort();
    await assert.rejects(first, /operation cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await readFile(sentinelPath, "utf8"), "owned by replacement builder\n");
    assert.deepEqual(await readJsonWhenPresent(join(destination, "building.json")), replacementMarker);

    secondController.abort();
    await assert.rejects(second, /operation cancelled/);
  } finally {
    await rm(setup.installGate, { force: true });
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("cached entrypoint receipts reject deleted and same-size modified executables before reuse", async () => {
  const setup = await fixture();
  const previousPath = process.env.PATH;
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.PATH = setup.path;
  process.env.SOMITE_PIXI_CACHE_DIR = setup.cache;
  try {
    const project = await setup.deepProject("entrypoint-integrity");
    const cache = new PixiCache(project);
    const deletedLock = await cache.lock("[workspace]\nname='deleted-entrypoint'\nplatforms=['linux-64']\n", "linux-64");
    const deletedManifest = await cache.environment(deletedLock, "linux-64");
    const deletedExecutable = join(dirname(deletedManifest), ".pixi", "envs", "default", "bin", "pixi-fixture-tool");
    await rm(deletedExecutable);
    await assert.rejects(cache.environment(deletedLock, "linux-64"), /cached Pixi entrypoint .* is missing/);

    const modifiedLock = await cache.lock("[workspace]\nname='modified-entrypoint'\nplatforms=['linux-64']\n", "linux-64");
    const modifiedManifest = await cache.environment(modifiedLock, "linux-64");
    const modifiedExecutable = join(dirname(modifiedManifest), ".pixi", "envs", "default", "bin", "pixi-fixture-tool");
    const original = await readFile(modifiedExecutable);
    const changed = Buffer.from(original);
    changed[changed.length - 2] = changed[changed.length - 2] === 0x78 ? 0x79 : 0x78;
    await writeFile(modifiedExecutable, changed);
    await chmod(modifiedExecutable, 0o755);
    await assert.rejects(cache.environment(modifiedLock, "linux-64"), /cached Pixi entrypoint .* digest changed/);

    const invocations = (await readFile(setup.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.filter(({ command }) => command === "install").length, 2, "corrupt entries must fail closed instead of being silently rebuilt");
  } finally {
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("cache root configuration is portable, absolute, and refuses symbolic trust", async () => {
  assert.equal(
    pixiEnvironmentCacheRoot({ XDG_CACHE_HOME: "/cache/alice" }, "linux", "/users/alice"),
    "/cache/alice/somite/pixi",
  );
  assert.equal(
    pixiEnvironmentCacheRoot({}, "darwin", "/Users/alice"),
    "/Users/alice/Library/Caches/Somite/pixi",
  );
  assert.equal(
    pixiEnvironmentCacheRoot({ XDG_CACHE_HOME: "relative/cache" }, "linux", "/users/alice"),
    "/users/alice/.cache/somite/pixi",
  );
  assert.throws(
    () => pixiEnvironmentCacheRoot({ SOMITE_PIXI_CACHE_DIR: "relative/cache" }, "linux", "/users/alice"),
    /must be an absolute path/,
  );

  const setup = await fixture();
  const previousPath = process.env.PATH;
  const previousCache = process.env.SOMITE_PIXI_CACHE_DIR;
  process.env.PATH = setup.path;
  try {
    const project = await setup.deepProject("symbolic-root");
    const target = join(setup.root, "cache-target");
    const link = join(setup.root, "cache-link");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link, "dir");
    process.env.SOMITE_PIXI_CACHE_DIR = link;
    const cache = new PixiCache(project);
    const locked = await cache.lock("[workspace]\nname='symbolic-root'\nplatforms=['linux-64']\n", "linux-64");
    await assert.rejects(cache.environment(locked, "linux-64"), /must be a regular directory|contains a symbolic path/);
    let invocations = (await readFile(setup.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.filter(({ command }) => command === "install").length, 0, "an untrusted cache path must be rejected before Pixi starts");

    const linkedHomeTarget = join(setup.root, "mounted-home");
    const linkedHome = join(setup.root, "home-link");
    await mkdir(linkedHomeTarget, { mode: 0o700 });
    await symlink(linkedHomeTarget, linkedHome, "dir");
    process.env.SOMITE_PIXI_CACHE_DIR = join(linkedHome, "cache");
    const mountedProject = await setup.deepProject("mounted-home-project");
    const mountedCache = new PixiCache(mountedProject);
    const mountedLock = await mountedCache.lock("[workspace]\nname='mounted-home'\nplatforms=['linux-64']\n", "linux-64");
    const mountedManifest = await mountedCache.environment(mountedLock, "linux-64");
    assert.ok(mountedManifest.startsWith(`${join(linkedHomeTarget, "cache")}/`), mountedManifest);
    invocations = (await readFile(setup.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.filter(({ command }) => command === "install").length, 1, "a canonicalized home ancestor must remain usable");
  } finally {
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.SOMITE_PIXI_CACHE_DIR;
    else process.env.SOMITE_PIXI_CACHE_DIR = previousCache;
    await rm(setup.root, { recursive: true, force: true });
  }
});
