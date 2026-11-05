// Expected values were printed by CPython 3.13.
import { describe, expect, test } from "bun:test";
import { PyFloat, pyJsonDumps, pyJsonLoads, pyRawDecode } from "../src/index.ts";

function outcome(parse: () => unknown): unknown {
  try {
    return parse();
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

describe("json.loads", () => {
  test("strict rejects a raw control character inside a string, before an unterminated one", () => {
    const cases: [string, unknown, unknown][] = [
      [
        '{"a": "x\ny"}',
        "JSONDecodeError: Invalid control character at: line 1 column 9 (char 8)",
        { a: "x\ny" },
      ],
      [
        '"ab\ncd',
        "JSONDecodeError: Invalid control character at: line 1 column 4 (char 3)",
        "JSONDecodeError: Unterminated string starting at: line 1 column 1 (char 0)",
      ],
      [
        '"ab\x01',
        "JSONDecodeError: Invalid control character at: line 1 column 4 (char 3)",
        "JSONDecodeError: Unterminated string starting at: line 1 column 1 (char 0)",
      ],
      [
        '{"a": "\t"}',
        "JSONDecodeError: Invalid control character at: line 1 column 8 (char 7)",
        { a: "\t" },
      ],
      [
        '{"a": 1}\n{"a": 1}',
        "JSONDecodeError: Extra data: line 2 column 1 (char 9)",
        "JSONDecodeError: Extra data: line 2 column 1 (char 9)",
      ],
      [
        "\ufeff{}",
        "JSONDecodeError: Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)",
        "JSONDecodeError: Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)",
      ],
      ['"\\ud83d\\ude00"', "😀", "😀"],
    ];
    for (const [text, strict, lax] of cases) {
      expect([text, outcome(() => pyJsonLoads(text, { strict: true }))]).toEqual([text, strict]);
      expect([text, outcome(() => pyJsonLoads(text))]).toEqual([text, lax]);
    }
  });

  test("floats keeps Python's floats apart from its ints", () => {
    const text = "[1.0, 2, 1e5, -0, -0.0, NaN, Infinity]";
    const value = pyJsonLoads(text, { floats: true }) as unknown[];
    expect(value.slice(0, 5)).toEqual([new PyFloat(1), 2, new PyFloat(100000), 0, new PyFloat(-0)]);
    expect(pyJsonDumps(value)).toBe("[1.0, 2, 100000.0, 0, -0.0, NaN, Infinity]");
    expect(pyJsonDumps(pyJsonLoads(text))).toBe("[1, 2, 100000, 0, 0, NaN, Infinity]");
  });
});

describe("JSONDecoder.raw_decode", () => {
  test("the first value at the index and the index past it; the rest is ignored", () => {
    const cases: [string, number, unknown, unknown][] = [
      ['{"a": 1}}', 0, [{ a: 1 }, 8], [{ a: 1 }, 8]],
      [
        '  {"a": 1}',
        0,
        "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
        "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
      ],
      ['x{"a": 1} tail', 1, [{ a: 1 }, 9], [{ a: 1 }, 9]],
      [
        "\ufeff{}",
        0,
        "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
        "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
      ],
      [
        '{"a": "x\ny"} tail',
        0,
        "JSONDecodeError: Invalid control character at: line 1 column 9 (char 8)",
        [{ a: "x\ny" }, 12],
      ],
      [
        "",
        0,
        "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
        "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
      ],
      [
        "[1, 2",
        0,
        "JSONDecodeError: Expecting ',' delimiter: line 1 column 6 (char 5)",
        "JSONDecodeError: Expecting ',' delimiter: line 1 column 6 (char 5)",
      ],
      ["1.5e3x", 0, [1500, 5], [1500, 5]],
      [
        '{"a": 1}',
        8,
        "JSONDecodeError: Expecting value: line 1 column 9 (char 8)",
        "JSONDecodeError: Expecting value: line 1 column 9 (char 8)",
      ],
      [
        '{"a": 1}',
        99,
        "JSONDecodeError: Expecting value: line 1 column 100 (char 99)",
        "JSONDecodeError: Expecting value: line 1 column 100 (char 99)",
      ],
    ];
    for (const [text, index, strict, lax] of cases) {
      const label = `${text} @${index}`;
      expect([label, outcome(() => pyRawDecode(text, index, { strict: true }))]).toEqual([
        label,
        strict,
      ]);
      expect([label, outcome(() => pyRawDecode(text, index))]).toEqual([label, lax]);
    }
    expect(outcome(() => pyRawDecode("1", -1))).toBe("ValueError: idx cannot be negative");
  });

  test("indices count code points", () => {
    expect(pyRawDecode('😀{"a": "😀"} tail', 1)).toEqual([{ a: "😀" }, 11]);
  });
});
