// Source text as the repository scans see it: comments and regex bodies blanked in place, so what
// is left is code, strings and templates, each at its own offset and line.

/** Words after which a `/` opens a regex rather than dividing. */
const BEFORE_REGEX_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** The index just past the string literal opening at `start`. */
function endOfString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === quote || source[i] === "\n") return i + 1;
  }
  return source.length;
}

/** The index just past the regex literal opening at `start`, or null if none opens there. */
function endOfRegex(source: string, start: number): number | null {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (c === "\n") return null;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let end = i + 1;
      while (/[a-z]/.test(source[end] ?? "")) end++;
      return end;
    }
  }
  return null;
}

/** Whether a `/` after `source`'s code up to `end` starts a regex literal rather than dividing. */
function opensRegex(source: string, end: number): boolean {
  if (end === 0) return true;
  const last = source[end - 1] as string;
  if (/[\w$]/.test(last)) {
    const word = /[A-Za-z_$][\w$]*$/.exec(source.slice(Math.max(0, end - 16), end))?.[0] ?? "";
    return BEFORE_REGEX_WORDS.has(word);
  }
  return !/[)\]"'`]/.test(last);
}

/** `source` with comments and regex bodies blanked: what remains is code, strings and templates. */
export function withoutComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  /** The brace depth each open `${` returns to its template at. */
  const templates: number[] = [];
  let inTemplate = false;
  let depth = 0;
  /** Just past the last code character that wasn't space. */
  let previous = 0;
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (inTemplate) {
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        inTemplate = false;
        i += 1;
        previous = i;
      } else if (c === "$" && next === "{") {
        templates.push(depth);
        depth += 1;
        inTemplate = false;
        i += 2;
        previous = i;
      } else {
        i += 1;
      }
    } else if (c === "/" && (next === "/" || next === "*")) {
      const close = next === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : next === "/" ? close : close + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      i = endOfString(source, i);
      previous = i;
    } else if (c === "`") {
      inTemplate = true;
      i += 1;
    } else if (c === "/" && opensRegex(source, previous)) {
      const end = endOfRegex(source, i);
      if (end !== null) blank(i + 1, end);
      i = end ?? i + 1;
      previous = i;
    } else {
      if (c === "{") {
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (templates.at(-1) === depth) {
          templates.pop();
          inTemplate = true;
        }
      }
      i += 1;
      if (!/\s/.test(c)) previous = i;
    }
  }
  return out.join("");
}
