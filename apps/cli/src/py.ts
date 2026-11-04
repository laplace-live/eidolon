// Python semantics the CLI output depends on that @eidolon/config doesn't cover: `str.splitlines`,
// `textwrap.indent`, `round`, `statistics`, format-spec padding by code point, and floats Python
// holds as float even when integral ("1.0" where JS prints "1").
import { cpLen, isPySpace, pyFloatRepr, pyRepr, pyTruthy } from "@eidolon/config";

/** A value Python holds as a float, so it prints as "1.0" where a JS number would print "1". */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export type PyNumber = number | PyFloat;

export function numOf(x: PyNumber): number {
  return x instanceof PyFloat ? x.value : x;
}

/** An Error whose `name` is the Python exception class, so a crash reads as Python's last line. */
export function pyError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: str.splitlines() also splits on U+001C–U+001E.
const LINE_BREAK = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/;
const LINE_BREAKS = new RegExp(LINE_BREAK.source, "g");

/** `str.splitlines()`. */
export function splitlines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(LINE_BREAK);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** `str.splitlines(keepends=True)`. */
function splitlinesKeepends(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (const match of text.matchAll(LINE_BREAKS)) {
    const end = match.index + match[0].length;
    lines.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** `textwrap.indent(text, prefix)`: whitespace-only lines stay unprefixed. */
export function textwrapIndent(text: string, prefix: string): string {
  return splitlinesKeepends(text)
    .map((line) => ([...line].every(isPySpace) ? line : prefix + line))
    .join("");
}

/** f-string `{s:<width}`, counted in code points. */
export function ljust(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cpLen(text)));
}

/** f-string `{s:>width}`, counted in code points. */
export function rjust(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - cpLen(text))) + text;
}

/** What `for x in value` visits for a JSON value: list items, string characters, dict keys. */
export function iterPy(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (isDict(value)) return Object.keys(value);
  if (value === null || value === undefined) {
    throw pyError("TypeError", "'NoneType' object is not iterable");
  }
  const type = typeof value === "boolean" ? "bool" : Number.isInteger(value) ? "int" : "float";
  throw pyError("TypeError", `'${type}' object is not iterable`);
}

/** `value or []`, iterated. */
export function itemsOr(value: unknown): unknown[] {
  return pyTruthy(value) ? iterPy(value) : [];
}

/** `str.partition(sep)`. */
export function partition(text: string, sep: string): [string, string, string] {
  const i = text.indexOf(sep);
  return i === -1 ? [text, "", ""] : [text.slice(0, i), sep, text.slice(i + sep.length)];
}

/** `round(x)` to an int: ties go to the even neighbour. */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const fraction = x - floor;
  if (fraction !== 0.5) return fraction < 0.5 ? floor : floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function sortedNumbers(data: readonly number[]): number[] {
  return [...data].sort((a, b) => a - b);
}

/** `statistics.median`: the middle value, or the mean of the two middle values. */
export function median(data: readonly number[]): number {
  const sorted = sortedNumbers(data);
  const n = sorted.length;
  if (n === 0) throw pyError("StatisticsError", "no median for empty data");
  if (n % 2 === 1) return sorted[(n - 1) / 2] as number;
  return ((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2;
}

/** `statistics.quantiles(data, n=n)`, the default exclusive method. */
export function quantilesExclusive(data: readonly number[], n: number): number[] {
  if (n < 1) throw pyError("StatisticsError", "n must be at least 1");
  const sorted = sortedNumbers(data);
  const ld = sorted.length;
  if (ld < 2) {
    if (ld === 1) return Array.from({ length: n - 1 }, () => sorted[0] as number);
    throw pyError("StatisticsError", "must have at least one data point");
  }
  const m = ld + 1;
  const result: number[] = [];
  for (let i = 1; i < n; i++) {
    const j = Math.min(Math.max(Math.floor((i * m) / n), 1), ld - 1);
    const delta = i * m - j * n;
    result.push(((sorted[j - 1] as number) * (n - delta) + (sorted[j] as number) * delta) / n);
  }
  return result;
}

/** `statistics.mean`, summed in floating point where Python sums exactly; it prints as whole ms. */
export function mean(data: readonly number[]): number {
  if (data.length === 0) throw pyError("StatisticsError", "mean requires at least one data point");
  return data.reduce((sum, x) => sum + x, 0) / data.length;
}

/** A JSON object, which Python would hold as a dict. */
export function isDict(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Python `repr()` of a JSON-shaped value that may hold PyFloats. */
export function reprPy(value: unknown): string {
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (Array.isArray(value)) return `[${value.map(reprPy).join(", ")}]`;
  if (isDict(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${pyRepr(k)}: ${reprPy(v)}`).join(", ")}}`;
  }
  return pyRepr(value);
}

function jsonNumber(value: number, float: boolean): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return !float && Number.isSafeInteger(value) ? String(value) : pyFloatRepr(value);
}

/** `json.dumps(value, ensure_ascii=False, indent=indent)` for values that may hold PyFloats. */
export function dumpsPy(value: unknown, options: { indent?: number } = {}): string {
  const { indent } = options;
  const encode = (v: unknown, depth: number): string => {
    if (v instanceof PyFloat) return jsonNumber(v.value, true);
    if (v === null || v === undefined) return "null";
    switch (typeof v) {
      case "boolean":
        return v ? "true" : "false";
      case "number":
        return jsonNumber(v, false);
      case "bigint":
        return v.toString();
      case "string":
        return JSON.stringify(v);
    }
    let items: string[];
    let brackets: [string, string];
    if (Array.isArray(v)) {
      items = v.map((x) => encode(x, depth + 1));
      brackets = ["[", "]"];
    } else if (isDict(v)) {
      items = Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => `${JSON.stringify(k)}: ${encode(x, depth + 1)}`);
      brackets = ["{", "}"];
    } else {
      throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
    }
    const [open, close] = brackets;
    if (items.length === 0) return open + close;
    if (indent === undefined) return `${open}${items.join(", ")}${close}`;
    const pad = " ".repeat(indent * (depth + 1));
    return `${open}\n${pad}${items.join(`,\n${pad}`)}\n${" ".repeat(indent * depth)}${close}`;
  };
  return encode(value, 0);
}

/**
 * `json.loads`: a number literal with a fraction or an exponent is a Python float, so it comes back
 * as a PyFloat; every other number is an int.
 */
export function loadsPy(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && /[.eE]/.test(context?.source ?? "") ? new PyFloat(value) : value,
  );
}
