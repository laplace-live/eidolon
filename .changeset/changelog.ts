// Stock changelog-git output, minus the kind prefix (`feat:`, `fix(scope):`, …) every changeset
// summary starts with, so it stays out of CHANGELOG.md and the GitHub Release body;
// scripts/changelog.ts, which owns the prefixes, keeps it as changelog.json's kind.
import changelogGit from "@changesets/cli/changelog";
import { classify } from "../scripts/changelog.ts";

const changelogFunctions: typeof changelogGit = {
  ...changelogGit,
  getReleaseLine: (changeset, type, options) =>
    changelogGit.getReleaseLine(
      { ...changeset, summary: classify(changeset.summary).text },
      type,
      options,
    ),
};

export default changelogFunctions;
