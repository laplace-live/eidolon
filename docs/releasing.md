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
| `@laplace.live/eidolon` | `apps/eidolon` | the tag `@laplace.live/eidolon@X.Y.Z`, its GitHub Release, and the npm package once publishing is on |
| `@laplace.live/eidolon-sdk` | `packages/sdk` | the tag `@laplace.live/eidolon-sdk@X.Y.Z`, its GitHub Release, and the npm package once publishing is on |

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
[AGENTS.md](../AGENTS.md#shipping-a-change).

## The version PR

On every push to `master` while changesets are pending, the workflow keeps a `chore: version
packages` PR open. Its commit is `bun run version`:

1. `changeset version` bumps `apps/bot/package.json`, `apps/eidolon/package.json` and/or
   `packages/sdk/package.json`, adds each package's entry to its `CHANGELOG.md`, and deletes the
   changesets.
2. `apps/bot/scripts/sync-version.ts` copies the version into `packages/runtime/src/rtvi.ts`,
   and into the Python reference implementation's `pyproject.toml`, `uv.lock` and bot entry
   point (AGENTS.md, "The Python").

The PR runs the full CI. `bun.lock` keeps the old workspace versions until a later `bun install`
rewrites them, which `--frozen-lockfile` tolerates.

## Tags, GitHub Releases and images

When the version PR merges, no changeset is pending, so the workflow runs `bun run release`
(`changeset git-tag`), which tags every package whose current version has no tag yet:
`laplace-eidolon@X.Y.Z`, `@laplace.live/eidolon@X.Y.Z` and/or `@laplace.live/eidolon-sdk@X.Y.Z`.
The action pushes the new tags and creates a GitHub Release for each from its `CHANGELOG.md` entry.

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

The run that tags a new version publishes whichever of `@laplace.live/eidolon` and
`@laplace.live/eidolon-sdk` was tagged at `HEAD`, while the repository variable `NPM_PUBLISH` is
`true`. Unset, or anything else, and nothing is built or published.

- **`pack`** checks out the tagged commit, inspects `git tag --points-at HEAD`, runs
  `bun run pack:npm` (when `@laplace.live/eidolon@*` is tagged) and/or `bun run pack:sdk` (when
  `@laplace.live/eidolon-sdk@*` is tagged), and uploads the resulting tarball(s). It holds no
  token: the build runs every dev dependency's code, and any step in a job with `id-token: write`
  could mint the credential npm publishes with.
- **`publish`** holds only `id-token: write`. It downloads the tarball and runs
  `npm publish <tarball> --access public --provenance` with Node 24's npm. A tarball publishes
  without running its lifecycle scripts. npm trades the job's OIDC token for a short-lived publish
  token through the package's trusted publisher, so no npm token is stored anywhere. A version
  already on npm is skipped.

When `publish` fails, fix the cause and re-run the run's failed jobs; the tarball stays with the
run. An `ENEEDAUTH` error means npm found no trusted publisher matching the job: check the
workflow file name in the package's settings on npmjs.com. A run that pushed its tags but failed
before `pack` started can't be re-run into a publish, since its tags exist by then: publish that
version by hand, as in the first step below.

## Setting up npm publishing

Once, after the repository is public. npm refuses provenance from a private repository, so
`--provenance` fails the publish there.

1. **Publish the current version by hand.** npm can only trust a publisher for a package that
   exists. Check out each package's latest release tag (`laplace-eidolon@X.Y.Z` for the bot and
   `@laplace.live/eidolon-sdk@A.B.C` for the SDK, which versions independently), then, with the Bun
   the image runs (the build refuses another) and logged in to an npm account with 2FA that can
   publish to the `@laplace.live` scope:

   ```bash
   git checkout laplace-eidolon@X.Y.Z
   bun install --frozen-lockfile
   bun run pack:npm
   npm publish ./apps/eidolon/laplace.live-eidolon-X.Y.Z.tgz --access public

   git checkout @laplace.live/eidolon-sdk@A.B.C
   bun install --frozen-lockfile
   bun run pack:sdk
   npm publish ./packages/sdk/laplace.live-eidolon-sdk-A.B.C.tgz --access public
   ```

   Or stage it with npm 12, whose `npm stage publish` can create the package, and approve it with
   `npm stage approve <id>` or on npmjs.com.
2. **Configure the trusted publisher when a version PR is ready to merge.** A new configuration
   expires unless it publishes within 2 days. On npmjs.com, the package's Settings → Trusted
   publishing → GitHub Actions:
   - organization `laplace-live`, repository `eidolon`;
   - workflow `release.yml`, the file name only and case-sensitive;
   - no environment;
   - tick **npm publish**: a configuration made since 2026-09-03 allows only `npm stage publish`
     until it is ticked.

   Or, with npm 11.15 or later:

   ```bash
   npm trust github @laplace.live/eidolon --file release.yml --repo laplace-live/eidolon --allow-publish
   npm trust github @laplace.live/eidolon-sdk --file release.yml --repo laplace-live/eidolon --allow-publish
   ```

3. **Set the variable:** the repository's Settings → Secrets and variables → Actions → Variables,
   `NPM_PUBLISH` = `true`.
4. **Merge the version PR.** Its run publishes through the trusted publisher, with provenance.
5. **Close the token path:** the package's Settings → Publishing access → "Require two-factor
   authentication and disallow tokens". Trusted publishing keeps working.

To stop publishing, delete `NPM_PUBLISH`. To move the publish to another workflow file, the
trusted publisher must name it: delete the configuration and create one for the new file.
