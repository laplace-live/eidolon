// Expected values were printed by CPython 3.13's re.
import { describe, expect, test } from "bun:test";
import { PyPattern, pyRegexSource } from "../src/index.ts";

function outcome(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

describe("flags", () => {
  test("re.MULTILINE: ^ and $ at every newline, and only there", () => {
    const words = new PyPattern(String.raw`^\w+$`, "m");
    expect(words.finditer("ab\ncd\n").map((m) => m[0])).toEqual(["ab", "cd"]);
    expect(new PyPattern(String.raw`\w+$`).finditer("ab\ncd\n").map((m) => m[0])).toEqual(["cd"]);
    expect(new PyPattern("x$", "m").finditer("x\rx x").map((m) => m.index)).toEqual([4]);
    expect(new PyPattern("^", "m").sub(">", "a\nb\n")).toBe(">a\n>b\n>");
    expect(new PyPattern("$", "m").sub("<", "a\nb\n")).toBe("a<\nb<\n<");
  });

  test("re.DOTALL: . matches a newline too", () => {
    expect(new PyPattern("a.b", "s").finditer("a\nb a\rb").map((m) => m[0])).toEqual([
      "a\nb",
      "a\rb",
    ]);
    expect(new PyPattern("a.b").finditer("a\nb a\rb").map((m) => m[0])).toEqual(["a\rb"]);
  });

  test("_streams.H2_RE: whitespace crosses lines, ### never matches, $ stops at a newline", () => {
    const h2 = new PyPattern(String.raw`^##\s+(.+?)\s*$`, "m");
    const body = "intro\n## 00:00 — a \n\ntext\n##\n\nb\n### c\n## d";
    expect(h2.finditer(body).map((m) => [m[1], m.index, m.index + m[0].length])).toEqual([
      ["00:00 — a", 6, 20],
      ["b", 26, 31],
      ["d", 38, 42],
    ]);
  });

  test("an unknown flag is refused", () => {
    expect(() => pyRegexSource("a", "x")).toThrow("unsupported flag 'x'");
  });
});

describe("sub", () => {
  test("count limits the replacements; 0 replaces all and a negative count none", () => {
    const a = new PyPattern("a");
    expect(a.sub("b", "aaa", { count: -1 })).toBe("aaa");
    expect(a.sub("b", "aaa", { count: 0 })).toBe("bbb");
    expect(a.sub("b", "aaa", { count: 2 })).toBe("bba");
    expect(new PyPattern("x*").sub("-", "abxd")).toBe("-a-b--d-");
  });

  test("group references and escapes in the replacement", () => {
    const date = new PyPattern(String.raw`(\d+)-(?P<m>\d+)`);
    expect(date.sub(String.raw`\2/\g<m>/\g<1>/\1\\n\n`, "2026-11 x")).toBe(
      "11/11/2026/2026\\n\n x",
    );
    expect(new PyPattern("(a)|(b)").sub(String.raw`[\1\2]`, "ab")).toBe("[a][b]");
    expect(new PyPattern("a").sub(String.raw`\0\101\08`, "a")).toBe("\x00A\x008");
    expect(new PyPattern("a").sub(String.raw`\-\&`, "a")).toBe(String.raw`\-\&`);
  });

  test("bad templates raise as re does", () => {
    const a = new PyPattern("a");
    expect(outcome(() => a.sub(String.raw`\q`, "a"))).toBe("SyntaxError: bad escape \\q");
    expect(outcome(() => a.sub(String.raw`\9`, "a"))).toBe(
      "SyntaxError: invalid group reference 9",
    );
    expect(outcome(() => new PyPattern("(a)").sub(String.raw`\10`, "a"))).toBe(
      "SyntaxError: invalid group reference 10",
    );
    expect(outcome(() => new PyPattern("(?P<x>a)").sub(String.raw`\g<y>`, "a"))).toBe(
      "RangeError: unknown group name 'y'",
    );
    expect(outcome(() => a.sub("\\", "a"))).toBe("SyntaxError: bad escape (end of pattern)");
  });
});
