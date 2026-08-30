# Releasing Somite

Somite's current release is source-only. It does not yet publish a managed
hosted service or a standalone desktop bundle. Do not attach a partial artifact
and describe it as an installable application. Direct source execution supports
Linux and macOS; Windows verification runs inside WSL2, not native Windows.

## Prepare the release

1. Start from a clean checkout of `main` and confirm CI is green.
2. Choose the version and update the root, `web`, `runner`, and
   `packages/workflow` `package.json` files plus `pixi.toml`. Run
   `npm install --package-lock-only` so the lockfile carries the same versions.
3. Move relevant `CHANGELOG.md` entries from Unreleased into a dated version
   section and update comparison links.
4. Run the complete gate:

   ```bash
   npm ci
   npm run check
   npm audit
   git diff --check
   ```

5. Run `pixi install --locked`, then launch `pixi run dev` from the clean
   checkout. Verify runner health, a clean browser console, autosave, local file
   import, catalog loading, Agent discovery, representative validation, and a
   frozen export for the same graph revision.
6. Review the README from a new-user perspective and verify every command,
   relative link, requirement, and limitation.

## Publish

Create and push an annotated tag matching every package version:

```bash
git tag -a v0.1.0 -m "Somite v0.1.0"
git push origin v0.1.0
```

`.github/workflows/release.yml` repeats the locked TypeScript gate, rejects a
tag that does not match the workspace versions, and creates a GitHub release
with generated notes. GitHub provides the source archives.

After publication, verify the release page, source archives, rendered README,
license detection, and installation instructions from a fresh directory. Fix
forward with a new patch release; do not silently move an existing release tag.
