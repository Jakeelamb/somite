import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CREDENTIAL_ENV_NAMES,
  agentChildEnvironment,
} from "../src/agentEnvironment.ts";

test("Agent child inheritance keeps portable runtime values but strips ambient secrets", () => {
  const inherited = agentChildEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/scientist",
    TMPDIR: "/tmp/agent",
    LANG: "en_US.UTF-8",
    SSL_CERT_FILE: "/etc/ssl/certs/ca.pem",
    WSL_DISTRO_NAME: "Ubuntu",
    OPENAI_API_KEY: "sentinel-openai-secret",
    OTHER_SECRET: "sentinel-other-secret",
    SOMITE_MCP_RUNTIME_CAPABILITY: "sentinel-capability",
    [AGENT_CREDENTIAL_ENV_NAMES]: "OPENAI_API_KEY",
  });

  assert.equal(inherited.OTHER_SECRET, undefined);
  assert.equal(inherited.SOMITE_MCP_RUNTIME_CAPABILITY, undefined);
  assert.equal(inherited[AGENT_CREDENTIAL_ENV_NAMES], undefined);
  assert.deepEqual(inherited, {
    PATH: "/usr/bin",
    HOME: "/home/scientist",
    TMPDIR: "/tmp/agent",
    SSL_CERT_FILE: "/etc/ssl/certs/ca.pem",
    LANG: "en_US.UTF-8",
    WSL_DISTRO_NAME: "Ubuntu",
    OPENAI_API_KEY: "sentinel-openai-secret",
  });
});

test("Agent credential opt-in accepts only credential-shaped names and never the MCP capability", () => {
  assert.throws(
    () => agentChildEnvironment({ [AGENT_CREDENTIAL_ENV_NAMES]: "NODE_OPTIONS", NODE_OPTIONS: "--require=evil" }),
    /non-credential environment name/,
  );
  assert.throws(
    () => agentChildEnvironment({
      [AGENT_CREDENTIAL_ENV_NAMES]: "SOMITE_MCP_RUNTIME_CAPABILITY",
      SOMITE_MCP_RUNTIME_CAPABILITY: "sentinel",
    }),
    /may not be inherited/,
  );
});
