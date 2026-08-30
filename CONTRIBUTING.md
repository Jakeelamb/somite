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

The repository is one npm workspace: `web/`, `runner/`, and
`packages/workflow/`. Local graphs, uploads, evidence, and generated tool
environments live under `.somite/` and must not be committed.

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
npm audit
git diff --check
```

In the pull request, list exact commands and manual checks. If a check is
unavailable, state that directly and explain why.

Release-affecting changes also require `pixi run smoke` on a supported POSIX
host. This is a slower networked gate because it resolves and executes the real
pinned Pixi and Nextflow environment.

## License

By submitting a contribution, you agree that it is licensed under the
[Apache License 2.0](LICENSE).
