import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  arch,
  availableParallelism,
  cpus,
  platform,
  release,
  totalmem,
  type as osType,
  type CpuInfo,
} from "node:os";

export const HARDWARE_COMMAND_OPTIONS = {
  timeout: 2_000,
  maxBuffer: 512 * 1024,
  shell: false as const,
  windowsHide: true,
  killSignal: "SIGKILL" as const,
  encoding: "utf8" as const,
} as const;

export type HardwareCommandExecutor = (
  file: string,
  args: readonly string[],
  options: typeof HARDWARE_COMMAND_OPTIONS,
) => Promise<string>;

export type HardwareProfileProbe = {
  platform: NodeJS.Platform;
  arch: string;
  cpuList: readonly CpuInfo[];
  availableParallelism: number;
  totalMemoryBytes: number;
  osType: string;
  osRelease: string;
  readTextFile: (path: string) => Promise<string>;
  execute: HardwareCommandExecutor;
};

export type HardwareProfile = {
  cpu: string;
  physical_cores: number | null;
  logical_threads: number;
  available_parallelism: number;
  memory_bytes: number;
  gpus: string[];
  os: string;
};

export type LinuxCpuTopology = {
  cpu: string | null;
  physicalCores: number | null;
  logicalThreads: number | null;
};

type CpuInfoBlock = Map<string, string>;

function normalizedLabel(value: string | null | undefined) {
  const label = value?.trim().replace(/\s+/g, " ");
  return label || null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parsedPositiveInteger(value: string | undefined) {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  return positiveInteger(Number(value.trim()));
}

function cpuInfoBlocks(value: string) {
  return value
    .split(/\n\s*\n/g)
    .map((block) => {
      const fields: CpuInfoBlock = new Map();
      for (const line of block.split("\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
      }
      return fields;
    })
    .filter((fields) => fields.has("processor"));
}

export function parseLinuxCpuInfo(value: string): LinuxCpuTopology {
  const blocks = cpuInfoBlocks(value);
  const cpu = blocks.map((fields) => normalizedLabel(
    fields.get("model name")
      ?? fields.get("Model Name")
      ?? fields.get("Hardware")
      ?? fields.get("Processor"),
  )).find((candidate) => candidate !== null) ?? null;
  const topology = blocks.map((fields) => ({
    packageId: normalizedLabel(fields.get("physical id")),
    coreId: normalizedLabel(fields.get("core id")),
  }));
  const physicalCores = topology.length > 0 && topology.every(({ packageId, coreId }) => packageId !== null && coreId !== null)
    ? new Set(topology.map(({ packageId, coreId }) => `${packageId}:${coreId}`)).size
    : null;
  return {
    cpu,
    physicalCores,
    logicalThreads: blocks.length || null,
  };
}

function nodeCommand(file: string, args: readonly string[], options: typeof HARDWARE_COMMAND_OPTIONS) {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(file, [...args], options, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    });
  });
}

function defaultProbe(): HardwareProfileProbe {
  return {
    platform: platform(),
    arch: arch(),
    cpuList: cpus(),
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
    osType: osType(),
    osRelease: release(),
    readTextFile: (path) => readFile(path, "utf8"),
    execute: nodeCommand,
  };
}

async function optionalText(action: () => Promise<string>) {
  try {
    return await action();
  } catch {
    return null;
  }
}

function linuxDisplayName(value: string | null) {
  if (!value) return null;
  const fields = new Map<string, string>();
  for (const line of value.split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let field = match[2]?.trim() ?? "";
    if ((field.startsWith('"') && field.endsWith('"')) || (field.startsWith("'") && field.endsWith("'"))) {
      field = field.slice(1, -1);
    }
    fields.set(match[1]!, field.replace(/\\(["\\$`])/g, "$1"));
  }
  return normalizedLabel(fields.get("PRETTY_NAME"))
    ?? normalizedLabel([fields.get("NAME"), fields.get("VERSION")].filter(Boolean).join(" "));
}

function uniqueGpuNames(values: readonly (string | null | undefined)[]) {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = normalizedLabel(value)?.slice(0, 200);
    if (!name) continue;
    const key = name.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length === 16) break;
  }
  return names;
}

function linuxPciGpuNames(value: string | null) {
  if (!value) return [];
  const names: string[] = [];
  for (const line of value.split("\n")) {
    if (!/(?:VGA compatible|3D|Display) controller/i.test(line)) continue;
    const quoted = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
    if (quoted.length >= 3) {
      names.push(`${quoted[1]} ${quoted[2]}`);
      continue;
    }
    const match = line.match(/(?:VGA compatible|3D|Display) controller:\s*(.+?)(?:\s+\(rev\s+[^)]+\))?$/i);
    if (match?.[1]) names.push(match[1]);
  }
  return uniqueGpuNames(names);
}

function nvidiaGpuNames(value: string | null) {
  return uniqueGpuNames(value?.split("\n") ?? []);
}

function mergedLinuxGpuNames(pciOutput: string | null, nvidiaOutput: string | null) {
  const pciNames = linuxPciGpuNames(pciOutput);
  const nvidiaNames = nvidiaGpuNames(nvidiaOutput);
  return uniqueGpuNames([
    ...pciNames.filter((name) => nvidiaNames.length === 0 || !/nvidia/i.test(name)),
    ...nvidiaNames,
  ]);
}

function macGpuNames(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { SPDisplaysDataType?: Array<Record<string, unknown>> };
    return uniqueGpuNames((parsed.SPDisplaysDataType ?? []).map((display) => {
      for (const field of ["sppci_model", "spdisplays_chipset_model", "_name"]) {
        if (typeof display[field] === "string") return display[field];
      }
      return null;
    }));
  } catch {
    return uniqueGpuNames([...value.matchAll(/^\s*Chipset Model:\s*(.+)$/gim)].map((match) => match[1]));
  }
}

function macDisplayName(value: string | null) {
  if (!value) return null;
  const fields = new Map<string, string>();
  for (const line of value.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return normalizedLabel([fields.get("ProductName"), fields.get("ProductVersion")].filter(Boolean).join(" "));
}

function fallbackCpu(probe: HardwareProfileProbe) {
  return normalizedLabel(probe.cpuList[0]?.model) ?? "Unknown CPU";
}

function fallbackLogicalThreads(probe: HardwareProfileProbe, parallelism: number) {
  return positiveInteger(probe.cpuList.length) ?? parallelism;
}

function fallbackOs(probe: HardwareProfileProbe) {
  const name = normalizedLabel(`${probe.osType} ${probe.osRelease}`) ?? probe.platform;
  return `${name} (${probe.arch})`;
}

export async function detectHardwareProfile(overrides: Partial<HardwareProfileProbe> = {}): Promise<HardwareProfile> {
  const probe = { ...defaultProbe(), ...overrides };
  const parallelism = positiveInteger(probe.availableParallelism) ?? 1;
  const memoryBytes = typeof probe.totalMemoryBytes === "number" && Number.isFinite(probe.totalMemoryBytes) && probe.totalMemoryBytes >= 0
    ? Math.floor(probe.totalMemoryBytes)
    : 0;

  if (probe.platform === "linux") {
    const [cpuInfo, osRelease, pciOutput, nvidiaOutput] = await Promise.all([
      optionalText(() => probe.readTextFile("/proc/cpuinfo")),
      optionalText(() => probe.readTextFile("/etc/os-release")),
      optionalText(() => probe.execute("lspci", ["-mm"], HARDWARE_COMMAND_OPTIONS)),
      optionalText(() => probe.execute("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], HARDWARE_COMMAND_OPTIONS)),
    ]);
    const topology = parseLinuxCpuInfo(cpuInfo ?? "");
    return {
      cpu: topology.cpu ?? fallbackCpu(probe),
      physical_cores: topology.physicalCores,
      logical_threads: topology.logicalThreads ?? fallbackLogicalThreads(probe, parallelism),
      available_parallelism: parallelism,
      memory_bytes: memoryBytes,
      gpus: mergedLinuxGpuNames(pciOutput, nvidiaOutput),
      os: `${linuxDisplayName(osRelease) ?? normalizedLabel(`${probe.osType} ${probe.osRelease}`) ?? "Linux"} (${probe.arch})`,
    };
  }

  if (probe.platform === "darwin") {
    const [physicalOutput, logicalOutput, gpuOutput, versionOutput] = await Promise.all([
      optionalText(() => probe.execute("/usr/sbin/sysctl", ["-n", "hw.physicalcpu"], HARDWARE_COMMAND_OPTIONS)),
      optionalText(() => probe.execute("/usr/sbin/sysctl", ["-n", "hw.logicalcpu"], HARDWARE_COMMAND_OPTIONS)),
      optionalText(() => probe.execute("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], HARDWARE_COMMAND_OPTIONS)),
      optionalText(() => probe.execute("/usr/bin/sw_vers", [], HARDWARE_COMMAND_OPTIONS)),
    ]);
    return {
      cpu: fallbackCpu(probe),
      physical_cores: parsedPositiveInteger(physicalOutput ?? undefined),
      logical_threads: parsedPositiveInteger(logicalOutput ?? undefined) ?? fallbackLogicalThreads(probe, parallelism),
      available_parallelism: parallelism,
      memory_bytes: memoryBytes,
      gpus: macGpuNames(gpuOutput),
      os: `${macDisplayName(versionOutput) ?? normalizedLabel(`${probe.osType} ${probe.osRelease}`) ?? "macOS"} (${probe.arch})`,
    };
  }

  return {
    cpu: fallbackCpu(probe),
    physical_cores: null,
    logical_threads: fallbackLogicalThreads(probe, parallelism),
    available_parallelism: parallelism,
    memory_bytes: memoryBytes,
    gpus: [],
    os: fallbackOs(probe),
  };
}
