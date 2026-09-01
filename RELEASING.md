# Releasing Somite

Somite's current release is source-only. It does not yet publish a managed
hosted service or a standalone desktop bundle. Do not attach a partial artifact
and describe it as an installable application. Linux x64 is the sole verified
direct source-execution target for this release line.

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
   npm run smoke:browser
   npm audit --audit-level=moderate
   git diff --check
   ```

5. Run `pixi install --locked`, `pixi run setup`, and `pixi run smoke` from the
   clean checkout. Setup must pass the source/client size contract. The smoke
   must complete both direct-runner and browser-to-runner representative
   validation through real Pixi and Nextflow, retain the evidence, execute the
   workflow, and download the ZIP without mocked executables.
6. Launch `pixi run start` without rebuilding. Verify runner health, a clean
   browser console, autosave, local file import, catalog loading, Agent
   discovery, representative validation, and a frozen export for the same graph
   revision.
7. Review the README from a new-user perspective and verify every command,
   relative link, requirement, and limitation.

## Publish

Create and push an annotated tag matching every package version:

```bash
release_version="$(node -p "require('./package.json').version")"
npm run check:version -- "v${release_version}"
git tag -a "v${release_version}" -m "Somite v${release_version}"
git push origin "v${release_version}"
```

`.github/workflows/release.yml` accepts only an annotated tag whose commit is
reachable from `main`, repeats the locked TypeScript and production-browser
gates, verifies the size contract from an unpacked `git archive`, rejects a tag
that does not match the workspace versions, and runs the real execution smoke.
A separate minimal job receives `contents: write` only after verification and
creates the release without checking out or executing tagged source. GitHub's
generated source archives are the only release artifacts; do not attach build
directories or partially installable bundles.

Repository administrators should protect `main` and release tags with required
CI checks and restrict the release environment to maintainers. Those GitHub
settings are part of the publication boundary and cannot be enforced by the
source workflow alone.

The Linux x64 release gate runs both real execution and browser-to-runner smoke.
Other hosts remain unverified until their scientific package fixtures can be
resolved without changing source-owned requirements.

After publication, verify the release page, source archives, rendered README,
license detection, and installation instructions from a fresh directory. Fix
forward with a new patch release; do not silently move an existing release tag.
