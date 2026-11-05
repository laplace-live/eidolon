import { describe, expect, test } from "bun:test";
import {
  FACT_EXTENSIONS,
  factFileName,
  hasDeliveryCues,
  IMAGE_EXTENSIONS,
  imageProblem,
  MAX_IMAGE_BYTES,
  nameProblem,
  renamed,
  stemOf,
  textCounts,
} from "./files";

describe("file names", () => {
  test("names the server takes", () => {
    for (const name of ["设定集.txt", "facts 2.txt", "a.TXT"]) {
      expect(nameProblem(name, FACT_EXTENSIONS)).toBeNull();
    }
    expect(nameProblem("坚果.webp", IMAGE_EXTENSIONS)).toBeNull();
  });

  test("names it refuses, and why", () => {
    for (const name of [
      "",
      ".hidden.txt",
      "a/b.txt",
      "a\\b.txt",
      "a:b.txt",
      "a\u0000.txt",
      " a.txt",
    ]) {
      expect(nameProblem(name, FACT_EXTENSIONS)).toBe("invalid");
    }
    expect(nameProblem(`${"a".repeat(125)}.txt`, FACT_EXTENSIONS)).toBe("invalid");
    expect(nameProblem("notes.md", FACT_EXTENSIONS)).toBe("extension");
    expect(nameProblem("notes", FACT_EXTENSIONS)).toBe("extension");
    expect(nameProblem("face.svg", IMAGE_EXTENSIONS)).toBe("extension");
  });

  test("a fact file gets .txt when it has no extension, and a friend's picture their name", () => {
    expect(factFileName(" 事件集 ")).toBe("事件集.txt");
    expect(factFileName("events.txt")).toBe("events.txt");
    expect(renamed("IMG_0001.JPG", "坚果")).toBe("坚果.jpg");
    expect(stemOf("坚果.png")).toBe("坚果");
    expect(stemOf("README")).toBe("README");
  });
});

test("images are PNG, JPEG or WebP, up to 20 MiB", () => {
  expect(imageProblem({ type: "image/png", size: MAX_IMAGE_BYTES })).toBeNull();
  expect(imageProblem({ type: "image/svg+xml", size: 10 })).toBe("type");
  expect(imageProblem({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 })).toBe("size");
});

test("text counts characters, not UTF-16 units", () => {
  expect(textCounts("")).toEqual({ chars: 0, lines: 0 });
  expect(textCounts("奶绿🌸\n第二行")).toEqual({ chars: 7, lines: 2 });
});

test("a prompt that teaches delivery cues is told apart from one that doesn't", () => {
  expect(hasDeliveryCues("用 `[温柔地安慰]` 这样的提示。")).toBe(true);
  expect(hasDeliveryCues("说话<emphasis>重读</emphasis>就好。")).toBe(true);
  expect(hasDeliveryCues("你是一个温柔的主播，说话简短。")).toBe(false);
});
