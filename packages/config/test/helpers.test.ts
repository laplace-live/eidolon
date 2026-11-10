// Expected values were printed by CPython 3.13 and pydantic 2.13.
import { describe, expect, test } from "bun:test";
import {
  AsyncQueue,
  abortableSleep,
  daysInMonth,
  errorText,
  httpxStatusMessage,
  isJsonObject,
  isLeap,
  isPlainObject,
  isPySpace,
  ordinalToYmd,
  PY_SPACE_CLASS,
  PyFloat,
  parseRetryAfter,
  pyCompare,
  pyError,
  pyGet,
  pyIter,
  pyJsonDumps,
  pyRepr,
  pyTypeName,
  raceAbort,
  retryDelaySeconds,
  shouldRetry,
  sortedPy,
  validationErrorText,
  ymdToOrdinal,
} from "../src/index.ts";

describe("Python object helpers", () => {
  test("errorText is str(e)", () => {
    expect(errorText(new TypeError("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(42)).toBe("42");
  });

  test("pyError carries the exception name", () => {
    const error = pyError("ValueError", "bad");
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.message]).toEqual(["ValueError", "bad"]);
  });

  test("pyTypeName reads any integral number as an int", () => {
    const cases: [unknown, string][] = [
      [null, "NoneType"],
      [undefined, "NoneType"],
      [true, "bool"],
      [5, "int"],
      [5.5, "float"],
      [2 ** 53, "int"],
      [10n, "int"],
      ["x", "str"],
      [[1], "list"],
      [{ a: 1 }, "dict"],
      [new PyFloat(1), "float"],
    ];
    for (const [value, expected] of cases)
      expect([value, pyTypeName(value)]).toEqual([value, expected]);
  });

  test("isPlainObject wants a dict literal; isJsonObject any non-array object", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject(new Map())).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });

  test("pyGet is dict.get, raising AttributeError on a non-dict", () => {
    expect(pyGet({ a: 1 }, "a")).toBe(1);
    expect(pyGet({ a: 1 }, "b")).toBeNull();
    expect(pyGet({}, "b", 7)).toBe(7);
    expect(pyGet({}, "toString")).toBeNull();
    expect(() => pyGet([1], "a")).toThrow("'list' object has no attribute 'get'");
    expect(() => pyGet(1.5, "a")).toThrow("'float' object has no attribute 'get'");
  });

  test("pyIter iterates as a for loop does", () => {
    expect(pyIter([1, 2])).toEqual([1, 2]);
    expect(pyIter("a😀")).toEqual(["a", "😀"]);
    expect(pyIter({ x: 1, y: 2 })).toEqual(["x", "y"]);
    let thrown: unknown;
    try {
      pyIter(3);
    } catch (error) {
      thrown = error;
    }
    expect([(thrown as Error).name, (thrown as Error).message]).toEqual([
      "TypeError",
      "'int' object is not iterable",
    ]);
    expect(() => pyIter(null)).toThrow("'NoneType' object is not iterable");
  });

  test("pyCompare orders by code point", () => {
    expect(pyCompare("a", "a")).toBe(0);
    expect(pyCompare("a", "b")).toBe(-1);
    expect(pyCompare("b", "a")).toBe(1);
    expect(pyCompare("a", "ab")).toBe(-1);
    // U+FF5E sorts after U+1F600 by UTF-16 unit, before it by code point.
    expect(pyCompare("～", "😀")).toBe(-1);
    expect(sortedPy(["😀", "～", "a"])).toEqual(["a", "～", "😀"]);
  });

  test("PY_SPACE_CLASS is exactly str.isspace()", () => {
    const re = new RegExp(`^[${PY_SPACE_CLASS}]$`, "u");
    const plain = new RegExp(`^[${PY_SPACE_CLASS}]$`);
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      const expected = isPySpace(ch);
      if (re.test(ch) !== expected || (cp <= 0xffff && plain.test(ch) !== expected)) {
        throw new Error(`U+${cp.toString(16)} disagrees`);
      }
    }
  });
});

describe("PyFloat", () => {
  test("pyRepr prints it as a float", () => {
    expect(pyRepr({ p50: new PyFloat(527), p90: 2083.8, max: 1500, m: ["it's"], x: null })).toBe(
      "{'p50': 527.0, 'p90': 2083.8, 'max': 1500, 'm': [\"it's\"], 'x': None}",
    );
    expect(pyRepr([new PyFloat(Number.NaN), new PyFloat(-Infinity), new PyFloat(-0)])).toBe(
      "[nan, -inf, -0.0]",
    );
  });

  test("pyJsonDumps prints it as json.dumps prints a float", () => {
    const value = { a: new PyFloat(1), b: 1, c: [new PyFloat(2e-5), new PyFloat(0.5), 0] };
    expect(pyJsonDumps(value, { ensureAscii: false })).toBe(
      '{"a": 1.0, "b": 1, "c": [2e-05, 0.5, 0]}',
    );
    const nested = { 名: "七海\n", list: [], dict: {}, n: null, t: true, f: new PyFloat(1e16) };
    expect(pyJsonDumps(nested, { ensureAscii: false, indent: 1 })).toBe(
      '{\n "名": "七海\\n",\n "list": [],\n "dict": {},\n "n": null,\n "t": true,\n "f": 1e+16\n}',
    );
    expect(pyJsonDumps([new PyFloat(Number.NaN), new PyFloat(Infinity)])).toBe("[NaN, Infinity]");
  });
});

describe("raceAbort", () => {
  test("settles with the promise when nothing aborts", async () => {
    expect(await raceAbort(Promise.resolve(1))).toBe(1);
    expect(await raceAbort(Promise.resolve(2), new AbortController().signal)).toBe(2);
    await expect(
      raceAbort(Promise.reject(new Error("x")), new AbortController().signal),
    ).rejects.toThrow("x");
  });

  test("rejects with the reason on abort, before the promise settles", async () => {
    const controller = new AbortController();
    const pending = raceAbort(new Promise<never>(() => {}), controller.signal);
    controller.abort("stop");
    await expect(pending).rejects.toBe("stop");
  });

  test("an already aborted signal still handles the promise's late rejection", async () => {
    let unhandled = 0;
    const onUnhandled = (): void => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let fail: (error: Error) => void = () => {};
      const late = new Promise<never>((_, reject) => {
        fail = reject;
      });
      await expect(raceAbort(late, AbortSignal.abort("gone"))).rejects.toBe("gone");
      fail(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("abortableSleep", () => {
  test("waits its time without a signal, or with one that never aborts", async () => {
    for (const signal of [undefined, new AbortController().signal]) {
      const started = performance.now();
      await abortableSleep(30, signal);
      expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    }
  });

  test("an abort rejects at once with the reason, and an aborted signal never waits", async () => {
    const controller = new AbortController();
    const started = performance.now();
    const pending = abortableSleep(30_000, controller.signal);
    controller.abort("stop");
    await expect(pending).rejects.toBe("stop");
    await expect(abortableSleep(30_000, controller.signal)).rejects.toBe("stop");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("calendar", () => {
  test("leap years and month lengths", () => {
    expect([1900, 2000, 2024, 2026].map(isLeap)).toEqual([false, true, true, false]);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  test("ordinals match date.toordinal()", () => {
    expect(ymdToOrdinal(1, 1, 1)).toBe(1);
    expect(ymdToOrdinal(1970, 1, 1)).toBe(719_163);
    expect(ymdToOrdinal(2026, 9, 9)).toBe(739_868);
    expect(ymdToOrdinal(9999, 12, 31)).toBe(3_652_059);
    expect(ordinalToYmd(739_868)).toEqual([2026, 9, 9]);
    expect(ordinalToYmd(3_652_059)).toEqual([9999, 12, 31]);
  });

  test("every date in years 1..9999 round-trips in order", () => {
    let ordinal = 0;
    for (let year = 1; year <= 9999; year++) {
      for (let month = 1; month <= 12; month++) {
        for (let day = 1; day <= daysInMonth(year, month); day++) {
          ordinal++;
          if (ymdToOrdinal(year, month, day) !== ordinal)
            throw new Error(`${year}-${month}-${day}`);
          const [y, m, d] = ordinalToYmd(ordinal);
          if (y !== year || m !== month || d !== day) throw new Error(`ordinal ${ordinal}`);
        }
      }
    }
    expect(ordinal).toBe(3_652_059);
  });
});

describe("httpxStatusMessage", () => {
  const url = "https://api.example/v1/x";
  const reply = (status: number, statusText: string, headers: Record<string, string> = {}) => ({
    status,
    statusText,
    headers: new Headers(headers),
  });
  const link = (status: number) =>
    `For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${status}`;

  test("httpx's full text, with a redirect location only for a redirect status", () => {
    expect(httpxStatusMessage(reply(404, "Not Found"), url)).toBe(
      `Client error '404 Not Found' for url '${url}'\n${link(404)}`,
    );
    expect(httpxStatusMessage(reply(302, "Found", { location: "/next" }), url)).toBe(
      `Redirect response '302 Found' for url '${url}'\nRedirect location: '/next'\n${link(302)}`,
    );
    expect(httpxStatusMessage(reply(500, "", { location: "/x" }), url)).toBe(
      `Server error '500' for url '${url}'\n${link(500)}`,
    );
    expect(httpxStatusMessage(reply(301, "", { location: "" }), url)).toBe(
      `Redirect response '301' for url '${url}'\nRedirect location: ''\n${link(301)}`,
    );
    expect(httpxStatusMessage({ status: 304, statusText: "Not Modified" }, url)).toBe(
      `Redirect response '304 Not Modified' for url '${url}'\n${link(304)}`,
    );
  });

  test("anyLocation prints any non-empty Location", () => {
    const options = { anyLocation: true };
    expect(httpxStatusMessage(reply(500, "", { location: "/x" }), url, options)).toBe(
      `Server error '500' for url '${url}'\nRedirect location: '/x'\n${link(500)}`,
    );
    expect(httpxStatusMessage(reply(301, "", { location: "" }), url, options)).toBe(
      `Redirect response '301' for url '${url}'\n${link(301)}`,
    );
  });

  test("statusLineOnly and spaceBeforeEmptyReason", () => {
    expect(httpxStatusMessage(reply(429, "Too Many Requests"), url, { statusLineOnly: true })).toBe(
      `Client error '429 Too Many Requests' for url '${url}'`,
    );
    expect(httpxStatusMessage(reply(503, ""), url, { statusLineOnly: true })).toBe(
      `Server error '503' for url '${url}'`,
    );
    expect(httpxStatusMessage(reply(503, ""), url, { spaceBeforeEmptyReason: true })).toBe(
      `Server error '503 ' for url '${url}'\n${link(503)}`,
    );
  });

  test("a status outside 1xx-5xx", () => {
    expect(httpxStatusMessage({ status: 600, statusText: "" }, url, { statusLineOnly: true })).toBe(
      `Invalid status code '600' for url '${url}'`,
    );
  });
});

describe("the OpenAI SDK retry policy", () => {
  test("parseRetryAfter", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "1e999" }))).toBe(121);
    expect(parseRetryAfter(new Headers({ "retry-after": " 2_0 " }))).toBe(20);
    expect(parseRetryAfter(new Headers({ "retry-after": "inf" }))).toBe(Infinity);
    expect(parseRetryAfter(new Headers({ "retry-after": "+Infinity\xa0" }))).toBe(Infinity);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "1500" }))).toBe(1.5);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "soon", "retry-after": "3" }))).toBe(3);
    expect(parseRetryAfter(new Headers())).toBeNull();
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(
      parseRetryAfter(new Headers({ "retry-after": "Wed, 21 Oct 2015 07:28:30 GMT" }), now),
    ).toBe(30);
  });

  test("shouldRetry", () => {
    expect(shouldRetry(408, new Headers())).toBe(true);
    expect(shouldRetry(409, new Headers())).toBe(true);
    expect(shouldRetry(429, new Headers())).toBe(true);
    expect(shouldRetry(500, new Headers())).toBe(true);
    expect(shouldRetry(422, new Headers())).toBe(false);
    expect(shouldRetry(422, new Headers({ "x-should-retry": "true" }))).toBe(true);
    expect(shouldRetry(500, new Headers({ "x-should-retry": "false" }))).toBe(false);
    expect(shouldRetry(429, new Headers({ "retry-after": "121" }))).toBe(false);
    expect(shouldRetry(429, new Headers({ "retry-after": "1e999" }))).toBe(false);
    expect(shouldRetry(429, new Headers({ "retry-after": "inf" }))).toBe(true);
  });

  test("retryDelaySeconds", () => {
    expect(retryDelaySeconds(5, null, () => 0)).toBe(8);
    expect(retryDelaySeconds(0, null, () => 0)).toBe(0.5);
    expect(retryDelaySeconds(1, null, () => 1)).toBe(0.75);
    expect(retryDelaySeconds(0, new Headers({ "retry-after": "0" }), () => 0)).toBe(0.5);
    expect(retryDelaySeconds(0, new Headers({ "retry-after": "7" }), () => 0)).toBe(7);
    expect(retryDelaySeconds(0, new Headers({ "retry-after": "121" }), () => 0)).toBe(0.5);
  });
});

describe("validationErrorText", () => {
  const visit = (type: string) =>
    `    For further information visit https://errors.pydantic.dev/2.13/v/${type}`;

  test("one error per location, its input repr and type", () => {
    expect(
      validationErrorText("search_streamsArguments", [
        { loc: ["query"], type: "missing", msg: "Field required", input: { extra: 1, b: [1, 2] } },
      ]),
    ).toBe(
      "1 validation error for search_streamsArguments\nquery\n" +
        "  Field required [type=missing, input_value={'extra': 1, 'b': [1, 2]}, input_type=dict]\n" +
        visit("missing"),
    );
  });

  test("an empty loc prints no location line; several errors count in the plural", () => {
    const text = validationErrorText("RecallRequest", [
      { loc: [], type: "model_type", msg: "Input should be a valid dictionary", input: null },
      {
        loc: ["streams", 0],
        type: "string_type",
        msg: "Input should be a valid string",
        input: 5.5,
      },
    ]);
    expect(text).toBe(
      [
        "2 validation errors for RecallRequest",
        "  Input should be a valid dictionary [type=model_type, input_value=None, input_type=NoneType]",
        visit("model_type"),
        "streams.0",
        "  Input should be a valid string [type=string_type, input_value=5.5, input_type=float]",
        visit("string_type"),
      ].join("\n"),
    );
  });

  test("a long repr keeps 25 bytes, '...', 24 bytes, cut to whole characters", () => {
    const shown = (input: unknown) =>
      /input_value=(.*), input_type=/.exec(
        validationErrorText("M", [{ loc: ["mode"], type: "t", msg: "m", input }]),
      )?.[1];
    expect(shown(["x".repeat(80)])).toBe("['xxxxxxxxxxxxxxxxxxxxxxx...xxxxxxxxxxxxxxxxxxxxxx']");
    expect(shown("x".repeat(48))).toBe(`'${"x".repeat(48)}'`);
    expect(shown("x".repeat(49))).toBe("'xxxxxxxxxxxxxxxxxxxxxxxx...xxxxxxxxxxxxxxxxxxxxxxx'");
    expect(shown("你".repeat(30))).toBe("'你你你你你你你你...你你你你你你你'");
    expect(shown("a你".repeat(1) + "你".repeat(29))).toBe("'a你你你你你你你...你你你你你你你'");
    expect(shown("😀a".repeat(15))).toBe("'😀a😀a😀a😀a😀...a😀a😀a😀a😀a'");
  });
});

describe("AsyncQueue", () => {
  async function read<T>(queue: AsyncQueue<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of queue) items.push(item);
    return items;
  }

  test("reads in order, wakes a waiting reader, and ends once closed and drained", async () => {
    const queue = new AsyncQueue<number>();
    const reading = read(queue);
    queue.push(1);
    await Promise.resolve();
    queue.push(2);
    queue.close();
    queue.push(3);
    expect(queue.closed).toBe(true);
    expect(await reading).toEqual([1, 2]);
  });

  test("drop ends at once, leaving what was queued unread", async () => {
    const queue = new AsyncQueue<string>();
    queue.push("a");
    queue.drop();
    expect(await read(queue)).toEqual([]);
  });
});
