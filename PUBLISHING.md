# Publishing

This package publishes to npm through GitHub Actions using npm trusted publishing
(OIDC). There is no `NPM_TOKEN` and no long-lived secret anywhere. Once the
one-time setup below is done, releases publish automatically with provenance.

- CI workflow: `.github/workflows/ci.yml` (job name `verify`)
- Release workflow: `.github/workflows/release.yml` (job name `publish`)
- GitHub Actions environment: **`npm-publish`**
- npm package: `listening-log` (unscoped, public)

## How a normal release works (after setup)

1. Bump the version in `package.json` (for example `0.1.0` to `0.1.1`) and add a
   matching section to `CHANGELOG.md`.
2. Commit and push to `main` (CI runs and must be green).
3. Create a GitHub Release for the matching tag (for example `v0.1.1`), with notes
   copied from the CHANGELOG entry.
4. The release workflow re-runs typecheck, test, and build, then publishes to npm
   over OIDC with provenance. No token is involved.

## One-time setup (human-only steps)

These cannot be automated from the repository: the trusted-publisher link lives in
the npmjs.com web UI, and the package must already exist on npm before the link can
be configured.

### Step a. First publish from your machine (local, once)

The package must exist on npm before a trusted publisher can be attached. Publish
the first version locally:

```sh
npm login
pnpm build
pnpm smoke                  # see below; do not skip this one
npm publish --access public
```

`pnpm smoke` packs the tarball, installs it into a clean directory, and calls the
real entry points with an injected fetch. It exists because
`apple-music-developer-token` shipped a bug that every test passed straight over:
the tests exercised the source, never the installed artifact, and the failure only
showed up once the package was resolved the way a consumer resolves it. `publint`
and `attw` read the manifest; only the smoke check runs the thing you are about to
publish. CI runs it too, so a green `verify` job already covers this, but it is
worth running locally before the one publish that does not go through CI.

This first publish is done from your machine, so it will not carry CI provenance.
That is expected and fine for the bootstrap; every later release (published by the
workflow) will have provenance.

### Step b. Add the Trusted Publisher on npmjs.com (web UI, once)

Go to the package page on npmjs.com:
`https://www.npmjs.com/package/listening-log` then Settings, and under
"Trusted Publisher" add a GitHub Actions publisher with these values, which must
match the workflow EXACTLY (a mismatch makes publishes fail with a 404):

- Provider: GitHub Actions
- Organization or user: `anthony-liddle`
- Repository: `listening-log`
- Workflow filename: `release.yml`
- Environment: `npm-publish`

Then, under "Allowed actions" (at least one must be selected), check
"Allow npm publish" and leave "Allow npm stage publish" unchecked, since the
release workflow runs a plain `pnpm publish` (a standard, non-staged publish)
rather than the staged two-step flow. Finally, click "Set up connection".

The separate "Publishing access" section on the same page (the two-factor
authentication options) does not need changing: npm notes that trusted publishers
keep working regardless of which option is selected there.

### Step c. Enable branch protection on `main` (once, after CI is green)

Run `pnpm setup:branch-protection` after the first CI run has landed on `main`.

The script applies the intended protection state idempotently: it reads the live
settings, prints one line per field it would change, asks before writing, and
verifies the result. Run it any time you want to confirm or restore the intended
state, not just during setup; if nothing has drifted it reports that and exits.
Pass `--dry-run` to see the diff and the payload without writing anything. The
intended state itself is documented in the comment block at the top of
`scripts/branch-protection.mjs`, which is the source of truth.

"After the first CI run" is load-bearing. Branch protection can only require a
status check that GitHub has already seen at least once, so if you run the script
before CI has ever run on `main`, the write succeeds but the required check does
not stick. Merge one pull request first, let `verify` run, then run the script.

### Step d. From then on

Releases are automatic: bump the version, push to `main`, create a GitHub Release,
and the workflow publishes with provenance and no token. You only repeat steps a
through c if you move the repo, rename the workflow, or change the environment name.

## Appendix: Manual branch protection setup (if the script isn't available)

Use this only when the scripted path in step c is not an option: `gh` is not
installed or cannot be authenticated, the script is broken, the settings are being
configured from an account that cannot run it, or some other atypical situation.
The script is the primary path and the source of truth. This appendix exists so a
human can reproduce the same result by hand, and it must be kept in step with
`scripts/branch-protection.mjs` if the intended state ever changes.

1. Navigate to `github.com/anthony-liddle/listening-log/settings/branches`.
2. Edit the branch protection rule for `main`, or create one if none exists yet.
3. Turn ON "Require a pull request before merging".
4. Set "Require approvals" to **0**. A solo maintainer cannot approve their own
   pull requests, so any higher number deadlocks every PR.
5. Leave "Require review from Code Owners" OFF.
6. Leave "Dismiss stale pull request approvals when new commits are pushed" OFF,
   and leave "Require approval of the most recent reviewable push" OFF.
7. Turn ON "Require status checks to pass before merging".
8. Turn ON "Require branches to be up to date before merging".
9. In the status-check search, type `verify` and select the **`verify`** job from
   the CI workflow. This is the job name in `.github/workflows/ci.yml`.
10. Leave "Do not allow bypassing the above settings" OFF, so the maintainer is
    not locked out during a genuine emergency.
11. Leave "Allow force pushes" and "Allow deletions" OFF.
12. Save.

Then confirm it took: open a small pull request (a comment-only or whitespace
change) and check that the merge button stays grey until `verify` completes green.

If `verify` does not appear in the status-check search at step 9, CI has not run on
`main` yet. Merge one pull request, let CI run, then come back to this screen and
the check will be selectable.
