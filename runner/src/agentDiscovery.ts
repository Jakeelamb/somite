import { basename } from "node:path";

import { boundedResponseBytes } from "@somite/workflow/boundedResponse";
import { executablePath } from "./system.ts";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const LIVE_REGISTRY_TTL_MS = 10 * 60 * 1_000;
const FALLBACK_REGISTRY_TTL_MS = 30 * 1_000;

const FALLBACK_REGISTRY = {
  version: "1.0.0",
  agents: [
    {
      id: "codex-acp",
      name: "Codex",
      version: "1.6.2",
      description: "ACP adapter for OpenAI's coding assistant",
      repository: "https://github.com/agentclientprotocol/codex-acp",
      distribution: { npx: { package: "@agentclientprotocol/codex-acp@1.6.2" } },
    },
    {
      id: "opencode",
      name: "OpenCode",
      version: "1.18.23",
      description: "The open source coding agent",
      repository: "https://github.com/anomalyco/opencode",
      website: "https://opencode.ai",
      distribution: { binary: {
        "linux-x86_64": { cmd: "./opencode", args: ["acp"] },
        "linux-aarch64": { cmd: "./opencode", args: ["acp"] },
        "darwin-x86_64": { cmd: "./opencode", args: ["acp"] },
        "darwin-aarch64": { cmd: "./opencode", args: ["acp"] },
      } },
    },
    {
      id: "claude-acp",
      name: "Claude Agent",
      version: "0.70.0",
      description: "ACP wrapper for Anthropic's Claude",
      repository: "https://github.com/agentclientprotocol/claude-agent-acp",
      distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.70.0" } },
    },
  ],
};

type PackageDistribution = { package: string; args?: string[] };
type BinaryDistribution = { cmd: string; args?: string[] };
type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  icon?: string;
  distribution: {
    binary?: Record<string, BinaryDistribution>;
    npx?: PackageDistribution;
    uvx?: PackageDistribution;
  };
};

export type AgentDiscovery = {
  registry_url: string;
  registry_status: "live" | "offline_cache" | "unavailable";
  agents: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    command?: string;
    availability: "installed" | "ready" | "unavailable";
    availability_detail: string;
    repository?: string;
    website?: string;
    icon?: string;
  }>;
};

type RegistrySnapshot = {
  agents: RegistryAgent[];
  status: AgentDiscovery["registry_status"];
};

let cachedRegistry: { expiresAt: number; snapshot: RegistrySnapshot } | undefined;
let pendingRegistry: Promise<RegistrySnapshot> | undefined;

function safeToken(value: string) {
  return value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_./@:=+-]+$/.test(value);
}

function strings(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;
}

export function parseAgentRegistry(value: unknown): RegistryAgent[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const agents = (value as Record<string, unknown>).agents;
  if (!Array.isArray(agents)) return undefined;
  const parsed: RegistryAgent[] = [];
  for (const candidate of agents) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    if (![raw.id, raw.name, raw.version, raw.description].every((field) => typeof field === "string")
      || !raw.distribution || typeof raw.distribution !== "object" || Array.isArray(raw.distribution)) continue;
    const distributionRaw = raw.distribution as Record<string, unknown>;
    const distribution: RegistryAgent["distribution"] = {};
    if (distributionRaw.npx && typeof distributionRaw.npx === "object" && !Array.isArray(distributionRaw.npx)) {
      const item = distributionRaw.npx as Record<string, unknown>;
      if (typeof item.package === "string") distribution.npx = { package: item.package, ...(strings(item.args) ? { args: strings(item.args) } : {}) };
    }
    if (distributionRaw.uvx && typeof distributionRaw.uvx === "object" && !Array.isArray(distributionRaw.uvx)) {
      const item = distributionRaw.uvx as Record<string, unknown>;
      if (typeof item.package === "string") distribution.uvx = { package: item.package, ...(strings(item.args) ? { args: strings(item.args) } : {}) };
    }
    if (distributionRaw.binary && typeof distributionRaw.binary === "object" && !Array.isArray(distributionRaw.binary)) {
      const binaries: Record<string, BinaryDistribution> = {};
      for (const [target, value] of Object.entries(distributionRaw.binary as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const item = value as Record<string, unknown>;
        if (typeof item.cmd === "string") binaries[target] = { cmd: item.cmd, ...(strings(item.args) ? { args: strings(item.args) } : {}) };
      }
      distribution.binary = binaries;
    }
    parsed.push({
      id: raw.id as string,
      name: raw.name as string,
      version: raw.version as string,
      description: raw.description as string,
      ...(typeof raw.repository === "string" ? { repository: raw.repository } : {}),
      ...(typeof raw.website === "string" ? { website: raw.website } : {}),
      ...(typeof raw.icon === "string" ? { icon: raw.icon } : {}),
      distribution,
    });
  }
  return parsed;
}

function targetPlatform() {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  return `${os}-${arch}`;
}

function companion(id: string) {
  return id === "codex-acp" ? "codex" : id === "claude-acp" ? "claude" : id === "github-copilot-cli" ? "copilot" : undefined;
}

async function registryBytes() {
  const response = await fetch(ACP_REGISTRY_URL, { signal: AbortSignal.timeout(4_000), headers: { accept: "application/json" } });
  if (!response.ok || !response.body) throw new Error(`registry returned HTTP ${response.status}`);
  return boundedResponseBytes(response, MAX_REGISTRY_BYTES, "Agent registry");
}

async function registrySnapshot(): Promise<RegistrySnapshot> {
  const now = Date.now();
  if (cachedRegistry && cachedRegistry.expiresAt > now) return cachedRegistry.snapshot;
  if (pendingRegistry) return pendingRegistry;
  pendingRegistry = (async () => {
    let agents = parseAgentRegistry(FALLBACK_REGISTRY) ?? [];
    let status: AgentDiscovery["registry_status"] = agents.length ? "offline_cache" : "unavailable";
    let ttl = FALLBACK_REGISTRY_TTL_MS;
    try {
      const live = parseAgentRegistry(JSON.parse(new TextDecoder().decode(await registryBytes())));
      if (live?.length) {
        agents = live;
        status = "live";
        ttl = LIVE_REGISTRY_TTL_MS;
      }
    } catch {
      // The small bundled registry keeps the connection UI useful offline.
    }
    const snapshot = { agents, status };
    cachedRegistry = { expiresAt: Date.now() + ttl, snapshot };
    return snapshot;
  })();
  try {
    return await pendingRegistry;
  } finally {
    pendingRegistry = undefined;
  }
}

async function resolveAgent(root: string, agent: RegistryAgent) {
  const distribution = agent.distribution;
  const binary = distribution.binary?.[targetPlatform()];
  let command: string | undefined;
  let availability: "installed" | "ready" | "unavailable" = "unavailable";
  let availabilityDetail = `Install ${agent.name} to connect`;
  if (binary) {
    const executable = basename(binary.cmd).replace(/\.exe$/i, "");
    const args = binary.args ?? [];
    if (!safeToken(executable) || args.some((argument) => !safeToken(argument))) return undefined;
    const installed = await executablePath(root, executable);
    if (installed) {
      command = [executable, ...args].join(" ");
      availability = "installed";
      availabilityDetail = `${executable} detected on this computer`;
    }
  } else {
    const runner = distribution.npx ? "npx" : distribution.uvx ? "uvx" : undefined;
    const packageInfo = distribution.npx ?? distribution.uvx;
    if (!runner || !packageInfo || !safeToken(packageInfo.package) || (packageInfo.args ?? []).some((argument) => !safeToken(argument))) return undefined;
    const installedRunner = await executablePath(root, runner);
    if (installedRunner) {
      command = [runner, ...(runner === "npx" ? ["-y"] : []), packageInfo.package, ...(packageInfo.args ?? [])].join(" ");
      const installedCompanion = companion(agent.id) ? await executablePath(root, companion(agent.id)!) : undefined;
      availability = installedCompanion ? "installed" : "ready";
      availabilityDetail = installedCompanion
        ? `${companion(agent.id)} detected on this computer`
        : "Verified ACP Registry package · downloads on first launch";
    } else availabilityDetail = `${runner} is not available`;
  }
  return {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    description: agent.description,
    ...(command ? { command } : {}),
    availability,
    availability_detail: availabilityDetail,
    ...(agent.repository ? { repository: agent.repository } : {}),
    ...(agent.website ? { website: agent.website } : {}),
    ...(agent.icon ? { icon: agent.icon } : {}),
  };
}

export async function discoverAgents(root: string): Promise<AgentDiscovery> {
  const registry = await registrySnapshot();
  const resolved = (await Promise.all(registry.agents.map((agent) => resolveAgent(root, agent)))).filter((agent) => agent !== undefined);
  const availabilityRank = { installed: 0, ready: 1, unavailable: 2 } as const;
  const preferredRank = (id: string) => id === "codex-acp" ? 0 : id === "opencode" ? 1 : id === "claude-acp" ? 2 : id === "github-copilot-cli" ? 3 : 4;
  resolved.sort((left, right) => availabilityRank[left.availability] - availabilityRank[right.availability]
    || preferredRank(left.id) - preferredRank(right.id)
    || left.name.localeCompare(right.name));
  return { registry_url: ACP_REGISTRY_URL, registry_status: registry.status, agents: resolved };
}
