# Contributing to Somite

Somite welcomes focused bug fixes, documentation improvements, operator
contracts, and workflow capabilities. Start with the user or scientific outcome;
implementation details should follow from that outcome.

## Before opening a change

- Search existing issues and discussions.
- Open an issue before a large feature, new execution engine, graph-schema
  change, or operator-contract change.
- Never include credentials, private datasets, unpublished paper content, or
  machine-specific absolute paths.
- Keep execution claims evidence-bound. A graph edit, successful compilation,
  representative validation, and production execution are different outcomes.

## Development setup

Requirements:

- Rust via `rustup`; the repository pins the toolchain in `rust-toolchain.toml`.
- Node.js from `.nvmrc` (22.13.0 or newer compatible release).
- [Pixi](https://pixi.sh/) for resolving and running bioinformatics tools.

Install the locked web dependencies and launch the app:

```bash
cd web
npm ci
cd ..
scripts/somite-web
```

Open <http://localhost:3000>. Local graphs, evidence, and generated tool
environments live under `.somite/` and must not be committed.

## Make a reviewable change

- Keep one production path and delete obsolete code before adding abstraction.
- Add tests for new behavior. Prefer property tests for graph invariants and
  end-to-end checks for user-visible paths.
- Avoid `unwrap()` in library code. Return typed errors with useful context.
- Preserve graph identity, operator revisions, provenance, and fail-closed
  behavior when changing compilation or execution.
- Update the README, relevant design documentation, and `CHANGELOG.md` when
  public behavior changes.

Run the full local gate before requesting review:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --release --locked

cd web
npm run typecheck
npm run lint
npm test
```

In the pull request, list the exact commands and manual checks that passed. If a
check is unavailable, state that directly and explain why.

## License

By submitting a contribution, you agree that it is licensed under the
[Apache License 2.0](LICENSE).
