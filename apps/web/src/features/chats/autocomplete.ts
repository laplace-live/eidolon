// The composer's autocomplete: a participant's name after an `@` the caret is typing after, and a
// command's or a skill's after the `/` a draft starts with. @eidolon/chat's parseMentions reads a
// picked mention, so a pick inserts a name it matches.
import type { MentionTarget } from "@eidolon/chat";

/** The longest name looked back for; past it, an `@` is too far behind the caret to be typing one. */
const MAX_QUERY = 32;

const LATIN_WORD = /[A-Za-z0-9_]/;

/** What a slash word holds before the caret while it could be a command's or a skill's name. */
const SLASH_NAME = /^[A-Za-z0-9-]*$/;

/** An `@`, or the `/` a draft starts with, and what the caret has typed after it. */
export interface Trigger {
  /** Where its `@` or `/` is. */
  readonly start: number;
  /** What follows it up to the caret. */
  readonly query: string;
}

/**
 * The mention the caret is in: the nearest `@` or `＠` before it on its line. One right after a
 * Latin letter or digit is an address's, `name@host`, so none.
 */
export function mentionAt(text: string, caret: number): Trigger | null {
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
 * The slash word the caret is in: the `/` or `／` the draft starts with, spaces aside, while what
 * follows it up to the caret could begin a name. A slash anywhere else is a path's or a sentence's.
 */
export function slashAt(text: string, caret: number): Trigger | null {
  const start = text.length - text.trimStart().length;
  const slash = text[start];
  if (caret <= start || (slash !== "/" && slash !== "／")) return null;
  const query = text.slice(start + 1, caret);
  return SLASH_NAME.test(query) ? { start, query } : null;
}

/** `options` with a name that begins with `query`, case-blind, then those with one that holds it. */
function matching<T>(
  query: string,
  options: readonly T[],
  namesOf: (option: T) => readonly string[],
): T[] {
  const typed = query.toLowerCase();
  const names = (option: T) => namesOf(option).map((name) => name.toLowerCase());
  const starts = options.filter((option) => names(option).some((name) => name.startsWith(typed)));
  const holds = options.filter(
    (option) => !starts.includes(option) && names(option).some((name) => name.includes(typed)),
  );
  return [...starts, ...holds];
}

/** The participants `query` could be, by name or short name. */
export function mentionOptions<T extends MentionTarget>(
  query: string,
  participants: readonly T[],
): T[] {
  return matching(query, participants, (target) => [target.name, target.shortName]);
}

export function slashOptions<T extends { readonly name: string }>(
  query: string,
  entries: readonly T[],
): T[] {
  return matching(query, entries, (entry) => [entry.name]);
}

/** `text` with the name at `at` completed to `name` and a space, and where the caret goes. */
export function insertName(
  text: string,
  at: Trigger,
  name: string,
): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, at.start + 1);
  const after = text.slice(at.start + 1 + at.query.length);
  const spaced = /^\s/.test(after) ? after : ` ${after}`;
  return { text: `${before}${name}${spaced}`, caret: before.length + name.length + 1 };
}

/** An `@` or `/` whose suggestions are closed, and what it held then. */
export interface Closed {
  readonly start: number;
  /** Its `@` or `/`, and the name after it. */
  readonly typed: string;
}

/** The composer's text and caret, and the `@` or `/` whose suggestions are closed. */
export interface Draft {
  readonly text: string;
  readonly caret: number;
  readonly closed: Closed | null;
}

/** The `@` or `/` at `at` in `text`, closed as it stands. */
export function closedAt(text: string, at: Trigger): Closed {
  return { start: at.start, typed: text.slice(at.start, at.start + 1 + at.query.length) };
}

export const EMPTY_DRAFT: Draft = { text: "", caret: 0, closed: null };

/**
 * `draft` edited to `text`: a closed `@` or `/` stays closed while the caret is still in the name
 * after it and the name is still there. An `@` or `/` typed over it, in the same place, opens again.
 */
export function retyped(draft: Draft, text: string, caret: number): Draft {
  const { closed } = draft;
  const at = mentionAt(text, caret) ?? slashAt(text, caret);
  const still =
    closed !== null && at?.start === closed.start && text.startsWith(closed.typed, closed.start);
  return { text, caret, closed: still ? closed : null };
}

/** The mention at the caret, and who it could be: no one once its `@` is closed. */
export function mentionSuggestions<T extends MentionTarget>(
  draft: Draft,
  participants: readonly T[],
): { readonly at: Trigger | null; readonly options: T[] } {
  const at = mentionAt(draft.text, draft.caret);
  const closed = at === null || at.start === draft.closed?.start;
  return { at, options: closed ? [] : mentionOptions(at.query, participants) };
}

/** The slash word at the caret, and which of `entries` it could be: none once its `/` is closed. */
export function slashSuggestions<T extends { readonly name: string }>(
  draft: Draft,
  entries: readonly T[],
): { readonly at: Trigger | null; readonly options: T[] } {
  const at = slashAt(draft.text, draft.caret);
  const closed = at === null || at.start === draft.closed?.start;
  return { at, options: closed ? [] : slashOptions(at.query, entries) };
}

/**
 * `draft` with the name at `at` completed to `name`, and its suggestions closed: `@Ken ` still
 * begins "Ken Takagi", so Enter would pick her again instead of sending.
 */
export function picked(draft: Draft, at: Trigger, name: string): Draft {
  const next = insertName(draft.text, at, name);
  return { ...next, closed: closedAt(next.text, { start: at.start, query: name }) };
}

/**
 * What picking `target` inserts: her short name, else her name where another participant answers
 * to the short one too, which parseMentions would read as whoever comes first.
 */
export function mentionName(target: MentionTarget, participants: readonly MentionTarget[]): string {
  const short = target.shortName.trim();
  const shared = participants.some(
    (other) =>
      other.id !== target.id &&
      [other.name, other.shortName].some((name) => name.toLowerCase() === short.toLowerCase()),
  );
  return short === "" || shared ? target.name : short;
}
