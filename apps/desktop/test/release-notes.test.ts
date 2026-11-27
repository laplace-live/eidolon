import { describe, expect, test } from "vitest";
import {
  compareVersions,
  DESKTOP_PACKAGE,
  manifestNotes,
  notesBetween,
  parseReleaseNotes,
  type ReleaseNoteEntry,
  type ReleaseNoteItem,
} from "../src/shared/release-notes.ts";

const item = (text: string, over: Partial<ReleaseNoteItem> = {}): ReleaseNoteItem => ({
  kind: "feature",
  packages: [DESKTOP_PACKAGE],
  text,
  ...over,
});

/** A batch that released the desktop app at `version`, with one item unless given others. */
const entry = (version: string, over: Partial<ReleaseNoteEntry> = {}): ReleaseNoteEntry => ({
  date: "2026-11-22T19:30:54.000Z",
  versions: { [DESKTOP_PACKAGE]: version },
  items: [item(`In ${version}`)],
  ...over,
});

describe("compareVersions", () => {
  test("orders by each number, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.14.2")).toBeGreaterThan(0);
    expect(compareVersions("0.14.0", "0.14.0")).toBe(0);
    expect(compareVersions("0.14.0", "0.14.1")).toBeLessThan(0);
  });

  test("reads a missing number as zero", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  test("puts a prerelease, an unpackaged build's 0.0.0-dev too, below its release", () => {
    expect(compareVersions("0.2.0-next.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.2.0-next.0")).toBeGreaterThan(0);
    expect(compareVersions("0.0.0-dev", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0-next.0", "0.2.0-next.0")).toBe(0);
  });
});

describe("parseReleaseNotes", () => {
  test("keeps a well-formed block as it is", () => {
    const notes = [
      {
        date: "2026-11-22T19:30:54.000Z",
        versions: { [DESKTOP_PACKAGE]: "0.2.0", "@laplace.live/eidolon-sdk": "0.3.0" },
        items: [
          { kind: "feature", packages: [DESKTOP_PACKAGE], text: "Check for updates" },
          { kind: "fix", packages: ["@laplace.live/eidolon-sdk"], text: "Keep the mic" },
        ],
      },
    ];
    expect(parseReleaseNotes(notes)).toEqual(notes);
  });

  test("finds no notes in anything but an array", () => {
    for (const raw of [undefined, null, "notes", 3, { releases: [] }]) {
      expect(parseReleaseNotes(raw)).toEqual([]);
    }
  });

  test("reads a kind it doesn't know, or none, as other", () => {
    const [parsed] = parseReleaseNotes([
      {
        date: "d",
        versions: { [DESKTOP_PACKAGE]: "1.0.0" },
        items: [
          { kind: "security", packages: [], text: "a kind a newer generator added" },
          { kind: null, packages: [], text: "no kind" },
          { kind: "toString", packages: [], text: "a name every object has" },
          { packages: [], text: "no kind at all" },
        ],
      },
    ]);
    expect(parsed?.items.map((i) => i.kind)).toEqual(["other", "other", "other", "other"]);
  });

  test("drops a malformed item, and a batch it leaves empty", () => {
    const parsed = parseReleaseNotes([
      { date: "d", versions: {}, items: [{ kind: "fix", packages: [], text: "" }] },
      { date: "d", versions: {}, items: [{ kind: "fix", packages: "nope", text: "x" }] },
      { date: "d", versions: {}, items: [{ kind: "fix", packages: [3], text: "x" }] },
      { date: "d", versions: {}, items: "nope" },
      { versions: {}, items: [{ kind: "fix", packages: [], text: "no date" }] },
      { date: "d", items: [{ kind: "fix", packages: [], text: "no versions" }] },
      { date: "d", versions: {}, items: [null, 1, { kind: "fix", packages: [], text: "kept" }] },
    ]);
    expect(parsed).toEqual([
      { date: "d", versions: {}, items: [{ kind: "fix", packages: [], text: "kept" }] },
    ]);
  });

  test("keeps only the versions given as text", () => {
    const [parsed] = parseReleaseNotes([
      {
        date: "d",
        versions: { [DESKTOP_PACKAGE]: "1.0.0", unquoted: 0.1, missing: null },
        items: [{ kind: "fix", packages: [], text: "x" }],
      },
    ]);
    expect(parsed?.versions).toEqual({ [DESKTOP_PACKAGE]: "1.0.0" });
  });

  test("throws on nothing a manifest's YAML can hold", () => {
    const hostile = [null, 1, "x", [], [[]], { date: 1 }, { date: "d", versions: [], items: [] }];
    expect(() => parseReleaseNotes(hostile)).not.toThrow();
    expect(parseReleaseNotes(hostile)).toEqual([]);
  });
});

describe("notesBetween", () => {
  test("keeps the batches after the running version, up to the offered one, newest first", () => {
    const notes = notesBetween(
      [entry("0.1.0"), entry("0.4.0"), entry("0.2.0"), entry("0.3.0")],
      "0.1.0",
      "0.3.0",
    );
    expect(notes.map((n) => n.versions[DESKTOP_PACKAGE])).toEqual(["0.3.0", "0.2.0"]);
  });

  test("leaves out a batch that didn't release the desktop app", () => {
    const backendOnly = entry("0.2.0", { versions: { "laplace-eidolon": "0.15.0" } });
    expect(notesBetween([backendOnly, entry("0.2.0")], "0.1.0", "0.2.0")).toEqual([entry("0.2.0")]);
  });

  test("keeps the items whose changesets named the desktop app, and only those", () => {
    const sdk = item("An SDK fix", { kind: "fix", packages: ["@laplace.live/eidolon-sdk"] });
    // A change desktop users get names the app too; the fixed pair alone is production's or npx's.
    const backend = item("A production fix", {
      kind: "fix",
      packages: ["@laplace.live/eidolon", "laplace-eidolon"],
    });
    const shared = item("Images in chats", {
      packages: ["@laplace.live/eidolon", DESKTOP_PACKAGE, "laplace-eidolon"],
    });
    const notes = notesBetween(
      [
        entry("0.3.0", { items: [sdk] }),
        entry("0.2.0", { items: [item("Updates"), sdk, backend, shared] }),
      ],
      "0.1.0",
      "0.3.0",
    );
    expect(notes).toEqual([entry("0.2.0", { items: [item("Updates"), shared] })]);
  });
});

describe("manifestNotes", () => {
  test("returns the manifest's eidolonNotes entries between the version that runs and the one offered", () => {
    const info = {
      version: "0.3.0",
      eidolonNotes: [entry("0.3.0"), entry("0.2.0"), entry("0.1.0")],
    };
    expect(manifestNotes(info, "0.1.0")).toEqual([entry("0.3.0"), entry("0.2.0")]);
  });

  test("returns empty for a manifest without notes, or with ones it can't read", () => {
    expect(manifestNotes({ version: "0.2.0" }, "0.1.0")).toEqual([]);
    expect(manifestNotes({ version: "0.2.0", eidolonNotes: "a page" }, "0.1.0")).toEqual([]);
  });
});
