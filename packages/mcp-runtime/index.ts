import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_500;
const TERMINATION_SETTLEMENT_MS = 1_500;
const SAFE_ENVIRONMENT = [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS", "NIX_SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "SHELL",
  "USER", "LOGNAME", "USERNAME", "SYSTEMROOT", "SystemRoot", "WINDIR", "windir",
  "COMSPEC", "ComSpec", "OS", "PROCESSOR_ARCHITECTURE", "WSL_DISTRO_NAME",
] as const;

export type CommandResult = {
  command: string[];
  cwd: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  duration_ms: number;
  ok: boolean;
};

export type CommandOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
};

export type RuntimeCompatibility = {
  result: CommandResult;
  observed_version?: string;
  supported_version: string;
  compatible: boolean;
};

function boundedAppend(current: Buffer, chunk: Buffer, maximum: number) {
  if (current.byteLength >= maximum) return { bytes: current, truncated: true };
  const remaining = maximum - current.byteLength;
  if (chunk.byteLength <= remaining) return { bytes: Buffer.concat([current, chunk]), truncated: false };
  return { bytes: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}

export function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env, additions: NodeJS.ProcessEnv = {}) {
  const result: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(additions)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export async function runCommand(binary: string, args: readonly string[], cwd: string, options: CommandOptions = {}): Promise<CommandResult> {
  const maximum = options.maximumOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const started = performance.now();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(binary, [...args], {
      cwd,
      env: safeChildEnvironment(process.env, options.environment),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let terminationSignal: NodeJS.Signals | null = null;
    let hardKillTimer: NodeJS.Timeout | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", terminate);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      resolvePromise({
        command: [basename(binary), ...args],
        cwd,
        exit_code: exitCode,
        signal: exitSignal ?? terminationSignal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        duration_ms: Math.round(performance.now() - started),
        ok: exitCode === 0 && !signal.aborted,
      });
    };
    const signalTree = (treeSignal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(treeSignal);
        else process.kill(-child.pid, treeSignal);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
    };
    const terminate = () => {
      if (settled || terminationSignal) return;
      terminationSignal = "SIGTERM";
      try { signalTree("SIGTERM"); } catch { child.kill("SIGTERM"); }
      hardKillTimer = setTimeout(() => {
        if (settled) return;
        terminationSignal = "SIGKILL";
        if (process.platform === "win32" && child.pid !== undefined) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.unref();
        } else {
          try { signalTree("SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
        settlementTimer = setTimeout(() => finish(null, "SIGKILL"), TERMINATION_SETTLEMENT_MS);
        settlementTimer.unref();
      }, TERMINATION_GRACE_MS);
      hardKillTimer.unref();
    };
    child.stdout.on("data", (value: Buffer) => {
      const next = boundedAppend(stdout, value, maximum);
      stdout = next.bytes;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on("data", (value: Buffer) => {
      const next = boundedAppend(stderr, value, maximum);
      stderr = next.bytes;
      stderrTruncated ||= next.truncated;
    });
    child.once("error", (cause) => {
      if (settled) return;
      signal.removeEventListener("abort", terminate);
      rejectPromise(cause);
    });
    child.once("close", finish);
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
  });
}

/** Run one exact CLI contract and fail closed when the installed binary drifts. */
export class VersionedCommandRunner {
  readonly #binary: string;
  readonly #cwd: string;
  readonly #supportedVersion: string;
  readonly #versionArgs: readonly string[];
  readonly #environment: NodeJS.ProcessEnv;
  #compatibility?: Promise<RuntimeCompatibility>;

  constructor(options: {
    binary: string;
    cwd: string;
    supportedVersion: string;
    versionArgs: readonly string[];
    environment?: NodeJS.ProcessEnv;
  }) {
    this.#binary = options.binary;
    this.#cwd = options.cwd;
    this.#supportedVersion = options.supportedVersion;
    this.#versionArgs = options.versionArgs;
    this.#environment = options.environment ?? {};
  }

  compatibility() {
    if (!this.#compatibility) {
      this.#compatibility = runCommand(this.#binary, this.#versionArgs, this.#cwd, {
        timeoutMs: 30_000,
        maximumOutputBytes: 64 * 1024,
        environment: this.#environment,
      }).then((result) => {
        const observedVersion = `${result.stdout}\n${result.stderr}`.match(/(?:^|[^0-9])(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9_.-]+)?)(?![0-9])/m)?.[1];
        return {
          result,
          ...(observedVersion ? { observed_version: observedVersion } : {}),
          supported_version: this.#supportedVersion,
          compatible: result.ok && observedVersion === this.#supportedVersion,
        };
      }).catch((cause) => {
        this.#compatibility = undefined;
        throw cause;
      });
    }
    return this.#compatibility;
  }

  async run(args: readonly string[], options: CommandOptions = {}) {
    const compatibility = await this.compatibility();
    if (!compatibility.compatible) {
      const observed = compatibility.observed_version ?? "an unreadable version";
      return {
        command: [basename(this.#binary), ...args],
        cwd: this.#cwd,
        exit_code: null,
        signal: null,
        stdout: "",
        stderr: `Unsupported ${basename(this.#binary)} runtime ${observed}; this MCP server is proven against ${this.#supportedVersion}.`,
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 0,
        ok: false,
      } satisfies CommandResult;
    }
    return runCommand(this.#binary, args, this.#cwd, {
      ...options,
      environment: { ...this.#environment, ...options.environment },
    });
  }
}

export class WorkspaceBoundary {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string) {
    const canonical = await realpath(resolve(root));
    if (!(await stat(canonical)).isDirectory()) throw new Error("workspace root must be a directory");
    return new WorkspaceBoundary(canonical);
  }

  path(value = ".") {
    if (value.includes("\0")) throw new Error("path contains a null byte");
    const candidate = resolve(this.root, value);
    const traversal = relative(this.root, candidate);
    if (traversal === ".." || traversal.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(traversal)) {
      throw new Error("path leaves the configured workspace root");
    }
    let cursor = this.root;
    for (const segment of traversal.split(sep).filter(Boolean)) {
      cursor = resolve(cursor, segment);
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new Error("path contains a symbolic link");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") break;
        throw cause;
      }
    }
    return candidate;
  }
}

export function parseServerOptions(argv = process.argv.slice(2)) {
  let workspaceRoot = process.cwd();
  let binary: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--workspace-root" && argv[index + 1]) workspaceRoot = argv[++index]!;
    else if (argv[index] === "--binary" && argv[index + 1]) binary = argv[++index]!;
    else throw new Error(`unknown MCP server option: ${argv[index]}`);
  }
  return { workspaceRoot, binary };
}

export function commandText(result: CommandResult) {
  const output = result.stdout.trim() || result.stderr.trim() || `Command exited ${result.exit_code ?? result.signal ?? "without a status"}.`;
  return `${result.ok ? "Succeeded" : "Failed"}: ${result.command.join(" ")}\n${output}`;
}

export function toolResult(result: CommandResult, extra: Record<string, unknown> = {}) {
  let parsed: { value: unknown } | undefined;
  if (result.ok && !result.stdout_truncated && result.stdout.trim()) {
    try { parsed = { value: JSON.parse(result.stdout) as unknown }; } catch { /* Preserve non-JSON command evidence verbatim. */ }
  }
  const structuredResult = parsed
    ? { ...result, stdout: "", data: parsed.value, ...extra }
    : { ...result, ...extra };
  return {
    content: [{
      type: "text" as const,
      text: parsed ? `${result.ok ? "Succeeded" : "Failed"}: ${result.command.join(" ")}\nReturned structured JSON.` : commandText(result),
    }],
    structuredContent: structuredResult,
    isError: !result.ok,
  };
}

export function jsonToolResult(value: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent: value,
  };
}
