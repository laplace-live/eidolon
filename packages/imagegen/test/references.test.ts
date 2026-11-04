import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataHome, PROJECT_ROOT } from "@eidolon/config";
import {
  friendSources,
  ImageGenError,
  imageMediaType,
  imagesIn,
  isReferenceUrl,
  isSelfieConfigured,
  loadReference,
  loadReferences,
  referenceRoots,
  referenceSources,
  selectOutfit,
} from "../src/index.ts";
import { FRIEND_REFERENCE, OUTFIT_TABLE } from "./goldens.ts";
import {
  bytesOf,
  clearSelfieEnv,
  dataUrl,
  removeTempDirs,
  restoreEnv,
  setEnv,
  tempDir,
  tempTree,
} from "./helpers.ts";

// The template ships the outfits; the friend image lives only in the user's data home.
const TEMPLATE_REFS = join(PROJECT_ROOT, "personas", "milky-green", "references");
const OUTFITS = join(TEMPLATE_REFS, "outfits");
const HOME_REFS = () => join(dataHome(), "personas", "milky-green", "references");

function privateFriend(): string {
  const dir = join(HOME_REFS(), "friends");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "七海Nana7mi.png");
  writeFileSync(path, bytesOf("nana"));
  return path;
}

afterEach(() => rmSync(join(dataHome(), "personas"), { recursive: true, force: true }));

// The real image, for the encoding Python produced; present only on a machine holding the data.
const REAL_FRIEND = join(
  process.env.EIDOLON_REAL_HOME ?? "",
  "personas",
  "milky-green",
  "references",
  "friends",
  "七海Nana7mi.png",
);

const NOON = { hour: 12, minute: 0 };
const NIGHT = { hour: 22, minute: 0 };

beforeEach(clearSelfieEnv);
afterEach(restoreEnv);
afterAll(removeTempDirs);

function expectImageGenError(fn: () => unknown, message: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ImageGenError);
  expect((caught as Error).message).toBe(message);
}

describe("imageMediaType", () => {
  test("follows mimetypes.guess_type over the built-in table", () => {
    // MimeTypes().guess_type(name)[0], image types only.
    const cases: Record<string, string | null> = {
      "a.png": "image/png",
      "A.PNG": "image/png",
      "a.jpg": "image/jpeg",
      "a.JPEG": "image/jpeg",
      "a.webp": "image/webp",
      "a.ico": "image/vnd.microsoft.icon",
      "a.svgz": "image/svg+xml",
      "a.png.gz": "image/png",
      "a.png.GZ": null,
      ".png": null,
      "..png": null,
      "a.": null,
      "a.txt": null,
      ".DS_Store": null,
      "README.md": null,
      noext: null,
      "x.tar.gz": null,
      "a.b.png": "image/png",
      "a..png": "image/png",
      ".a.png": "image/png",
      "...png": null,
      "a.Z": null,
      "x.png.Z": "image/png",
      "x.svg.br": "image/svg+xml",
      "x.tgz": null,
    };
    for (const [name, type] of Object.entries(cases))
      expect([name, imageMediaType(name)]).toEqual([name, type]);
  });
});

describe("imagesIn", () => {
  test("is empty for a missing directory or a file", () => {
    const root = tempTree({ "file.png": bytesOf("f") });
    expect(imagesIn(join(root, "missing"))).toEqual([]);
    expect(imagesIn(join(root, "file.png"))).toEqual([]);
  });

  test("lists image files by code point, skipping directories and other types", () => {
    const root = tempTree({
      "b.png": bytesOf("b"),
      "A.PNG": bytesOf("A"),
      "c.txt": "text",
      ".DS_Store": "finder",
      "sub/inner.png": bytesOf("inner"),
      "z.jpeg": bytesOf("z"),
      "x.png.gz": bytesOf("x"),
      ".png": bytesOf("dot"),
      "七海.png": bytesOf("seven"),
      "Z.webp": bytesOf("Z"),
      "y.svgz": bytesOf("y"),
      noext: bytesOf("n"),
    });
    expect(imagesIn(root)).toEqual(
      ["A.PNG", "Z.webp", "b.png", "x.png.gz", "y.svgz", "z.jpeg", "七海.png"].map((name) =>
        join(root, name),
      ),
    );
  });

  test("follows symlinks; a broken one is not a file", () => {
    const root = tempTree({ "b.png": bytesOf("b") });
    symlinkSync(join(root, "b.png"), join(root, "link.png"));
    symlinkSync(join(root, "missing.png"), join(root, "broken.png"));
    expect(imagesIn(root)).toEqual([join(root, "b.png"), join(root, "link.png")]);
  });
});

describe("friendSources", () => {
  test("keys each friend by file stem", () => {
    const root = tempTree({ "friends/B.webp": bytesOf("B"), "friends/A.jpg": bytesOf("A") });
    expect([...friendSources({ root })]).toEqual([
      ["A", join(root, "friends", "A.jpg")],
      ["B", join(root, "friends", "B.webp")],
    ]);
  });

  test("a later file with the same stem wins and keeps the first position", () => {
    const root = tempTree({
      "friends/A.jpg": bytesOf("A1"),
      "friends/A.png": bytesOf("A2"),
      "friends/B.png": bytesOf("B"),
    });
    expect([...friendSources({ root })]).toEqual([
      ["A", join(root, "friends", "A.png")],
      ["B", join(root, "friends", "B.png")],
    ]);
  });

  test("the template ships no friend; one in the user's folder joins its outfits", () => {
    expect([...friendSources()]).toEqual([]);
    expect(referenceRoots()).toEqual([TEMPLATE_REFS]);
    const friend = privateFriend();
    expect([...friendSources()]).toEqual([["七海Nana7mi", friend]]);
    expect(referenceRoots()).toEqual([HOME_REFS(), TEMPLATE_REFS]);
    expect(referenceSources({ clock: NOON })).toEqual([join(OUTFITS, "day.png")]);
  });

  test("the user's copy of an outfit wins over the template's", () => {
    const own = join(HOME_REFS(), "outfits", "day.png");
    mkdirSync(join(HOME_REFS(), "outfits"), { recursive: true });
    writeFileSync(own, bytesOf("own-day"));
    expect(referenceSources({ clock: NOON })).toEqual([own]);
    expect(referenceSources({ clock: NIGHT })).toEqual([join(OUTFITS, "night.png")]);
  });
});

describe("selectOutfit", () => {
  const cases = [
    ["a/day.png", "a/night.png"],
    ["a/NIGHT.png", "a/knight.png"],
    ["https://x/y/night.png?sig=1", "https://x/y/day.png"],
    ["a/day.png", "a/summer.png"],
    ["only.png"],
    [],
    ["a/midnight.png", "a/day.png", "a/b-night.jpg"],
  ];

  test("matches Python's choice at every boundary hour", () => {
    for (const [hour, expected] of Object.entries(OUTFIT_TABLE)) {
      const clock = { hour: Number(hour), minute: 0 };
      expect(cases.map((sources) => selectOutfit(sources, clock))).toEqual(expected);
    }
  });
});

describe("referenceSources", () => {
  test("SELFIE_REFERENCE_IMAGES wins, trimmed, empties dropped, one outfit by the hour", () => {
    setEnv("SELFIE_REFERENCE_IMAGES", " a.png , ,b-night.png,");
    expect(referenceSources({ clock: NOON })).toEqual(["a.png"]);
    expect(referenceSources({ clock: NIGHT })).toEqual(["b-night.png"]);
    setEnv("SELFIE_REFERENCE_IMAGES", "https://e/x.png,https://e/night.png?sig=1");
    expect(referenceSources({ clock: NIGHT })).toEqual(["https://e/night.png?sig=1"]);
  });

  test("only blank parts fall back to the bundled outfits", () => {
    setEnv("SELFIE_REFERENCE_IMAGES", " , ,");
    expect(referenceSources({ clock: NOON })).toEqual([join(OUTFITS, "day.png")]);
    expect(referenceSources({ clock: NIGHT })).toEqual([join(OUTFITS, "night.png")]);
  });

  test("loose images stand in when outfits/ is missing or empty; friends never count", () => {
    const root = tempTree({
      "day.png": bytesOf("loose-day"),
      "night.png": bytesOf("loose-night"),
      "friends/A.png": bytesOf("A"),
    });
    mkdirSync(join(root, "outfits"));
    expect(referenceSources({ root, clock: NIGHT })).toEqual([join(root, "night.png")]);
    writeFileSync(join(root, "outfits", "only.png"), bytesOf("outfit"));
    expect(referenceSources({ root, clock: NIGHT })).toEqual([join(root, "outfits", "only.png")]);
  });

  test("nothing configured and nothing bundled is empty", () => {
    const root = tempTree({ "friends/A.png": bytesOf("A") });
    expect(referenceSources({ root })).toEqual([]);
    expect(loadReferences({ root })).toEqual([]);
  });
});

describe("loadReference", () => {
  test("http(s) URLs pass through; HTTPS:// is a path", () => {
    expect(isReferenceUrl("https://example.com/night.png")).toBe(true);
    expect(loadReference("http://example.com/a.png")).toEqual({
      type: "image_url",
      image_url: { url: "http://example.com/a.png" },
    });
    expectImageGenError(
      () => loadReference("HTTPS://example.com/x.png"),
      "HTTPS:/example.com/x.png: no such file",
    );
  });

  test("names the path as pathlib prints it", () => {
    expectImageGenError(
      () => loadReference("./eidolon-missing//a/./b.png"),
      "eidolon-missing/a/b.png: no such file",
    );
    const root = tempTree({ "sub/x.png": bytesOf("x") });
    expectImageGenError(() => loadReference(`${root}/sub/`), `${root}/sub: no such file`);
  });

  test("expands ~ to the home directory", () => {
    const name = `eidolon-missing-${crypto.randomUUID()}.png`;
    expectImageGenError(() => loadReference(`~/${name}`), `${join(homedir(), name)}: no such file`);
  });

  test("refuses a file that isn't an image type", () => {
    const root = tempTree({ "notes.txt": "hello" });
    expectImageGenError(
      () => loadReference(join(root, "notes.txt")),
      `${join(root, "notes.txt")}: not a recognizable image type`,
    );
  });

  test("encodes a local image with its real media type and padded base64", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02]);
    const root = tempTree({ "x.webp": bytes, "y.JPG": bytes });
    expect(loadReference(join(root, "x.webp")).image_url.url).toBe(
      "data:image/webp;base64,//4AAQI=",
    );
    expect(loadReference(join(root, "y.JPG")).image_url.url).toBe(dataUrl("image/jpeg", bytes));
  });

  test.skipIf(!existsSync(REAL_FRIEND))("encodes the private friend exactly as Python does", () => {
    const url = loadReference(REAL_FRIEND).image_url.url;
    expect(url.length).toBe(FRIEND_REFERENCE.length);
    expect(url.slice(0, 60)).toBe(FRIEND_REFERENCE.head);
    expect(url.slice(-20)).toBe(FRIEND_REFERENCE.tail);
  });
});

describe("isSelfieConfigured", () => {
  test("needs a non-blank OPENROUTER_API_KEY", () => {
    expect(isSelfieConfigured()).toBe(false);
    setEnv("OPENROUTER_API_KEY", "");
    expect(isSelfieConfigured()).toBe(false);
    setEnv("OPENROUTER_API_KEY", "sk-test");
    expect(isSelfieConfigured()).toBe(true);
  });

  test("checks that the outfit exists, not what it is", () => {
    setEnv("OPENROUTER_API_KEY", "sk-test");
    setEnv("SELFIE_REFERENCE_IMAGES", " eidolon-missing.png , ,");
    expect(isSelfieConfigured()).toBe(false);
    setEnv("SELFIE_REFERENCE_IMAGES", "https://example.com/a.png");
    expect(isSelfieConfigured()).toBe(true);
    const root = tempTree({ "notes.txt": "not an image" });
    setEnv("SELFIE_REFERENCE_IMAGES", join(root, "notes.txt"));
    expect(isSelfieConfigured()).toBe(true);
  });

  test("is false without any outfit", () => {
    setEnv("OPENROUTER_API_KEY", "sk-test");
    expect(isSelfieConfigured({ root: tempDir() })).toBe(false);
  });
});
