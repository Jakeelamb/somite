import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  await writeFile(pixi, `#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const manifest = args[args.indexOf("--manifest-path") + 1];
const prefix = join(dirname(manifest), ".pixi", "envs", "default");
await appendFile(${JSON.stringify(log)}, JSON.stringify({ command: args[0], manifest, prefix }) + "\\n");
if (args[0] === "lock") {
  await writeFile(join(dirname(manifest), "pixi.lock"), "version: 6\\n");
  process.exit(0);
}
if (args[0] === "install") {
  if (Buffer.byteLength(prefix) > 255) {
    process.stderr.write("target prefix cannot be longer than the placeholder prefix\\n");
    process.exit(1);
  }
  await mkdir(prefix, { recursive: true });
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
  return { root, cache, log, path: `${bin}${delimiter}${process.env.PATH ?? ""}`, deepProject };
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
    assert.equal(invocations.filter(({ command }) => command === "install").length, 1);
    assert.equal((await readdir(join(setup.cache, "v1", "linux-64"))).length, 1);
    assert.equal((await lstat(setup.cache)).mode & 0o077, 0, "the shared cache root must remain private");
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
