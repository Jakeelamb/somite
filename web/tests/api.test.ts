import assert from "node:assert/strict";
import test from "node:test";

import {
  configureSomiteServer,
  normalizedSomiteServerUrl,
  somiteServerUrl,
} from "../app/api.ts";

test("normalizes the runtime runner origin", () => {
  assert.equal(normalizedSomiteServerUrl(undefined), "http://localhost:7310");
  assert.equal(normalizedSomiteServerUrl("https://runner.example:7443/"), "https://runner.example:7443");
  configureSomiteServer("http://127.0.0.1:43117");
  assert.equal(somiteServerUrl(), "http://127.0.0.1:43117");
});

test("rejects runner URLs that can redirect requests outside one origin", () => {
  for (const value of [
    "file:///tmp/socket",
    "https://user:secret@runner.example",
    "https://runner.example/api",
    "https://runner.example/?target=other",
    "https://runner.example/#other",
  ]) {
    assert.throws(() => normalizedSomiteServerUrl(value), /HTTP\(S\) origin/);
  }
});
