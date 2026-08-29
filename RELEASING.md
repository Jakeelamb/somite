# Releasing Somite

Somite's first release is source-only. It does not yet publish a standalone
desktop or binary bundle: the visual app needs the Rust server, the web
workspace, the operator catalog, Node.js, and Pixi. Do not attach a partial
binary and describe it as an installable app.

## Prepare the release

1. Start from a clean checkout of `main` and confirm CI is green.
2. Choose the version and update `[workspace.package].version` in `Cargo.toml`.
   In `web`, run `npm version 0.1.0 --no-git-tag-version --allow-same-version`
   with the chosen version so `package.json` and `package-lock.json` change
   together.
3. Confirm the Rust workspace, web package, and web lockfile carry the same
   version.
4. Move the relevant `CHANGELOG.md` entries from `Unreleased` into a dated
   version section and update its comparison links.
5. Run the complete gate:

   ```bash
   cargo fmt --all -- --check
   cargo clippy --workspace --all-targets --locked -- -D warnings
   cargo test --workspace --locked
   cargo build --workspace --release --locked

   cd web
   npm ci
   npm run typecheck
   npm run lint
   npm test
   ```

6. Launch `scripts/somite-web` from a clean checkout. Verify the backend health,
   a clean browser console, successful autosave, agent discovery, a representative
   graph validation, and export of the same graph revision.
7. Review the README from a new-user perspective and verify every documented
   command, relative link, requirement, and screenshot against that checkout.

## Publish

Create and push an annotated tag matching the package version:

```bash
git tag -a v0.1.0 -m "Somite v0.1.0"
git push origin v0.1.0
```

`.github/workflows/release.yml` repeats the release gate, rejects a tag that
does not match the Rust and web versions, and creates a GitHub release with
generated notes. GitHub provides the source archives.

After publication, verify the release page, source archives, rendered README,
license detection, and installation instructions from a fresh directory. If
any verification fails, fix forward with a new patch release; do not silently
move an existing release tag.
