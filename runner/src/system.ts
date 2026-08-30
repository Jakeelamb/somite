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

export function pixiPlatform() {
  const machine = process.arch;
  if (platform() === "darwin") return machine === "arm64" ? "osx-arm64" : "osx-64";
  if (platform() === "win32") return "win-64";
  return machine === "arm64" ? "linux-aarch64" : "linux-64";
}
