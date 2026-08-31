import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OfficialDocumentation, type DocumentationProvider } from "@somite/mcp-runtime/docs";
import { VersionedCommandRunner, WorkspaceBoundary, jsonToolResult, parseServerOptions, toolResult } from "@somite/mcp-runtime";
import { z } from "zod/v4";

import {
  compactSearchResult,
  dependencyCommand,
  environmentCommand,
  globalCommand,
  inspectCommand,
  lockCommand,
  searchCommand,
  taskCommand,
  workspaceCommand,
} from "./commands.ts";

export const SUPPORTED_PIXI_VERSION = "0.77.1";
export const PIXI_DOCUMENTATION_SOURCE = {
  name: "Pixi",
  repository: "prefix-dev/pixi",
  branch: `v${SUPPORTED_PIXI_VERSION}`,
  directory: "docs",
  website: "https://pixi.prefix.dev/latest/",
} as const;

const commandOutput = z.object({
  command: z.array(z.string()), cwd: z.string(), exit_code: z.number().int().nullable(), signal: z.string().nullable(),
  stdout: z.string(), stderr: z.string(), stdout_truncated: z.boolean(), stderr_truncated: z.boolean(),
  duration_ms: z.number().int().nonnegative(), ok: z.boolean(),
}).loose();
const packageRecord = z.object({
  name: z.string(), version: z.string(), build: z.string(), build_number: z.number().int(), subdir: z.string(), channel: z.string(), url: z.string(),
  license: z.string().optional(), size: z.number().nonnegative().optional(), timestamp: z.number().nonnegative().optional(), depends: z.array(z.string()),
});
const packageSearchOutput = commandOutput.extend({ query: z.string(), total_records: z.number().int().nonnegative(), matches: z.array(packageRecord) });
const docsSearchOutput = z.object({ query: z.string(), source_revision: z.string(), matches: z.array(z.object({ path: z.string(), url: z.string(), snippet: z.string() })) });
const docsReadOutput = z.object({ path: z.string(), url: z.string(), source_revision: z.string(), source_url: z.string(), text: z.string() });
const relativePath = z.string().min(1).max(1_024).describe("Path relative to the configured workspace root; it may not escape that root.");
const identifier = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const manifestPath = relativePath.optional().describe("Workspace directory or pixi.toml/pyproject.toml path, relative to the configured root.");

const defaultDocs = new OfficialDocumentation(PIXI_DOCUMENTATION_SOURCE);

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const localWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const execution = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export function createPixiServer(boundary: WorkspaceBoundary, binary = "pixi", docs: DocumentationProvider = defaultDocs) {
  const server = new McpServer({ name: "somite-pixi", title: "Pixi", version: "0.1.0" });
  const runner = new VersionedCommandRunner({
    binary,
    cwd: boundary.root,
    supportedVersion: SUPPORTED_PIXI_VERSION,
    versionArgs: ["--version"],
    environment: { PIXI_NO_PROGRESS: "true", PIXI_COLOR: "never" },
  });
  const execute = (args: string[], signal: AbortSignal) => runner.run(args, { signal });

  server.registerResource("pixi-documentation-catalog", "pixi://docs/catalog", {
    title: `Official Pixi ${SUPPORTED_PIXI_VERSION} documentation catalog`,
    description: `Every Markdown page in the official prefix-dev/pixi v${SUPPORTED_PIXI_VERSION} documentation tree, matched to the supported CLI contract.`,
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
    repository: docs.source.repository,
    revision: docs.source.branch,
    directory: docs.source.directory,
    pages: await docs.catalog(),
  }, null, 2) }] }));

  server.registerResource("pixi-safety-policy", "pixi://policy/execution", {
    title: "Pixi MCP execution policy",
    description: "Explains why arbitrary shell, token disclosure, insecure TLS, and post-link execution are not exposed.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Pixi MCP policy\n\nTools are workspace-contained and invoke Pixi with argument arrays. Arbitrary `pixi exec` and interactive `pixi shell` are intentionally excluded; use a declared task through `pixi_task`. Authentication tokens are never returned. Insecure TLS and post-link-script flags are never enabled. Mutating, install, run, publish, upload, and self-update operations remain approval boundaries." }] }));

  server.registerTool("pixi_docs_search", {
    title: "Search complete Pixi documentation",
    description: "Search every official Pixi documentation page path, including CLI, workspaces, global tools, builds, deployment, configuration, security, and integrations. Then call pixi_docs_read.",
    inputSchema: z.object({ query: z.string().min(1).max(120), limit: z.number().int().min(1).max(50).default(20) }),
    outputSchema: docsSearchOutput,
    annotations: { ...readOnly, openWorldHint: true },
  }, async ({ query, limit }, context) => {
    const matches = await docs.search(query, limit, context.mcpReq.signal);
    return jsonToolResult({ query, source_revision: docs.source.branch, matches }, matches.length ? `Found ${matches.length} official Pixi documentation pages.` : "No documentation paths matched.");
  });

  server.registerTool("pixi_docs_read", {
    title: "Read official Pixi documentation",
    description: "Read one exact Markdown page from the complete official Pixi documentation catalog.",
    inputSchema: z.object({ path: relativePath.describe("Exact .md path returned by pixi_docs_search or pixi://docs/catalog.") }),
    outputSchema: docsReadOutput,
    annotations: { ...readOnly, openWorldHint: true },
  }, async ({ path }, context) => {
    const page = await docs.read(path, context.mcpReq.signal);
    return jsonToolResult(page, `Read official Pixi documentation: ${path}`);
  });

  server.registerTool("pixi_runtime_info", {
    title: "Inspect Pixi runtime compatibility",
    description: `Return the installed Pixi version and whether it matches the proven ${SUPPORTED_PIXI_VERSION} command contract without opening a workspace.`,
    inputSchema: z.object({}),
    outputSchema: commandOutput,
    annotations: readOnly,
  }, async () => {
    const compatibility = await runner.compatibility();
    return toolResult(compatibility.result, {
      supported_version: compatibility.supported_version,
      observed_version: compatibility.observed_version ?? null,
      compatible: compatibility.compatible,
    });
  });

  server.registerTool("pixi_inspect", {
    title: "Inspect Pixi state",
    description: "Inspect a Pixi workspace, packages, tasks, dependency tree, activation, configuration, or user-global installations with machine-readable output where Pixi provides it.",
    inputSchema: z.object({
      view: z.enum(["workspace", "packages", "tasks", "dependency_tree", "activation", "config", "global"]),
      manifest_path: manifestPath, environment: identifier.optional(), platform: identifier.optional(),
      package_filter: z.string().max(120).optional(), invert: z.boolean().optional(),
    }),
    outputSchema: commandOutput,
    annotations: readOnly,
  }, async (input, context) => toolResult(await execute(inspectCommand(boundary, input), context.mcpReq.signal)));

  server.registerTool("pixi_package_search", {
    title: "Search Conda packages with Pixi",
    description: "Search current Conda package records using an exact MatchSpec and optional channels/platform. Somite parses Pixi's complete JSON response and returns only the requested number of typed records.",
    inputSchema: z.object({ spec: z.string().min(1).max(240), channels: z.array(z.string().min(1).max(240)).max(16).optional(), platform: identifier.optional(), limit: z.number().int().min(1).max(100).default(25) }),
    outputSchema: packageSearchOutput,
    annotations: { ...readOnly, openWorldHint: true },
  }, async (input, context) => {
    const result = await runner.run(searchCommand(input), { signal: context.mcpReq.signal, maximumOutputBytes: 8 * 1024 * 1024 });
    if (!result.ok) return toolResult({ ...result, stdout: "" }, { query: input.spec, total_records: 0, matches: [] });
    if (result.stdout_truncated) return toolResult({ ...result, stdout: "", stderr: "Pixi package search exceeded the bounded 8 MiB response; narrow the MatchSpec, channels, or platform.", ok: false }, { query: input.spec, total_records: 0, matches: [] });
    try {
      const compact = compactSearchResult(result.stdout, input.limit);
      const structuredContent = { ...result, stdout: "", query: input.spec, ...compact };
      return {
        content: [{ type: "text" as const, text: `Found ${compact.total_records} Pixi package records; returning ${compact.matches.length}.` }],
        structuredContent,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return toolResult({ ...result, stdout: "", stderr: message, ok: false }, { query: input.spec, total_records: 0, matches: [] });
    }
  });

  server.registerTool("pixi_dependency", {
    title: "Manage Pixi dependencies",
    description: "Add, remove, update, or upgrade explicit Conda/PyPI dependencies through Pixi's manifest and solver. Environment installation is skipped by default; use pixi_environment for one explicit frozen install, or set install=true when immediate materialization is intentional.",
    inputSchema: z.object({
      action: z.enum(["add", "remove", "update", "upgrade"]), packages: z.array(z.string().min(1).max(240)).min(1).max(64),
      source: z.enum(["conda", "pypi"]).default("conda"), manifest_path: manifestPath, feature: identifier.optional(),
      environment: identifier.optional(), platform: identifier.optional(), editable: z.boolean().optional(), index: z.string().url().optional(), dry_run: z.boolean().default(false), install: z.boolean().default(false),
    }),
    outputSchema: commandOutput,
    annotations: localWrite,
  }, async (input, context) => toolResult(await execute(dependencyCommand(boundary, input), context.mcpReq.signal)));

  server.registerTool("pixi_lock", {
    title: "Check or resolve a Pixi lock",
    description: "Check manifest-lock consistency, preview a solve without writing, or resolve pixi.lock. Preview still evaluates package metadata and build sources; resolve writes the lock.",
    inputSchema: z.object({ action: z.enum(["check", "preview", "resolve"]), manifest_path: manifestPath }),
    outputSchema: commandOutput,
    annotations: localWrite,
  }, async (input, context) => toolResult(await execute(lockCommand(boundary, input), context.mcpReq.signal)));

  server.registerTool("pixi_environment", {
    title: "Manage Pixi environments",
    description: "Install, reinstall, clean, or inspect activation variables for a workspace environment. Prefer frozen installs for reproducibility.",
    inputSchema: z.object({
      action: z.enum(["install", "reinstall", "clean", "activation_environment"]), manifest_path: manifestPath,
      environment: identifier.optional(), all: z.boolean().default(false), frozen: z.boolean().default(true), locked: z.boolean().default(false),
    }),
    outputSchema: commandOutput,
    annotations: execution,
  }, async (input, context) => toolResult(await execute(environmentCommand(boundary, input), context.mcpReq.signal)));

  server.registerTool("pixi_task", {
    title: "Manage and run declared Pixi tasks",
    description: "List, add, remove, alias, or run a declared Pixi task. Runs are frozen and clean-environment by default; arbitrary pixi exec and interactive shells are not exposed.",
    inputSchema: z.object({
      action: z.enum(["list", "add", "remove", "alias", "run"]), manifest_path: manifestPath, name: identifier.optional(),
      command: z.string().min(1).max(4_096).optional(), dependencies: z.array(identifier).max(32).optional(), environment: identifier.optional(),
      arguments: z.array(z.string().max(1_024)).max(64).optional(),
    }),
    outputSchema: commandOutput,
    annotations: execution,
  }, async (input, context) => toolResult(await execute(taskCommand(boundary, input), context.mcpReq.signal)));

  server.registerTool("pixi_workspace", {
    title: "Create, import, export, and configure Pixi workspaces",
    description: "Create a workspace, import Conda/PyPI requirements, export reproducible Conda files, or manage declared platforms, environments, and channels.",
    inputSchema: z.object({
      action: z.enum(["init", "import", "export_conda", "export_explicit", "platform_add", "platform_remove", "environment_add", "environment_remove", "channel_add", "channel_remove"]),
      manifest_path: manifestPath, path: relativePath.optional(), name: identifier.optional(), values: z.array(z.string().min(1).max(240)).max(32).optional(),
      environment: identifier.optional(), feature: identifier.optional(), platforms: z.array(identifier).max(16).optional(), channels: z.array(z.string().min(1).max(240)).max(16).optional(),
      format: z.enum(["conda-env", "pypi-txt"]).optional(), pinned: z.boolean().default(true), install: z.boolean().default(false),
    }),
    outputSchema: commandOutput,
    annotations: localWrite,
  }, async (input, context) => toolResult(await execute(workspaceCommand(boundary, input), context.mcpReq.signal)));

  server.registerTool("pixi_global", {
    title: "Manage Pixi global tools",
    description: "List, install, update, remove, sync, inspect, or expose Pixi global tool environments using the official global-tools model.",
    inputSchema: z.object({
      action: z.enum(["list", "install", "add", "remove", "uninstall", "update", "sync", "tree", "expose_add", "expose_remove"]),
      packages: z.array(z.string().min(1).max(240)).max(32).optional(), environment: identifier.optional(), exposed_name: identifier.optional(), executable: z.string().min(1).max(240).optional(),
    }),
    outputSchema: commandOutput,
    annotations: execution,
  }, async (input, context) => toolResult(await execute(globalCommand(input), context.mcpReq.signal)));

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseServerOptions();
  const boundary = await WorkspaceBoundary.create(options.workspaceRoot);
  serveStdio(() => createPixiServer(boundary, options.binary), { onerror: (cause) => console.error(cause) });
}
