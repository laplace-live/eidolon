// Goldens from pydantic-core under the Python venv (to_json and str(ValidationError)).
import { expect, test } from "bun:test";
import { envelopeText, pydanticFloat, validationErrorText } from "../../src/mcp/pydantic.ts";

test("floats print as pydantic_core.to_json does", () => {
  const cases: [number, string][] = [
    [0.92, "0.92"],
    [0.9200000166893005, "0.9200000166893005"],
    [1, "1.0"],
    [0, "0.0"],
    [-0, "-0.0"],
    [1e-5, "0.00001"],
    [1.2e-5, "0.000012"],
    [1e-6, "1e-6"],
    [1.5e-6, "1.5e-6"],
    [5.2e-6, "5.2e-6"],
    [1e-7, "1e-7"],
    [0.0001, "0.0001"],
    [123456789012345.6, "123456789012345.6"],
    [1e15, "1000000000000000.0"],
    [1e16, "1e+16"],
    [1.5e16, "1.5e+16"],
    [1e21, "1e+21"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [5e-324, "5e-324"],
    [0.1 + 0.2, "0.30000000000000004"],
    [0.01639344262295082, "0.01639344262295082"],
    [100, "100.0"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NaN, "NaN"],
  ];
  for (const [value, text] of cases) expect([value, pydanticFloat(value)]).toEqual([value, text]);
});

test("the envelope text keeps counts as ints and scores as floats", () => {
  expect(envelopeText({ count: 0, results: [], o: {} })).toBe(
    '{\n  "count": 0,\n  "results": [],\n  "o": {}\n}',
  );
  expect(envelopeText({ count: 1, results: [{ text: 'a\n"b"', score: 1 }] })).toBe(
    '{\n  "count": 1,\n  "results": [\n    {\n      "text": "a\\n\\"b\\"",\n      "score": 1.0\n    }\n  ]\n}',
  );
});

test("input_value truncates past 50 UTF-8 bytes on character boundaries", () => {
  const shown = (input: unknown) =>
    validationErrorText("M", [{ loc: "query", type: "string_type", message: "m", input }])
      .split("input_value=")[1]
      ?.split(", input_type")[0];
  expect(shown(["a".repeat(46)])).toBe(`['${"a".repeat(46)}']`);
  expect(shown(["a".repeat(47)])).toBe(`['${"a".repeat(23)}...${"a".repeat(22)}']`);
  expect(shown(["奶".repeat(15)])).toBe(`['${"奶".repeat(15)}']`);
  expect(shown(["奶".repeat(16)])).toBe(`['${"奶".repeat(7)}...${"奶".repeat(7)}']`);
  expect(shown([`${"a".repeat(20)}奶${"b".repeat(30)}`])).toBe(
    `['${"a".repeat(20)}奶...${"b".repeat(22)}']`,
  );
  expect(shown([`${"b".repeat(30)}é${"a".repeat(21)}`])).toBe(
    `['${"b".repeat(23)}...${"a".repeat(21)}']`,
  );
  expect(shown(["😀".repeat(30)])).toBe(`['${"😀".repeat(5)}...${"😀".repeat(5)}']`);
  expect(shown({ ["日".repeat(60)]: 1 })).toBe(`{'${"日".repeat(7)}...${"日".repeat(6)}': 1}`);
  expect(shown([null, true, false, 1.5, { a: [1] }])).toBe("[None, True, False, 1.5, {'a': [1]}]");
});

test("the error count is pluralized as pydantic does", () => {
  const error = { loc: "x", type: "missing", message: "Field required", input: {} };
  expect(validationErrorText("M", [error])).toStartWith("1 validation error for M\nx\n");
  expect(validationErrorText("M", [error, error])).toStartWith("2 validation errors for M\nx\n");
});
