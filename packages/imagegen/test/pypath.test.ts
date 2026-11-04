import { describe, expect, test } from "bun:test";
import { pyPath, pyPathName, pyPathStem, pyPathSuffix, pyPathWithName } from "../src/index.ts";

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
