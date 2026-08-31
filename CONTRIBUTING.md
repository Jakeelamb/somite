# Contributing to Somite

Somite welcomes focused bug fixes, documentation improvements, operator
contracts, and workflow capabilities. Start with the user or scientific
outcome; implementation details should follow from that outcome.

## Before opening a change

- Search existing issues and discussions.
- Open an issue before a large feature, graph-schema change, execution-target
  change, or operator-contract change.
- Never include credentials, private datasets, unpublished paper content, or
  machine-specific absolute paths.
- Keep claims evidence-bound. A graph edit, successful compilation,
  representative validation, and production execution are different outcomes.

## Development setup

Use the checked-in Pixi environment for development:

```bash
pixi run install
pixi run dev
```

Or use Node.js from `.nvmrc` directly:

```bash
npm ci
npm run dev
```

To exercise the production path, run `pixi run setup` once and then
`pixi run start`. Starting the app reuses the built bundle.

The repository is one npm workspace: `web/` owns browser interaction,
`runner/` owns local I/O and processes, `packages/workflow/` owns graph and
workflow semantics, `packages/mcp-runtime/` owns the shared MCP boundary, and
`mcp/pixi/` plus `mcp/nextflow/` expose the two external toolchains. Local
graphs, uploads, evidence, benchmark profiles, and generated tool environments
live under `.somite/` or `output/` and must not be committed.

Development is supported directly on Linux and macOS. Windows contributors
should use WSL2; the project does not claim a native Windows execution path.

## Make a reviewable change

- Keep one production path and delete obsolete code before adding abstraction.
- Put graph semantics, validation, compilation, and identity in
  `@somite/workflow`; keep browser interaction in `web/` and host/process I/O in
  `runner/`.
- Runtime-validate every persisted, network, catalog, paper, and Agent value.
  TypeScript types alone are not a trust boundary.
- Add tests at the narrowest useful Interface. Add a spawned-runner or browser
  test when behavior crosses Modules.
- Preserve graph identity, operator revisions, provenance, atomic writes, and
  fail-closed behavior.
- Update the README, relevant design documentation, and `CHANGELOG.md` when
  public behavior changes.

Run the full gate before requesting review:

```bash
npm ci
npm run check
npm run smoke:browser
npm run benchmark:quick
npm audit --audit-level=moderate
git diff --check
```

In the pull request, list exact commands and manual checks. If a check is
unavailable, state that directly and explain why.

The browser smoke uses a system Chrome or Chromium against the built production
bundle. Set `SOMITE_BROWSER_PATH` for a nonstandard executable location.

Release-affecting changes also require `pixi run smoke` on a supported POSIX
host. This is a slower networked gate because it resolves and executes the real
pinned Pixi and Nextflow environment.

Performance changes must start with the relevant `benchmark:quick` receipt and
an outcome-preserving profile. Use `profile:cpu` or `profile:heap` for the exact
case, then compare a same-host candidate receipt. Do not use hosted-runner,
live-paper, or cross-machine wall times as a speed claim. The complete contract
and the slower release lane are in [docs/benchmarks.md](docs/benchmarks.md).
If a pull request intentionally changes that contract or either dependency
lock, ask a maintainer to apply `benchmark-series-reset`; CI verifies that a
passing new series is actually required rather than silently waiving a
comparable regression.

Packaging changes also require `npm run proof:source` after committing. That
task installs, builds, starts, and shuts down an archive of `HEAD`; it
intentionally ignores uncommitted files.

## Cut a release

Release tags must be annotated, and their commit must already be reachable from
`origin/main`. The release workflow records both the tag-object identity and
resolved commit during verification, then checks both identities again
immediately before publishing. Never move, replace, or force-push a release
tag; correct a release with a new version and a new annotated tag.

## License

By submitting a contribution, you agree that it is licensed under the
[Apache License 2.0](LICENSE).
