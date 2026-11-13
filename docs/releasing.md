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
   `pack/` folder — no intermediate `.tgz` tarballs, cross-job artifacts, or toggle variables.
3. npm exchanges the job's GitHub OIDC token for a short-lived publish token through the package's
   trusted publisher and records build provenance, so no `NPM_TOKEN` secret is stored anywhere.

`bun run pack:npm` and `bun run pack:sdk` remain available locally and in CI (`ci-install-check.ts`)
to inspect or smoke-test packed tarballs offline.

When `release` fails before finishing a publish, fix the cause and re-run the failed job:
`changeset publish` re-checks the registry and publishes and tags whatever is still missing. An
`ENEEDAUTH` error means npm found no trusted publisher matching the job: check the workflow file
name (`release.yml`) in the package's settings on npmjs.com.

## Setting up npm publishing

`@laplace.live/eidolon` and `@laplace.live/eidolon-sdk` are already configured with GitHub Actions
Trusted Publishing (`laplace-live/eidolon`, workflow `release.yml`). To bootstrap any new public
package in a public repository (npm refuses `--provenance` from private repositories):

1. **Create the initial version on npm.** npm can only attach a trusted publisher to an existing
   package. Stage its `pack/` directory with the image's Bun version and publish once from an npm
   account with 2FA that can publish to `@laplace.live` (temporarily omitting `provenance: true`
   for a local publish, or using `npm stage publish` + `npm stage approve` on npm 12):

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
