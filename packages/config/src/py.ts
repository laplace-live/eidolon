// Python text semantics the TS port must reproduce byte for byte: `repr`, `str`, truthiness,
// `str.strip`/`str.split` whitespace, code-point lengths, `sorted()` order, `json.dumps` and
// f-string `.Nf` rounding. JS defaults differ on each: `trim()` strips U+FEFF but not U+001C–U+001F
// or U+0085, `.length` counts UTF-16 units, `sort()` compares UTF-16 units, and `toFixed` rounds
// exact binary ties up where Python rounds them to even.
//
// JS has one number type, so an integral number always prints as a Python int ("2", never "2.0").
// Where the Python value is a float, use pyFloatRepr, or wrap it in a PyFloat inside a structure.

const PY_WHITESPACE =
  "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005" +
  "\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
const PY_WHITESPACE_SET = new Set(PY_WHITESPACE);

/** `str.isspace()` as a regex character-class body: `new RegExp(`[${PY_SPACE_CLASS}]`)`. */
export const PY_SPACE_CLASS = String.raw`\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;

/** Python `str.isspace()` for one code point. */
export function isPySpace(ch: string): boolean {
  return PY_WHITESPACE_SET.has(ch);
}

const DECIMAL_DIGIT = /^\p{Nd}$/u;

/** A Unicode decimal digit's value, or null. Every digit set is ten contiguous code points. */
export function pyDigitValue(ch: string): number | null {
  const cp = ch.codePointAt(0) as number;
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  if (!DECIMAL_DIGIT.test(ch)) return null;
  let zero = cp;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
  return (cp - zero) % 10;
}

// What int() and float() parse, as CPython's _PyUnicode_TransformDecimalAndSpaceToASCII builds
// it: past ASCII a space becomes " " and a decimal digit its ASCII digit, and anything else makes
// the text unparseable. Only ASCII whitespace is then skipped, so "\x1c12" fails where
// str.strip() would have removed the "\x1c", and a leading U+FEFF fails where trim() drops it.
function pyNumericAscii(text: string): string | null {
  let ascii = "";
  for (const ch of text) {
    if ((ch.codePointAt(0) as number) < 0x7f) ascii += ch;
    else if (isPySpace(ch)) ascii += " ";
    else {
      const digit = pyDigitValue(ch);
      if (digit === null) return null;
      ascii += digit;
    }
  }
  return ascii;
}

const ASCII_WS_EDGES = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
const INT_LITERAL = /^([+-]?)(\d+(?:_\d+)*)$/;
const FLOAT_LITERAL =
  /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const SPECIAL_FLOAT = /^([+-]?)(inf|infinity|nan)$/i;

/** Python `int(text)`, or null where it raises ValueError. */
export function pyParseInt(text: string): number | null {
  const match = INT_LITERAL.exec(pyNumericAscii(text)?.replace(ASCII_WS_EDGES, "") ?? "");
  if (!match) return null;
  const n = Number((match[2] as string).replaceAll("_", ""));
  return match[1] === "-" && n !== 0 ? -n : n;
}

/** Python `float(text)`, `inf` and `nan` included, or null where it raises ValueError. */
export function pyParseFloat(text: string): number | null {
  const ascii = pyNumericAscii(text)?.replace(ASCII_WS_EDGES, "");
  if (ascii === undefined) return null;
  if (FLOAT_LITERAL.test(ascii)) return Number(ascii.replaceAll("_", ""));
  const special = SPECIAL_FLOAT.exec(ascii);
  if (!special) return null;
  if (special[2]?.toLowerCase() === "nan") return Number.NaN;
  return special[1] === "-" ? -Infinity : Infinity;
}

/** Python `str.strip(chars)`; without `chars`, Python's whitespace set. */
export function pyStrip(s: string, chars?: string): string {
  const strip = chars === undefined ? PY_WHITESPACE_SET : new Set(chars);
  const points = [...s];
  let start = 0;
  let end = points.length;
  while (start < end && strip.has(points[start] as string)) start++;
  while (end > start && strip.has(points[end - 1] as string)) end--;
  return points.slice(start, end).join("");
}

/** Python `str.split()` with no arguments: runs of whitespace separate, empties dropped. */
export function pySplitWs(s: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of s) {
    if (PY_WHITESPACE_SET.has(ch)) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Python `len(s)`: code points, not UTF-16 units. */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Python `s[start:end]` over code points, including negative indices. */
export function cpSlice(s: string, start?: number, end?: number): string {
  const points = [...s];
  const len = points.length;
  const clamp = (i: number | undefined, fallback: number): number => {
    if (i === undefined) return fallback;
    if (i < 0) return Math.max(0, len + i);
    return Math.min(len, i);
  };
  return points.slice(clamp(start, 0), clamp(end, len)).join("");
}

/** Python string ordering: by code point, where JS `<` compares UTF-16 units. */
export function pyCompare(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = (x.value as string).codePointAt(0) as number;
    const cy = (y.value as string).codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Python `sorted()` of strings: code-point order. */
export function sortedPy(strings: Iterable<string>): string[] {
  return [...strings].sort(pyCompare);
}

/** Python `bool(value)` for JSON-shaped values. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/** A Python dict as JS builds one: an object literal or a null-prototype object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Python `isinstance(value, dict)` for a `JSON.parse` result. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value Python holds as a float, so it prints as "1.0" where a JS number would print "1". */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** Python `type(value).__name__` for a JSON value; any integral number is an int. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    case "bigint":
      return "int";
    case "string":
      return "str";
  }
  if (value instanceof PyFloat) return "float";
  return Array.isArray(value) ? "list" : "dict";
}

/** An Error whose `name` is the Python exception class, as `{type(e).__name__}: {e}` prints it. */
export function pyError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Python `str(e)` for a caught error: the message alone. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `value.get(key, fallback)`, raising Python's AttributeError when `value` is not a dict. */
export function pyGet(value: unknown, key: string, fallback: unknown = null): unknown {
  if (!isPlainObject(value)) {
    throw pyError("AttributeError", `'${pyTypeName(value)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** `for item in value` over a JSON value: lists yield items, strings code points, dicts keys. */
export function pyIter(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (isPlainObject(value)) return Object.keys(value);
  throw pyError("TypeError", `'${pyTypeName(value)}' object is not iterable`);
}

/** `float.__repr__`. */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";
  const [mantissa = "0", expText = "0"] = value.toExponential().split("e");
  const exp = Number(expText);
  if (exp >= -4 && exp < 16) {
    const fixed = Object.is(value, -0) ? "-0" : fixedFromExponential(mantissa, exp);
    return fixed.includes(".") ? fixed : `${fixed}.0`;
  }
  const abs = Math.abs(exp);
  return `${mantissa}e${exp < 0 ? "-" : "+"}${abs < 10 ? "0" : ""}${abs}`;
}

function fixedFromExponential(mantissa: string, exp: number): string {
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const point = 1 + exp;
  let text: string;
  if (point <= 0) text = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) text = digits + "0".repeat(point - digits.length);
  else text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${text}` : text;
}

/** Python `repr(int)` for integral numbers, `float.__repr__` otherwise. */
function pyNumberRepr(value: number): string {
  if (Number.isSafeInteger(value)) return String(value);
  return pyFloatRepr(value);
}

/** Python's own test for a printable code point (`str.isprintable`), used by `repr`. */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, "0");
}

/** Python `repr(str)`. */
export function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${hex(code, 2)}`;
    else if (code < 0x7f) out += ch;
    else if (ch !== " " && NON_PRINTABLE.test(ch)) {
      if (code <= 0xff) out += `\\x${hex(code, 2)}`;
      else if (code <= 0xffff) out += `\\u${hex(code, 4)}`;
      else out += `\\U${hex(code, 8)}`;
    } else out += ch;
  }
  return out + quote;
}

/** Python `repr()` of a JSON-shaped value: arrays as lists, plain objects as dicts. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  switch (typeof value) {
    case "boolean":
      return value ? "True" : "False";
    case "number":
      return pyNumberRepr(value);
    case "bigint":
      return value.toString();
    case "string":
      return pyStrRepr(value);
  }
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (value instanceof Map) {
    return `{${[...value].map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return String(value);
}

/** Python `str()`: strings as is, everything else as `repr`. */
export function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

function bitsOf(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  const fraction = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased === 0) return { mantissa: fraction, exponent: -1074 };
  return { mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
}

/** f-string `format(value, ".{digits}f")`: exact binary value, ties to even. */
export function pyFixed(value: number, digits: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const negative = value < 0 || Object.is(value, -0);
  const { mantissa, exponent } = bitsOf(Math.abs(value));
  const scale = 10n ** BigInt(digits);
  let units: bigint;
  if (exponent >= 0) {
    units = (mantissa << BigInt(exponent)) * scale;
  } else {
    const denominator = 1n << BigInt(-exponent);
    const numerator = mantissa * scale;
    units = numerator / denominator;
    const twice = (numerator % denominator) * 2n;
    if (twice > denominator || (twice === denominator && units % 2n === 1n)) units += 1n;
  }
  let text = units.toString().padStart(digits + 1, "0");
  if (digits > 0) text = `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  return negative ? `-${text}` : text;
}

function jsonString(s: string, ensureAscii: boolean): string {
  const json = JSON.stringify(s);
  if (!ensureAscii) return json;
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${hex(c.charCodeAt(0), 4)}`);
}

function jsonNumber(value: number, float: boolean): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return float ? pyFloatRepr(value) : pyNumberRepr(value);
}

/** `json.dumps(value, ensure_ascii=..., indent=...)` with Python's default separators. */
export function pyJsonDumps(
  value: unknown,
  options: { ensureAscii?: boolean; indent?: number } = {},
): string {
  const ensureAscii = options.ensureAscii ?? true;
  const indent = options.indent;
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
        return jsonString(v, ensureAscii);
    }
    let items: string[];
    let open: string;
    let close: string;
    if (Array.isArray(v)) {
      items = v.map((x) => encode(x, depth + 1));
      [open, close] = ["[", "]"];
    } else if (isPlainObject(v)) {
      items = Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => `${jsonString(k, ensureAscii)}: ${encode(x, depth + 1)}`);
      [open, close] = ["{", "}"];
    } else {
      throw new TypeError(
        `Object of type ${v?.constructor?.name ?? typeof v} is not JSON serializable`,
      );
    }
    if (items.length === 0) return open + close;
    if (indent === undefined) return `${open}${items.join(", ")}${close}`;
    const pad = " ".repeat(indent * (depth + 1));
    const closePad = " ".repeat(indent * depth);
    return `${open}\n${pad}${items.join(`,\n${pad}`)}\n${closePad}${close}`;
  };
  return encode(value, 0);
}
