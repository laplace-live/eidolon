// Stock changelog-git output, minus the kind prefix (`feat:`, `fix(scope):`, …) every changeset summary starts
// with, so it stays out of CHANGELOG.md and the GitHub Release body; scripts/changelog.ts, which owns the
// prefixes, keeps it as changelog.json's kind. Plain .mjs because changesets imports it with its own resolver
// during `changeset version`, on Node, which strips the script's types.

import changelogGit from '@changesets/cli/changelog'
import { classify } from '../scripts/changelog.ts'

const changelogFunctions = {
  ...changelogGit,
  getReleaseLine: (changeset, type, options) =>
    changelogGit.getReleaseLine({ ...changeset, summary: classify(changeset.summary).text }, type, options),
}

export default changelogFunctions
