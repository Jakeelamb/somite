import assert from "node:assert/strict";
import test from "node:test";

import manifest from "../package.json" with { type: "json" };
import {
  SOMITE_NEXTFLOW_COMPILER_IDENTITY,
  SOMITE_TYPESCRIPT_RUNNER_IDENTITY,
  SOMITE_VERSION,
} from "../version.ts";

test("application and provenance identities derive from package metadata", () => {
  assert.equal(SOMITE_VERSION, manifest.version);
  assert.equal(SOMITE_NEXTFLOW_COMPILER_IDENTITY, `somite-nextflow@${manifest.version}`);
  assert.equal(SOMITE_TYPESCRIPT_RUNNER_IDENTITY, `somite-typescript-runner@${manifest.version}`);
});
