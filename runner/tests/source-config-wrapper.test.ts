import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSourceConfigWrapper,
  SOURCE_EFFECTIVE_CONFIG,
} from "../src/sourceConfigWrapper.ts";

const decoder = new TextDecoder();

test("renders one deterministic effective config with bindings before and after source defaults", () => {
  const rendered = decoder.decode(renderSourceConfigWrapper(
    ["workflows/demo/nextflow.config", "nextflow.config"],
    { text: "a'b\\c$1\n", enabled: true, count: 3, absent: null },
    ".somite/run/source-task-nextflow.config",
  ));

  assert.equal(SOURCE_EFFECTIVE_CONFIG, ".somite/run/source-effective-nextflow.config");
  assert.deepEqual(rendered.match(/^params\.[^\n]+/gm), [
    "params.absent = null",
    "params.count = 3",
    "params.enabled = true",
    "params.text = 'a\\'b\\\\c$1\\n'",
    "params.absent = null",
    "params.count = 3",
    "params.enabled = true",
    "params.text = 'a\\'b\\\\c$1\\n'",
  ]);
  assert.match(rendered, /includeConfig '\.\.\/\.\.\/workflows\/demo\/nextflow\.config'/);
  assert.match(rendered, /includeConfig '\.\.\/\.\.\/nextflow\.config'/);
  assert.match(rendered, /includeConfig 'source-task-nextflow\.config'\n$/);
});

test("rejects duplicate roots, unsafe paths, hostile names, and non-finite values", () => {
  assert.throws(() => renderSourceConfigWrapper(
    ["nextflow.config", "nextflow.config"], {}, ".somite/run/source-task-nextflow.config",
  ), /duplicate root configs/);
  assert.throws(() => renderSourceConfigWrapper(
    ["../outside"], {}, ".somite/run/source-task-nextflow.config",
  ), /unsafe path/);
  assert.throws(() => renderSourceConfigWrapper(
    [], { "bad.name": true }, ".somite/run/source-task-nextflow.config",
  ), /invalid parameter name/);
  assert.throws(() => renderSourceConfigWrapper(
    [], { count: Number.POSITIVE_INFINITY }, ".somite/run/source-task-nextflow.config",
  ), /must be finite/);
});
