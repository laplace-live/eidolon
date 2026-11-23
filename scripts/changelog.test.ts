import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  DESKTOP_PACKAGE,
  parseReleaseNotes,
  type ReleaseNoteEntry,
} from "../apps/desktop/src/shared/release-notes.ts";
import {
  backfillReleases,
  type Changelog,
  changelogSections,
  classify,
  consumedKinds,
  inferKind,
  MANIFEST_LIMIT,
  manifestLine,
  readChangelog,
  sectionBullets,
  sync,
  tagBatches,
} from "./changelog.ts";

const ROOT = join(import.meta.dirname, "..");

/** Two releases of apps/bot/CHANGELOG.md, and the SDK's first, which has no commit. */
const CHANGELOG_MD = `# laplace-eidolon

## 0.13.0

### Minor Changes

- db9d808: Run on Windows x64, where tasks run their commands in Git Bash
- 096fb88: Send her images and text files in chats, in the app and through the SDK

### Patch Changes

- bc0e211: A floating message box in chats, its buttons and permission picker inside it
- 1a2b3c4: A headline
  with a second line
- Updated dependencies [abcdef0]
  - @laplace.live/eidolon-sdk@0.2.0

## 0.1.0

### Minor Changes

- Publish \`@laplace.live/eidolon-sdk\` for WebRTC calls and stateless chats
`;

/** A temporary folder, removed when the test that made it finishes. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-changelog-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

describe("classify", () => {
  test("takes the kind from the summary's prefix, and leaves the prefix out of the text", () => {
    expect(classify("feat: Call her")).toEqual({ kind: "feature", text: "Call her" });
    expect(classify("fix(desktop)!: Keep the window")).toEqual({
      kind: "fix",
      text: "Keep the window",
    });
    expect(classify("perf: Start faster")).toEqual({ kind: "performance", text: "Start faster" });
    expect(classify("chore: Run on Bun 1.4.5")).toEqual({
      kind: "improvement",
      text: "Run on Bun 1.4.5",
    });
  });

  test("calls a summary with no known prefix other, and keeps it whole", () => {
    expect(classify("Call her")).toEqual({ kind: "other", text: "Call her" });
    expect(classify("wip: Call her")).toEqual({ kind: "other", text: "wip: Call her" });
    expect(classify("constructor: Call her")).toEqual({
      kind: "other",
      text: "constructor: Call her",
    });
  });
});

describe("changelogSections and sectionBullets", () => {
  test("split a CHANGELOG.md by version", () => {
    expect([...changelogSections(CHANGELOG_MD).keys()]).toEqual(["0.13.0", "0.1.0"]);
  });

  test("read each bullet's commit, text and bump, and drop dependency bumps", () => {
    const sections = changelogSections(CHANGELOG_MD);
    expect(sectionBullets(sections.get("0.13.0") ?? "")).toEqual([
      {
        commit: "db9d808",
        text: "Run on Windows x64, where tasks run their commands in Git Bash",
        bump: "minor",
      },
      {
        commit: "096fb88",
        text: "Send her images and text files in chats, in the app and through the SDK",
        bump: "minor",
      },
      {
        commit: "bc0e211",
        text: "A floating message box in chats, its buttons and permission picker inside it",
        bump: "patch",
      },
      { commit: "1a2b3c4", text: "A headline\nwith a second line", bump: "patch" },
    ]);
    expect(sectionBullets(sections.get("0.1.0") ?? "")).toEqual([
      {
        commit: null,
        text: "Publish `@laplace.live/eidolon-sdk` for WebRTC calls and stateless chats",
        bump: "minor",
      },
    ]);
  });
});

describe("tagBatches", () => {
  test("groups the tags on one commit, dated in UTC, and skips other tags", () => {
    const refs = [
      "@laplace.live/eidolon-sdk@0.2.0\tea2a55e\t2026-11-21T04:33:30+08:00",
      "@laplace.live/eidolon@0.13.0\tea2a55e\t2026-11-21T04:33:30+08:00",
      "laplace-eidolon@0.13.0\tea2a55e\t2026-11-21T04:33:30+08:00",
      "laplace-eidolon@0.12.0\t4f5fe19\t2026-11-20T17:36:15+08:00",
      "spike\tabcdef0\t2026-11-19T00:00:00Z",
      "",
    ].join("\n");
    expect(tagBatches(refs)).toEqual([
      {
        commit: "ea2a55e",
        date: "2026-11-20T20:33:30.000Z",
        tags: [
          { name: "@laplace.live/eidolon-sdk", version: "0.2.0" },
          { name: "@laplace.live/eidolon", version: "0.13.0" },
          { name: "laplace-eidolon", version: "0.13.0" },
        ],
      },
      {
        commit: "4f5fe19",
        date: "2026-11-20T09:36:15.000Z",
        tags: [{ name: "laplace-eidolon", version: "0.12.0" }],
      },
    ]);
  });
});

describe("consumedKinds", () => {
  /** What `git log -p` prints for changesets a version commit deleted, newest commit first. */
  const deleted = (file: string, frontmatter: string[], summary: string[]) =>
    [
      `diff --git a/.changeset/${file} b/.changeset/${file}`,
      "deleted file mode 100644",
      "index 4012b87..0000000",
      `--- a/.changeset/${file}`,
      "+++ /dev/null",
      `@@ -1,${4 + frontmatter.length + summary.length} +0,0 @@`,
      "----",
      ...frontmatter.map((line) => `-${line}`),
      "----",
      "-",
      ...summary.map((line) => `-${line}`),
    ].join("\n");

  test("reads each consumed changeset's kind, by its text's first line", () => {
    const log = [
      deleted(
        "chatty-breads-decide.md",
        ['"laplace-eidolon": patch', '"@laplace.live/eidolon": patch'],
        ["fix: Muting your mic on a call in the local app stops sending your voice"],
      ),
      deleted(
        "tall-trees-grow.md",
        ['"laplace-eidolon": patch'],
        ["feat: A floating message box", "", "With its buttons inside it"],
      ),
      "",
      deleted("odd-owls-hoot.md", ['"laplace-eidolon": patch'], ["No prefix at all"]),
    ].join("\n");
    expect(consumedKinds(log)).toEqual(
      new Map([
        ["Muting your mic on a call in the local app stops sending your voice", "fix"],
        ["A floating message box", "feature"],
        ["No prefix at all", "other"],
      ]),
    );
  });

  test("keeps the newest of two changesets with one text", () => {
    const log = [
      deleted("newer.md", ['"laplace-eidolon": patch'], ["fix: Keep the mic"]),
      deleted("older.md", ['"laplace-eidolon": patch'], ["feat: Keep the mic"]),
    ].join("\n");
    expect(consumedKinds(log).get("Keep the mic")).toBe("fix");
  });
});

describe("inferKind", () => {
  test("goes by a decisive opening verb, then by the bump", () => {
    expect(inferKind("Fix the stale shortcut list", "minor")).toBe("fix");
    expect(inferKind("Add a tray icon", "patch")).toBe("feature");
    expect(inferKind("Calls start faster", "minor")).toBe("performance");
    expect(inferKind("Rename the data folder", "minor")).toBe("improvement");
    expect(inferKind("Publish the SDK for calls", "minor")).toBe("feature");
    expect(inferKind("A blue theme for the local app", "patch")).toBe("improvement");
  });
});

describe("backfillReleases", () => {
  const sections = new Map([
    [
      "laplace-eidolon",
      new Map([
        ["0.13.0", "### Minor Changes\n\n- 096fb88: Images in chats\n- db9d808: Run on Windows\n"],
        ["0.12.0", "### Patch Changes\n\n- 72fdd19: Update undici\n"],
      ]),
    ],
    [
      "@laplace.live/eidolon",
      new Map([["0.13.0", "### Minor Changes\n\n- 096fb88: Images in chats\n"]]),
    ],
    [
      "@laplace.live/eidolon-sdk",
      new Map([
        ["0.2.0", "### Patch Changes\n\n- 096fb88: Images in chats\n- 1234567: Keep the mic\n"],
      ]),
    ],
  ]);
  const sectionsOf = (name: string) => sections.get(name) ?? new Map<string, string>();

  test("makes a release of each batch, newest first, an item of each changeset", () => {
    const { releases, skipped, inferred } = backfillReleases(
      [
        {
          commit: "4f5fe19",
          date: "2026-11-20T09:36:15.000Z",
          tags: [{ name: "laplace-eidolon", version: "0.12.0" }],
        },
        {
          commit: "ea2a55e",
          date: "2026-11-20T20:33:30.000Z",
          tags: [
            { name: "laplace-eidolon", version: "0.13.0" },
            { name: "@laplace.live/eidolon-sdk", version: "0.2.0" },
            { name: "@laplace.live/eidolon", version: "0.13.0" },
            { name: "laplace-eidolon-desktop", version: "0.1.0" },
          ],
        },
      ],
      sectionsOf,
      new Map([
        ["Images in chats", "feature"],
        ["Keep the mic", "fix"],
        ["Update undici", "fix"],
      ]),
    );
    expect(releases).toEqual([
      {
        date: "2026-11-20T20:33:30.000Z",
        versions: {
          "@laplace.live/eidolon": "0.13.0",
          "@laplace.live/eidolon-sdk": "0.2.0",
          "laplace-eidolon": "0.13.0",
          "laplace-eidolon-desktop": "0.1.0",
        },
        items: [
          {
            kind: "feature",
            packages: ["@laplace.live/eidolon", "@laplace.live/eidolon-sdk", "laplace-eidolon"],
            text: "Images in chats",
          },
          { kind: "feature", packages: ["laplace-eidolon"], text: "Run on Windows" },
          { kind: "fix", packages: ["@laplace.live/eidolon-sdk"], text: "Keep the mic" },
        ],
      },
      {
        date: "2026-11-20T09:36:15.000Z",
        versions: { "laplace-eidolon": "0.12.0" },
        items: [{ kind: "fix", packages: ["laplace-eidolon"], text: "Update undici" }],
      },
    ]);
    expect(skipped).toEqual(["laplace-eidolon-desktop@0.1.0"]);
    expect(inferred).toEqual(["Run on Windows"]);
  });

  test("makes no release of a batch whose sections hold no items", () => {
    const { releases, skipped } = backfillReleases(
      [{ commit: "c", date: "2026-11-20T00:00:00.000Z", tags: [{ name: "x", version: "1.0.0" }] }],
      sectionsOf,
      new Map(),
    );
    expect(releases).toEqual([]);
    expect(skipped).toEqual(["x@1.0.0"]);
  });

  test("infers a change's kind from the largest bump any of its packages lists it under", () => {
    const bumps = new Map([
      ["a", new Map([["1.0.1", "### Patch Changes\n\n- 096fb88: Images in chats\n"]])],
      ["b", new Map([["1.1.0", "### Minor Changes\n\n- 096fb88: Images in chats\n"]])],
    ]);
    const { releases } = backfillReleases(
      [
        {
          commit: "c",
          date: "2026-11-20T00:00:00.000Z",
          tags: [
            { name: "b", version: "1.1.0" },
            { name: "a", version: "1.0.1" },
          ],
        },
      ],
      (name) => bumps.get(name) ?? new Map(),
      new Map(),
    );
    expect(releases[0]?.items).toEqual([
      { kind: "feature", packages: ["a", "b"], text: "Images in chats" },
    ]);
  });
});

describe("sync", () => {
  const older: ReleaseNoteEntry = {
    date: "2026-11-20T20:33:30.000Z",
    versions: { "laplace-eidolon": "0.13.0" },
    items: [{ kind: "feature", packages: ["laplace-eidolon"], text: "Run on Windows" }],
  };

  /** A repository's changelog.json and the status `bun run version` saved before versioning. */
  function snapshotRepo(status: unknown): string {
    const dir = tempDir();
    write(dir, "changelog.json", `${JSON.stringify({ schema: 1, releases: [older] })}\n`);
    write(dir, ".changeset/.status.json", JSON.stringify(status));
    return dir;
  }

  test("records the batch the status released before the ones there, and deletes the status", () => {
    const dir = snapshotRepo({
      changesets: [
        {
          id: "breezy-beers-press",
          summary: "fix: Estimate refinement costs at current prices",
          releases: [
            { name: "laplace-eidolon", type: "patch" },
            { name: "@laplace.live/eidolon", type: "patch" },
          ],
        },
        {
          id: "wild-ways-smoke",
          summary: "feat: Pick any provider in setup",
          releases: [
            { name: "laplace-eidolon", type: "minor" },
            { name: "laplace-eidolon-desktop", type: "none" },
          ],
        },
        { id: "empty-symbols-bake", summary: "", releases: [] },
      ],
      releases: [
        { name: "laplace-eidolon", type: "minor", oldVersion: "0.13.0", newVersion: "0.14.0" },
        {
          name: "@laplace.live/eidolon",
          type: "minor",
          oldVersion: "0.13.0",
          newVersion: "0.14.0",
        },
        {
          name: "laplace-eidolon-desktop",
          type: "none",
          oldVersion: "0.1.0",
          newVersion: "0.1.0",
        },
      ],
    });
    expect(sync(dir, new Date("2026-11-22T19:30:54.000Z"))).toBe(
      "recorded 2 items for laplace-eidolon@0.14.0, @laplace.live/eidolon@0.14.0",
    );
    expect(readChangelog(dir)).toEqual({
      schema: 1,
      releases: [
        {
          date: "2026-11-22T19:30:54.000Z",
          versions: { "laplace-eidolon": "0.14.0", "@laplace.live/eidolon": "0.14.0" },
          items: [
            { kind: "feature", packages: ["laplace-eidolon"], text: "Pick any provider in setup" },
            {
              kind: "fix",
              packages: ["@laplace.live/eidolon", "laplace-eidolon"],
              text: "Estimate refinement costs at current prices",
            },
          ],
        },
        older,
      ],
    });
    expect(existsSync(join(dir, ".changeset/.status.json"))).toBe(false);
  });

  test("records nothing without a status, or from one with no released changeset", () => {
    const none = tempDir();
    expect(sync(none)).toContain("nothing to record");
    expect(existsSync(join(none, "changelog.json"))).toBe(false);

    const empty = snapshotRepo({ changesets: [{ id: "e", summary: "", releases: [] }] });
    expect(sync(empty)).toContain("nothing to record");
    expect(readChangelog(empty)).toEqual({ schema: 1, releases: [older] });
    expect(existsSync(join(empty, ".changeset/.status.json"))).toBe(false);
  });
});

describe("manifestLine", () => {
  const release = (version: string | null, other = "0.20.0"): ReleaseNoteEntry => ({
    date: "2026-11-22T19:30:54.000Z",
    versions: {
      "laplace-eidolon": other,
      ...(version === null ? {} : { [DESKTOP_PACKAGE]: version }),
    },
    items: [{ kind: "fix", packages: [DESKTOP_PACKAGE], text: `“Quoted”: #${version}` }],
  });

  test(`is one line holding the desktop app's newest ${MANIFEST_LIMIT} releases`, () => {
    const desktop = Array.from({ length: MANIFEST_LIMIT + 2 }, (_, i) =>
      release(`0.${MANIFEST_LIMIT + 2 - i}.0`),
    );
    const changelog: Changelog = { schema: 1, releases: [release(null), ...desktop] };
    const line = manifestLine(changelog);
    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("eidolonNotes: ")).toBe(true);
    expect(JSON.parse(line.slice("eidolonNotes: ".length))).toEqual(
      desktop.slice(0, MANIFEST_LIMIT),
    );
  });

  test("parses as YAML at the end of a manifest, to what the dialog reads", () => {
    const changelog: Changelog = { schema: 1, releases: [release("0.2.0"), release("0.1.0")] };
    // The parser packages/config reads settings.yaml with; the root has no YAML parser of its own.
    const { parse } = createRequire(join(ROOT, "packages/config/package.json"))("yaml") as {
      parse(text: string): Record<string, unknown>;
    };
    const manifest = parse(
      `version: 0.2.0\nfiles:\n  - url: Eidolon-0.2.0-arm64-mac.zip\n    sha512: abc\n${manifestLine(changelog)}\n`,
    );
    expect(manifest.version).toBe("0.2.0");
    expect(parseReleaseNotes(manifest.eidolonNotes)).toEqual(changelog.releases);
  });
});

describe("changelog.json", () => {
  test("holds releases newest first, each one as the update's box reads it", () => {
    const { schema, releases } = readChangelog(ROOT);
    expect(schema).toBe(1);
    expect(releases.length).toBeGreaterThan(0);
    expect(parseReleaseNotes(releases)).toEqual(releases);
    const dates = releases.map((release) => Date.parse(release.date));
    expect(dates.every((date) => !Number.isNaN(date))).toBe(true);
    expect(dates).toEqual(dates.toSorted((a, b) => b - a));
    for (const release of releases) {
      for (const item of release.items) expect(item.packages.length).toBeGreaterThan(0);
    }
  });
});

describe("bun run version", () => {
  /**
   * A one-package workspace in its own git repository, with this repository's changesets plugin,
   * the script and its types, and two changesets.
   */
  function fixtureRepo(): string {
    const repo = tempDir();
    write(
      repo,
      "package.json",
      JSON.stringify({ private: true, type: "module", workspaces: ["packages/*"] }),
    );
    // manypkg takes a Bun workspace's root by its lockfile.
    write(repo, "bun.lock", "");
    for (const [name, version] of [
      ["fixture-app", "1.0.0"],
      ["fixture-lib", "2.0.0"],
    ]) {
      write(
        repo,
        `packages/${name}/package.json`,
        JSON.stringify({ name, version, private: true }),
      );
    }
    write(
      repo,
      ".changeset/config.json",
      JSON.stringify({
        changelog: "./changelog.mjs",
        commit: false,
        fixed: [],
        linked: [],
        access: "restricted",
        baseBranch: "master",
        updateInternalDependencies: "patch",
        ignore: [],
        privatePackages: { version: true, tag: true },
      }),
    );
    for (const file of [
      ".changeset/changelog.mjs",
      "scripts/changelog.ts",
      "apps/desktop/src/shared/release-notes.ts",
    ]) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      cpSync(join(ROOT, file), join(repo, file));
    }
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"), "junction");
    write(
      repo,
      ".changeset/brave-cats-sing.md",
      '---\n"fixture-app": minor\n"fixture-lib": patch\n---\n\nfeat: Sing along\n',
    );
    write(repo, ".changeset/calm-dogs-rest.md", '---\n"fixture-lib": patch\n---\n\nfix: Rest\n');
    git(repo, "init", "--quiet", "--initial-branch=master");
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "--message=fixture");
    return repo;
  }

  /** git with none of this machine's configuration, so no signing or hook runs in the fixture. */
  const ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };

  function git(repo: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: repo, env: ENV, encoding: "utf8" });
  }

  test("records the batch it versions, with each changeset's kind and packages", () => {
    const repo = fixtureRepo();
    const changeset = join(ROOT, "node_modules/@changesets/cli/bin.js");
    const script = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts
      .version as string;
    for (const step of script.split(" && ")) {
      const [command, ...args] = step.split(" ");
      // The fixture has no bot whose version to copy.
      if (step === "bun apps/bot/scripts/sync-version.ts") continue;
      if (command === "changeset") args.unshift(changeset);
      else if (command !== "node") throw new Error(`unknown step in the version script: ${step}`);
      execFileSync(process.execPath, args, { cwd: repo, env: ENV, stdio: "pipe" });
    }

    const lib = readFileSync(join(repo, "packages/fixture-lib/CHANGELOG.md"), "utf8");
    expect(lib).toMatch(/^- [0-9a-f]{7}: Sing along$/m);
    expect(lib).toMatch(/^- [0-9a-f]{7}: Rest$/m);
    const { releases } = readChangelog(repo);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.versions).toEqual({ "fixture-app": "1.1.0", "fixture-lib": "2.0.1" });
    expect(releases[0]?.items).toEqual([
      { kind: "feature", packages: ["fixture-app", "fixture-lib"], text: "Sing along" },
      { kind: "fix", packages: ["fixture-lib"], text: "Rest" },
    ]);
    expect(existsSync(join(repo, ".changeset/.status.json"))).toBe(false);
  });
});
