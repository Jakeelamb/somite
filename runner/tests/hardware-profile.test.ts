import assert from "node:assert/strict";
import type { CpuInfo } from "node:os";
import test from "node:test";

import {
  HARDWARE_COMMAND_OPTIONS,
  detectHardwareProfile,
  parseLinuxCpuInfo,
  type HardwareCommandExecutor,
  type HardwareProfileProbe,
} from "../src/hardwareProfile.ts";

const linuxCpuInfo = `processor : 0
physical id : 0
core id : 0
model name : AMD Ryzen Test CPU

processor : 1
physical id : 0
core id : 1
model name : AMD Ryzen Test CPU

processor : 2
physical id : 0
core id : 0
model name : AMD Ryzen Test CPU

processor : 3
physical id : 0
core id : 1
model name : AMD Ryzen Test CPU
`;

function cpu(model: string): CpuInfo {
  return { model, speed: 1, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } };
}

function probe(overrides: Partial<HardwareProfileProbe> = {}): HardwareProfileProbe {
  return {
    platform: "linux",
    arch: "x64",
    cpuList: [cpu("Fallback CPU")],
    availableParallelism: 1,
    totalMemoryBytes: 16_000,
    osType: "Linux",
    osRelease: "6.12.0",
    readTextFile: async () => { throw new Error("missing"); },
    execute: async () => { throw new Error("missing"); },
    ...overrides,
  };
}

test("Linux /proc topology distinguishes physical cores, logical threads, and scheduler parallelism", async () => {
  const parsed = parseLinuxCpuInfo(linuxCpuInfo);
  assert.deepEqual(parsed, { cpu: "AMD Ryzen Test CPU", physicalCores: 2, logicalThreads: 4 });

  const calls: Array<{ file: string; args: readonly string[]; options: typeof HARDWARE_COMMAND_OPTIONS }> = [];
  const execute: HardwareCommandExecutor = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === "lspci") {
      return `00:02.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Radeon 890M"
01:00.0 "3D controller" "NVIDIA Corporation" "GB206M [GeForce RTX 5070 Laptop GPU]"
`;
    }
    if (file === "nvidia-smi") return "NVIDIA GeForce RTX 5070 Laptop GPU\n";
    throw new Error(`unexpected command ${file}`);
  };
  const profile = await detectHardwareProfile(probe({
    cpuList: Array.from({ length: 8 }, () => cpu("Fallback CPU")),
    readTextFile: async (path) => path === "/proc/cpuinfo"
      ? linuxCpuInfo
      : `NAME=Fedora Linux\nPRETTY_NAME="Fedora Linux 42"\n`,
    execute,
  }));

  assert.equal(profile.cpu, "AMD Ryzen Test CPU");
  assert.equal(profile.physical_cores, 2);
  assert.equal(profile.logical_threads, 4);
  assert.equal(profile.available_parallelism, 1);
  assert.equal(profile.os, "Fedora Linux 42 (x64)");
  assert.deepEqual(profile.gpus, [
    "Advanced Micro Devices, Inc. [AMD/ATI] Radeon 890M",
    "NVIDIA GeForce RTX 5070 Laptop GPU",
  ]);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.options === HARDWARE_COMMAND_OPTIONS));
});

test("macOS uses bounded no-shell system commands for physical and logical topology", async () => {
  const calls: Array<{ file: string; args: readonly string[]; options: typeof HARDWARE_COMMAND_OPTIONS }> = [];
  const profile = await detectHardwareProfile(probe({
    platform: "darwin",
    arch: "arm64",
    cpuList: Array.from({ length: 12 }, () => cpu("Apple M3 Max")),
    availableParallelism: 6,
    osType: "Darwin",
    osRelease: "24.5.0",
    execute: async (file, args, options) => {
      calls.push({ file, args, options });
      if (file.endsWith("sysctl") && args.at(-1) === "hw.physicalcpu") return "8\n";
      if (file.endsWith("sysctl") && args.at(-1) === "hw.logicalcpu") return "12\n";
      if (file.endsWith("system_profiler")) return JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "Apple M3 Max" }] });
      if (file.endsWith("sw_vers")) return "ProductName:\t\tmacOS\nProductVersion:\t\t15.5\nBuildVersion:\t\t24F74\n";
      throw new Error(`unexpected command ${file}`);
    },
  }));

  assert.equal(profile.physical_cores, 8);
  assert.equal(profile.logical_threads, 12);
  assert.equal(profile.available_parallelism, 6);
  assert.deepEqual(profile.gpus, ["Apple M3 Max"]);
  assert.equal(profile.os, "macOS 15.5 (arm64)");
  assert.ok(calls.every(({ options }) => options.timeout <= 2_000 && options.maxBuffer <= 512 * 1024 && options.shell === false));
});

test("missing platform facilities degrade without relabeling logical CPUs as physical cores", async () => {
  const profile = await detectHardwareProfile(probe({
    platform: "freebsd",
    arch: "x64",
    cpuList: [cpu("First CPU"), cpu("First CPU")],
    osType: "FreeBSD",
    osRelease: "14.2",
  }));

  assert.equal(profile.cpu, "First CPU");
  assert.equal(profile.physical_cores, null);
  assert.equal(profile.logical_threads, 2);
  assert.equal(profile.available_parallelism, 1);
  assert.deepEqual(profile.gpus, []);
  assert.equal(profile.os, "FreeBSD 14.2 (x64)");
});

test("missing Linux files and GPU commands fall back without failing the profile", async () => {
  const profile = await detectHardwareProfile(probe({
    cpuList: [cpu("Fallback Linux CPU"), cpu("Fallback Linux CPU")],
  }));

  assert.equal(profile.cpu, "Fallback Linux CPU");
  assert.equal(profile.physical_cores, null);
  assert.equal(profile.logical_threads, 2);
  assert.deepEqual(profile.gpus, []);
  assert.equal(profile.os, "Linux 6.12.0 (x64)");
});

test("incomplete Linux topology stays unknown instead of guessing physical cores", () => {
  assert.deepEqual(parseLinuxCpuInfo("processor: 0\nmodel name: ARM Test\n\nprocessor: 1\nmodel name: ARM Test\n"), {
    cpu: "ARM Test",
    physicalCores: null,
    logicalThreads: 2,
  });
});
