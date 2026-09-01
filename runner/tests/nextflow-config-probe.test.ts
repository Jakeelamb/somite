import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import { byteDigest, canonicalJsonDigest } from "@somite/workflow/contentIdentity";

import {
  NextflowConfigProbeError,
  probeNextflowConfiguration,
  type NextflowConfigProbeInput,
  type NextflowProbeCommandRequest,
  type NextflowProbeCommandResult,
  type NextflowProbeCommandRunner,
} from "../src/nextflowConfigProbe.ts";

const encoder = new TextEncoder();

function bytes(value: string) {
  return encoder.encode(value);
}

function input(overrides: Partial<NextflowConfigProbeInput> = {}): NextflowConfigProbeInput {
  return {
    pixiBinary: "/opt/somite/pixi",
    frozenManifestPath: "/workspace/frozen/pixi.toml",
    projectDirectory: "/workspace/source",
    entrypoint: "main.nf",
    configurationPaths: ["nextflow.config", ".somite/run/source-task-nextflow.config"],
    profiles: ["test", "somite_frozen_execution"],
    paramsFile: ".somite/run/params.json",
    frozenPluginDirectory: "/workspace/frozen/nextflow-plugins",
    allowedPluginIds: ["nf-schema", "nf-core-utils"],
    ...overrides,
  };
}

function result(stdout: string, stderr = ""): NextflowProbeCommandResult {
  return { code: 0, signal: null, stdout: bytes(stdout), stderr: bytes(stderr) };
}

const LEGACY_PARSER_COMPATIBILITY_DIAGNOSTIC = [
  "Error nextflow.config:256:1: Variable declarations cannot be mixed with config statements",
  "ERROR ~ Config parsing failed",
  "",
].join("\n");

test("native config and inspect proofs use one private offline Nextflow home and exact pinned Pixi invocation", async () => {
  const calls: NextflowProbeCommandRequest[] = [];
  const runner: NextflowProbeCommandRunner = async (request) => {
    calls.push(request);
    return calls.length === 1
      ? result('{"process":{"executor":"local"}}\n', "config note\n")
      : result('{"processes":[{"name":"ALIGN","container":"example/aligner:1"}]}\n');
  };

  const proof = await probeNextflowConfiguration(input(), runner);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.file, "/opt/somite/pixi");
  assert.deepEqual(calls[0]!.args, [
    "run", "--frozen", "--manifest-path", "/workspace/frozen/pixi.toml", "--", "env", "-u", "CONDA_PREFIX", "nextflow",
    "-log", calls[0]!.env.NXF_HOME + "/config.log",
    "-C", "nextflow.config,.somite/run/source-task-nextflow.config",
    "config", ".", "-profile", "test,somite_frozen_execution", "-o", "json",
  ]);
  assert.deepEqual(calls[1]!.args, [
    "run", "--frozen", "--manifest-path", "/workspace/frozen/pixi.toml", "--", "env", "-u", "CONDA_PREFIX", "nextflow",
    "-log", calls[1]!.env.NXF_HOME + "/inspect.log",
    "-C", "nextflow.config,.somite/run/source-task-nextflow.config",
    "inspect", "main.nf", "-profile", "test,somite_frozen_execution",
    "-params-file", ".somite/run/params.json", "-format", "json",
  ]);
  assert.equal(calls[0]!.cwd, "/workspace/source");
  assert.equal(calls[0]!.env.NXF_HOME, calls[1]!.env.NXF_HOME);
  assert.equal(calls[0]!.env.NXF_CACHE_DIR, calls[0]!.env.NXF_HOME + "/cache");
  assert.equal(calls[0]!.env.NXF_OFFLINE, "true");
  assert.equal(calls[0]!.env.NXF_PLUGINS_DEFAULT, "false");
  assert.equal(calls[0]!.env.NXF_PLUGINS_ALLOWED, "nf-schema,nf-core-utils");
  assert.equal(calls[0]!.env.NXF_PLUGINS_DIR, "/workspace/frozen/nextflow-plugins");
  assert.equal(calls[0]!.env.NXF_WORK, calls[0]!.env.NXF_HOME + "/work");
  assert.equal(calls[0]!.env.NXF_SYNTAX_PARSER, undefined);
  assert.equal(calls[0]!.maxOutputBytes, 8 * 1024 * 1024);
  assert.equal(calls[0]!.timeoutMs, 60_000);
  await assert.rejects(() => access(calls[0]!.env.NXF_HOME!));

  assert.deepEqual(proof.config.document, { process: { executor: "local" } });
  assert.equal(proof.inspect.document.processes[0]!.name, "ALIGN");
  assert.equal(proof.config.receipt.stdout_digest, byteDigest(bytes('{"process":{"executor":"local"}}\n')));
  assert.equal(proof.config.receipt.stderr_digest, byteDigest(bytes("config note\n")));
  assert.match(proof.config.receipt.receipt_digest, /^blake3:[0-9a-f]{64}$/);
  assert.match(proof.inspect.receipt.receipt_digest, /^blake3:[0-9a-f]{64}$/);
  assert.match(proof.proof_digest, /^blake3:[0-9a-f]{64}$/);
  assert.equal(proof.schema_version, 2);
  assert.equal(proof.parser_mode, "default");
  assert.equal(proof.fallback_reason, null);
  assert.deepEqual(proof.config.attempts, [proof.config.receipt]);
  assert.deepEqual(proof.inspect.attempts, [proof.inspect.receipt]);
  assert.equal(proof.config.receipt.attempt, 1);
  assert.equal(proof.config.receipt.parser_mode, "default");
  const { proof_digest: _proofDigest, ...proofIdentity } = proof;
  assert.equal(proof.proof_digest, canonicalJsonDigest(proofIdentity));
});

test("the exact strict-parser compatibility failure retries config with v1 and keeps inspect on v1", async () => {
  const calls: NextflowProbeCommandRequest[] = [];
  const inheritedParser = process.env.NXF_SYNTAX_PARSER;
  const inheritedConfig = process.env.NXF_CONFIG;
  process.env.NXF_SYNTAX_PARSER = "inherited-value-must-not-leak";
  process.env.NXF_CONFIG = "/tmp/ambient-nextflow.config";
  try {
    const proof = await probeNextflowConfiguration(input(), async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          code: 1,
          signal: null,
          stdout: bytes(""),
          stderr: bytes(LEGACY_PARSER_COMPATIBILITY_DIAGNOSTIC),
        };
      }
      return calls.length === 2
        ? result('{"process":{"executor":"local"}}\n')
        : result('{"processes":[{"name":"ALIGN"}]}\n');
    });

    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.env.NXF_SYNTAX_PARSER, undefined);
    assert.equal(calls[0]!.env.NXF_CONFIG, undefined);
    assert.equal(calls[1]!.env.NXF_SYNTAX_PARSER, "v1");
    assert.equal(calls[2]!.env.NXF_SYNTAX_PARSER, "v1");
    assert.equal(calls[0]!.args.includes("config"), true);
    assert.deepEqual(calls[1]!.args, calls[0]!.args);
    assert.equal(calls[2]!.args.includes("inspect"), true);
    assert.equal(proof.parser_mode, "v1");
    assert.equal(
      proof.fallback_reason,
      "mixed_variable_declarations_and_config_statements",
    );
    assert.deepEqual(
      proof.config.attempts.map((attempt) => [
        attempt.attempt,
        attempt.parser_mode,
        attempt.exit_code,
      ]),
      [[1, "default", 1], [2, "v1", 0]],
    );
    assert.deepEqual(
      proof.inspect.attempts.map((attempt) => [attempt.attempt, attempt.parser_mode]),
      [[1, "v1"]],
    );
    assert.equal(proof.config.receipt, proof.config.attempts[1]);
    const { proof_digest: _proofDigest, ...proofIdentity } = proof;
    assert.equal(proof.proof_digest, canonicalJsonDigest(proofIdentity));
  } finally {
    if (inheritedParser === undefined) delete process.env.NXF_SYNTAX_PARSER;
    else process.env.NXF_SYNTAX_PARSER = inheritedParser;
    if (inheritedConfig === undefined) delete process.env.NXF_CONFIG;
    else process.env.NXF_CONFIG = inheritedConfig;
  }
});

test("parser fallback is fail-closed for partial signatures, signals, and inspect-only failures", async () => {
  for (const failedResult of [
    {
      code: 1,
      signal: null,
      stdout: bytes(""),
      stderr: bytes("Error nextflow.config:256:1: Variable declarations cannot be mixed with config statements\n"),
    },
    {
      code: 1,
      signal: null,
      stdout: bytes(""),
      stderr: bytes(`prefix ${LEGACY_PARSER_COMPATIBILITY_DIAGNOSTIC}`),
    },
    {
      code: null,
      signal: "SIGTERM" as NodeJS.Signals,
      stdout: bytes(""),
      stderr: bytes(LEGACY_PARSER_COMPATIBILITY_DIAGNOSTIC),
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      () => probeNextflowConfiguration(input(), async () => {
        calls += 1;
        return failedResult;
      }),
      (error: unknown) => error instanceof NextflowConfigProbeError
        && error.code === "command_failed"
        && error.stage === "config"
        && error.fallbackReason === undefined,
    );
    assert.equal(calls, 1);
  }

  let inspectCalls = 0;
  await assert.rejects(
    () => probeNextflowConfiguration(input(), async () => {
      inspectCalls += 1;
      return inspectCalls === 1
        ? result("{}")
        : {
            code: 1,
            signal: null,
            stdout: bytes(""),
            stderr: bytes(LEGACY_PARSER_COMPATIBILITY_DIAGNOSTIC),
          };
    }),
    (error: unknown) => error instanceof NextflowConfigProbeError
      && error.stage === "inspect"
      && error.receipt?.parser_mode === "default",
  );
  assert.equal(inspectCalls, 2);
});

test("a failed v1 retry reports both parser attempt receipts and never runs inspect", async () => {
  let calls = 0;
  await assert.rejects(
    () => probeNextflowConfiguration(input(), async () => {
      calls += 1;
      return calls === 1
        ? {
            code: 1,
            signal: null,
            stdout: bytes(""),
            stderr: bytes(LEGACY_PARSER_COMPATIBILITY_DIAGNOSTIC),
          }
        : {
            code: 1,
            signal: null,
            stdout: bytes(""),
            stderr: bytes("legacy parser still rejected the configuration\n"),
          };
    }),
    (error: unknown) => {
      assert.ok(error instanceof NextflowConfigProbeError);
      assert.equal(error.code, "command_failed");
      assert.equal(error.stage, "config");
      assert.equal(error.fallbackReason, "mixed_variable_declarations_and_config_statements");
      assert.deepEqual(
        error.attempts?.map((attempt) => [attempt.attempt, attempt.parser_mode, attempt.exit_code]),
        [[1, "default", 1], [2, "v1", 1]],
      );
      assert.match(error.message, /parser fallback attempts: default=blake3:/);
      assert.match(error.message, /v1=blake3:/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("a failed config command returns a hashed receipt and never runs inspect", async () => {
  let calls = 0;
  const runner: NextflowProbeCommandRunner = async () => {
    calls += 1;
    return { code: 1, signal: null, stdout: bytes(""), stderr: bytes("bad config\n") };
  };

  await assert.rejects(
    () => probeNextflowConfiguration(input(), runner),
    (error: unknown) => {
      assert.ok(error instanceof NextflowConfigProbeError);
      assert.equal(error.code, "command_failed");
      assert.equal(error.stage, "config");
      assert.match(error.message, /bad config/);
      assert.equal(error.receipt?.stderr_digest, byteDigest(bytes("bad config\n")));
      assert.match(error.receipt?.receipt_digest ?? "", /^blake3:[0-9a-f]{64}$/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("JSON is runtime-decoded and inspect requires named process records", async () => {
  const malformedConfig: NextflowProbeCommandRunner = async () => result("not-json");
  await assert.rejects(
    () => probeNextflowConfiguration(input(), malformedConfig),
    (error: unknown) => {
      assert.ok(error instanceof NextflowConfigProbeError);
      assert.equal(error.code, "invalid_json");
      assert.equal(error.stage, "config");
      assert.match(error.receipt?.stdout_digest ?? "", /^blake3:[0-9a-f]{64}$/);
      return true;
    },
  );

  let calls = 0;
  const malformedInspect: NextflowProbeCommandRunner = async () => {
    calls += 1;
    return calls === 1 ? result("{}") : result('{"processes":[{"container":"image:1"}]}');
  };
  await assert.rejects(
    () => probeNextflowConfiguration(input(), malformedInspect),
    (error: unknown) => error instanceof NextflowConfigProbeError
      && error.code === "invalid_shape"
      && error.stage === "inspect",
  );
});

test("injected runners cannot bypass stream limits or command deadlines", async () => {
  const oversized: NextflowProbeCommandRunner = async () => result('{"padding":"0123456789"}');
  await assert.rejects(
    () => probeNextflowConfiguration(input({ maxOutputBytes: 8 }), oversized),
    (error: unknown) => error instanceof NextflowConfigProbeError
      && error.code === "output_limit"
      && error.stage === "config",
  );

  const stalled: NextflowProbeCommandRunner = async () => new Promise<NextflowProbeCommandResult>(() => {});
  await assert.rejects(
    () => probeNextflowConfiguration(input({ commandTimeoutMs: 5 }), stalled),
    (error: unknown) => error instanceof NextflowConfigProbeError
      && error.code === "timed_out"
      && error.stage === "config",
  );
});

test("the proof refuses implicit config sets, ambiguous paths, duplicate policy values, and pre-cancelled work", async () => {
  const unused: NextflowProbeCommandRunner = async () => {
    throw new Error("runner should not be reached");
  };
  for (const invalid of [
    input({ configurationPaths: [] }),
    input({ configurationPaths: ["one.config,two.config"] }),
    input({ profiles: ["test", "test"] }),
    input({ allowedPluginIds: ["nf-schema", "nf-schema"] }),
    input({ pixiBinary: "pixi" }),
  ]) {
    await assert.rejects(
      () => probeNextflowConfiguration(invalid, unused),
      (error: unknown) => error instanceof NextflowConfigProbeError && error.code === "invalid_input",
    );
  }

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => probeNextflowConfiguration(input({ signal: controller.signal }), unused),
    (error: unknown) => error instanceof NextflowConfigProbeError
      && error.code === "cancelled"
      && error.stage === "config",
  );
});
