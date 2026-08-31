# Pixi MCP server

A standalone stdio MCP server proven against Pixi 0.77.1. It exposes the complete official `v0.77.1` documentation tree plus typed workspace and global-tool operations.

```sh
npm run build --workspace=@somite/pixi-mcp-server
node mcp/pixi/dist/server.js --workspace-root /path/to/project
```

The documentation catalog and pages come from the matching `prefix-dev/pixi` tag and are cached in the platform user-cache directory. No manual is vendored into Somite. An incompatible Pixi binary fails before a workspace command runs.

Package search uses Pixi's JSON registry response, validates it, and returns only the requested number of typed records; the full registry payload never enters agent context. Dependency and channel/platform edits default to Pixi's `--no-install`, so an agent can solve several edits without repeatedly materializing the environment.

The reproducible path is `pixi lock --dry-run` when proposing a solve, dependency edits that update the lock without installation, `pixi lock` to write the exact lock when needed, then one explicit `pixi install --frozen` and a declared task. Set `install=true` on an edit only when immediate materialization is intentional. A clean task can use only declared environment tools; the scheduled live MCP canary therefore declares `coreutils` before executing its proof task. Global `add` and `remove` require an exact global environment, while `uninstall` removes environments rather than packages.

Arbitrary `pixi exec`, interactive shells, auth-token reads, insecure TLS, and post-link-script flags are intentionally not tools. The `pixi://policy/execution` resource explains the boundary.

The Pixi MCP case inside `npm run smoke:execution` drives a real client through version inspection, local workspace creation, locking, frozen installation, and a declared local task without contacting package or documentation registries. `npm run canary:mcp:live` separately checks the complete pinned manual, Bioconda package discovery, a real Conda solve and install, clean task execution, and locked Conda export. CI runs that upstream canary only on its schedule or by manual dispatch, so registry availability does not decide a source release.
