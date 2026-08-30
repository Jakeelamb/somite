import assert from "node:assert/strict";
import test from "node:test";

import { discoverAgents } from "../src/agentDiscovery.ts";

test("Agent discovery coalesces repeated registry reads behind a live cache", async (context) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      version: "1.0.0",
      agents: [{
        id: "test-agent",
        name: "Test Agent",
        version: "1.0.0",
        description: "Deterministic discovery fixture",
        distribution: { npx: { package: "@example/test-agent@1.0.0" } },
      }],
    }), { headers: { "content-type": "application/json" } });
  };
  context.after(() => { globalThis.fetch = originalFetch; });

  const [first, second] = await Promise.all([
    discoverAgents("/tmp/somite-agent-discovery"),
    discoverAgents("/tmp/somite-agent-discovery"),
  ]);
  const third = await discoverAgents("/tmp/somite-agent-discovery");

  assert.equal(calls, 1);
  assert.equal(first.registry_status, "live");
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(first.agents[0]?.id, "test-agent");
});
