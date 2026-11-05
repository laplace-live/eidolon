// Python `re` on str patterns, so patterns can be copied verbatim from the Python source. JS
// differs on each: `\d` is any Nd digit, `\s` is `str.isspace()` (JS also matches U+FEFF but not
// U+001C–U+001F or U+0085), `\w`/`\b` use Unicode word characters (CJK included), `.` excludes
// only "\n", and `$` also matches before a trailing newline. Under re.MULTILINE, `^` and `$` see
// only "\n" as a line break, where JS's `m` flag also breaks on "\r", U+2028 and U+2029.
import { cpLen, cpSlice, PY_SPACE_CLASS, pyDigitValue, pyRepr } from "@eidolon/config";

/** Python's flags as their inline letters: "i" re.IGNORECASE, "m" re.MULTILINE, "s" re.DOTALL. */
export type PyFlags = string;

function flagSet(flags: PyFlags): Set<string> {
  const set = new Set(flags);
  for (const flag of set) {
    if (!"ims".includes(flag)) throw new SyntaxError(`unsupported flag ${pyRepr(flag)}`);
  }
  return set;
}

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
export function pyRegexSource(pattern: string, flags: PyFlags = ""): string {
  const set = flagSet(flags);
  const multiline = set.has("m");
  const dotall = set.has("s");
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
      out += dotall ? "[\\s\\S]" : "[^\\n]";
    } else if (c === "^") {
      out += multiline ? "(?:^|(?<=\\n))" : "^";
    } else if (c === "$") {
      out += multiline ? "(?=\\n|$)" : "(?=\\n?$)";
    } else if (pattern.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
    } else {
      out += c;
    }
  }
  return out;
}

/** A compiled Python pattern with `re`'s entry points. */
export class PyPattern {
  readonly #search: RegExp;
  readonly #all: RegExp;
  readonly #match: RegExp;
  readonly #full: RegExp;
  readonly #groups: number;
  readonly #names: ReadonlySet<string>;

  constructor(pattern: string, flags: PyFlags = "") {
    const source = pyRegexSource(pattern, flags);
    const js = flagSet(flags).has("i") ? "ui" : "u";
    this.#search = new RegExp(source, js);
    this.#all = new RegExp(source, `g${js}`);
    this.#match = new RegExp(`^(?:${source})`, js);
    this.#full = new RegExp(`^(?:${source})$`, js);
    // The empty branch always matches, which reports every group the pattern declares.
    const probe = new RegExp(`(?:${source})|`, js).exec("") as RegExpExecArray;
    this.#groups = probe.length - 1;
    this.#names = new Set(Object.keys(probe.groups ?? {}));
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

  /**
   * `pattern.sub(replacement, text, count)`: `\1`, `\g<1>` and `\g<name>` insert groups (an
   * unmatched one inserts nothing), and Python's escapes apply. `count` 0 replaces every match.
   */
  sub(replacement: string, text: string, options: { count?: number } = {}): string {
    const template = parseTemplate(replacement, this.#groups, this.#names);
    const count = options.count ?? 0;
    if (count < 0) return text;
    let out = "";
    let last = 0;
    let done = 0;
    for (const match of text.matchAll(this.#all)) {
      if (count > 0 && done === count) break;
      out += text.slice(last, match.index);
      for (const part of template) {
        out += typeof part === "string" ? part : groupText(match, part);
      }
      last = match.index + match[0].length;
      done++;
    }
    return out + text.slice(last);
  }
}

type TemplatePart = string | number | { readonly name: string };

function groupText(match: RegExpExecArray, group: number | { readonly name: string }): string {
  return (typeof group === "number" ? match[group] : match.groups?.[group.name]) ?? "";
}

const TEMPLATE_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
};
const OCTAL = /^[0-7]$/;
const DIGIT = /^[0-9]$/;

/** `re._parser.parse_template`: literal runs and group references. */
function parseTemplate(source: string, groups: number, names: ReadonlySet<string>): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const chars = [...source];
  let literal = "";
  const group = (ref: number | { readonly name: string }): void => {
    if (typeof ref === "number" && ref > groups) {
      throw new SyntaxError(`invalid group reference ${ref}`);
    }
    if (literal) parts.push(literal);
    literal = "";
    parts.push(ref);
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c !== "\\") {
      literal += c;
      continue;
    }
    const next = chars[++i];
    if (next === undefined) throw new SyntaxError("bad escape (end of pattern)");
    if (next === "g") {
      if (chars[i + 1] !== "<") throw new SyntaxError("missing <");
      const close = chars.indexOf(">", i + 2);
      if (close === -1) throw new SyntaxError("missing >, unterminated name");
      const name = chars.slice(i + 2, close).join("");
      i = close;
      if (/^[0-9]+$/.test(name)) group(Number(name));
      else if (names.has(name)) group({ name });
      else throw new RangeError(`unknown group name ${pyRepr(name)}`);
    } else if (next === "0") {
      let digits = "";
      while (digits.length < 2 && OCTAL.test(chars[i + 1] ?? "")) digits += chars[++i];
      literal += String.fromCharCode(Number.parseInt(digits || "0", 8) & 0xff);
    } else if (DIGIT.test(next)) {
      let digits = next;
      if (DIGIT.test(chars[i + 1] ?? "")) {
        digits += chars[++i];
        if (OCTAL.test(next) && OCTAL.test(digits[1] as string) && OCTAL.test(chars[i + 1] ?? "")) {
          digits += chars[++i];
          const code = Number.parseInt(digits, 8);
          if (code > 0o377) {
            throw new SyntaxError(`octal escape value \\${digits} outside of range`);
          }
          literal += String.fromCharCode(code);
          continue;
        }
      }
      group(Number(digits));
    } else if (Object.hasOwn(TEMPLATE_ESCAPES, next)) {
      literal += TEMPLATE_ESCAPES[next];
    } else if (/^[A-Za-z]$/.test(next)) {
      throw new SyntaxError(`bad escape \\${next}`);
    } else {
      literal += `\\${next}`;
    }
  }
  if (literal) parts.push(literal);
  return parts;
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
