import { describe, expect, test } from "vitest";
import {
  pyPath,
  pyPathName,
  pyPathParent,
  pyPathRelativeTo,
  pyPathStem,
  pyPathSuffix,
  pyPathWithName,
  pyPathWithSuffix,
} from "../src/index.ts";

// [input, str(PurePosixPath), name, stem, suffix], from Python 3.13.
const TABLE: [string, string, string, string, string][] = [
  ["a.png", "a.png", "a.png", "a", ".png"],
  ["a", "a", "a", "a", ""],
  [".png", ".png", ".png", ".png", ""],
  ["..png", "..png", "..png", ".", ".png"],
  ["a.", "a.", "a.", "a.", ""],
  ["a..", "a..", "a..", "a..", ""],
  ["a.b.c", "a.b.c", "a.b.c", "a.b", ".c"],
  ["a/b.png/", "a/b.png", "b.png", "b", ".png"],
  ["a//b.png", "a/b.png", "b.png", "b", ".png"],
  ["./x.png", "x.png", "x.png", "x", ".png"],
  ["a/./b.png", "a/b.png", "b.png", "b", ".png"],
  ["HTTPS://example.com/x.png", "HTTPS:/example.com/x.png", "x.png", "x", ".png"],
  [
    "https://x/y/night.png?sig=1",
    "https:/x/y/night.png?sig=1",
    "night.png?sig=1",
    "night",
    ".png?sig=1",
  ],
  [
    "x3QpM0n2abcdefghijklZr.png.png",
    "x3QpM0n2abcdefghijklZr.png.png",
    "x3QpM0n2abcdefghijklZr.png.png",
    "x3QpM0n2abcdefghijklZr.png",
    ".png",
  ],
  [".", ".", "", "", ""],
  ["/", "/", "", "", ""],
  ["//x/y", "//x/y", "y", "y", ""],
  ["///x/y", "/x/y", "y", "y", ""],
  ["", ".", "", "", ""],
  ["a/..", "a/..", "..", "..", ""],
  ["out.tar.gz", "out.tar.gz", "out.tar.gz", "out.tar", ".gz"],
  ["dir/", "dir", "dir", "dir", ""],
  [".a.b", ".a.b", ".a.b", ".a", ".b"],
  [" .png", " .png", " .png", " ", ".png"],
];

describe("PurePosixPath parsing", () => {
  test("str, name, stem and suffix match Python", () => {
    for (const [input, str, name, stem, suffix] of TABLE) {
      expect([
        input,
        pyPath(input),
        pyPathName(input),
        pyPathStem(input),
        pyPathSuffix(input),
      ]).toEqual([input, str, name, stem, suffix]);
    }
  });

  test("with_name replaces the last component", () => {
    expect(pyPathWithName("out", "out.webp")).toBe("out.webp");
    expect(pyPathWithName("data/generated/image.png", "image.webp")).toBe(
      "data/generated/image.webp",
    );
    expect(pyPathWithName("a/", "a.webp")).toBe("a.webp");
    expect(pyPathWithName("x/.", "x.webp")).toBe("x.webp");
    expect(pyPathWithName("/abs/out.tar.gz", "out.tar.png")).toBe("/abs/out.tar.png");
    expect(() => pyPathWithName(".", "x")).toThrow("has an empty name");
  });
});

test("with_suffix swaps the last suffix, as Python 3.13 does", () => {
  expect(pyPathWithSuffix("streams/a.md", ".refined.json")).toBe("streams/a.refined.json");
  expect(pyPathWithSuffix("a.b.md", ".refined.json")).toBe("a.b.refined.json");
  expect(pyPathWithSuffix(".md", ".refined.json")).toBe(".md.refined.json");
  expect(pyPathWithSuffix("vods/BV1_p1.m4a", ".info.json")).toBe("vods/BV1_p1.info.json");
  expect(pyPathWithSuffix("x/", ".y")).toBe("x.y");
  expect(pyPathWithSuffix("a.", ".z")).toBe("a..z");
  expect(pyPathWithSuffix("a/b", "")).toBe("a/b");
  expect(() => pyPathWithSuffix("a.md", "x")).toThrow("Invalid suffix 'x'");
  expect(() => pyPathWithSuffix("a.md", ".")).toThrow("Invalid suffix '.'");
  expect(() => pyPathWithSuffix(".", ".x")).toThrow("has an empty name");
});

test("parent and relative_to read paths as PurePosixPath does", () => {
  expect(
    ["streams", "/srv/streams", "/x", "/", "//x", ".", "..", "a/..", "a/b/"].map(pyPathParent),
  ).toEqual([".", "/srv", "/", "/", "//", ".", ".", "a", "a"]);
  expect(pyPathRelativeTo("streams/x.md", ".")).toBe("streams/x.md");
  expect(pyPathRelativeTo("/srv/streams/x.md", "/srv")).toBe("streams/x.md");
  expect(pyPathRelativeTo("/x.md", "/")).toBe("x.md");
  expect(pyPathRelativeTo("../x.md", ".")).toBe("../x.md");
  expect(() => pyPathRelativeTo("/a/x.md", "/b")).toThrow("is not in the subpath");
});

describe("on Windows", () => {
  /** Runs `check` while process.platform reads `value`, as the helpers read it on each call. */
  function on(value: NodeJS.Platform, check: () => void): void {
    const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { ...platform, value });
    try {
      check();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  }

  test("a backslash separates too, a drive's root stays a root, and paths print with slashes", () => {
    on("win32", () => {
      expect(pyPath("C:\\Users\\t\\.laplace\\x.md")).toBe("C:/Users/t/.laplace/x.md");
      expect(pyPathName("C:\\Users\\t\\lists\\batches\\videos-1.txt")).toBe("videos-1.txt");
      expect(pyPathStem(".\\vods\\BV1x.m4a")).toBe("BV1x");
      expect(pyPathSuffix("C:\\a\\b.refined.json")).toBe(".json");
      expect(pyPathParent("C:\\Users\\t")).toBe("C:/Users");
      expect(pyPathParent("C:\\x")).toBe("C:/");
      expect(pyPathParent("C:\\")).toBe("C:/");
      expect(pyPathRelativeTo("C:\\data\\streams\\a.md", "C:/data")).toBe("streams/a.md");
      expect(pyPathWithSuffix("C:\\a\\b.md", ".json")).toBe("C:/a/b.json");
      expect(pyPath("\\\\server\\share\\x")).toBe("//server/share/x");
    });
    // Elsewhere a backslash is part of a name, as in PurePosixPath.
    on("linux", () => expect(pyPathName("a\\b.png")).toBe("a\\b.png"));
  });
});
