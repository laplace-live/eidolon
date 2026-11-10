import { describe, expect, test } from "bun:test";
import { type MentionTarget, parseMentions } from "@eidolon/chat";
import {
  EMPTY_DRAFT,
  insertMention,
  mentionAt,
  mentionName,
  mentionOptions,
  picked,
  retyped,
  suggestions,
} from "./autocomplete";

const KEN: MentionTarget = { id: "ken", name: "Kenny Lin", shortName: "Ken" };
const MIO: MentionTarget = { id: "mio", name: "澪", shortName: "" };
const MILKY: MentionTarget = { id: "milky-green", name: "米哈游绿", shortName: "米绿" };
const ALL = [KEN, MIO, MILKY];

describe("mentionAt", () => {
  test("finds the @ the caret is typing after, full-width too", () => {
    expect(mentionAt("hi @Ke", 6)).toEqual({ start: 3, query: "Ke" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("你好＠米", 4)).toEqual({ start: 2, query: "米" });
    // Chinese runs on into the mention with no space before it.
    expect(mentionAt("问问@米", 4)).toEqual({ start: 2, query: "米" });
  });

  test("reads only up to the caret", () => {
    expect(mentionAt("@Ken said hi", 4)).toEqual({ start: 0, query: "Ken" });
  });

  test("is none without an @ on the caret's line, or after an address's", () => {
    expect(mentionAt("hello", 5)).toBeNull();
    expect(mentionAt("@Ken\nhi", 7)).toBeNull();
    expect(mentionAt("me@host", 7)).toBeNull();
    expect(mentionAt(`@${"x".repeat(40)}`, 41)).toBeNull();
  });
});

describe("mentionOptions", () => {
  test("puts names that begin with the query first, case-blind, then names holding it", () => {
    expect(mentionOptions("ke", ALL)).toEqual([KEN]);
    expect(mentionOptions("LIN", ALL)).toEqual([KEN]);
    expect(mentionOptions("绿", ALL)).toEqual([MILKY]);
    expect(mentionOptions("米", ALL)).toEqual([MILKY]);
  });

  test("offers everyone for a bare @, and no one for a query nobody matches", () => {
    expect(mentionOptions("", ALL)).toEqual(ALL);
    expect(mentionOptions("Ken said", ALL)).toEqual([]);
  });
});

describe("insertMention", () => {
  test("completes the name with a space, and puts the caret after it", () => {
    const at = mentionAt("hi @Ke", 6);
    expect(at).not.toBeNull();
    expect(insertMention("hi @Ke", at!, "Ken")).toEqual({ text: "hi @Ken ", caret: 8 });
  });

  test("keeps what follows the caret, and the space already there", () => {
    const at = mentionAt("@M you", 2);
    expect(insertMention("@M you", at!, "米绿")).toEqual({ text: "@米绿 you", caret: 4 });
    const bare = mentionAt("@在吗", 1);
    expect(insertMention("@在吗", bare!, "澪")).toEqual({ text: "@澪 在吗", caret: 3 });
  });

  test("inserts a name parseMentions reads back", () => {
    for (const target of ALL) {
      for (const name of [target.name, target.shortName].filter((name) => name !== "")) {
        const text = "问问@";
        const { text: done } = insertMention(text, mentionAt(text, 3)!, name);
        expect(parseMentions(done, ALL)).toEqual([target.id]);
      }
    }
  });
});

describe("picking a mention", () => {
  const TAKAGI: MentionTarget = { id: "takagi", name: "Ken Takagi", shortName: "Ken" };

  /** The draft after typing `text` and picking `target` for its mention. */
  function pick(text: string, target: MentionTarget, room: readonly MentionTarget[]) {
    const draft = retyped(EMPTY_DRAFT, text, text.length);
    const { at } = suggestions(draft, room);
    return picked(draft, at!, mentionName(target, room));
  }

  test("inserts her full name where her short name is someone else's too", () => {
    const room = [TAKAGI, KEN, MILKY];
    for (const target of room) {
      expect(parseMentions(pick("问问@", target, room).text, room)).toEqual([target.id]);
    }
    expect(room.map((target) => mentionName(target, room))).toEqual([
      "Ken Takagi",
      "Kenny Lin",
      "米绿",
    ]);
    expect(mentionName(TAKAGI, [TAKAGI, MILKY])).toBe("Ken");
    // Her short name as someone's full name, in any case.
    expect(mentionName(TAKAGI, [TAKAGI, { id: "k", name: "KEN", shortName: "" }])).toBe(
      "Ken Takagi",
    );
  });

  test("closes its suggestions, though her name still begins with what is typed", () => {
    const room = [TAKAGI, MIO];
    expect(suggestions(retyped(EMPTY_DRAFT, "@Ke", 3), room).options).toEqual([TAKAGI]);
    const done = pick("@Ke", TAKAGI, room);
    expect(done.text).toBe("@Ken ");
    expect(suggestions(done, room).options).toEqual([]);
    // Typing on in that mention keeps them closed; a new @ opens its own.
    expect(suggestions(retyped(done, "@Ken T", 6), room).options).toEqual([]);
    expect(suggestions(retyped(done, "@Ken @", 6), room).options).toEqual(room);
  });
});
