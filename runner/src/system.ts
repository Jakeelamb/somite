import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { platform } from "node:os";

type AccessCheck = (path: string, mode: number) => Promise<void>;

export function environmentBinaryDirectories(projectRoot: string, operatingSystem: NodeJS.Platform = platform()) {
  const environment = join(projectRoot, ".pixi", "envs", "default");
  return operatingSystem === "win32"
    ? [environment, join(environment, "Scripts"), join(environment, "Library", "bin")]
    : [join(environment, "bin")];
}

export async function executablePath(projectRoot: string, binary: string) {
  const suffixes = platform() === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const directories = [
    ...environmentBinaryDirectories(projectRoot),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
  ];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${binary}${suffix}`);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep searching the declared execution path.
      }
    }
  }
  return undefined;
}

/**
 * Nextflow 26.04.6's local executor starts its outer `.command.run` wrapper
 * with an absolute /bin/bash path before any Pixi task environment is active.
 * Fail before a scientific run instead of surfacing a late executor error.
 */
export async function requireNextflowHostBash(check: AccessCheck = access) {
  try {
    await check("/bin/bash", fsConstants.X_OK);
  } catch {
    throw new Error(
      "Nextflow 26.04.6 local execution requires an executable /bin/bash on the host; install Bash at /bin/bash or run Somite inside a compatible Linux or macOS environment.",
    );
  }
  return "/bin/bash" as const;
}

export function pixiPlatform(
  operatingSystem: NodeJS.Platform = platform(),
  machine: string = process.arch,
) {
  if (operatingSystem === "win32") {
    throw new Error("Native Windows workflow execution is unsupported; run Somite inside WSL2.");
  }
  if (operatingSystem === "darwin" && machine === "arm64") return "osx-arm64";
  if (operatingSystem === "darwin" && machine === "x64") return "osx-64";
  if (operatingSystem === "linux" && machine === "arm64") return "linux-aarch64";
  if (operatingSystem === "linux" && machine === "x64") return "linux-64";
  throw new Error(`Workflow execution is unsupported on ${operatingSystem}/${machine}; Somite supports Linux and macOS on x64 or arm64.`);
}
