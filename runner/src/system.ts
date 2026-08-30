import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { platform } from "node:os";

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
