// Writes changelog.json, every released package's changes in one file, which the website reads and
// the desktop's update manifest carries: a CHANGELOG.md drops a change's kind and the other packages
// it touched. `sync` records what `changeset version` just released (`pnpm run version`), `backfill`
// rebuilds the history from the release tags, and `manifest` prints the manifest's line.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  CHANGE_KIND_ORDER,
  type ChangeKind,
  DESKTOP_PACKAGE,
  type ReleaseNoteEntry,
  type ReleaseNoteItem,
} from "../apps/desktop/src/shared/release-notes.ts";

export interface Changelog {
  readonly schema: 1;
  readonly releases: readonly ReleaseNoteEntry[];
}

/** The desktop app's releases its update manifest carries; one further behind sees these. */
export const MANIFEST_LIMIT = 10;

const CHANGELOG = "changelog.json";
/** What `changeset status` saw before `changeset version` consumed the changesets. */
const STATUS = ".changeset/.status.json";

const KIND_BY_PREFIX = new Map<string, ChangeKind>([
  ["build", "improvement"],
  ["chore", "improvement"],
  ["ci", "improvement"],
  ["docs", "improvement"],
  ["feat", "feature"],
  ["feature", "feature"],
  ["fix", "fix"],
  ["improve", "improvement"],
  ["improvement", "improvement"],
  ["other", "other"],
  ["perf", "performance"],
  ["refactor", "improvement"],
  ["revert", "fix"],
  ["style", "improvement"],
  ["test", "improvement"],
]);

/**
 * A changeset summary's kind, from its `feat:` or `fix(scope)!:` prefix, and its text without the
 * prefix, which .changeset/changelog.mjs writes to CHANGELOG.md. With no prefix it knows, `other`.
 */
export function classify(summary: string): { kind: ChangeKind; text: string } {
  const trimmed = summary.trim();
  const match = /^([a-z]+)(?:\([^)]*\))?!?:[ \t]+/.exec(trimmed);
  const kind = match ? KIND_BY_PREFIX.get(match[1] as string) : undefined;
  if (!match || kind === undefined) return { kind: "other", text: trimmed };
  return { kind, text: trimmed.slice(match[0].length).trim() };
}

function firstLine(text: string): string {
  return (text.trim().split("\n", 1)[0] as string).trim();
}

function sortItems(items: ReleaseNoteItem[]): ReleaseNoteItem[] {
  return items.toSorted(
    (a, b) => CHANGE_KIND_ORDER.indexOf(a.kind) - CHANGE_KIND_ORDER.indexOf(b.kind),
  );
}

export function readChangelog(root: string): Changelog {
  const path = join(root, CHANGELOG);
  if (!existsSync(path)) return { schema: 1, releases: [] };
  return JSON.parse(readFileSync(path, "utf8")) as Changelog;
}

function writeChangelog(root: string, changelog: Changelog): void {
  writeFileSync(join(root, CHANGELOG), `${JSON.stringify(changelog, null, 2)}\n`);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
}

interface Status {
  readonly changesets?: readonly {
    readonly summary: string;
    readonly releases: readonly { readonly name: string; readonly type: string }[];
  }[];
  readonly releases?: readonly {
    readonly name: string;
    readonly type: string;
    readonly newVersion: string;
  }[];
}

/**
 * Adds the batch `changeset version` released to changelog.json, from the status saved before it
 * ran, and deletes that status. A `none` bump releases nothing, and an empty changeset says nothing.
 */
export function sync(root: string, now = new Date()): string {
  const path = join(root, STATUS);
  if (!existsSync(path)) return `no ${STATUS}: nothing to record`;
  const status = JSON.parse(readFileSync(path, "utf8")) as Status;
  rmSync(path, { force: true });

  const versions: Record<string, string> = {};
  for (const release of status.releases ?? []) {
    if (release.type !== "none") versions[release.name] = release.newVersion;
  }
  const items = sortItems(
    (status.changesets ?? []).flatMap((changeset) => {
      const packages = changeset.releases
        .filter((release) => release.type !== "none")
        .map((release) => release.name)
        .sort();
      const { kind, text } = classify(changeset.summary);
      return packages.length > 0 && text.length > 0 ? [{ kind, packages, text }] : [];
    }),
  );
  if (items.length === 0) return "the status released no changeset: nothing to record";

  const { releases } = readChangelog(root);
  writeChangelog(root, {
    schema: 1,
    releases: [{ date: now.toISOString(), versions, items }, ...releases],
  });
  const released = Object.entries(versions).map(([name, version]) => `${name}@${version}`);
  return `recorded ${items.length} item${items.length === 1 ? "" : "s"} for ${released.join(", ")}`;
}

/** A CHANGELOG.md's body under each `## <version>` heading. */
export function changelogSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let version: string | null = null;
  let body: string[] = [];
  for (const line of markdown.split("\n")) {
    const heading = /^## +(.+?) *$/.exec(line);
    if (heading) {
      if (version !== null) sections.set(version, body.join("\n"));
      version = heading[1] as string;
      body = [];
    } else if (version !== null) body.push(line);
  }
  if (version !== null) sections.set(version, body.join("\n"));
  return sections;
}

export interface Bullet {
  /** The short hash changesets wrote before the text: the commit that added its changeset. */
  readonly commit: string | null;
  readonly text: string;
  readonly bump: string;
}

/** A section's changes, each with the bump it is listed under; not its dependency bumps. */
export function sectionBullets(section: string): Bullet[] {
  const bullets: { text: string; bump: string }[] = [];
  let bump = "patch";
  for (const line of section.split("\n")) {
    const heading = /^### +(Major|Minor|Patch) Changes/.exec(line);
    if (heading) bump = (heading[1] as string).toLowerCase();
    else if (line.startsWith("- ")) bullets.push({ text: line.slice(2), bump });
    else if (/^ {2}\S/.test(line) && bullets.length > 0) {
      (bullets.at(-1) as { text: string }).text += `\n${line.slice(2)}`;
    }
  }
  return bullets
    .filter((bullet) => !bullet.text.startsWith("Updated dependencies"))
    .map((bullet) => {
      const hash = /^([0-9a-f]{7,40}): /.exec(bullet.text);
      const text = hash ? bullet.text.slice(hash[0].length) : bullet.text;
      return { commit: hash ? (hash[1] as string) : null, text: text.trim(), bump: bullet.bump };
    })
    .filter((bullet) => bullet.text.length > 0);
}

// The opening clause's verb, where one decides; changesets hold their kind, so this reads only
// bullets with no changeset left in the history.
const KIND_PROSE: readonly (readonly [RegExp, ChangeKind])[] = [
  [/^(?:fix|correct|stop)\b/i, "fix"],
  [/^(?:add|introduce|first public release)\b/i, "feature"],
  [/^New [A-Z]/, "feature"],
  [
    /\b(?:performance|faster|smoother|halving|responsive)\b|\bcut\w* (?:GPU|CPU|memory|power)/i,
    "performance",
  ],
  [
    /^(?:clarify|click|drop|group|highlight|merge|remove|rename|replace|set|show|update|use)\b|\b(?:is|are) now\b/i,
    "improvement",
  ],
];

/** A CHANGELOG.md bullet's kind by its prose: a decisive verb, else a minor is new. */
export function inferKind(text: string, bump: string): ChangeKind {
  const clause = text.split(/[\n.:;]/, 1)[0] as string;
  for (const [pattern, kind] of KIND_PROSE) if (pattern.test(clause)) return kind;
  return bump === "patch" ? "improvement" : "feature";
}

/** The kind of each changeset a version commit deleted, by its text's first line, newest first. */
export function consumedKinds(log: string): Map<string, ChangeKind> {
  const kinds = new Map<string, ChangeKind>();
  const record = (lines: string[]) => {
    const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
    const { kind, text } = classify(lines.slice(end + 1).join("\n"));
    const key = firstLine(text);
    if (key.length > 0 && !kinds.has(key)) kinds.set(key, kind);
  };
  let file: string[] | null = null;
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (file) record(file);
      file = null;
    } else if (line.startsWith("@@ ")) file = [];
    else if (file && line.startsWith("-")) file.push(line.slice(1));
  }
  if (file) record(file);
  return kinds;
}

/** The release tags one `changeset publish` left on a commit, or the sections one commit wrote. */
export interface TagBatch {
  readonly commit: string;
  readonly date: string;
  readonly tags: { readonly name: string; readonly version: string }[];
}

const TAG_FORMAT = [
  "%(refname:strip=2)",
  "%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)",
  "%(if)%(*committerdate:iso-strict)%(then)%(*committerdate:iso-strict)%(else)%(committerdate:iso-strict)%(end)",
].join("%09");

/** `<package>@<version>` tags, from `git for-each-ref` in TAG_FORMAT, by the commit they peel to. */
export function tagBatches(refs: string): TagBatch[] {
  const batches = new Map<string, TagBatch>();
  for (const line of refs.split("\n")) {
    const [ref = "", commit = "", date = ""] = line.split("\t");
    const tag = /^(.+)@(\d[^@]*)$/.exec(ref);
    const time = Date.parse(date);
    if (!tag || commit === "" || Number.isNaN(time)) continue;
    // In UTC: iso-strict keeps each committer's offset, and mixed offsets sort wrong as text.
    const batch = batches.get(commit) ?? { commit, date: new Date(time).toISOString(), tags: [] };
    batch.tags.push({ name: tag[1] as string, version: tag[2] as string });
    batches.set(commit, batch);
  }
  return [...batches.values()];
}

const BUMP_RANK: Readonly<Record<string, number>> = { patch: 0, minor: 1, major: 2 };

/**
 * A release of each batch, newest first, with an item of each changeset its sections list, kind
 * from `kinds` or else inferred; also the tags with no section, and the texts whose kind was inferred.
 */
export function backfillReleases(
  batches: readonly TagBatch[],
  sectionsOf: (name: string) => ReadonlyMap<string, string>,
  kinds: ReadonlyMap<string, ChangeKind>,
): { releases: ReleaseNoteEntry[]; skipped: string[]; inferred: string[] } {
  const releases: ReleaseNoteEntry[] = [];
  const skipped: string[] = [];
  const inferred: string[] = [];
  const newestFirst = batches.toSorted((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const batch of newestFirst) {
    const versions: Record<string, string> = {};
    const merged = new Map<string, { packages: string[]; text: string; bump: string }>();
    const tags = batch.tags.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const { name, version } of tags) {
      versions[name] = version;
      const section = sectionsOf(name).get(version);
      if (section === undefined) {
        skipped.push(`${name}@${version}`);
        continue;
      }
      for (const { commit, text, bump } of sectionBullets(section)) {
        const key = `${commit ?? ""}\0${text}`;
        const same = merged.get(key);
        if (!same) merged.set(key, { packages: [name], text, bump });
        else {
          if (!same.packages.includes(name)) same.packages.push(name);
          if ((BUMP_RANK[bump] ?? 0) > (BUMP_RANK[same.bump] ?? 0)) same.bump = bump;
        }
      }
    }
    const items = [...merged.values()].map(({ packages, text, bump }) => {
      const kind = kinds.get(firstLine(text));
      if (kind === undefined) inferred.push(text);
      return { kind: kind ?? inferKind(text, bump), packages: packages.sort(), text };
    });
    if (items.length > 0) releases.push({ date: batch.date, versions, items: sortItems(items) });
  }
  return { releases, skipped, inferred };
}

/** Workspace package → its folder, from the tracked manifests. */
function workspaceDirs(root: string): Map<string, string> {
  const dirs = new Map<string, string>();
  const manifests = git(
    root,
    "ls-files",
    ":(glob)apps/*/package.json",
    ":(glob)packages/*/package.json",
  );
  for (const rel of manifests.split("\n").filter(Boolean)) {
    const { name } = JSON.parse(readFileSync(join(root, rel), "utf8")) as { name?: string };
    if (name) dirs.set(name, join(root, dirname(rel)));
  }
  return dirs;
}

/**
 * The sections no tag names, such as a first version published by hand, each dated by the commit
 * that wrote its heading.
 */
function untaggedBatches(
  root: string,
  dirs: ReadonlyMap<string, string>,
  sectionsOf: (name: string) => ReadonlyMap<string, string>,
  tagged: ReadonlySet<string>,
): TagBatch[] {
  const batches = new Map<string, TagBatch>();
  for (const [name, dir] of dirs) {
    for (const version of sectionsOf(name).keys()) {
      if (tagged.has(`${name}@${version}`)) continue;
      const heading = `^## ${version.replaceAll(".", "\\.")}$`;
      const file = relative(root, join(dir, "CHANGELOG.md"));
      const log = git(
        root,
        "log",
        "--no-show-signature",
        "--reverse",
        "--format=%H%x09%cI",
        "-G",
        heading,
        "--",
        file,
      );
      const [line = ""] = log.split("\n");
      const [commit = "", date = ""] = line.split("\t");
      if (commit === "") continue;
      const batch = batches.get(commit) ?? {
        commit,
        date: new Date(date).toISOString(),
        tags: [],
      };
      batch.tags.push({ name, version });
      batches.set(commit, batch);
    }
  }
  return [...batches.values()];
}

/**
 * Rebuilds changelog.json from the release tags and the CHANGELOG.md sections they name, each item's
 * kind from the prefix of the changeset its version commit deleted.
 */
export function backfill(root: string): string {
  const dirs = workspaceDirs(root);
  const cache = new Map<string, Map<string, string>>();
  const sectionsOf = (name: string) => {
    let sections = cache.get(name);
    if (!sections) {
      const dir = dirs.get(name);
      const file = dir === undefined ? null : join(dir, "CHANGELOG.md");
      sections =
        file && existsSync(file) ? changelogSections(readFileSync(file, "utf8")) : new Map();
      cache.set(name, sections);
    }
    return sections;
  };
  const tags = tagBatches(git(root, "for-each-ref", `--format=${TAG_FORMAT}`, "refs/tags"));
  const tagged = new Set(tags.flatMap((batch) => batch.tags.map((t) => `${t.name}@${t.version}`)));
  const kinds = consumedKinds(
    git(
      root,
      "log",
      "--no-show-signature",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "--diff-filter=D",
      "--format=",
      "-p",
      "--",
      ".changeset/*.md",
    ),
  );
  const { releases, skipped, inferred } = backfillReleases(
    [...tags, ...untaggedBatches(root, dirs, sectionsOf, tagged)],
    sectionsOf,
    kinds,
  );
  writeChangelog(root, { schema: 1, releases });
  const items = releases.reduce((sum, release) => sum + release.items.length, 0);
  return [
    `backfilled ${releases.length} releases, ${items} items`,
    ...skipped.map((tag) => `${tag}: no section in its CHANGELOG.md, so no items`),
    ...inferred.map((text) => `no changeset in the history, kind inferred: ${firstLine(text)}`),
  ].join("\n");
}

/** desktop.yml's line for latest*.yml: JSON is YAML, so one line carries the notes as they are. */
export function manifestLine(changelog: Changelog): string {
  const desktop = changelog.releases.filter((r) => r.versions[DESKTOP_PACKAGE] !== undefined);
  return `eidolonNotes: ${JSON.stringify(desktop.slice(0, MANIFEST_LIMIT))}`;
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  const mode = process.argv[2];
  if (mode === "sync") console.log(`[changelog] ${sync(root)}`);
  else if (mode === "backfill") console.log(`[changelog] ${backfill(root)}`);
  else if (mode === "manifest") process.stdout.write(`${manifestLine(readChangelog(root))}\n`);
  else {
    console.error("usage: node scripts/changelog.ts sync | backfill | manifest");
    process.exitCode = 1;
  }
}
