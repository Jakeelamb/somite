import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OfficialDocumentation, type DocumentationProvider } from "@somite/mcp-runtime/docs";
import { VersionedCommandRunner, WorkspaceBoundary, jsonToolResult, parseServerOptions, toolResult } from "@somite/mcp-runtime";
import { z } from "zod/v4";

import {
  analysisCommand, historyCommand, maintenanceCommand, moduleCommand, platformCommand,
  pluginCommand, projectCommand, runCommand, storageCommand,
} from "./commands.ts";

export const SUPPORTED_NEXTFLOW_VERSION = "26.04.6";
export const NEXTFLOW_DOCUMENTATION_SOURCE = {
  name: "Nextflow",
  repository: "nextflow-io/nextflow",
  branch: `v${SUPPORTED_NEXTFLOW_VERSION}`,
  directory: "docs",
  website: "https://docs.seqera.io/nextflow/",
} as const;

const commandOutput = z.object({
  command: z.array(z.string()), cwd: z.string(), exit_code: z.number().int().nullable(), signal: z.string().nullable(),
  stdout: z.string(), stderr: z.string(), stdout_truncated: z.boolean(), stderr_truncated: z.boolean(),
  duration_ms: z.number().int().nonnegative(), ok: z.boolean(),
}).loose();
const docsSearchOutput = z.object({ query: z.string(), source_revision: z.string(), matches: z.array(z.object({ path: z.string(), url: z.string(), snippet: z.string() })) });
const docsReadOutput = z.object({ path: z.string(), url: z.string(), source_revision: z.string(), source_url: z.string(), text: z.string() });
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/);
const relativePath = z.string().min(1).max(1_024).describe("Path relative to the configured workspace root; it may not escape that root.");
const source = z.enum(["local", "remote"]);
const project = z.string().min(1).max(1_024).describe("Workspace-relative local path, owner/repository, or credential-free HTTPS repository URL according to source.");
const target = { source: source.default("local"), project: project.default(".") } as const;
const assetIdentity = { source: z.literal("remote").default("remote"), project } as const;
const projectInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("info"), ...assetIdentity }),
  z.object({ action: z.literal("view"), ...assetIdentity, revision: z.string().min(1).max(240).optional(), list_files: z.boolean().default(false) }),
  z.object({ action: z.enum(["pull", "drop"]), ...assetIdentity, revision: z.string().min(1).max(240).optional() }),
  z.object({ action: z.literal("clone"), ...assetIdentity, revision: z.string().min(1).max(240).optional(), destination: relativePath }),
]);
const params = z.record(identifier, z.union([z.string().max(4_096), z.number().finite(), z.boolean()]));

const defaultDocs = new OfficialDocumentation(NEXTFLOW_DOCUMENTATION_SOURCE);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const remoteRead = { ...readOnly, openWorldHint: true } as const;
const execution = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export function createNextflowServer(boundary: WorkspaceBoundary, binary = "nextflow", docs: DocumentationProvider = defaultDocs) {
  const server = new McpServer({ name: "somite-nextflow", title: "Nextflow", version: "0.1.0" });
  const runner = new VersionedCommandRunner({
    binary,
    cwd: boundary.root,
    supportedVersion: SUPPORTED_NEXTFLOW_VERSION,
    versionArgs: ["-version"],
    environment: { NXF_AGENT_MODE: "true", NXF_ANSI_LOG: "false", NXF_DISABLE_CHECK_LATEST: "true" },
  });
  const execute = (args: string[], signal: AbortSignal, timeoutMs = 120_000) => runner.run(args, { signal, timeoutMs });

  server.registerResource("nextflow-documentation-catalog", "nextflow://docs/catalog", {
    title: `Official Nextflow ${SUPPORTED_NEXTFLOW_VERSION} documentation catalog`,
    description: `Every Markdown/MDX page in the official nextflow-io/nextflow v${SUPPORTED_NEXTFLOW_VERSION} documentation tree, matched to Somite's pinned runtime.`,
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
    repository: docs.source.repository,
    revision: docs.source.branch,
    directory: docs.source.directory,
    pages: await docs.catalog(),
  }, null, 2) }] }));

  server.registerResource("nextflow-validation-ladder", "nextflow://guidance/validation-ladder", {
    title: "Nextflow proof ladder",
    description: "Distinguishes lint, preview, stub, fixture, and full execution evidence.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Nextflow proof ladder\n\n1. Freeze source and revision. 2. Lint syntax/style. 3. Resolve config and inspect processes. 4. Preview construction and DAG. 5. Run reviewed stubs when present. 6. Execute the smallest real fixture and verify artifacts. 7. Execute full data. Only real fixture/full execution proves process commands ran. Nextflow source and config are code-execution boundaries even during preview." }] }));

  server.registerResource("nextflow-safety-policy", "nextflow://policy/execution", {
    title: "Nextflow MCP execution policy",
    description: "Documents containment, credentials, and unsupported interactive/arbitrary plugin boundaries.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Nextflow MCP policy\n\nLocal paths stay inside the configured workspace. Remote repositories and filesystem URIs may not contain credentials. Commands use fixed argument arrays and bounded output. Interactive console, Kubernetes login, arbitrary plugin subcommands, and secret reads are not exposed. Execution, deletion, remote launch, module/plugin install, and secret mutation require approval." }] }));

  server.registerTool("nextflow_docs_search", {
    title: "Search complete Nextflow documentation",
    description: "Search all official Nextflow documentation paths, including CLI, language, typed workflows, configuration, executors, containers, reports, modules, plugins, lineage, cloud, migrations, and developer internals.",
    inputSchema: z.object({ query: z.string().min(1).max(120), limit: z.number().int().min(1).max(50).default(20) }), outputSchema: docsSearchOutput, annotations: remoteRead,
  }, async ({ query, limit }, context) => {
    const matches = await docs.search(query, limit, context.mcpReq.signal);
    return jsonToolResult({ query, source_revision: docs.source.branch, matches }, matches.length ? `Found ${matches.length} official Nextflow documentation pages.` : "No documentation paths matched.");
  });

  server.registerTool("nextflow_docs_read", {
    title: "Read official Nextflow documentation",
    description: "Read one exact Markdown/MDX page from the complete official Nextflow documentation catalog.",
    inputSchema: z.object({ path: relativePath.describe("Exact .md or .mdx path from nextflow_docs_search or nextflow://docs/catalog.") }), outputSchema: docsReadOutput, annotations: remoteRead,
  }, async ({ path }, context) => {
    const page = await docs.read(path, context.mcpReq.signal);
    return jsonToolResult(page, `Read official Nextflow documentation: ${path}`);
  });

  server.registerTool("nextflow_runtime_info", {
    title: "Inspect Nextflow runtime",
    description: "Return the installed Nextflow version and local runtime information without evaluating a pipeline.",
    inputSchema: z.object({}), outputSchema: commandOutput, annotations: readOnly,
  }, async () => {
    const compatibility = await runner.compatibility();
    return toolResult(compatibility.result, {
      supported_version: compatibility.supported_version,
      observed_version: compatibility.observed_version ?? null,
      compatible: compatibility.compatible,
    });
  });

  server.registerTool("nextflow_project", {
    title: "Inspect or acquire Nextflow projects",
    description: "List cached projects, inspect an asset identity, view asset files, pull an exact revision, clone an asset into the workspace, or drop a cached project. These are Nextflow asset-registry operations; use nextflow_analyze/run for local directories.",
    inputSchema: projectInput,
    outputSchema: commandOutput, annotations: destructive,
  }, async (input, context) => toolResult(await execute(projectCommand(boundary, input), context.mcpReq.signal)));

  server.registerTool("nextflow_analyze", {
    title: "Analyze a Nextflow project",
    description: "Lint scripts/config as JSON, resolve effective configuration, inspect process environments as JSON, or construct a preview DAG without running processes. Preview still evaluates workflow code.",
    inputSchema: z.object({
      action: z.enum(["lint", "config", "inspect", "preview_dag"]), ...target,
      paths: z.array(relativePath).max(128).optional(), profiles: z.array(identifier).max(16).optional(), params_file: relativePath.optional(),
      revision: z.string().min(1).max(240).optional(), dag_file: relativePath.optional(), config_format: z.enum(["json", "yaml", "flat", "canonical", "properties"]).default("json"),
    }),
    outputSchema: commandOutput, annotations: execution,
  }, async (input, context) => toolResult(await execute(analysisCommand(boundary, input), context.mcpReq.signal, input.action === "preview_dag" ? 300_000 : 120_000)));

  server.registerTool("nextflow_run", {
    title: "Preview, stub-test, fixture-test, or run a Nextflow pipeline",
    description: "Execute the explicit validation ladder: preview without processes, reviewed stub run, real fixture-bound execution, or full pipeline. Fixture mode is an ordinary execution over explicit fixture inputs, not Nextflow's unrelated -test function option. Captures optional DAG, trace, report, and timeline evidence in workspace-contained paths.",
    inputSchema: z.object({
      mode: z.enum(["preview", "stub", "fixture", "full"]), ...target, revision: z.string().min(1).max(240).optional(), profiles: z.array(identifier).max(16).optional(),
      params_file: relativePath.optional(), parameters: params.optional(), entry: identifier.optional(), run_name: identifier.optional(), resume: z.boolean().default(false), offline: z.boolean().default(false),
      output_dir: relativePath.optional(), work_dir: relativePath.optional(), dag_file: relativePath.optional(), trace_file: relativePath.optional(), report_file: relativePath.optional(), timeline_file: relativePath.optional(),
      container_runtime: z.enum(["docker", "podman", "apptainer", "singularity", "charliecloud"]).optional(),
    }),
    outputSchema: commandOutput, annotations: execution,
  }, async (input, context) => toolResult(await execute(runCommand(boundary, input), context.mcpReq.signal, input.mode === "preview" ? 300_000 : 3_600_000)));

  server.registerTool("nextflow_module", {
    title: "Discover and use Nextflow modules",
    description: "Search/view/list registry modules as JSON; install/remove/validate them; generate or publish-preview specs; or run a registry module with typed parameters.",
    inputSchema: z.object({
      action: z.enum(["search", "view", "list", "install", "remove", "validate", "spec", "publish_preview", "run"]), module: z.string().min(1).max(240).optional(),
      query: z.string().max(240).optional(), version: z.string().max(120).optional(), limit: z.number().int().min(1).max(100).default(20), path: relativePath.optional(), namespace: identifier.optional(),
      force: z.boolean().default(false), keep_files: z.boolean().default(false), parameters: params.optional(),
    }),
    outputSchema: commandOutput, annotations: execution,
  }, async (input, context) => toolResult(await execute(moduleCommand(boundary, input), context.mcpReq.signal, input.action === "run" ? 3_600_000 : 300_000)));

  server.registerTool("nextflow_history", {
    title: "Inspect Nextflow execution evidence",
    description: "Inspect run history, per-task fields, or lineage list/view/find/check/diff/render evidence. Read a raw .nextflow.log through nextflow_storage; the pinned runtime has no logfile command.",
    inputSchema: z.object({
      action: z.enum(["runs", "tasks", "lineage_list", "lineage_view", "lineage_find", "lineage_check", "lineage_diff", "lineage_render"]),
      run: z.string().max(240).optional(), fields: z.array(identifier).max(64).optional(), query: z.string().max(1_024).optional(), lineage_ids: z.array(z.string().min(1).max(1_024)).max(2).optional(), output_file: relativePath.optional(),
    }),
    outputSchema: commandOutput, annotations: { ...execution, openWorldHint: false },
  }, async (input, context) => toolResult(await execute(historyCommand(boundary, input), context.mcpReq.signal)));

  server.registerTool("nextflow_storage", {
    title: "Use Nextflow filesystem providers",
    description: "List, stat, read, copy, move, or remove workspace-contained files and credential-free provider URIs through Nextflow fs.",
    inputSchema: z.object({ action: z.enum(["list", "stat", "cat", "copy", "move", "remove"]), source: z.string().min(1).max(2_048), destination: z.string().min(1).max(2_048).optional() }),
    outputSchema: commandOutput, annotations: destructive,
  }, async (input, context) => toolResult(await execute(storageCommand(boundary, input), context.mcpReq.signal, 300_000)));

  server.registerTool("nextflow_maintenance", {
    title: "Preview or perform Nextflow cleanup",
    description: "Dry-run cleanup or force an explicitly scoped cleanup. Self-update is intentionally excluded because it would invalidate the version-matched command and documentation contract. Prefer clean_preview before clean.",
    inputSchema: z.object({ action: z.enum(["clean_preview", "clean"]), run: z.string().max(240).optional(), before: z.string().max(240).optional(), after: z.string().max(240).optional(), keep_logs: z.boolean().default(false) }),
    outputSchema: commandOutput, annotations: destructive,
  }, async (input, context) => toolResult(await execute(maintenanceCommand(input), context.mcpReq.signal, 300_000)));

  server.registerTool("nextflow_platform", {
    title: "Use Nextflow Seqera authentication, launch, and secrets",
    description: "Inspect or clear Seqera authentication, launch a pipeline, list secret names, or delete a secret. Interactive auth login/configuration and secret values never enter MCP requests or responses.",
    inputSchema: z.object({
      action: z.enum(["auth_status", "auth_logout", "launch", "secrets_list", "secrets_delete"]), ...target,
      workspace: z.string().max(240).optional(), compute_environment: z.string().max(240).optional(), revision: z.string().max(240).optional(), profiles: z.array(identifier).max(16).optional(),
      params_file: relativePath.optional(), run_name: identifier.optional(), secret_name: identifier.optional(),
    }),
    outputSchema: commandOutput, annotations: execution,
  }, async (input, context) => toolResult(await execute(platformCommand(boundary, input), context.mcpReq.signal, input.action === "launch" ? 300_000 : 120_000)));

  server.registerTool("nextflow_plugin_install", {
    title: "Install explicit Nextflow plugins",
    description: "Install one exact plugin ID, preferably pinned with @version. Install additional plugins with separate calls so each result is independently attributable. Arbitrary plugin subcommands and plugin scaffolding are not exposed.",
    inputSchema: z.object({ plugin: z.string().regex(/^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.+~-]+)?$/) }), outputSchema: commandOutput, annotations: execution,
  }, async (input, context) => toolResult(await execute(pluginCommand({ action: "install", ...input }), context.mcpReq.signal, 300_000)));

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseServerOptions();
  const boundary = await WorkspaceBoundary.create(options.workspaceRoot);
  serveStdio(() => createNextflowServer(boundary, options.binary), { onerror: (cause) => console.error(cause) });
}
