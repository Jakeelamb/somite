# Nextflow MCP server

A standalone stdio MCP server proven against Nextflow 26.04.6. It exposes the complete official `v26.04.6` manual plus typed project acquisition, analysis, module, execution, evidence, filesystem, cleanup, plugin, and Seqera operations.

```sh
npm run build --workspace=@somite/nextflow-mcp-server
node mcp/nextflow/dist/server.js --workspace-root /path/to/project
```

Documentation comes from the matching `nextflow-io/nextflow` tag and is cached in the platform user-cache directory. No manual is vendored into Somite. An incompatible Nextflow binary fails before a project command runs.

Commands that support JSON expose it as native MCP structured data rather than duplicated JSON text. `nextflow_project` models Nextflow's asset registry: list needs no target, while info/view/pull/clone/drop require an explicit remote or cached `owner/repository` identity. Local directories are handled by analyze and run. Registry module search is verified live against nf-core.

The execution modes are intentionally different:

- `preview` evaluates workflow construction and can render a DAG, but runs no processes.
- `stub` executes reviewed stub bodies instead of real process scripts.
- `fixture` is a real execution and therefore requires explicit fixture parameters, a params file, or the conventional `test`/`test_full` profile.
- `full` is an ordinary production-data execution.

Nextflow 26.04.6 has no `logfile` command; raw `.nextflow.log` files are read through the contained storage tool. `self-update` and the launcher's latest-version check are disabled because they would invalidate or add remote state to this pinned contract. Interactive console, authentication configuration, Kubernetes login, secret reads, credential-bearing URLs, and arbitrary plugin commands are also excluded.

The Nextflow MCP case inside `npm run smoke:execution` drives a real client through local lint, preview DAG construction, offline fixture execution, trace/report/timeline generation, run-history lookup, and evidence-file reading. `npm run canary:mcp:live` separately checks the complete pinned manual and nf-core module discovery. CI runs that upstream canary only on its schedule or by manual dispatch, so registry availability does not decide a source release.
