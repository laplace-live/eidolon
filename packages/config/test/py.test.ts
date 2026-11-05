// Expected values were printed by CPython 3.13.
import { describe, expect, test } from "bun:test";
import {
  cpLen,
  cpSlice,
  loadsPy,
  PyFloat,
  partition,
  pyFixed,
  pyFloatRepr,
  pyJsonDumps,
  pyLstrip,
  pyParseFloat,
  pyParseInt,
  pyRepr,
  pyRound,
  pyRstrip,
  pySplitWs,
  pyStr,
  pyStrip,
  pyTruthy,
  sortedPy,
  splitlines,
} from "../src/index.ts";

describe("pyRepr", () => {
  test.each([
    ["plain", "'plain'"],
    ["it's", `"it's"`],
    ['say "hi"', `'say "hi"'`],
    [`both ' and "`, `'both \\' and "'`],
    ["tab\tnl\nret\r", "'tab\\tnl\\nret\\r'"],
    ["\x00\x1f\x7f", "'\\x00\\x1f\\x7f'"],
    ["\x85\xa0", "'\\x85\\xa0'"],
    ["中文", "'中文'"],
    ["\u200b\u2028\ufeff", "'\\u200b\\u2028\\ufeff'"],
    ["😀", "'😀'"],
    ["\u{e0001}", "'\\U000e0001'"],
    ["back\\slash", "'back\\\\slash'"],
  ])("str %p", (input, expected) => {
    expect(pyRepr(input)).toBe(expected);
  });

  test("JSON-shaped values", () => {
    expect(
      [null, true, false, 3, -7, 1.5, 0.1, 1e16, 1.5e-7, 0.0001, 0.00001, 123456789012345680].map(
        pyRepr,
      ),
    ).toEqual([
      "None",
      "True",
      "False",
      "3",
      "-7",
      "1.5",
      "0.1",
      "1e+16",
      "1.5e-07",
      "0.0001",
      "1e-05",
      "1.2345678901234568e+17",
    ]);
    expect(pyRepr([1, "a", null])).toBe("[1, 'a', None]");
    expect(pyRepr({ k: [true, 2.5], j: "x'y" })).toBe(`{'k': [True, 2.5], 'j': "x'y"}`);
    expect(pyStr("as is")).toBe("as is");
    expect(pyStr(["x"])).toBe("['x']");
  });

  test("floats", () => {
    expect(
      [2, 0.1, 1e15, 1e16, 1e-5, 0.0001, -0, 123.456, 1e22, 5e-324, Infinity, Number.NaN].map(
        pyFloatRepr,
      ),
    ).toEqual([
      "2.0",
      "0.1",
      "1000000000000000.0",
      "1e+16",
      "1e-05",
      "0.0001",
      "-0.0",
      "123.456",
      "1e+22",
      "5e-324",
      "inf",
      "nan",
    ]);
  });
});

test("pyFixed rounds exact binary ties to even", () => {
  const cases: [number, number][] = [
    [0.125, 2],
    [0.375, 2],
    [0.0625, 3],
    [2.5, 0],
    [3.5, 0],
    [-0.001, 2],
    [1.005, 2],
    [0.5, 0],
    [1234.5678, 1],
    [-0, 1],
    [1e20, 2],
    [5e-324, 3],
  ];
  expect(cases.map(([v, d]) => pyFixed(v, d))).toEqual([
    "0.12",
    "0.38",
    "0.062",
    "2",
    "4",
    "-0.00",
    "1.00",
    "0",
    "1234.6",
    "-0.0",
    "100000000000000000000.00",
    "0.000",
  ]);
});

test("whitespace follows str.isspace", () => {
  const ws = " \t\x1c\x85\u3000x y\ufeff  ";
  expect(pyStrip(ws)).toBe("x y\ufeff");
  expect(pySplitWs(ws)).toEqual(["x", "y\ufeff"]);
  expect(pyStrip("xxhixx", "x")).toBe("hi");
});

test("code points", () => {
  expect(cpLen("😀😀😀😀")).toBe(4);
  expect(cpSlice("a😀b😀c", 1, 3)).toBe("😀b");
  expect(cpSlice("a😀b😀c", -2)).toBe("😀c");
  expect(sortedPy(["～", "😀", "a", "B", "\ue000"])).toEqual(["B", "a", "\ue000", "～", "😀"]);
});

test("truthiness", () => {
  expect([null, undefined, false, 0, -0, "", [], {}].map(pyTruthy)).toEqual(Array(8).fill(false));
  expect([true, 1, Number.NaN, " ", [0], { a: 0 }].map(pyTruthy)).toEqual(Array(6).fill(true));
  // A float as json.loads keeps it: 0.0 is falsy, NaN is not.
  expect([0, -0, 0.5, Number.NaN].map((v) => pyTruthy(new PyFloat(v)))).toEqual([
    false,
    false,
    true,
    true,
  ]);
});

test("pyJsonDumps matches json.dumps", () => {
  expect(pyJsonDumps({ a: [1, 2.5, "中\x7f"], b: null, c: { d: true } })).toBe(
    '{"a": [1, 2.5, "\\u4e2d\\u007f"], "b": null, "c": {"d": true}}',
  );
  expect(pyJsonDumps({ a: "中😀" }, { ensureAscii: false })).toBe('{"a": "中😀"}');
  expect(pyJsonDumps({ a: [1, { b: 2 }], e: [] }, { indent: 2 })).toBe(
    '{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ],\n  "e": []\n}',
  );
});

describe("pyParseInt and pyParseFloat", () => {
  test("int() accepts any decimal digit and Unicode spaces, but skips only ASCII whitespace", () => {
    const cases: [string, number | null][] = [
      ["\uff11\uff10", 10],
      [" \u0661\u0662 ", 12],
      ["\u3000\uff11\u3000", 1],
      ["\uff11_\uff10", 10],
      ["12\x85", 12],
      ["\u0663", 3],
      ["1_000", 1000],
      ["+0", 0],
      ["-0", 0],
      ["\ufeff10", null],
      ["\x1c12", null],
      ["\u0661\u066b\u0665", null],
      ["1 0", null],
      ["0x10", null],
    ];
    for (const [text, expected] of cases)
      expect([text, pyParseInt(text)]).toEqual([text, expected]);
    expect(Object.is(pyParseInt("-0"), 0)).toBe(true);
  });

  test("float() the same way, with inf and nan", () => {
    const cases: [string, number | null][] = [
      ["\uff10.\uff15", 0.5],
      ["\uff11e\uff13", 1000],
      [" inf ", Infinity],
      ["\u2003-1.5\u2003", -1.5],
      ["1_0.2_5", 10.25],
      ["-Infinity", -Infinity],
      [".5", 0.5],
      ["5.", 5],
      ["\u0661\u066b\u0665", null],
      ["\ufeff1.0", null],
      ["1e", null],
      ["\uff11,\uff15", null],
    ];
    for (const [text, expected] of cases) {
      expect([text, pyParseFloat(text)]).toEqual([text, expected]);
    }
    expect(pyParseFloat("nan")).toBeNaN();
  });
});

describe("str.lstrip and str.rstrip", () => {
  test("Python's whitespace, or the given characters, from one end", () => {
    const s = "\u3000 \x1cx y\x85\u2028 ";
    expect(pyLstrip(s)).toBe("x y\x85\u2028 ");
    expect(pyRstrip(s)).toBe("\u3000 \x1cx y");
    expect(pyLstrip("xxyabcyx", "xy")).toBe("abcyx");
    expect(pyRstrip("xxyabcyx", "xy")).toBe("xxyabc");
    expect(pyLstrip("\ufeff a ")).toBe("\ufeff a ");
  });
});

describe("str.splitlines", () => {
  test("splits on every Python line boundary and drops a trailing empty line", () => {
    expect(splitlines("")).toEqual([]);
    expect(splitlines("\n")).toEqual([""]);
    expect(splitlines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitlines("a\n\n")).toEqual(["a", ""]);
    expect(splitlines("a\r\nb\rc\vd\fe\x1cf\x1dg\x1eh\x85i\u2028j\u2029k")).toEqual([
      ..."abcdefghijk",
    ]);
  });

  test("keepends", () => {
    expect(splitlines("a\r\nb\rc\vd\fe\x1cf\x1dg\x1eh\x85i\u2028j\u2029k\n", true)).toEqual([
      "a\r\n",
      "b\r",
      "c\v",
      "d\f",
      "e\x1c",
      "f\x1d",
      "g\x1e",
      "h\x85",
      "i\u2028",
      "j\u2029",
      "k\n",
    ]);
    expect(splitlines("", true)).toEqual([]);
    expect(splitlines("a\n\nb", true)).toEqual(["a\n", "\n", "b"]);
  });
});

test("round() ties go to the even neighbour", () => {
  expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001].map(pyRound)).toEqual([0, 2, 2, 0, -2, 2, 3]);
});

test("str.partition", () => {
  expect(partition("a=b=c", "=")).toEqual(["a", "=", "b=c"]);
  expect(partition("abc", "=")).toEqual(["abc", "", ""]);
});

test("loadsPy keeps 1.0 apart from 1", () => {
  const value = loadsPy('{"a": 1.0, "b": 1, "c": [2e-05, 0.5, -0]}') as Record<string, unknown>;
  expect(value.a).toEqual(new PyFloat(1));
  expect(value.b).toBe(1);
  expect(pyJsonDumps(value)).toBe('{"a": 1.0, "b": 1, "c": [2e-05, 0.5, 0]}');
});
