import assert from "node:assert/strict";
import test from "node:test";

import {
  extractNextflowConfigScalarDefaults,
  resolveNextflowConfigExpression,
} from "../nextflowConfigExpression.ts";

const offline = {
  parameters: {
    custom_config_base: "https://raw.githubusercontent.com/nf-core/configs/master",
    igenomes_ignore: false,
  },
  environment: { NXF_OFFLINE: "true" },
} as const;

test("resolves the standard nf-core offline custom-config guard to dev null", () => {
  const resolved = resolveNextflowConfigExpression(
    `params.custom_config_base && (!System.getenv('NXF_OFFLINE') || !params.custom_config_base.startsWith('http')) ? "\${params.custom_config_base}/pipeline/demo.config" : "/dev/null"`,
    offline,
  );

  assert.deepEqual(resolved, {
    status: "resolved",
    value: "/dev/null",
    parameters: ["custom_config_base"],
    environment: ["NXF_OFFLINE"],
  });
});

test("resolves source-local ternary branches from a bound boolean", () => {
  assert.deepEqual(
    resolveNextflowConfigExpression(
      `!params.igenomes_ignore ? 'conf/igenomes.config' : 'conf/igenomes_ignored.config'`,
      offline,
    ),
    {
      status: "resolved",
      value: "conf/igenomes.config",
      parameters: ["igenomes_ignore"],
      environment: [],
    },
  );
  assert.equal(
    resolveNextflowConfigExpression(
      `!params.igenomes_ignore ? 'conf/igenomes.config' : 'conf/igenomes_ignored.config'`,
      { ...offline, parameters: { ...offline.parameters, igenomes_ignore: true } },
    ).status,
    "resolved",
  );
});

test("interpolates only known scalar parameters", () => {
  assert.deepEqual(
    resolveNextflowConfigExpression(`"\${params.base}/nested.config"`, {
      parameters: { base: "conf" },
      environment: {},
    }),
    {
      status: "resolved",
      value: "conf/nested.config",
      parameters: ["base"],
      environment: [],
    },
  );
});

test("short-circuits without requiring an unreachable unknown value", () => {
  assert.deepEqual(
    resolveNextflowConfigExpression(`System.getenv('NXF_OFFLINE') ? '/dev/null' : params.missing`, {
      parameters: {},
      environment: { NXF_OFFLINE: "true" },
    }),
    {
      status: "resolved",
      value: "/dev/null",
      parameters: [],
      environment: ["NXF_OFFLINE"],
    },
  );
});

test("fails closed for missing values, unsupported calls, and trailing syntax", () => {
  for (const expression of [
    "params.unknown",
    "params.base.toUpperCase()",
    "new File('secret.config')",
    "'conf/base.config' + params.suffix",
  ]) {
    const result = resolveNextflowConfigExpression(expression, { parameters: {}, environment: {} });
    assert.equal(result.status, "unresolved", expression);
    if (result.status === "unresolved") assert.ok(result.reason.length > 0);
  }
});

test("bounds expression size and nesting", () => {
  assert.equal(
    resolveNextflowConfigExpression("x".repeat(16_385), { parameters: {}, environment: {} }).status,
    "unresolved",
  );
  assert.equal(
    resolveNextflowConfigExpression(`${"(".repeat(140)}'x'${")".repeat(140)}`, {
      parameters: {},
      environment: {},
    }).status,
    "unresolved",
  );
});

test("extracts only unambiguous top-level scalar parameter defaults", () => {
  const source = new TextEncoder().encode([
    "// params { ignored = 'comment' }",
    "def note = \"params { ignored = 'string' }\"",
    "params {",
    "  custom_config_version = 'stable'",
    "  custom_config_base = \"https://example.test/configs/\${params.custom_config_version}\"",
    "  igenomes_ignore = false",
    "  absent = null",
    "  dynamic = System.getenv('DYNAMIC')",
    "  duplicate = 'first'",
    "  duplicate = 'second'",
    "}",
    "profiles { test { params.igenomes_ignore = true } }",
    "",
  ].join("\n"));

  assert.deepEqual(extractNextflowConfigScalarDefaults(source), {
    values: {
      absent: null,
      custom_config_base: "https://example.test/configs/stable",
      custom_config_version: "stable",
      igenomes_ignore: false,
    },
    unresolved: ["duplicate", "dynamic"],
  });
});
