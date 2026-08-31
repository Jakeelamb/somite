import { readFile } from "node:fs/promises";

type LockedPackage = Readonly<{
  version?: unknown;
  resolved?: unknown;
  integrity?: unknown;
  optional?: unknown;
  os?: readonly string[];
  cpu?: readonly string[];
}>;

type PackageLock = Readonly<{ packages?: Readonly<Record<string, LockedPackage>> }>;

const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8")) as PackageLock;
const packages = lock.packages ?? {};

const targets = [
  {
    label: "macOS arm64", os: "darwin", cpu: "arm64",
    packages: [
      "@cloudflare/workerd-darwin-arm64", "@esbuild/darwin-arm64", "@img/sharp-darwin-arm64",
      "@img/sharp-libvips-darwin-arm64", "@napi-rs/canvas-darwin-arm64",
      "@rolldown/binding-darwin-arm64", "lightningcss-darwin-arm64",
    ],
  },
  {
    label: "macOS x64", os: "darwin", cpu: "x64",
    packages: [
      "@cloudflare/workerd-darwin-64", "@esbuild/darwin-x64", "@img/sharp-darwin-x64",
      "@img/sharp-libvips-darwin-x64", "@napi-rs/canvas-darwin-x64",
      "@rolldown/binding-darwin-x64", "lightningcss-darwin-x64",
    ],
  },
  {
    label: "Linux arm64", os: "linux", cpu: "arm64",
    packages: [
      "@cloudflare/workerd-linux-arm64", "@esbuild/linux-arm64", "@img/sharp-linux-arm64",
      "@img/sharp-libvips-linux-arm64", "@napi-rs/canvas-linux-arm64-gnu",
      "@rolldown/binding-linux-arm64-gnu", "lightningcss-linux-arm64-gnu",
    ],
  },
  {
    label: "Linux x64", os: "linux", cpu: "x64",
    packages: [
      "@cloudflare/workerd-linux-64", "@esbuild/linux-x64", "@img/sharp-linux-x64",
      "@img/sharp-libvips-linux-x64", "@napi-rs/canvas-linux-x64-gnu",
      "@rolldown/binding-linux-x64-gnu", "lightningcss-linux-x64-gnu",
    ],
  },
] as const;

function entriesFor(packageName: string) {
  const suffix = `/node_modules/${packageName}`;
  return Object.entries(packages).filter(([path]) => path === `node_modules/${packageName}` || path.endsWith(suffix));
}

for (const target of targets) {
  for (const packageName of target.packages) {
    const matches = entriesFor(packageName);
    if (matches.length === 0) throw new Error(`${target.label} native package is absent from package-lock.json: ${packageName}`);
    if (!matches.some(([, value]) => value.optional === true
      && typeof value.version === "string"
      && typeof value.resolved === "string"
      && value.resolved.startsWith("https://registry.npmjs.org/")
      && typeof value.integrity === "string"
      && value.integrity.startsWith("sha512-")
      && value.os?.includes(target.os)
      && value.cpu?.includes(target.cpu))) {
      throw new Error(`${target.label} native package has an invalid lock contract: ${packageName}`);
    }
  }
}

process.stdout.write(`Native package lock covers ${targets.length} supported platform targets\n`);
