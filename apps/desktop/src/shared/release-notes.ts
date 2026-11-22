// Release notes as the root changelog.json records them, which an update's manifest carries as
// `eidolonNotes`: their check, and what an update's box shows of them. scripts/changelog.ts writes
// them with these types too, so the module imports nothing.

/** Features read first and `other` last. */
export const CHANGE_KIND_ORDER = ["feature", "performance", "improvement", "fix", "other"] as const;
/** A change's kind, from its changeset's `feat:`, `perf:`, `chore:` or `fix:` prefix. */
export type ChangeKind = (typeof CHANGE_KIND_ORDER)[number];

export interface ReleaseNoteItem {
  readonly kind: ChangeKind;
  /** Every package its changeset named. */
  readonly packages: readonly string[];
  readonly text: string;
}

/** What one `changeset version` released: several packages, each at its own version. */
export interface ReleaseNoteEntry {
  readonly date: string;
  /** Package → the version this batch released it at; a package it didn't bump is absent. */
  readonly versions: Readonly<Record<string, string>>;
  readonly items: readonly ReleaseNoteItem[];
}

export const DESKTOP_PACKAGE = "laplace-eidolon-desktop";

/** The packages whose changes reach the desktop app's users: the app, and the backend it ships. */
const APP_PACKAGES: readonly string[] = [
  DESKTOP_PACKAGE,
  "@laplace.live/eidolon",
  "laplace-eidolon",
];

/** The most items an update's box lists, since a native box grows to fit its text. */
export const MAX_NOTE_ITEMS = 8;

/**
 * Compares `x.y.z` versions: below 0, 0 or above 0. A prerelease sorts below its release, and
 * prereleases of one release by their tag's text.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = a.split("-", 2);
  const [coreB = "", preB] = b.split("-", 2);
  const partsA = coreA.split(".");
  const partsB = coreB.split(".");
  for (let i = 0; i < 3; i++) {
    const diff = (Number(partsA[i]) || 0) - (Number(partsB[i]) || 0);
    if (diff !== 0) return diff;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseItem(raw: unknown): ReleaseNoteItem | null {
  if (!isRecord(raw)) return null;
  const { kind, packages, text } = raw;
  if (typeof text !== "string" || text.length === 0) return null;
  if (!Array.isArray(packages) || !packages.every((p) => typeof p === "string")) return null;
  return { kind: CHANGE_KIND_ORDER.find((k) => k === kind) ?? "other", packages, text };
}

/**
 * The release notes in a manifest's `eidolonNotes`, which is remote input: what parses is kept, a
 * malformed item or batch is dropped, and nothing throws.
 */
export function parseReleaseNotes(raw: unknown): ReleaseNoteEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ReleaseNoteEntry[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const { date, versions, items } = candidate;
    if (typeof date !== "string" || !isRecord(versions) || !Array.isArray(items)) continue;
    const kept: Record<string, string> = {};
    for (const [name, version] of Object.entries(versions)) {
      if (typeof version === "string") kept[name] = version;
    }
    const parsed = items.map(parseItem).filter((i): i is ReleaseNoteItem => i !== null);
    if (parsed.length > 0) entries.push({ date, versions: kept, items: parsed });
  }
  return entries;
}

/**
 * What an update from `running` to `offered` brings, newest first: the batches that released the
 * desktop app after `running` and up to `offered`, with their items about the app.
 */
export function notesBetween(
  entries: readonly ReleaseNoteEntry[],
  running: string,
  offered: string,
): ReleaseNoteEntry[] {
  const released = (entry: ReleaseNoteEntry) => entry.versions[DESKTOP_PACKAGE] ?? "";
  return entries
    .filter((entry) => {
      const version = entry.versions[DESKTOP_PACKAGE];
      return (
        version !== undefined &&
        compareVersions(version, running) > 0 &&
        compareVersions(version, offered) <= 0
      );
    })
    .map((entry) => ({
      ...entry,
      items: entry.items.filter((item) => item.packages.some((p) => APP_PACKAGES.includes(p))),
    }))
    .filter((entry) => entry.items.length > 0)
    .sort((a, b) => compareVersions(released(b), released(a)));
}

/** The words notesText puts around the notes, in the box's language. */
export interface NotesLabels {
  /** Each kind's label, such as "New" or "Fixed", before an item's text. */
  readonly kinds: Readonly<Record<ChangeKind, string>>;
  /** The line under a list that leaves `count` items out. */
  readonly more: (count: number) => string;
}

/**
 * The notes as a native box's plain text: a line per item, under its release's version when there
 * are several, and at most MAX_NOTE_ITEMS of them, with a line that counts the rest.
 */
export function notesText(entries: readonly ReleaseNoteEntry[], labels: NotesLabels): string {
  const blocks: string[] = [];
  let room = MAX_NOTE_ITEMS;
  let left = 0;
  for (const entry of entries) {
    const shown = entry.items.slice(0, room);
    room -= shown.length;
    left += entry.items.length - shown.length;
    if (shown.length === 0) continue;
    const version = entries.length > 1 ? entry.versions[DESKTOP_PACKAGE] : undefined;
    const lines = shown.map(
      (item) => `${labels.kinds[item.kind]}: ${item.text.trim().split("\n", 1)[0]}`,
    );
    blocks.push([...(version === undefined ? [] : [version]), ...lines].join("\n"));
  }
  if (left > 0) blocks.push(labels.more(left));
  return blocks.join("\n\n");
}
