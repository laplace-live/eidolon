// tests/test_stream_time.py, case for case, then goldens printed by the Python module.
import { describe, expect, test } from "bun:test";
import {
  hasStreamTimeReference,
  isStreamElaboration,
  isStreamFollowup,
  isStreamOverview,
  isStreamQuery,
  resolveStreamScope,
  type StreamScope,
  streamScope,
} from "../src/index.ts";

const TODAY = "2026-09-09";

describe("tests/test_stream_time.py", () => {
  test.each([
    ["What did you stream last week?", "2026-08-31", "2026-09-07"],
    ["上周播了什么？", "2026-08-31", "2026-09-07"],
    ["上上周直播内容", "2026-08-24", "2026-08-31"],
    ["这周直播聊了哪些话题", "2026-09-07", "2026-09-14"],
    ["What did you stream this week?", "2026-09-07", "2026-09-14"],
    ["Summarize the past 7 days", "2026-09-03", "2026-09-10"],
    ["最近七天直播说了什么", "2026-09-03", "2026-09-10"],
    ["过去三十天直播聊了什么", "2026-08-11", "2026-09-10"],
    ["the last 1 day", "2026-09-09", "2026-09-10"],
    ["昨天直播", "2026-09-08", "2026-09-09"],
    ["前天播了什么", "2026-09-07", "2026-09-08"],
    ["the day before yesterday", "2026-09-07", "2026-09-08"],
    ["what happened today", "2026-09-09", "2026-09-10"],
    ["What did you stream last month?", "2026-08-01", "2026-09-01"],
    ["这个月直播总结", "2026-09-01", "2026-10-01"],
    ["2026年9月8日直播播了什么？", "2026-09-08", "2026-09-09"],
    ["25年3月24直播播了什么？", "2025-03-24", "2025-03-25"],
    ["2024年3月直播播了什么？", "2024-03-01", "2024-04-01"],
    ["24年3月直播播了什么？", "2024-03-01", "2024-04-01"],
    ["26年3月 24日直播", "2026-03-24", "2026-03-25"],
    ["9月8号直播", "2026-09-08", "2026-09-09"],
    ["2026-09-08", "2026-09-08", "2026-09-09"],
    ["2026/9/8 stream", "2026-09-08", "2026-09-09"],
    ["What did you stream on September 8?", "2026-09-08", "2026-09-09"],
    ["Sep. 8th, 2025", "2025-09-08", "2025-09-09"],
    ["8 September 2026", "2026-09-08", "2026-09-09"],
    ["9月1日到9月7日直播", "2026-09-01", "2026-09-08"],
    ["9月1日至7日直播", "2026-09-01", "2026-09-08"],
    ["2026-09-01 to 2026-09-07", "2026-09-01", "2026-09-08"],
    ["from September 1 through September 7", "2026-09-01", "2026-09-08"],
    ["between September 1 and September 7", "2026-09-01", "2026-09-08"],
    ["2025年12月30日至1月2日直播", "2025-12-30", "2026-01-03"],
    ["12月30日至2026年1月2日直播", "2025-12-30", "2026-01-03"],
    ["12月30日至1月2日直播", "2025-12-30", "2026-01-03"],
    ["Last week what did you say about ASMR?", "2026-08-31", "2026-09-07"],
    ["上周你说了什么关于ASMR的事情", "2026-08-31", "2026-09-07"],
  ])("precise period %p", (query, start, end) => {
    const scope = resolveStreamScope(query, { today: TODAY });
    expect(scope).not.toBeNull();
    expect(scope?.startDate).toBe(start);
    expect(scope?.endDate).toBe(end);
    expect(scope?.latest).toBeNull();
  });

  test.each([
    ["last week", "2026-01-01", "2025-12-22", "2025-12-29"],
    ["this week", "2026-01-01", "2025-12-29", "2026-01-05"],
    ["last month", "2026-01-01", "2025-12-01", "2026-01-01"],
    ["this month", "2024-02-29", "2024-02-01", "2024-03-01"],
    ["December 31", "2026-01-01", "2025-12-31", "2026-01-01"],
    ["昨天", "2026-01-01", "2025-12-31", "2026-01-01"],
    ["本周", "2026-09-07", "2026-09-07", "2026-09-14"],
    ["2024年2月29日", "2026-09-09", "2024-02-29", "2024-03-01"],
  ])("persona-local calendar boundary %p on %p", (query, today, start, end) => {
    const scope = resolveStreamScope(query, { today });
    expect(scope).not.toBeNull();
    expect([scope?.startDate, scope?.endDate]).toEqual([start, end]);
  });

  test.each([
    ["What was your last stream's content?", 1],
    ["your latest broadcast", 1],
    ["the most recent stream", 1],
    ["上次直播播了什么", 1],
    ["最近一次直播", 1],
    ["上上次直播聊了什么", 2],
    ["second latest stream", 2],
    ["second-last stream", 2],
  ])("latest ordinal %p", (query, ordinal) => {
    const scope = resolveStreamScope(query, { today: TODAY });
    expect(scope).not.toBeNull();
    expect(scope?.latest).toBe(ordinal);
    expect(scope?.startDate).toBeNull();
  });

  test.each([
    "When were you born?",
    "09/08 stream",
    "9-8 stream",
    "2026-09",
    "2026-13-08 stream",
    "2026年9月31日直播",
    "2025年2月29日直播",
    "2026年9月8日到2026年9月7日直播",
    "9月8日到7日直播",
    "9月8日到9月7日直播",
    "2026-09-08 to 9/10",
    "2026-09-08 to some other date",
    "September 1 and September 7",
    "last week or this week",
    "last week on September 1",
    "last week's latest stream",
    "last week Monday",
    "Monday last week",
    "last week's Monday",
    "last week of August",
    "What did you stream the first day of last week?",
    "What did you stream the last day of last week?",
    "你上周第一天直播播了什么",
    "你上周的最后一天直播播了什么",
    "上周二直播",
    "上周末直播",
    "上上上周直播",
    "上上个月直播",
    "before September 8",
    "around September 8",
    "the week ending September 8",
    "9月8日之前的直播",
    "2024年3月以前的直播内容",
    "2024年3月之后的直播内容",
    "9月1日至7日到8日直播",
    "since September 8",
    "从上周开始的直播",
    "since last week",
    "去年9月8日直播",
    "September 8 last year",
    "past 0 days",
    "past 999 days",
    "那周直播",
    "the week before that",
  ])("ambiguous or invalid period %p gives no partial filter", (query) => {
    expect(resolveStreamScope(query, { today: TODAY })).toBeNull();
  });

  test("followup scope", () => {
    const prior = streamScope({ startDate: "2026-08-17", endDate: "2026-08-24" });
    const same = resolveStreamScope("那周玩了什么游戏", { today: TODAY, previous: prior });
    expect(same).not.toBeNull();
    expect([same?.startDate, same?.endDate]).toEqual([prior.startDate, prior.endDate]);
    const earlier = resolveStreamScope("the week before that", { today: TODAY, previous: prior });
    expect(earlier).not.toBeNull();
    expect([earlier?.startDate, earlier?.endDate]).toEqual(["2026-08-10", "2026-08-17"]);
    expect(resolveStreamScope("that day", { today: TODAY, previous: prior })).toBeNull();
    expect(resolveStreamScope("that stream", { today: TODAY, previous: prior })).toBeNull();
  });

  test("followup broadcast requires an identified broadcast", () => {
    const prior = streamScope({ streamIds: ["BV1"], label: "a selected broadcast" });
    expect(resolveStreamScope("that stream", { today: TODAY, previous: prior })).toEqual(prior);
    expect(resolveStreamScope("that week", { today: TODAY, previous: prior })).toBeNull();
    expect(resolveStreamScope("your birthday", { today: TODAY, previous: prior })).toBeNull();
  });

  test.each(["那场聊了什么", "那次呢", "上次那场", "那场直播"])(
    "short broadcast reference %p",
    (query) => {
      const prior = streamScope({ streamIds: ["BV1"] });
      expect(isStreamFollowup(query)).toBe(true);
      expect(resolveStreamScope(query, { today: TODAY, previous: prior })).toEqual(prior);
    },
  );

  test.each(["你第一次玩健身环是什么时候", "第一次是什么时候"])(
    "a first time %p asks when, not which listed broadcast",
    (query) => {
      const prior = streamScope({ streamIds: ["BV3", "BV2", "BV1"] });
      expect(isStreamFollowup(query)).toBe(false);
      expect(resolveStreamScope(query, { today: TODAY, previous: prior })).toBeNull();
    },
  );

  test.each(["the second stream", "第二场直播", "第2次", "第二次呢", "第二次直播讲了什么"])(
    "ordinal %p selects displayed order",
    (query) => {
      const prior = streamScope({ streamIds: ["BV3", "BV2", "BV1"] });
      expect(isStreamFollowup(query)).toBe(true);
      const scope = resolveStreamScope(query, { today: TODAY, previous: prior });
      expect(scope).not.toBeNull();
      expect(scope?.streamIds).toEqual(["BV2"]);
      expect(resolveStreamScope(query, { today: TODAY })).toBeNull();
    },
  );

  test("ordinal cannot select an unlisted broadcast", () => {
    const prior = streamScope({ streamIds: ["BV1"] });
    expect(resolveStreamScope("the second stream", { today: TODAY, previous: prior })).toBeNull();
  });

  test("a week reference to multiple weeks is ambiguous", () => {
    const prior = streamScope({ startDate: "2026-08-01", endDate: "2026-09-01" });
    expect(resolveStreamScope("that week", { today: TODAY, previous: prior })).toBeNull();
    expect(resolveStreamScope("week before that", { today: TODAY, previous: prior })).toBeNull();
  });

  test.each(["那周呢", "what about that week", "tell me more about that stream"])(
    "explicit temporal followup %p",
    (query) => {
      expect(isStreamFollowup(query)).toBe(true);
    },
  );

  test.each(["my birthday is Sept 8", "你生日是9月8日吗", "你好"])(
    "biography %p does not inherit archive context",
    (query) => {
      expect(isStreamFollowup(query)).toBe(false);
    },
  );

  test.each(["Tell me more", "展开说说", "Please elaborate."])(
    "elaboration %p is scoped to the previous selection",
    (query) => {
      const prior = streamScope({ streamIds: ["BV1"] });
      expect(isStreamElaboration(query)).toBe(true);
      expect(isStreamFollowup(query)).toBe(true);
      expect(resolveStreamScope(query, { today: TODAY, previous: prior })).toEqual(prior);
      expect(resolveStreamScope(query, { today: TODAY })).toBeNull();
      expect(isStreamOverview(query)).toBe(false);
    },
  );

  test.each(["Tell me more about your birthday", "展开说说你的生日"])(
    "specific new topic %p is not elaboration only",
    (query) => {
      expect(isStreamElaboration(query)).toBe(false);
      expect(isStreamFollowup(query)).toBe(false);
    },
  );

  test.each([
    "那周呢",
    "the second stream",
    "9/8 stream",
    "去年直播",
    "2024年3月的直播",
    "last Thursday",
    "last year",
    "the week before last",
    "streams in September",
  ])("unresolved time reference %p can use the tool", (query) => {
    expect(hasStreamTimeReference(query)).toBe(true);
  });

  test.each(["直播说过ASMR吗", "What did you say about ASMR?", "May I ask?"])(
    "topic-only question %p needs no time resolution",
    (query) => {
      expect(hasStreamTimeReference(query)).toBe(false);
    },
  );

  test.each([
    "What was your last stream's content?",
    "What did you stream last week?",
    "What was your stream about last week?",
    "what did you stream on September 8?",
    "Summarize your streams last week",
    "recap last week",
    "What about that week?",
    "你上次直播播了什么？",
    "上周播了什么？",
    "你这周播了啥？",
    "上周直播内容是什么？",
    "9月8日直播播了什么？",
    "9月1日到9月7日直播播了什么？",
    "回顾一下上周的直播",
    "上个月呢？",
  ])("overview question %p", (query) => {
    expect(isStreamOverview(query)).toBe(true);
  });

  test.each([
    "Last week what did you say about ASMR?",
    "What games did you play that week?",
    "Summarize the ASMR discussion last week",
    "Tell me more about that stream",
    "上周你说了什么关于ASMR的事情",
    "上周玩了什么游戏？",
    "你上周直播为什么哭了？",
    "9月8日直播提到了谁？",
    "回顾一下昨天聊到的相亲经历",
    "What's your birthday?",
  ])("detail question %p is not an overview", (query) => {
    expect(isStreamOverview(query)).toBe(false);
  });

  test.each([
    "What was your last stream's content?",
    "What did you stream last week?",
    "Last week what did you say about ASMR?",
    "What games did you play that week?",
    "上周你说了什么关于ASMR的事情",
    "昨天玩了什么游戏",
    "9月8日直播提到了谁",
  ])("archive intent %p", (query) => {
    expect(isStreamQuery(query)).toBe(true);
  });

  test.each(["Were you born on September 8?", "你生日是9月8日吗", "你好"])(
    "unrelated temporal question %p",
    (query) => {
      expect(isStreamQuery(query)).toBe(false);
    },
  );
});

type Expected = [string, string] | { latest: number; label?: string } | null;

function check(scope: StreamScope | null, expected: Expected): void {
  if (expected === null) expect(scope).toBeNull();
  else if (Array.isArray(expected)) expect([scope?.startDate, scope?.endDate]).toEqual(expected);
  else {
    expect(scope?.latest).toBe(expected.latest);
    if (expected.label !== undefined) expect(scope?.label).toBe(expected.label);
  }
}

describe("Unicode and edge goldens", () => {
  test.each([
    // Python's \b sees CJK as word characters, so "last week" glued to 直播 is no reference.
    ["last week直播", null, false, true],
    ["看last week的直播", null, false, true],
    ["September 8号直播", null, true, true],
    ["September 8 直播", ["2026-09-08", "2026-09-09"], true, true],
    ["２６年３月２４日直播", ["2026-03-24", "2026-03-25"], true, true],
    ["٢٠٢٦-٠٩-٠٨", ["2026-09-08", "2026-09-09"], true, false],
    ["26年3月　24日", ["2026-03-24", "2026-03-25"], true, false],
    ["2月29日直播", null, true, true],
    ["0026年3月24日", ["2026-03-24", "2026-03-25"], true, false],
    ["9999年12月31日至1月1日", null, true, false],
    ["12月31日至1月1日", ["2025-12-31", "2026-01-02"], true, false],
    ["Last Week", ["2026-08-31", "2026-09-07"], true, false],
    ["LAST WEEK", ["2026-08-31", "2026-09-07"], true, false],
    ["past 7 days", ["2026-09-03", "2026-09-10"], true, false],
    ["past  7  days", ["2026-09-03", "2026-09-10"], true, false],
    ["the  day before yesterday", null, true, false],
  ] as [string, Expected, boolean, boolean][])("%p", (query, scope, reference, archive) => {
    check(resolveStreamScope(query, { today: TODAY }), scope);
    expect(hasStreamTimeReference(query)).toBe(reference);
    expect(isStreamQuery(query)).toBe(archive);
  });

  test.each([
    ["最近十五天", ["2026-08-26", "2026-09-10"]],
    ["近两天", ["2026-09-08", "2026-09-10"]],
    ["过去十天", ["2026-08-31", "2026-09-10"]],
    ["最近100天", ["2026-06-02", "2026-09-10"]],
    ["最近367天", null],
    ["上上次直播", { latest: 2, label: "上上次直播" }],
    ["上一场直播", { latest: 1, label: "最近一次直播" }],
    ["最后一次直播", { latest: 1 }],
    ["最近一次的直播", { latest: 1 }],
    ["September 1 to 8", null],
    ["Sept 8", ["2026-09-08", "2026-09-09"]],
    ["sept. 8", ["2026-09-08", "2026-09-09"]],
    ["8th Sept, 2025", ["2025-09-08", "2025-09-09"]],
    ["9/8", null],
    ["2026-9-8", ["2026-09-08", "2026-09-09"]],
    ["2026/09/08到2026/09/10", ["2026-09-08", "2026-09-11"]],
    ["上周和这周", null],
    ["前天和昨天", null],
    ["大前天", ["2026-09-06", "2026-09-07"]],
    ["上大前天", null],
    ["昨天的", ["2026-09-08", "2026-09-09"]],
    ["上个月", ["2026-08-01", "2026-09-01"]],
    ["上月", ["2026-08-01", "2026-09-01"]],
    ["本月", ["2026-09-01", "2026-10-01"]],
    ["这星期", ["2026-09-07", "2026-09-14"]],
    ["本星期", ["2026-09-07", "2026-09-14"]],
    ["上星期", ["2026-08-31", "2026-09-07"]],
    // Python raises KeyError('ſep'): IGNORECASE matches the long s, the month table can't.
    ["ſeptember 8", null],
    // Python's `start_year or today.year` lets a year of 0 fall back to today's year.
    ["0000-09-01 to 0000-09-07", ["2026-09-01", "2026-09-08"]],
  ] as [string, Expected][])("%p", (query, expected) => {
    check(resolveStreamScope(query, { today: TODAY }), expected);
  });

  test("labels name the inclusive range", () => {
    expect(resolveStreamScope("上周", { today: TODAY })?.label).toBe("2026-08-31 至 2026-09-06");
  });

  test("a year-one today raises past the calendar's start, as Python's OverflowError does", () => {
    expect(() => resolveStreamScope("last month", { today: "0001-01-08" })).toThrow(RangeError);
  });
});

describe("followups against a previous scope", () => {
  const range = streamScope({
    startDate: "2026-08-17",
    endDate: "2026-08-24",
    streamIds: ["BV3", "BV2"],
    label: "x",
  });
  const day = streamScope({ startDate: "2026-08-03", endDate: "2026-08-04" });
  const latest = streamScope({ latest: 1 });

  test.each([
    ["那个月", range, ["2026-08-01", "2026-09-01"]],
    ["that month", range, ["2026-08-01", "2026-09-01"]],
    ["那天", range, null],
    ["那场", range, null],
    ["第3场", range, null],
    ["同一周", range, ["2026-08-17", "2026-08-24"]],
    ["再前一周", range, ["2026-08-10", "2026-08-17"]],
    ["the week before that", range, ["2026-08-10", "2026-08-17"]],
    ["那个月", day, ["2026-08-01", "2026-09-01"]],
    ["那天", latest, null],
    ["那周", latest, null],
  ] as [string, StreamScope, Expected][])("%p", (query, previous, expected) => {
    check(resolveStreamScope(query, { today: TODAY, previous }), expected);
  });

  test.each(["第一场", "the first stream"])("%p picks the first listed broadcast", (query) => {
    expect(resolveStreamScope(query, { today: TODAY, previous: range })).toEqual(
      streamScope({ streamIds: ["BV3"], label: "上次查询结果中的第1场直播" }),
    );
  });

  test.each(["那天", "同一天", "that day"])("%p keeps a one-day selection", (query) => {
    expect(resolveStreamScope(query, { today: TODAY, previous: day })).toBe(day);
  });

  test("a broadcast followup keeps a latest selection", () => {
    expect(resolveStreamScope("那场直播", { today: TODAY, previous: latest })).toBe(latest);
  });
});
