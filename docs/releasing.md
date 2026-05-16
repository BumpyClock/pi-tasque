---
summary: Release process, package version source, GitHub workflows, npm Trusted Publishing, and verification checklist.
read_when:
  - Preparing a new pi-tasque release, forcing release workflow runs, or bumping package versions.
  - Changing release, npm publish, package contents, or version bump automation.
---

# Releasing

## Source Of Version Truth

- `package.json` is the release version source.
- `package-lock.json` must match `package.json` before release.
- The package published to npm is `@bumpyclock/pi-tasque`.

Use the bump helper so `package.json` and `package-lock.json` stay in sync:

```bash
node scripts/bump-version.js patch
node scripts/bump-version.js minor
node scripts/bump-version.js major
node scripts/bump-version.js promote
node scripts/bump-version.js 0.2.0
node scripts/bump-version.js patch --dry-run
```

Package aliases:

```bash
npm run bump:patch
npm run bump:minor
npm run bump:major
npm run bump:set -- 0.2.0
```

## GitHub Workflows

Release automation uses these workflows:

- `/.github/workflows/release-please.yml`
  - Trigger: push to `main` or manual `workflow_dispatch`.
  - Action: runs Node quality checks, then opens/updates the release PR from Conventional Commits using Node release type.
- `/.github/workflows/release-from-package.yml`
  - Trigger: manual `workflow_dispatch`.
  - Action: validates optional `version` input against `package.json`, creates tag `v<package.json version>`, publishes GitHub Release.
- `/.github/workflows/npm-publish.yml`
  - Trigger: GitHub Release `published` or manual `workflow_dispatch`.
  - Auth: npm Trusted Publishing/OIDC from GitHub Actions; no `NPM_TOKEN` is required for publish.
  - Action: runs Node quality checks, verifies package contents with `npm pack --dry-run`, then publishes `@bumpyclock/pi-tasque`.

## Standard Release Path

1. Merge feature/fix PRs to `main` with Conventional Commit titles.
2. Wait for (or manually run) `Release Please`.
3. Review the generated release PR and merge it.
4. Confirm the GitHub Release was published.
5. Confirm `npm-publish` succeeds after the GitHub Release is published.
6. Verify the npm package version and provenance on npmjs.com.

## Manual Release Path

Use this when releasing directly from the current `package.json` version:

1. Ensure target version is in `package.json` and `package-lock.json`.
2. Open GitHub Actions and run `Release From Package`.
3. Optional input: `version` (must match `package.json` if provided).
4. Optional input: `target` (branch or commit SHA; default `main`).
5. Workflow creates and publishes tag `v<package.json version>`.
6. Published release triggers `npm-publish` automatically.

## npm Package Flow

`npm-publish.yml` publishes one public scoped package:

- `@bumpyclock/pi-tasque`

The package contents come from `package.json` `files`:

- `src/`
- `README.md`
- `LICENSE`
- `NOTICE.md`

npm publishing uses Trusted Publishing. The npm package must trust GitHub Actions for repository `BumpyClock/pi-tasque` and workflow filename `npm-publish.yml`. The workflow grants `id-token: write` only to the publish job so npm can exchange the GitHub OIDC identity for short-lived publish credentials.

Trusted Publisher settings:

- Provider: GitHub Actions
- Repository: `BumpyClock/pi-tasque`
- Workflow filename: `npm-publish.yml`
- Environment: blank (the workflow intentionally has no `environment:` gate so standard releases publish automatically)

Do not add `NODE_AUTH_TOKEN` or `NPM_TOKEN` to the publish step. If publishing fails with `ENEEDAUTH`, verify the npm Trusted Publisher settings before adding token fallback.

Manual npm dry run:

```bash
gh workflow run npm-publish.yml --ref main -f dry_run=true
gh run list --workflow "npm-publish" --limit 5
gh run watch "$(gh run list --workflow "npm-publish" --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Manual npm publish:

```bash
gh workflow run npm-publish.yml --ref v<version> -f dry_run=false
```

## Verification Checklist

Before merging a release PR:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm pack --dry-run`
5. Verify `package.json` version matches `package-lock.json`.
6. Ensure npm package contents include only intended files.
7. Confirm npm Trusted Publisher settings match repository `BumpyClock/pi-tasque` and workflow `npm-publish.yml`.

## Rollback

1. Delete GitHub Release.
2. Delete git tag (`git push --delete origin v<version>`).
3. Revert bad commit on `main`.
4. Let Release Please open the next corrective release PR.
