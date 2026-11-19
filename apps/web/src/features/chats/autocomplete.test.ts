import { describe, expect, test } from "bun:test";
import { type MentionTarget, parseMentions } from "@eidolon/chat";
import {
  closedAt,
  EMPTY_DRAFT,
  insertName,
  mentionAt,
  mentionName,
  mentionOptions,
  mentionSuggestions,
  picked,
  retyped,
  slashAt,
  slashOptions,
  slashSuggestions,
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

describe("insertName", () => {
  test("completes the name with a space, and puts the caret after it", () => {
    const at = mentionAt("hi @Ke", 6);
    expect(at).not.toBeNull();
    expect(insertName("hi @Ke", at!, "Ken")).toEqual({ text: "hi @Ken ", caret: 8 });
  });

  test("keeps what follows the caret, and the space already there", () => {
    const at = mentionAt("@M you", 2);
    expect(insertName("@M you", at!, "米绿")).toEqual({ text: "@米绿 you", caret: 4 });
    const bare = mentionAt("@在吗", 1);
    expect(insertName("@在吗", bare!, "澪")).toEqual({ text: "@澪 在吗", caret: 3 });
  });

  test("inserts a name parseMentions reads back", () => {
    for (const target of ALL) {
      for (const name of [target.name, target.shortName].filter((name) => name !== "")) {
        const text = "问问@";
        const { text: done } = insertName(text, mentionAt(text, 3)!, name);
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
    const { at } = mentionSuggestions(draft, room);
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
    expect(mentionSuggestions(retyped(EMPTY_DRAFT, "@Ke", 3), room).options).toEqual([TAKAGI]);
    const done = pick("@Ke", TAKAGI, room);
    expect(done.text).toBe("@Ken ");
    expect(mentionSuggestions(done, room).options).toEqual([]);
    // Typing on in that mention keeps them closed; a new @ opens its own.
    expect(mentionSuggestions(retyped(done, "@Ken T", 6), room).options).toEqual([]);
    expect(mentionSuggestions(retyped(done, "@Ken @", 6), room).options).toEqual(room);
  });

  test("an @ typed over a picked mention, in its place, opens again", () => {
    const room = [TAKAGI, MIO];
    const done = pick("@Ke", TAKAGI, room);
    expect(mentionSuggestions(retyped(done, "@", 1), room).options).toEqual(room);
    expect(mentionSuggestions(retyped(done, "@澪", 2), room).options).toEqual([MIO]);
  });
});

describe("slashAt", () => {
  test("finds the slash the draft starts with, full-width too, spaces aside", () => {
    expect(slashAt("/", 1)).toEqual({ start: 0, query: "" });
    expect(slashAt("/front-de", 9)).toEqual({ start: 0, query: "front-de" });
    expect(slashAt("／St", 3)).toEqual({ start: 0, query: "St" });
    expect(slashAt("  /pd", 5)).toEqual({ start: 2, query: "pd" });
    expect(slashAt("　/pd", 4)).toEqual({ start: 1, query: "pd" });
  });

  test("reads only up to the caret, so a slash put before a draft offers every name", () => {
    expect(slashAt("/focus", 2)).toEqual({ start: 0, query: "f" });
    expect(slashAt("/做个网页", 1)).toEqual({ start: 0, query: "" });
  });

  test("is none for a slash anywhere else, or once the word holds what no name does", () => {
    for (const [text, caret] of [
      ["看看 /tmp", 7],
      ["~/Desktop", 3],
      ["a /b", 4],
      ["/usr/local", 10],
      ["/pdf 做", 6],
      ["/哈", 2],
      ["  /fo", 1],
      ["", 0],
      ["   ", 3],
    ] as const) {
      expect(slashAt(text, caret)).toBeNull();
    }
  });
});

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("slashOptions", () => {
  const ENTRIES = named("focus", "normal", "verbose", "stop", "frontend-design", "pdf");

  test("puts names that begin with the query first, case-blind, then names holding it", () => {
    expect(slashOptions("s", ENTRIES)).toEqual(
      named("stop", "focus", "verbose", "frontend-design"),
    );
    expect(slashOptions("DE", ENTRIES)).toEqual(named("frontend-design"));
    expect(slashOptions("pdf", ENTRIES)).toEqual(named("pdf"));
  });

  test("offers every entry for a bare slash, and none for a query nothing matches", () => {
    expect(slashOptions("", ENTRIES)).toEqual(ENTRIES);
    expect(slashOptions("docx", ENTRIES)).toEqual([]);
  });
});

describe("picking a slash word", () => {
  const ENTRIES = named("stop", "pdf", "pdf-tools");

  /** The draft after typing `text`, the caret at `caret`, and picking `name` for its slash word. */
  function pick(text: string, name: string, caret = text.length) {
    const draft = retyped(EMPTY_DRAFT, text, caret);
    const { at } = slashSuggestions(draft, ENTRIES);
    return picked(draft, at!, name);
  }

  test("completes the name with a space, before what the draft already says", () => {
    expect(slashSuggestions(retyped(EMPTY_DRAFT, "/pd", 3), ENTRIES).options).toEqual(
      named("pdf", "pdf-tools"),
    );
    expect(pick("/pd", "pdf")).toEqual({
      text: "/pdf ",
      caret: 5,
      closed: { start: 0, typed: "/pdf" },
    });
    const prefixed = pick("/做个报告", "pdf", 1);
    expect([prefixed.text, prefixed.caret]).toEqual(["/pdf 做个报告", 5]);
  });

  test("closes its suggestions until a slash is typed in its place again", () => {
    const done = pick("/pd", "pdf");
    expect(slashSuggestions(done, ENTRIES).options).toEqual([]);
    // The space taken back, the name still begins "pdf-tools".
    expect(slashSuggestions(retyped(done, "/pdf", 4), ENTRIES).options).toEqual([]);
    expect(slashSuggestions(retyped(done, "/", 1), ENTRIES).options).toEqual(ENTRIES);
  });

  test("Escape closes them as typed, and a mention closed there closes no slash", () => {
    const draft = retyped(EMPTY_DRAFT, "/pd", 3);
    const { at } = slashSuggestions(draft, ENTRIES);
    const closed = { ...draft, closed: closedAt(draft.text, at!) };
    expect(slashSuggestions(retyped(closed, "/pdf", 4), ENTRIES).options).toEqual([]);
    const room = [KEN, MIO];
    const mention = retyped(EMPTY_DRAFT, "@Ke", 3);
    const mentioned = picked(mention, mentionSuggestions(mention, room).at!, "Ken");
    expect(slashSuggestions(retyped(mentioned, "/", 1), ENTRIES).options).toEqual(ENTRIES);
  });
});
