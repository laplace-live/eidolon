// The composer's @-mention autocomplete: the name the caret is typing after an `@`, the
// participants it could be, and the text with one picked. @eidolon/chat's parseMentions reads the
// result, so a pick inserts a name it matches.
import type { MentionTarget } from "@eidolon/chat";

/** The longest name looked back for; past it, an `@` is too far behind the caret to be typing one. */
const MAX_QUERY = 32;

const LATIN_WORD = /[A-Za-z0-9_]/;

export interface MentionQuery {
  /** Where its `@` is. */
  readonly start: number;
  /** What follows the `@` up to the caret. */
  readonly query: string;
}

/**
 * The mention the caret is in: the nearest `@` or `＠` before it on its line. One right after a
 * Latin letter or digit is an address's, `name@host`, so none.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  for (let index = caret - 1; index >= 0 && caret - index <= MAX_QUERY + 1; index--) {
    const char = text[index] as string;
    if (char === "\n") return null;
    if (char !== "@" && char !== "＠") continue;
    if (LATIN_WORD.test(text[index - 1] ?? "")) return null;
    return { start: index, query: text.slice(index + 1, caret) };
  }
  return null;
}

/**
 * The participants `query` could be the start of, case-blind: those whose name or short name begins
 * with it, then those that hold it elsewhere. An empty query is everyone.
 */
export function mentionOptions<T extends MentionTarget>(
  query: string,
  participants: readonly T[],
): T[] {
  const typed = query.toLowerCase();
  const names = (target: T) => [target.name, target.shortName].map((name) => name.toLowerCase());
  const starts = participants.filter((target) =>
    names(target).some((name) => name.startsWith(typed)),
  );
  const holds = participants.filter(
    (target) => !starts.includes(target) && names(target).some((name) => name.includes(typed)),
  );
  return [...starts, ...holds];
}

/** `text` with the mention at `at` completed to `name` and a space, and where the caret goes. */
export function insertMention(
  text: string,
  at: MentionQuery,
  name: string,
): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, at.start + 1);
  const after = text.slice(at.start + 1 + at.query.length);
  const spaced = /^\s/.test(after) ? after : ` ${after}`;
  return { text: `${before}${name}${spaced}`, caret: before.length + name.length + 1 };
}
