// Python's shlex.split, which turns --yt-dlp-args into argv: POSIX quoting and escapes, `#` an
// ordinary character, and only space, tab, CR and LF separating words.
import { pyError } from "@eidolon/config";

const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

/** `shlex.split(text)`; throws ValueError's "No closing quotation" or "No escaped character". */
export function shlexSplit(text: string): string[] {
  const chars = Array.from(text);
  const tokens: string[] = [];
  let pos = 0;
  // The lexer's state outlives each token, as shlex's does: null once the input has run out.
  let state: string | null = " ";
  for (;;) {
    let token = "";
    let quoted = false;
    let escapedState = "a";
    for (;;) {
      const next = pos < chars.length ? (chars[pos++] as string) : "";
      if (state === null) {
        token = "";
        break;
      }
      if (state === " ") {
        if (next === "") {
          state = null;
          break;
        }
        if (WHITESPACE.has(next)) {
          if (token || quoted) break;
        } else if (next === "\\") {
          escapedState = "a";
          state = next;
        } else if (next === "'" || next === '"') {
          state = next;
        } else {
          token = next;
          state = "a";
        }
      } else if (state === "'" || state === '"') {
        quoted = true;
        if (next === "") throw pyError("ValueError", "No closing quotation");
        if (next === state) {
          state = "a";
        } else if (next === "\\" && state === '"') {
          escapedState = state;
          state = next;
        } else {
          token += next;
        }
      } else if (state === "\\") {
        if (next === "") throw pyError("ValueError", "No escaped character");
        // Inside double quotes only the quote and the backslash itself can be escaped.
        if (escapedState === '"' && next !== "\\" && next !== '"') token += "\\";
        token += next;
        state = escapedState;
      } else if (next === "") {
        state = null;
        break;
      } else if (WHITESPACE.has(next)) {
        state = " ";
        if (token || quoted) break;
      } else if (next === "'" || next === '"') {
        state = next;
      } else if (next === "\\") {
        escapedState = "a";
        state = next;
      } else {
        token += next;
      }
    }
    if (!quoted && token === "") return tokens;
    tokens.push(token);
  }
}
