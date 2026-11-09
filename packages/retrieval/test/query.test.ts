import { describe, expect, test } from "bun:test";
import { buildQueryText, extractDateFilter } from "../src/index.ts";

describe("extractDateFilter", () => {
  test.each([
    ["", null],
    ["5月8000元", null],
    ["20260524年", null],
    ["2026年13月", null],
    ["2026年2月30日", "date = '2026-02-30'"],
    ["26年3月24", "date = '2026-03-24'"],
    ["2024年3月发生什么", "date >= '2024-03-01' AND date < '2024-04-01'"],
    ["3月", null],
    ["2024年12月", "date >= '2024-12-01' AND date < '2025-01-01'"],
    ["5月9日和6月1日", "date LIKE '%-05-09'"],
    ["2026年5月9号", "date = '2026-05-09'"],
    ["12月31号", "date LIKE '%-12-31'"],
    ["你2026年5月9号说了什么", "date = '2026-05-09'"],
    ["9月8号", "date LIKE '%-09-08'"],
    ["２６年３月２４日直播", "date = '2026-03-24'"],
    ["26年3月　24日", "date = '2026-03-24'"],
    ["２０２６-０９-０８", null],
    ["13月5日", null],
  ])("%p", (query, expected) => {
    expect(extractDateFilter(query)).toBe(expected);
  });

  test("targets the column it is given", () => {
    expect(extractDateFilter("26年3月24直播内容", { column: "stream_date" })).toBe(
      "stream_date = '2026-03-24'",
    );
    expect(extractDateFilter("5月8号直播", { column: "stream_date" })).toBe(
      "stream_date LIKE '%-05-08'",
    );
  });
});

const user = (content: unknown) => ({ role: "user", content });

describe("buildQueryText", () => {
  test.each([
    ["no messages", [], null],
    ["assistant only", [{ role: "assistant", content: "hi" }], null],
    [
      "short latest pulls in earlier user turns, not assistant ones",
      [user("我喜欢猫"), { role: "assistant", content: "x" }, user("嗯")],
      "我喜欢猫 嗯",
    ],
    [
      "at most maxUserTurns texts",
      [user("第一句话很长很长很长"), user("二"), user("三"), user("嗯")],
      "二 三 嗯",
    ],
    [
      "blank, part arrays and system turns",
      [user("  "), user(["x"]), { role: "system", content: "s" }],
      null,
    ],
    [
      "a short latest after a long one",
      [user("今天天气很好啊朋友"), user("短")],
      "今天天气很好啊朋友 短",
    ],
    ["eight emoji are eight code points", [user("今天天气"), user("😀".repeat(8))], "😀".repeat(8)],
    [
      "four emoji are short",
      [user("今天天气"), user("😀".repeat(4))],
      `今天天气 ${"😀".repeat(4)}`,
    ],
    [
      "non-object entries are skipped",
      [user("前面"), "stray", null, 42, ["x"], user("嗯")],
      "前面 嗯",
    ],
  ] as [string, unknown[], string | null][])("%s", (_name, messages, expected) => {
    expect(buildQueryText(messages)).toBe(expected);
  });

  test("null and undefined", () => {
    expect(buildQueryText(null)).toBeNull();
    expect(buildQueryText(undefined)).toBeNull();
  });

  test("maxUserTurns and shortThreshold", () => {
    const messages = ["a", "b", "c", "d"].map(user);
    expect(buildQueryText(messages, { maxUserTurns: 2 })).toBe("c d");
    expect(buildQueryText(messages, { shortThreshold: 1 })).toBe("d");
  });

  test("strips Python whitespace, which JS trim() doesn't match", () => {
    expect(buildQueryText([user("\x1f长句子长句子长句子\x85")])).toBe("长句子长句子长句子");
    expect(buildQueryText([user("﻿嗯")])).toBe("﻿嗯");
  });
});
