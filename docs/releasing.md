# Releasing

Every release is cut by the Release workflow (`.github/workflows/release.yml`) with
[Changesets](https://github.com/changesets/changesets). Nobody bumps a version, pushes a tag or
edits a `CHANGELOG.md` by hand.

Three packages are released. `.changeset/config.json` puts the bot and `@laplace.live/eidolon` in
one `fixed` group so they always share a version, while `@laplace.live/eidolon-sdk` versions
independently.

| Package | Folder | A release makes |
| --- | --- | --- |
| `laplace-eidolon` | `apps/bot` | the tag `laplace-eidolon@X.Y.Z`, its GitHub Release, and the images |
| `@laplace.live/eidolon` | `apps/eidolon` | the tag `@laplace.live/eidolon@X.Y.Z`, its GitHub Release, and the npm package |
| `@laplace.live/eidolon-sdk` | `packages/sdk` | the tag `@laplace.live/eidolon-sdk@X.Y.Z`, its GitHub Release, and the npm package |

The `@eidolon/*` workspace packages are never released; Changesets ignores them.

## Changesets

A user-facing bot change ships with a changeset in the same commit, naming both fixed-group
packages; a client SDK change names `@laplace.live/eidolon-sdk` (too, or alone):

```bash
bunx changeset add --minor laplace-eidolon,@laplace.live/eidolon -m "feat: Remember a viewer's nickname"
bunx changeset add --minor @laplace.live/eidolon-sdk -m "feat: Add useEidolonWatchdog hook"
```

The fixed group bumps both packages whichever one a changeset names, but each `CHANGELOG.md`
lists only the changesets that name its own package. A changeset that names only one leaves the
other's release notes without that line, or saying "No changes in this release." when it was the
only one. `--minor`, `--patch` and the summary's form are in
[AGENTS.md](../AGENTS.md#shipping-a-change). The summary's prefix is its kind in
[changelog.json](#changelogjson), and `.changeset/changelog.mjs` leaves it out of `CHANGELOG.md`.

## The version PR

On every push to `master` while changesets are pending, the workflow keeps a `chore: version
packages` PR open. Its commit is `bun run version`:

1. `changeset status --output=.changeset/.status.json` saves what the release holds: each
   changeset's summary and packages, and each package's new version.
2. `changeset version` bumps `apps/bot/package.json`, `apps/eidolon/package.json` and/or
   `packages/sdk/package.json`, adds each package's entry to its `CHANGELOG.md`, and deletes the
   changesets.
3. `apps/bot/scripts/sync-version.ts` copies the version into `packages/runtime/src/rtvi.ts`,
   and into the Python reference implementation's `pyproject.toml`, `uv.lock` and bot entry
   point (AGENTS.md, "The Python").
4. `node scripts/changelog.ts sync` adds the release to [changelog.json](#changelogjson) from the
   saved status, and deletes it.

The PR runs the full CI. `bun.lock` keeps the old workspace versions until a later `bun install`
rewrites them, which `--frozen-lockfile` tolerates.

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

- **`bun run version` writes it**, in the version PR: `sync` adds the release from the status
  saved before `changeset version` consumed the changesets, dated when the PR was last updated.
  It records a summary whole, so a second line would reach the website; the update box shows
  only the first.
- **`bun run changelog:backfill` rebuilds it** from the release tags and the `CHANGELOG.md`
  sections they name, so it needs the whole history and every tag (`git fetch --tags`). The tags
  one `changeset publish` left on a commit make one release, dated by that commit. Each item's
  kind is the prefix of the changeset its version commit deleted; a bullet with no changeset in
  the history gets one from its opening verb and its bump, which only the SDK's 0.1.0, published
  by hand, needs. That version has no tag either, so its release is dated by the commit that
  wrote its section. A re-run rewrites the whole file, `sync`'s dates with the tags'.
- **The website reads it** at `https://downloads.vrp.moe/eidolon/changelog.json`, where the
  desktop's release uploads it.
- **The update manifest carries the desktop's slice.** `node scripts/changelog.ts manifest`
  prints one line, `eidolonNotes: [...]`: the desktop app's 10 newest releases (`MANIFEST_LIMIT`)
  as JSON, which is YAML, for desktop.yml to append to `latest-mac.yml` and `latest.yml`.
  electron-updater parses the whole manifest, so the notes arrive with the version check's own
  request, frozen as they were when the release uploaded it.
  `apps/desktop/src/shared/release-notes.ts` reads them as remote input, keeps the releases of
  the desktop app after the running version and up to the offered one, with their items about the
  app or the backend it ships (none about the SDK alone), and writes them as the box's text: a
  line per item after its kind's label, at most 8, and a line that counts the rest.

`scripts/changelog.test.ts` covers the script, with `bun run version`'s own steps in a fixture
repository, and `apps/desktop/test/release-notes.test.ts` the desktop's side.

## Tags, GitHub Releases and images

When the version PR merges, no changeset is pending, so the workflow runs `bun run release`
(`bun run build:npm && bun run build:sdk && changeset publish`). `changeset publish` publishes each
unpublished non-private package to npm and tags every released package whose current version has no
tag yet (`laplace-eidolon@X.Y.Z` via `privatePackages.tag`, `@laplace.live/eidolon@X.Y.Z` and/or
`@laplace.live/eidolon-sdk@X.Y.Z`). The action pushes the new tags and creates a GitHub Release for
each from its `CHANGELOG.md` entry.

- **A GitHub App pushes the tags.** Events caused by the workflow's own `GITHUB_TOKEN` start no
  other workflow, so the laplace-release-bot App's token (the `RELEASE_APP_CLIENT_ID` and
  `RELEASE_APP_PRIVATE_KEY` org secrets) does it.
- **`laplace-eidolon@X.Y.Z` builds the images.** It fires `docker.yml`, which pushes
  `ghcr.io/laplace-live/eidolon` and `ghcr.io/laplace-live/eidolon-python` tagged `X.Y.Z`, `X.Y`
  and `X`. `@laplace.live/eidolon@X.Y.Z` and `@laplace.live/eidolon-sdk@X.Y.Z` match no workflow's
  trigger and build no image.
- **Production follows `:edge`, not the tags.** Every push to `master` that `docker.yml` doesn't
  ignore rebuilds `:edge`, and Watchtower restarts the production bot from it
  ([AGENTS.md](../AGENTS.md#shipping-a-change)).

## Publishing to npm

`apps/eidolon/package.json` and `packages/sdk/package.json` are non-private workspace packages with
`"publishConfig": { "access": "public", "provenance": true, "directory": "pack" }` (and a `prepack`
guard that rejects accidental `npm publish` of the unbuilt workspace folder).

In the single `release` job (`id-token: write`, Node 24's npm):

1. `bun run build:npm` and `bun run build:sdk` stage publishable directories into `apps/eidolon/pack`
   and `packages/sdk/pack` (bundled code and web assets, normalized ESM/declaration exports,
   stripped `workspace:*` `devDependencies`, and `publishConfig: { access: "public", provenance: true }`).
2. `changeset publish` queries the npm registry, skips versions already published, and runs
   `npm publish <pack-dir> --access public --tag latest` directly against each unpublished package's
   `pack/` folder.
3. npm exchanges the job's GitHub OIDC token for a short-lived publish token through the package's
   trusted publisher and records build provenance, so no `NPM_TOKEN` secret is stored anywhere.

`bun run pack:npm` and `bun run pack:sdk` remain available locally and in CI (`ci-install-check.ts`)
to inspect or smoke-test packed tarballs offline.

When `release` fails before `npm publish` finishes, fix the cause and re-run the failed job:
`changeset publish` re-checks the registry and publishes and tags whatever is still missing on npm.
If `npm publish` succeeded for a public package (`@laplace.live/eidolon` or
`@laplace.live/eidolon-sdk`) before a later step failed, a fresh run sees that version on npm and
skips its tag and GitHub Release (`privatePackages.tag` re-checks missing tags only for private
`laplace-eidolon`): push the missing `<pkg>@<version>` tag on the release commit and create its
GitHub Release with `gh release create` from `CHANGELOG.md`. An `ENEEDAUTH` error means npm found
no trusted publisher matching the job: check the workflow file name (`release.yml`) in the
package's settings on npmjs.com.

## Setting up npm publishing

`@laplace.live/eidolon` and `@laplace.live/eidolon-sdk` are already configured with GitHub Actions
Trusted Publishing (`laplace-live/eidolon`, workflow `release.yml`). To bootstrap any new public
package in a public repository (npm refuses `--provenance` from private repositories):

1. **Create the initial version on npm.** npm can only attach a trusted publisher to an existing
   package. Stage its `pack/` directory and publish once from an npm account with 2FA that can
   publish to `@laplace.live` (temporarily omitting `provenance: true` for a local publish, or
   using `npm stage publish` + `npm stage approve` on npm 12):

   ```bash
   bun install --frozen-lockfile
   bun run build:sdk
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
