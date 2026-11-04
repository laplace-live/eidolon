// Python `re` on str patterns, so patterns can be copied verbatim from the Python source. JS
// differs on each: `\d` is any Nd digit, `\s` is `str.isspace()` (JS also matches U+FEFF but not
// U+001C–U+001F or U+0085), `\w`/`\b` use Unicode word characters (CJK included), `.` excludes
// only "\n", and `$` also matches before a trailing newline.
import { cpLen, cpSlice, PY_SPACE_CLASS, pyDigitValue, pyRepr } from "@eidolon/config";

const W_CLASS = String.raw`\p{L}\p{N}_`;
const BOUNDARY = `(?:(?<=[${W_CLASS}])(?![${W_CLASS}])|(?<![${W_CLASS}])(?=[${W_CLASS}]))`;
const NOT_BOUNDARY = `(?:(?<=[${W_CLASS}])(?=[${W_CLASS}])|(?<![${W_CLASS}])(?![${W_CLASS}]))`;
// Identity escapes JS allows under the `u` flag; Python lets any punctuation be escaped.
const SYNTAX = new Set("^$\\.*+?()[]{}|/");

function escapeOutside(c: string): string {
  switch (c) {
    case "d":
      return String.raw`\p{Nd}`;
    case "D":
      return String.raw`\P{Nd}`;
    case "s":
      return `[${PY_SPACE_CLASS}]`;
    case "S":
      return `[^${PY_SPACE_CLASS}]`;
    case "w":
      return `[${W_CLASS}]`;
    case "W":
      return `[^${W_CLASS}]`;
    case "b":
      return BOUNDARY;
    case "B":
      return NOT_BOUNDARY;
  }
  if (/[A-Za-z0-9]/.test(c) || SYNTAX.has(c)) return `\\${c}`;
  return c;
}

function escapeInside(c: string, pattern: string): string {
  switch (c) {
    case "d":
      return String.raw`\p{Nd}`;
    case "D":
      return String.raw`\P{Nd}`;
    case "s":
      return PY_SPACE_CLASS;
    case "w":
      return W_CLASS;
    case "S":
    case "W":
      throw new SyntaxError(`negated class escape inside [...] is not translated: ${pattern}`);
  }
  if (/[A-Za-z0-9]/.test(c) || SYNTAX.has(c) || c === "-") return `\\${c}`;
  return c;
}

/** Translates a Python `re` pattern (str, no inline flags) to JS source for the `u` flag. */
export function pyRegexSource(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "\\") {
      const next = pattern[++i];
      if (next === undefined) throw new SyntaxError(`bad escape (end of pattern): ${pattern}`);
      out += inClass ? escapeInside(next, pattern) : escapeOutside(next);
    } else if (inClass) {
      if (c === "]") inClass = false;
      out += c;
    } else if (c === "[") {
      inClass = true;
      out += c;
      if (pattern[i + 1] === "^") out += pattern[++i];
    } else if (c === ".") {
      out += "[^\\n]";
    } else if (c === "$") {
      out += "(?=\\n?$)";
    } else if (pattern.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
    } else {
      out += c;
    }
  }
  return out;
}

/** A compiled Python pattern with `re`'s entry points; `flags` is "" or "i" (re.IGNORECASE). */
export class PyPattern {
  readonly #search: RegExp;
  readonly #all: RegExp;
  readonly #match: RegExp;
  readonly #full: RegExp;

  constructor(pattern: string, flags: "" | "i" = "") {
    const source = pyRegexSource(pattern);
    this.#search = new RegExp(source, `u${flags}`);
    this.#all = new RegExp(source, `gu${flags}`);
    this.#match = new RegExp(`^(?:${source})`, `u${flags}`);
    this.#full = new RegExp(`^(?:${source})$`, `u${flags}`);
  }

  search(text: string): RegExpExecArray | null {
    return this.#search.exec(text);
  }

  match(text: string): RegExpExecArray | null {
    return this.#match.exec(text);
  }

  fullmatch(text: string): RegExpExecArray | null {
    return this.#full.exec(text);
  }

  finditer(text: string): RegExpExecArray[] {
    return [...text.matchAll(this.#all)] as RegExpExecArray[];
  }

  sub(replacement: string, text: string): string {
    return text.replace(this.#all, () => replacement);
  }
}

/** UTF-16 end offset of a match, for slicing the string it was run on. */
export function matchEnd(match: RegExpExecArray): number {
  return match.index + match[0].length;
}

const ALL_ND = /^\p{Nd}+$/u;

/** `str.isdigit()` over what `\d` captures: Nd digits only, never empty. */
export function isNdDigits(text: string): boolean {
  return ALL_ND.test(text);
}

/** Python `int(s)` for a string of Nd digits: `int("２６") == 26`, `int("٢٠٢٦") == 2026`. */
export function pyInt(digits: string): number {
  if (!isNdDigits(digits)) {
    throw new SyntaxError(`invalid literal for int() with base 10: ${pyRepr(digits)}`);
  }
  let n = 0;
  for (const ch of digits) n = n * 10 + (pyDigitValue(ch) as number);
  return n;
}

/** `_clip`: at most `maxChars` code points, ending in "…" when cut. */
export function clip(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (cpLen(text) <= maxChars) return text;
  return `${cpSlice(text, 0, maxChars - 1)}…`;
}
