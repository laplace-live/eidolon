import { describe, expect, test } from "bun:test";
import { type MentionTarget, parseMentions } from "../src/index.ts";

const MILKY: MentionTarget = { id: "milky-green", name: "明前奶绿", shortName: "奶绿" };
const RUBY: MentionTarget = { id: "ruby", name: "露比", shortName: "露比" };
const KEN: MentionTarget = { id: "ken", name: "Ken Takagi", shortName: "Ken" };
const ROOM = [MILKY, RUBY, KEN];

describe("parseMentions", () => {
  test("names and short names, in the order first mentioned, each once", () => {
    expect(parseMentions("@露比 你觉得呢？@奶绿 还有@明前奶绿", ROOM)).toEqual([
      "ruby",
      "milky-green",
    ]);
    expect(parseMentions("@Ken Takagi and @露比", ROOM)).toEqual(["ken", "ruby"]);
  });

  test("Chinese runs on after a name with no space", () => {
    expect(parseMentions("@奶绿你今天播什么", ROOM)).toEqual(["milky-green"]);
    expect(parseMentions("问一下@露比，晚上好", ROOM)).toEqual(["ruby"]);
  });

  test("the full-width ＠ counts, and Latin names are case-blind", () => {
    expect(parseMentions("＠奶绿 早", ROOM)).toEqual(["milky-green"]);
    expect(parseMentions("@ken!", ROOM)).toEqual(["ken"]);
    expect(parseMentions("@KEN TAKAGI", ROOM)).toEqual(["ken"]);
  });

  test("a Latin name must end where its word does", () => {
    expect(parseMentions("@Kenny 你好", ROOM)).toEqual([]);
    expect(parseMentions("@Ken_2", ROOM)).toEqual([]);
    expect(parseMentions("@Ken，你好", ROOM)).toEqual(["ken"]);
  });

  test("the longest name after an @ wins where one starts another", () => {
    const twin: MentionTarget = { id: "milky-2", name: "奶绿二号", shortName: "二号" };
    expect(parseMentions("@奶绿二号 和 @奶绿", [MILKY, twin])).toEqual(["milky-2", "milky-green"]);
    expect(parseMentions("@奶绿二号", [twin, MILKY])).toEqual(["milky-2"]);
  });

  test("a name without an @ before it, an @ alone, and an empty name mention no one", () => {
    expect(parseMentions("奶绿和露比", ROOM)).toEqual([]);
    expect(parseMentions("@ 奶绿 @@", ROOM)).toEqual([]);
    expect(parseMentions("@", ROOM)).toEqual([]);
    const blank: MentionTarget = { id: "blank", name: "", shortName: "" };
    expect(parseMentions("@奶绿", [blank, MILKY])).toEqual(["milky-green"]);
    expect(parseMentions("@x", [])).toEqual([]);
  });
});
