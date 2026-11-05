// Python's `json.loads` and `JSONDecoder.raw_decode`, following CPython's C scanner, its error
// messages and code-point positions included, since they reach logs and records. JSON.parse also
// rejects NaN and Infinity, and has no non-strict mode for raw control characters inside strings,
// which mem0 parses with (`strict=False`).
import { PyFloat, pyError } from "./py.ts";

export interface PyJsonOptions {
  /**
   * Python's default (`json.loads(s)`, `JSONDecoder()`): a raw control character inside a string
   * is an error. Off unless set, as mem0 parses.
   */
  readonly strict?: boolean;
  /** Number literals with a fraction or an exponent (and NaN, ±Infinity) come back as PyFloat. */
  readonly floats?: boolean;
}

class StopIteration {
  readonly index: number;
  constructor(index: number) {
    this.index = index;
  }
}

function decodeError(message: string, points: readonly string[], pos: number): Error {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < pos; i++) {
    if (points[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return pyError(
    "JSONDecodeError",
    `${message}: line ${line} column ${pos - lastNewline} (char ${pos})`,
  );
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

class Scanner {
  readonly s: readonly string[];
  readonly strict: boolean;
  readonly floats: boolean;
  constructor(points: readonly string[], options: PyJsonOptions) {
    this.s = points;
    this.strict = options.strict ?? false;
    this.floats = options.floats ?? false;
  }

  skipWhitespace(idx: number): number {
    while (idx < this.s.length && WHITESPACE.has(this.s[idx] as string)) idx++;
    return idx;
  }

  matches(idx: number, word: string): boolean {
    for (let i = 0; i < word.length; i++) if (this.s[idx + i] !== word[i]) return false;
    return true;
  }

  float(value: number): number | PyFloat {
    return this.floats ? new PyFloat(value) : value;
  }

  value(idx: number): [unknown, number] {
    const s = this.s;
    if (idx >= s.length) throw new StopIteration(idx);
    switch (s[idx]) {
      case '"':
        return this.string(idx + 1);
      case "{":
        return this.object(idx + 1);
      case "[":
        return this.array(idx + 1);
      case "n":
        if (this.matches(idx, "null")) return [null, idx + 4];
        break;
      case "t":
        if (this.matches(idx, "true")) return [true, idx + 4];
        break;
      case "f":
        if (this.matches(idx, "false")) return [false, idx + 5];
        break;
      case "N":
        if (this.matches(idx, "NaN")) return [this.float(Number.NaN), idx + 3];
        break;
      case "I":
        if (this.matches(idx, "Infinity")) return [this.float(Number.POSITIVE_INFINITY), idx + 8];
        break;
      case "-":
        if (this.matches(idx, "-Infinity")) return [this.float(Number.NEGATIVE_INFINITY), idx + 9];
        break;
    }
    return this.number(idx);
  }

  number(start: number): [number | PyFloat, number] {
    const s = this.s;
    let idx = start;
    if (s[idx] === "-") idx++;
    if (s[idx] === "0") idx++;
    else if (isDigit(s[idx])) while (isDigit(s[idx])) idx++;
    else throw new StopIteration(start);
    let float = false;
    if (s[idx] === "." && isDigit(s[idx + 1])) {
      float = true;
      idx += 2;
      while (isDigit(s[idx])) idx++;
    }
    if (s[idx] === "e" || s[idx] === "E") {
      let end = idx + 1;
      if (s[end] === "-" || s[end] === "+") end++;
      if (isDigit(s[end])) {
        while (isDigit(s[end])) end++;
        float = true;
        idx = end;
      }
    }
    const value = Number(s.slice(start, idx).join(""));
    if (float) return [this.float(value), idx];
    // "-0" is a Python int, and ints have no negative zero.
    return [value !== 0 ? value : 0, idx];
  }

  hex4(from: number): number | null {
    let value = 0;
    for (let i = from; i < from + 4; i++) {
      const ch = this.s[i] ?? "";
      if (!/^[0-9a-fA-F]$/.test(ch)) return null;
      value = value * 16 + Number.parseInt(ch, 16);
    }
    return value;
  }

  string(end: number): [string, number] {
    const s = this.s;
    const begin = end - 1;
    let out = "";
    for (;;) {
      let next = end;
      // The C scanner checks for a control character before it notices the string never ends.
      for (; next < s.length; next++) {
        const ch = s[next] as string;
        if (ch === '"' || ch === "\\") break;
        if (this.strict && (ch.codePointAt(0) as number) <= 0x1f) {
          throw decodeError("Invalid control character at", s, next);
        }
      }
      if (next >= s.length) throw decodeError("Unterminated string starting at", s, begin);
      out += s.slice(end, next).join("");
      if (s[next] === '"') return [out, next + 1];
      next++;
      if (next === s.length) throw decodeError("Unterminated string starting at", s, begin);
      const esc = s[next] as string;
      if (esc !== "u") {
        const decoded = ESCAPES[esc];
        if (decoded === undefined) throw decodeError("Invalid \\escape", s, next - 1);
        out += decoded;
        end = next + 1;
        continue;
      }
      end = next + 5;
      if (end >= s.length) throw decodeError("Invalid \\uXXXX escape", s, next);
      let code = this.hex4(next + 1);
      if (code === null) throw decodeError("Invalid \\uXXXX escape", s, next);
      if (code >= 0xd800 && code <= 0xdbff && end + 6 < s.length && this.matches(end, "\\u")) {
        const low = this.hex4(end + 2);
        if (low === null) throw decodeError("Invalid \\uXXXX escape", s, end + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          end += 6;
        }
      }
      out += String.fromCodePoint(code);
    }
  }

  object(idx: number): [Record<string, unknown>, number] {
    const s = this.s;
    const result: Record<string, unknown> = {};
    idx = this.skipWhitespace(idx);
    if (s[idx] === "}") return [result, idx + 1];
    for (;;) {
      if (s[idx] !== '"') {
        throw decodeError("Expecting property name enclosed in double quotes", s, idx);
      }
      const [key, afterKey] = this.string(idx + 1);
      idx = this.skipWhitespace(afterKey);
      if (s[idx] !== ":") throw decodeError("Expecting ':' delimiter", s, idx);
      const [value, afterValue] = this.value(this.skipWhitespace(idx + 1));
      // defineProperty keeps a "__proto__" key an own property, as a Python dict holds it.
      Object.defineProperty(result, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      idx = this.skipWhitespace(afterValue);
      if (s[idx] === "}") return [result, idx + 1];
      if (s[idx] !== ",") throw decodeError("Expecting ',' delimiter", s, idx);
      const comma = idx;
      idx = this.skipWhitespace(idx + 1);
      if (s[idx] === "}") {
        throw decodeError("Illegal trailing comma before end of object", s, comma);
      }
    }
  }

  array(idx: number): [unknown[], number] {
    const s = this.s;
    const result: unknown[] = [];
    idx = this.skipWhitespace(idx);
    if (s[idx] === "]") return [result, idx + 1];
    for (;;) {
      const [value, after] = this.value(idx);
      result.push(value);
      idx = this.skipWhitespace(after);
      if (s[idx] === "]") return [result, idx + 1];
      if (s[idx] !== ",") throw decodeError("Expecting ',' delimiter", s, idx);
      const comma = idx;
      idx = this.skipWhitespace(idx + 1);
      if (s[idx] === "]") {
        throw decodeError("Illegal trailing comma before end of array", s, comma);
      }
    }
  }
}

/** `json.loads(text)`; failures raise an error named `JSONDecodeError`. Non-strict unless asked. */
export function pyJsonLoads(text: string, options: PyJsonOptions = {}): unknown {
  const points = Array.from(text);
  if (points[0] === "\ufeff") {
    throw decodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", points, 0);
  }
  const scanner = new Scanner(points, options);
  try {
    const [value, end] = scanner.value(scanner.skipWhitespace(0));
    const rest = scanner.skipWhitespace(end);
    if (rest !== points.length) throw decodeError("Extra data", points, rest);
    return value;
  } catch (error) {
    if (error instanceof StopIteration) throw decodeError("Expecting value", points, error.index);
    throw error;
  }
}

/**
 * `JSONDecoder(strict=...).raw_decode(text, index)`: the first value starting exactly at `index`
 * (no whitespace skipped) and the code-point index just past it; whatever follows is ignored.
 * Non-strict unless asked, where `JSONDecoder()` is strict.
 */
export function pyRawDecode(
  text: string,
  index = 0,
  options: PyJsonOptions = {},
): [unknown, number] {
  if (index < 0) throw pyError("ValueError", "idx cannot be negative");
  const points = Array.from(text);
  try {
    return new Scanner(points, options).value(index);
  } catch (error) {
    if (error instanceof StopIteration) throw decodeError("Expecting value", points, error.index);
    throw error;
  }
}
