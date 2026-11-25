# Releasing

Every release is cut by the Release workflow (`.github/workflows/release.yml`) with
[Changesets](https://github.com/changesets/changesets). Nobody bumps a version, pushes a tag or
edits a `CHANGELOG.md` by hand.

Four packages are released. `.changeset/config.json` puts the bot and `@laplace.live/eidolon` in
one `fixed` group so they always share a version, while `@laplace.live/eidolon-sdk` and the desktop
app, `laplace-eidolon-desktop`, each version independently.

| Package | Folder | A release makes |
| --- | --- | --- |
| `laplace-eidolon` | `apps/bot` | the tag `laplace-eidolon@X.Y.Z`, its GitHub Release, and the images |
| `@laplace.live/eidolon` | `apps/eidolon` | the tag `@laplace.live/eidolon@X.Y.Z`, its GitHub Release, and the npm package |
| `@laplace.live/eidolon-sdk` | `packages/sdk` | the tag `@laplace.live/eidolon-sdk@X.Y.Z`, its GitHub Release, and the npm package |
| `laplace-eidolon-desktop` | `apps/desktop` | the tag `laplace-eidolon-desktop@X.Y.Z`, its GitHub Release, and the signed installers on R2 ([desktop.md](desktop.md#releasing)) |

The `@eidolon/*` workspace packages are never released; Changesets ignores them.

## Changesets

A user-facing bot change ships with a changeset in the same commit, naming both fixed-group
packages; a client SDK change names `@laplace.live/eidolon-sdk` (too, or alone); a change desktop
users get names `laplace-eidolon-desktop`, beside the fixed pair when the npm package ships it too:

```bash
pnpm changeset add --minor laplace-eidolon,@laplace.live/eidolon -m "feat: Remember a viewer's nickname"
pnpm changeset add --minor @laplace.live/eidolon-sdk -m "feat: Add useEidolonWatchdog hook"
pnpm changeset add --minor laplace-eidolon,@laplace.live/eidolon,laplace-eidolon-desktop -m "feat: Search a chat's history"
pnpm changeset add --patch laplace-eidolon-desktop -m "fix: Reopen the window where it was closed"
```

Desktop users get the local app, the web app, the CLI the app ships, and the shell in
`apps/desktop`; a change to production alone, or to the npm launcher alone, doesn't name the
desktop app. Its version line is its own, so 0.1.0 can ship beside the npm package's 0.14.

The fixed group bumps both packages whichever one a changeset names, but each `CHANGELOG.md`
lists only the changesets that name its own package. A changeset that names only one leaves the
other's release notes without that line, or saying "No changes in this release." when it was the
only one. `--minor`, `--patch` and the summary's form are in
[AGENTS.md](../AGENTS.md#shipping-a-change). The summary's prefix is its kind in
[changelog.json](#changelogjson), and `.changeset/changelog.mjs` leaves it out of `CHANGELOG.md`.

## The version PR

On every push to `master` while changesets are pending, the workflow keeps a `chore: version
packages` PR open. Its commit is `pnpm run version`:

1. `changeset status --output=.changeset/.status.json` saves what the release holds: each
   changeset's summary and packages, and each package's new version.
2. `changeset version` bumps `apps/bot/package.json`, `apps/eidolon/package.json`,
   `packages/sdk/package.json` and/or `apps/desktop/package.json`, adds each package's entry to its
   `CHANGELOG.md`, and deletes the changesets.
3. `apps/bot/scripts/sync-version.ts` copies the version into `packages/runtime/src/rtvi.ts`,
   and into the Python reference implementation's `pyproject.toml`, `uv.lock` and bot entry
   point (AGENTS.md, "The Python").
4. `node scripts/changelog.ts sync` adds the release to [changelog.json](#changelogjson) from the
   saved status, and deletes it.

The PR runs the full CI. `pnpm-lock.yaml` records no workspace package's own version, so the bump
leaves it as it is.

## changelog.json

`changelog.json`, at the root, is every release of every released package in one file, newest
first: the website shows it, and the desktop app's update box shows its slice. No `CHANGELOG.md`
can: each lists only its own package's changes, and without their kind.

```json
{
  "schema": 1,
  "releases": [
    {
      "date": "2026-11-22T19:41:36.000Z",
      "versions": { "@laplace.live/eidolon": "0.14.0", "laplace-eidolon": "0.14.0" },
      "items": [
        {
          "kind": "fix",
          "packages": ["@laplace.live/eidolon", "laplace-eidolon"],
          "text": "Stop a cancelled ingest at once, even while it waits out an embedding quota error"
        }
      ]
    }
  ]
}
```

A release is what one `changeset version` released, so `versions` names each package it bumped
and no other; an item is one changeset, with every package it named and its summary as `text`.
The `kind` is the summary's prefix: `feat:` is `feature`, `perf:` is `performance`, `fix:` and
`revert:` are `fix`, `chore:`, `refactor:`, `docs:` and their like are `improvement`, and anything
else is `other` (`classify` in [scripts/changelog.ts](../scripts/changelog.ts)). The shape is
laplace-persona's, so the website reads both apps' files alike.

- **`pnpm run version` writes it**, in the version PR: `sync` adds the release from the status
  saved before `changeset version` consumed the changesets, dated when the PR was last updated.
  It records a summary whole, so a second line would reach the website; the update box shows
  only the first.
- **`pnpm changelog:backfill` rebuilds it** from the release tags and the `CHANGELOG.md`
  sections they name, so it needs the whole history and every tag (`git fetch --tags`). The tags
  one `changeset publish` left on a commit make one release, dated by that commit. Each item's
  kind is the prefix of the changeset its version commit deleted; a bullet with no changeset in
  the history gets one from its opening verb and its bump, which only the SDK's 0.1.0, published
  by hand, needs. That version has no tag either, so its release is dated by the commit that
  wrote its section. A re-run rewrites the whole file, `sync`'s dates with the tags'.
- **The website reads it** at `https://downloads.vrp.moe/eidolon/changelog.json`, where each
  desktop release uploads it: a release of the npm package or the SDK alone reaches that copy
  with the next desktop one. The repository's file is always current.
- **The update manifest carries the desktop's slice.** `node scripts/changelog.ts manifest`
  prints one line, `eidolonNotes: [...]`: the desktop app's 10 newest releases (`MANIFEST_LIMIT`)
  as JSON, which is YAML, for desktop.yml to append to `latest-mac.yml` and `latest.yml`.
  electron-updater parses the whole manifest, so the notes arrive with the version check's own
  request, frozen as they were when the release uploaded it.
  `apps/desktop/src/shared/release-notes.ts` reads them as remote input, keeps the releases of
  the desktop app after the running version and up to the offered one, with only the items whose
  changesets named `laplace-eidolon-desktop` (`notesBetween`), and writes them as the box's text:
  a line per item after its kind's label, at most 8, and a line that counts the rest, each line
  and version heading cut at 200 characters.

`scripts/changelog.test.ts` covers the script, with `pnpm run version`'s own steps in a fixture
repository, and `apps/desktop/test/release-notes.test.ts` the desktop's side.

## Tags, GitHub Releases and images

When the version PR merges, no changeset is pending, so the workflow runs `pnpm release`
(`pnpm build:npm && pnpm build:sdk && changeset publish`). `changeset publish` publishes each
unpublished non-private package to npm and tags every released package whose current version has no
tag yet (`laplace-eidolon@X.Y.Z` and `laplace-eidolon-desktop@X.Y.Z` via `privatePackages.tag`,
`@laplace.live/eidolon@X.Y.Z` and/or `@laplace.live/eidolon-sdk@X.Y.Z`). The action pushes the new
tags and creates a GitHub Release for each from its `CHANGELOG.md` entry.

- **A GitHub App pushes the tags.** Events caused by the workflow's own `GITHUB_TOKEN` start no
  other workflow, so the laplace-release-bot App's token (the `RELEASE_APP_CLIENT_ID` and
  `RELEASE_APP_PRIVATE_KEY` org secrets) does it.
- **`laplace-eidolon@X.Y.Z` builds the images.** It fires `docker.yml`, which pushes
  `ghcr.io/laplace-live/eidolon` and `ghcr.io/laplace-live/eidolon-python` tagged `X.Y.Z`, `X.Y`
  and `X`. `@laplace.live/eidolon@X.Y.Z` and `@laplace.live/eidolon-sdk@X.Y.Z` match no workflow's
  trigger and build no image.
- **`laplace-eidolon-desktop@X.Y.Z` releases the desktop app.** It fires `desktop.yml` in the tagged
  commit, which checks that the commit is on master and the tag names the package's version, signs
  and notarizes each platform's build, checks it, and uploads it to R2, where installs update from
  ([desktop.md](desktop.md#releasing)). Its GitHub Release carries the notes, not the installers.
  `desktop.yml` signs with the org's Apple and Azure secrets and uploads with the repository's R2
  ones ([desktop.md](desktop.md#secrets)). A run of it that fails is re-run with "Re-run failed
  jobs", never "Re-run all jobs" once its upload began ([desktop.md](desktop.md#recovery)).
- **Production follows `:edge`, not the tags.** Every push to `master` that `docker.yml` doesn't
  ignore rebuilds `:edge`, and Watchtower restarts the production bot from it
  ([AGENTS.md](../AGENTS.md#shipping-a-change)).

## Publishing to npm

`apps/eidolon/package.json` and `packages/sdk/package.json` are non-private workspace packages with
`"publishConfig": { "access": "public", "provenance": true, "directory": "pack" }`; the SDK's also
sets `"linkDirectory": false`, so the workspace links it from its own folder, not from `pack/`.

In the single `release` job (`id-token: write`):

1. `pnpm build:npm` and `pnpm build:sdk` stage publishable directories into `apps/eidolon/pack`
   and `packages/sdk/pack` (bundled code and web assets, normalized ESM/declaration exports,
   stripped `workspace:*` `devDependencies`, and `publishConfig: { access: "public", provenance: true }`).
2. `changeset publish` asks the registry (`pnpm info`), skips versions already published, and runs
   `pnpm publish --access public --tag latest --no-git-checks` in each unpublished package's folder,
   which publishes its `publishConfig.directory`, `pack/`, under `pack/package.json`.
3. pnpm exchanges the job's GitHub OIDC token for a short-lived publish token through the package's
   trusted publisher and attaches build provenance, so no `NPM_TOKEN` secret is stored anywhere.

`pnpm pack:npm` and `pnpm pack:sdk` remain available locally and in CI (`ci-install-check.ts`)
to inspect or smoke-test packed tarballs offline.

When `release` fails before `pnpm publish` finishes, fix the cause and re-run the failed job:
`changeset publish` re-checks the registry and publishes and tags whatever is still missing on npm.
If `pnpm publish` succeeded for a public package (`@laplace.live/eidolon` or
`@laplace.live/eidolon-sdk`) before a later step failed, a fresh run sees that version on npm and
skips its tag and GitHub Release (`privatePackages.tag` re-checks missing tags only for the private
packages, `laplace-eidolon` and `laplace-eidolon-desktop`, so a re-run tags those): push the missing
`<pkg>@<version>` tag on the release commit and create its GitHub Release with `gh release create`
from `CHANGELOG.md`. An authentication error means npm found no trusted publisher matching the
job: check the workflow file name (`release.yml`) in the package's settings on npmjs.com.

## Setting up npm publishing

`@laplace.live/eidolon` and `@laplace.live/eidolon-sdk` are already configured with GitHub Actions
Trusted Publishing (`laplace-live/eidolon`, workflow `release.yml`). To bootstrap any new public
package in a public repository (npm refuses `--provenance` from private repositories):

1. **Create the initial version on npm.** npm can only attach a trusted publisher to an existing
   package. Stage its `pack/` directory and publish once from an npm account with 2FA that can
   publish to `@laplace.live` (temporarily omitting `provenance: true` for a local publish, or
   using `npm stage publish` + `npm stage approve` on npm 12):

   ```bash
   pnpm install --frozen-lockfile
   pnpm build:sdk
   npm publish ./packages/sdk/pack --access public --no-provenance
   ```

2. **Configure the trusted publisher** (expires in 2 days until its first workflow publish):

   ```bash
   npm trust github @laplace.live/eidolon --file release.yml --repo laplace-live/eidolon --allow-publish
   npm trust github @laplace.live/eidolon-sdk --file release.yml --repo laplace-live/eidolon --allow-publish
   ```

3. **Merge the version PR** so `release.yml` publishes through the trusted publisher with provenance,
   then set the package's Publishing access on npmjs.com to "Require two-factor authentication and
   disallow tokens".

To move publishing to another workflow file, update the package's trusted publisher on npmjs.com to
name the new workflow file.
