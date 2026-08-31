import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ManagedResourceManager, managedResourceReference, type ManagedResourceProvider } from "../src/managedResources.ts";
import { runCaptured } from "../src/process.ts";

function md5(bytes: Uint8Array) { return createHash("md5").update(bytes).digest("hex"); }

test("managed resources verify, extract, cache, and replay a reviewed provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "somite-resource-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const cache = join(root, "cache");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(source));
  const files = { "hash.k2d": Buffer.from("hash"), "opts.k2d": Buffer.from("opts"), "taxo.k2d": Buffer.from("taxonomy") };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(source, name), bytes);
  const archive = join(root, "fixture.tar.gz");
  const packed = await runCaptured("tar", ["-czf", archive, "hash.k2d", "opts.k2d", "taxo.k2d"], source);
  assert.equal(packed.code, 0);
  const archiveBytes = await readFile(archive);
  const provider: ManagedResourceProvider = {
    id: "fixture", profile: "kraken2-database", resolution: "standard-8", version: "test-v1", title: "Fixture database",
    source_url: "https://resources.example/fixture.tar.gz", source_page: "https://resources.example/", archive_md5: md5(archiveBytes),
    download_bytes: archiveBytes.byteLength, stored_bytes: 64, scientific_effect: "fixture only",
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, md5(bytes)])),
  };
  const manager = new ManagedResourceManager(root, { cacheRoot: cache, providers: [provider], fetcher: async () => new Response(archiveBytes, { headers: { "Content-Length": String(archiveBytes.byteLength) } }) });
  t.after(() => manager.shutdown());
  assert.equal((await manager.assessmentContext()).managed_resources?.[0]?.available, false);
  const started = await manager.start(provider.profile, provider.resolution, "fixture-key-1");
  let status = await manager.status(started.job_id, 5_000);
  assert.equal(status.phase, "completed", status.error);
  assert.ok(status.path);
  assert.equal((await readFile(join(status.path!, "hash.k2d"))).toString(), "hash");
  const reference = managedResourceReference(provider.id);
  assert.equal(await manager.resolve(reference), status.path);
  assert.deepEqual((await manager.assessmentContext()).managed_resources?.map(({ reference: item, available }) => ({ reference: item, available })), [{ reference, available: true }]);
  const replay = await manager.start(provider.profile, provider.resolution, "fixture-key-1");
  assert.equal(replay.replayed, true);
  const cached = await manager.start(provider.profile, provider.resolution, "fixture-key-2");
  status = await manager.status(cached.job_id, 5_000);
  assert.equal(status.phase, "completed");
});

test("managed resources reject corrupt archives without publishing a cache entry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "somite-resource-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("not a reviewed archive");
  const provider: ManagedResourceProvider = {
    id: "corrupt", profile: "kraken2-database", resolution: "standard-8", version: "test-v1", title: "Corrupt fixture",
    source_url: "https://resources.example/corrupt.tar.gz", source_page: "https://resources.example/", archive_md5: "00000000000000000000000000000000",
    download_bytes: bytes.byteLength, stored_bytes: 1, scientific_effect: "fixture only", files: { "hash.k2d": "0", "opts.k2d": "0", "taxo.k2d": "0" },
  };
  const manager = new ManagedResourceManager(root, { cacheRoot: join(root, "cache"), providers: [provider], fetcher: async () => new Response(bytes) });
  t.after(() => manager.shutdown());
  const started = await manager.start(provider.profile, provider.resolution, "corrupt-key");
  const status = await manager.status(started.job_id, 5_000);
  assert.equal(status.phase, "failed");
  assert.match(status.error!, /checksum/);
});
