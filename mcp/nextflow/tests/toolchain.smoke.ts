import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent)}`);
  return result;
}

test("Nextflow MCP lints, previews, executes a real fixture, and returns evidence", { timeout: 5 * 60_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "nextflow-mcp-smoke-"));
  const client = new Client({ name: "nextflow-mcp-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", new URL("../src/server.ts", import.meta.url).pathname, "--workspace-root", root],
    cwd: root,
    stderr: "pipe",
  });
  context.after(async () => {
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    writeFile(join(root, "fixture.txt"), "somite mcp\n"),
    writeFile(join(root, "main.nf"), [
      "nextflow.enable.dsl=2",
      "params.input = 'fixture.txt'",
      "",
      "process UPPERCASE {",
      "    input:",
      "    path source",
      "",
      "    output:",
      "    path 'uppercase.txt'",
      "",
      "    script:",
      "    \"\"\"",
      "    tr '[:lower:]' '[:upper:]' < ${source} > uppercase.txt",
      "    \"\"\"",
      "}",
      "",
      "workflow {",
      "    input_ch = Channel.fromPath(params.input, checkIfExists: true)",
      "    UPPERCASE(input_ch)",
      "}",
      "",
    ].join("\n")),
  ]);

  await client.connect(transport);
  const docs = await client.readResource({ uri: "nextflow://docs/catalog" });
  const docsContent = docs.contents[0];
  assert.ok(docsContent && "text" in docsContent);
  const docsCatalog = JSON.parse(docsContent.text) as { revision?: string; pages?: string[] };
  assert.equal(docsCatalog.revision, "v26.04.6");
  assert.ok((docsCatalog.pages?.length ?? 0) >= 100);
  const docsSearch = await call(client, "nextflow_docs_search", { query: "preview stub-run process execution", limit: 10 });
  assert.match(JSON.stringify(docsSearch.structuredContent), /cli|execution|process/);
  const runtime = await call(client, "nextflow_runtime_info", {});
  assert.match(JSON.stringify(runtime.structuredContent), /26\.04\.6/);
  const moduleSearch = await call(client, "nextflow_module", { action: "search", query: "fastqc", limit: 5 });
  assert.match(JSON.stringify(moduleSearch.structuredContent), /nf-core\/fastqc/);
  await call(client, "nextflow_analyze", { action: "lint", source: "local", project: "." });
  await call(client, "nextflow_analyze", { action: "preview_dag", source: "local", project: ".", dag_file: "preview.html" });
  assert.ok((await stat(join(root, "preview.html"))).isFile());

  await call(client, "nextflow_run", {
    mode: "fixture",
    source: "local",
    project: ".",
    parameters: { input: "fixture.txt" },
    run_name: "somite_mcp_fixture",
    work_dir: "work",
    trace_file: "trace.tsv",
    report_file: "report.html",
    timeline_file: "timeline.html",
    dag_file: "fixture-dag.html",
  });
  assert.match(await readFile(join(root, "trace.tsv"), "utf8"), /UPPERCASE.*COMPLETED/);
  assert.ok((await stat(join(root, "report.html"))).isFile());
  assert.ok((await stat(join(root, "timeline.html"))).isFile());

  const history = await call(client, "nextflow_history", { action: "tasks", run: "somite_mcp_fixture", fields: ["name", "status", "exit"] });
  assert.match(JSON.stringify(history.structuredContent), /UPPERCASE.*COMPLETED/);
  const trace = await call(client, "nextflow_storage", { action: "cat", source: "trace.tsv" });
  assert.match(JSON.stringify(trace.structuredContent), /UPPERCASE.*COMPLETED/);
});
