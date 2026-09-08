import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const browserslist = require("browserslist");
const inheritedNames = ["__proto__", "toString", "valueOf", "constructor", "hasOwnProperty", "isPrototypeOf"];
const poisonedStats = (name) => JSON.parse(`{"${name}":{"onekey":5},"chrome":{"100":50}}`);

// https://github.com/browserslist/browserslist/security/advisories/GHSA-73wf-gq98-2v4g
test("all locked Browserslist copies include the custom-stats security fix", async () => {
  const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith("/node_modules/browserslist") || path === "node_modules/browserslist");
  assert.ok(copies.length > 0);
  for (const [path, entry] of copies) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = entry.version.split(".").map(Number);
    assert.ok(major > 4 || (major === 4 && (minor > 28 || (minor === 28 && patch >= 7))), `${path}@${entry.version} predates the security fix`);
  }
});

test("untrusted custom stats cannot crash an unrelated browser query", () => {
  const expected = browserslist("defaults", { stats: { chrome: { 100: 50 } } });
  assert.ok(expected.length > 0);
  for (const name of inheritedNames) {
    const stats = poisonedStats(name);
    assert.deepEqual(browserslist("defaults", { stats }), expected, name);
    assert.deepEqual(browserslist("defaults", { stats: { dataByBrowser: stats } }), expected, `${name} in dataByBrowser`);
  }
});

test("auto-discovered poisoned stats cannot break a build's default browser query", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "somite-browserslist-security-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "browserslist-stats.json"), JSON.stringify(poisonedStats("toString")));
  const script = `
    const assert = require("node:assert/strict");
    const browserslist = require(${JSON.stringify(require.resolve("browserslist"))});
    const expected = browserslist("defaults", { stats: { chrome: { 100: 50 } } });
    browserslist.clearCaches();
    assert.deepEqual(browserslist("defaults"), expected);
  `;
  await promisify(execFile)(process.execPath, ["-e", script], {
    cwd: directory,
    env: { ...process.env, BROWSERSLIST_STATS: "", BROWSERSLIST_DISABLE_CACHE: "1" },
    timeout: 10_000,
  });
});
