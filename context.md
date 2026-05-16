# Code Context

## Files Retrieved
1. `package.json` (lines 1-53) — package metadata, `publishConfig`, scripts, `packageManager` declaration, and no explicit publish script.
2. `package-lock.json` (lines 1-22) — npm lockfile exists, lockfile v3, root package section mirrors `package.json` and has only `devDependencies`/`peerDependencies` metadata.
3. `pnpm-lock.yaml` (lines 1-34) — pnpm lockfile also exists, importer root lists direct dependencies (`@earendil-works/*`, `typebox`) and dev deps.
4. `.github/workflows/ci.yml` (lines 1-30) — CI trigger, permissions, node setup, and commands.
5. `.github/workflows/npm-publish.yml` (lines 1-54) — publish trigger, permissions (`id-token`), publish guard, and publish command.
6. `.github/workflows/release-from-package.yml` (lines 1-77) — manual release creation path and tag check.
7. `.github/workflows/release-please.yml` (lines 1-42) — release-please automation path on push/dispatch.
8. `README.md` (lines 14-21, 337-343) — install/usage and verification command.
9. `tests/package-manifest.test.ts` (lines 1-50) — manifest assertions for `publishConfig`, scripts, repository, and peer deps.
10. Repo search sweep: no `CHANGELOG*`, `RELEASING*`, `release-notes*`, or `*release*.md` files found.

## Key Code
- **Package manager intent (package.json):** `packageManager: "pnpm@11.1.2+sha..."` (line 52) but all CI/release workflows install with npm (`npm ci`) and use npm lock cache.
- **Publish config (package.json):** `publishConfig.access = "public"` and `publishConfig.provenance = true` (lines 32-34).
- **CI workflow (`ci.yml`):** on `push` to `main` + `pull_request`; job `check` runs `npm ci`, `npm run typecheck`, `npm test`, `npm pack --dry-run` with `cache: npm` (lines 3-30).
- **Publish workflow (`npm-publish.yml`):** triggers on `release: [published]` and `workflow_dispatch`; permissions include `id-token: write`; checks out, `npm ci`, test/typecheck, pack, then `npm publish --provenance --access public` only if version not already in registry (`npm view`) and `inputs.dry_run` false (lines 3-54).
- **Release-please workflow (`release-please.yml`):** triggers on `push main` + `workflow_dispatch`; runs same quality block, then `googleapis/release-please-action@v5` with `release-type: node` and package-name set (lines 3-42).
- **Manual release-from-package (`release-from-package.yml`):** manual workflow only; quality checks then resolves version from `package.json`, checks tag non-existence, creates GitHub release with generated notes via `softprops/action-gh-release`.
- **Docs/commands:** README has install instructions and only release-adjacent command in docs is local verification `npm run typecheck && npm test` (line 342).

## Architecture
- **Source of truth conflict:** package manager is declared as pnpm in manifest, but automation is npm-first (`npm ci`, `cache: npm`, `npm pack`, `npm publish`).
- **Release flow is split across workflows:**
  - `release-please` can create a GitHub release automatically on merge to main.
  - `npm-publish` is the only step that publishes to npm and runs on `release` events.
  - `release-from-package` is a separate manual path that creates a GitHub release from package version but does not publish to npm.
- **Current gating for publish:** runtime typecheck/test/pack gates plus idempotency check (`npm view pkg@version`) before publish.

## Start Here
Open `.github/workflows/npm-publish.yml` first, then `package.json`, then `.github/workflows/release-please.yml` to validate whether publishing/release triggers match intended pipeline.

## Suspicious mismatches / audit flags
- **Lockfile mismatch:** both `package-lock.json` and `pnpm-lock.yaml` are present.
- **Dependency graph mismatch:** `pnpm-lock.yaml` root importer has direct `dependencies`, while `package.json` declares those as `peerDependencies`; indicates drift/out-of-sync lockfile state.
- **Potential context bug:** `npm-publish.yml` references `${{ inputs.dry_run }}` on non-dispatch trigger (`release` events), which can fail/behave unexpectedly depending on Actions expression context.
- **No explicit publish/release docs:** repo has no release notes/changelog/releasing guide file; only generic install + verification docs.