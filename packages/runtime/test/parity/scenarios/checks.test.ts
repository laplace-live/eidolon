// The twin harness's own logic on made-up sequences, no call needed: the invariants, how a run is
// normalized and compared, and that each allowed.ts rule matches its difference and nothing else.
import { describe, expect, test } from "bun:test";
import { INTERRUPTED_EMPTY_TURN_PROMPT } from "@eidolon/context";
import { type UsageRecord, usageRecord } from "@eidolon/providers";
import type { FishSession } from "../fakes/fish.ts";
import type { Received } from "../fakes/peer.ts";
import { checkInvariants, type WireMessage } from "../invariants.ts";
import { type Capture, judge, normalizeRtvi, type Twin } from "../twin.ts";

const m = (type: string, data?: Record<string, unknown>): WireMessage =>
  data === undefined ? { type } : { type, data };

const ready = m("bot-ready", { version: "2.2.0" });
const said = (text: string, final = true) => [
  m("user-input", { text, input_type: "transcription", final, user_id: "" }),
  m("user-transcription", { text, user_id: "", final }),
];
const output = (id: number, status: string) =>
  m("bot-output", { segment_id: id, spoken_status: status, text: "嗯。" });

/** A turn and her reply, as both engines send them. */
const CALL: WireMessage[] = [
  ready,
  m("user-started-speaking"),
  m("bot-interrupted"),
  ...said("你好"),
  m("user-llm-text", { text: "你好" }),
  m("user-stopped-speaking"),
  m("bot-llm-started"),
  m("bot-llm-text", { text: "嗯。" }),
  m("bot-transcription", { text: "嗯。" }),
  m("bot-tts-started"),
  m("bot-llm-stopped"),
  m("bot-started-speaking"),
  output(7, "new"),
  output(7, "completed"),
  m("bot-tts-text", { text: "嗯。" }),
  m("bot-tts-stopped"),
  m("bot-stopped-speaking"),
];

const ids = (messages: WireMessage[], native = true) =>
  checkInvariants(messages, { native }).map((v) => v.id);

describe("invariants", () => {
  test("a well-formed call keeps all ten, metrics anywhere", () => {
    expect(ids(CALL)).toEqual([]);
    const metrics = CALL.flatMap((message) => [message, m("metrics", { ttfb: [] })]);
    expect(ids([m("metrics"), ...metrics])).toEqual([]);
  });

  test("I1: nothing of hers or the caller's before bot-ready", () => {
    expect(ids([m("bot-llm-started"), ...CALL])).toContain("I1");
  });

  test("I2: a final transcript after the turn it belongs to ended", () => {
    const late = [...CALL.slice(0, 3), m("user-stopped-speaking"), ...said("你好")];
    expect(ids(late)).toContain("I2");
  });

  test("I3: user-transcription only after the same user-input", () => {
    const flipped = [
      ready,
      m("user-started-speaking"),
      m("bot-interrupted"),
      ...said("你").reverse(),
    ];
    expect(ids(flipped)).toContain("I3");
  });

  test("I4: bot-interrupted follows every user-started-speaking at once", () => {
    expect(ids([ready, m("user-started-speaking"), ...said("你")])).toContain("I4");
  });

  test("I5: one mind request at a time, each stopped", () => {
    expect(ids([ready, m("bot-llm-started"), m("bot-llm-started"), m("bot-llm-stopped")])).toEqual([
      "I5",
    ]);
    expect(ids([ready, m("bot-llm-started")])).toEqual(["I5"]);
  });

  test("I6: every bot-tts-started is stopped, on the native engine only", () => {
    const open = CALL.filter((message) => message.type !== "bot-tts-stopped");
    expect(ids(open)).toEqual(["I6"]);
    expect(ids(open, false)).toEqual([]);
  });

  test("I7: each segment is new first and completes once, unless cut off or never to be spoken", () => {
    expect(ids([ready, output(1, "completed")])).toEqual(["I7"]);
    expect(ids([ready, output(1, "new"), output(1, "completed"), output(1, "completed")])).toEqual([
      "I7",
    ]);
    expect(ids([ready, output(1, "new")])).toEqual(["I7"]);
    expect(ids([ready, output(1, "new"), m("bot-interrupted")])).toEqual([]);
    const unspoken = m("bot-output", {
      segment_id: 1,
      spoken_status: "new",
      will_be_spoken: false,
    });
    expect(ids([ready, unspoken])).toEqual([]);
  });

  test("I8: errors are never fatal", () => {
    expect(ids([ready, m("error", { error: "x", fatal: false })])).toEqual([]);
    expect(ids([ready, m("error", { error: "x", fatal: true })])).toEqual(["I8"]);
  });

  test("I9: a turn of no words that cut nothing off starts no reply", () => {
    const empty = [
      ready,
      m("user-started-speaking"),
      m("bot-interrupted"),
      m("user-stopped-speaking"),
    ];
    expect(ids([...empty, m("bot-llm-started"), m("bot-llm-stopped")])).toEqual(["I9"]);
    // One that cut her off may get the recovery prompt.
    const cut = [
      ready,
      m("bot-started-speaking"),
      ...empty.slice(1, 3),
      m("bot-stopped-speaking"),
      m("user-stopped-speaking"),
    ];
    expect(ids([...cut, m("bot-llm-started"), m("bot-llm-stopped")])).toEqual([]);
    // An async result settling in between starts a reply of its own.
    const settled = m("llm-function-call-stopped", { tool_call_id: "s1", cancelled: false });
    expect(ids([...empty, settled, m("bot-llm-started"), m("bot-llm-stopped")])).toEqual([]);
  });

  test("I10: no bot-llm-text from a reply the caller cut off", () => {
    const cut = [
      ready,
      m("bot-llm-started"),
      m("bot-interrupted"),
      m("bot-llm-text", { text: "嗯" }),
    ];
    expect(ids([...cut, m("bot-llm-stopped")])).toEqual(["I10"]);
  });
});

const rtvi = (type: string, data?: Record<string, unknown>, id?: string): Received => ({
  t: 0,
  message: {
    label: "rtvi-ai",
    type,
    ...(id === undefined ? {} : { id }),
    ...(data ? { data } : {}),
  },
});

describe("normalizeRtvi", () => {
  test("drops ids, timestamps and metric values, and numbers segments by their order", () => {
    const normal = normalizeRtvi([
      rtvi("bot-ready", { version: "2.2.0" }, "c1"),
      rtvi("metrics", { ttfb: [{ value: 0.2 }] }),
      rtvi("user-input", { text: "你", timestamp: "2026-11-10T00:00:00+00:00", final: true }),
      rtvi("bot-output", { segment_id: 86, spoken_status: "new" }),
      rtvi("bot-output", { segment_id: 100, spoken_status: "new" }),
      { t: 0, message: { type: "signalling", message: { type: "peerLeft" } } },
    ]);
    expect(normal.map((n) => n.key)).toEqual([
      'bot-ready {"version":"2.2.0"}',
      "metrics",
      'user-input {"text":"你","final":true}',
      'bot-output {"segment_id":1,"spoken_status":"new"}',
      'bot-output {"segment_id":2,"spoken_status":"new"}',
    ]);
  });

  test("a mind round's text is one message, wherever bot-transcription fell among its deltas", () => {
    const normal = normalizeRtvi([
      rtvi("bot-llm-started"),
      rtvi("bot-llm-text", { text: "你好。" }),
      rtvi("bot-transcription", { text: "你好。" }),
      rtvi("bot-llm-text", { text: "再见。" }),
      rtvi("bot-llm-stopped"),
      rtvi("bot-llm-started"),
      rtvi("bot-llm-text", { text: "嗯" }),
    ]);
    expect(normal.map((n) => n.key)).toEqual([
      "bot-llm-started",
      'bot-llm-text {"text":"你好。再见。"}',
      'bot-transcription {"text":"你好。"}',
      "bot-llm-stopped",
      "bot-llm-started",
      'bot-llm-text {"text":"嗯"}',
    ]);
  });
});

function capture(engine: "pipedog" | "native", messages: Received[], extra: Partial<Capture> = {}) {
  return {
    engine,
    received: messages,
    audible: [],
    mind: [],
    fish: [],
    soniox: [],
    usage: [],
    conversation: [],
    logs: [],
    ended: true,
    failed: null,
    ...extra,
  } satisfies Capture;
}

const rules = (twin: Twin) => judge(twin).map((j) => j.rule?.id ?? "UNEXPLAINED");

describe("allowed.ts", () => {
  const reply = (stopsAt: "end" | "late"): Received[] => [
    rtvi("bot-ready"),
    rtvi("bot-llm-started"),
    rtvi("bot-llm-text", { text: "你好。再见。" }),
    rtvi("bot-transcription", { text: "你好。" }),
    ...(stopsAt === "late" ? [rtvi("bot-transcription", { text: "再见。" })] : []),
    rtvi("bot-tts-started"),
    rtvi("bot-llm-stopped"),
    ...(stopsAt === "end" ? [rtvi("bot-transcription", { text: "再见。" })] : []),
    rtvi("bot-started-speaking"),
  ];

  test("each rule names its difference and its trigger", async () => {
    const { ALLOWED } = await import("../allowed.ts");
    expect(ALLOWED.map((rule): string => rule.id)).toEqual(
      Array.from({ length: 16 }, (_, i) => `D${i + 1}`),
    );
    for (const rule of ALLOWED) {
      expect(rule.difference.length).toBeGreaterThan(0);
      expect(rule.trigger.length).toBeGreaterThan(0);
    }
  });

  test("D2, D3, D4, D5 and D7 explain a greeting's differences, and nothing else passes", () => {
    const pipedog = capture("pipedog", [
      rtvi("metrics", { ttfb: [] }),
      rtvi("user-llm-text", { text: "用一两句话简短自然地打个招呼。" }),
      ...reply("late"),
      rtvi("user-started-speaking"),
      rtvi("bot-interrupted"),
      rtvi("bot-stopped-speaking"),
    ]);
    const native = capture("native", [
      ...reply("end"),
      rtvi("bot-tts-stopped"),
      rtvi("bot-stopped-speaking"),
      rtvi("user-started-speaking"),
      rtvi("bot-interrupted"),
    ]);
    expect(rules({ pipedog, native }).sort()).toEqual(["D2", "D3", "D4", "D5", "D7"]);
  });

  test("D5 holds whichever side of the swap the alignment moves", () => {
    const typed = (stopFirst: boolean): Received[] => [
      rtvi("bot-ready"),
      rtvi("bot-started-speaking"),
      ...(stopFirst
        ? [rtvi("bot-stopped-speaking"), rtvi("bot-interrupted")]
        : [rtvi("bot-interrupted"), rtvi("bot-stopped-speaking")]),
      rtvi("user-input", { text: "再说", input_type: "chat", final: true }),
    ];
    const twin = {
      pipedog: capture("pipedog", typed(false)),
      native: capture("native", typed(true)),
    };
    expect(rules(twin)).toEqual(["D5"]);
    // The other way round, native late, is no allowed difference.
    const late = {
      pipedog: capture("pipedog", typed(true)),
      native: capture("native", typed(false)),
    };
    expect(rules(late)).toEqual(["UNEXPLAINED"]);
  });

  test("a difference no rule allows is unexplained", () => {
    const pipedog = capture("pipedog", [rtvi("bot-ready"), rtvi("user-stopped-speaking")]);
    const native = capture("native", [
      rtvi("bot-ready"),
      rtvi("user-stopped-speaking"),
      rtvi("error", { error: "x", fatal: false }),
    ]);
    expect(rules({ pipedog, native })).toEqual(["UNEXPLAINED"]);
  });

  test("D6: the same text joined without pipedog's space between CJK segments", () => {
    const say = (content: string) => [{ role: "assistant", content }];
    const pipedog = capture("pipedog", [], { conversation: say("你好。 再见。") });
    const native = capture("native", [], { conversation: say("你好。再见。") });
    expect(rules({ pipedog, native })).toEqual(["D6"]);
    const other = capture("native", [], { conversation: say("你好。再会。") });
    expect(rules({ pipedog, native: other })).toEqual(["UNEXPLAINED"]);
  });

  const request = (content: string) => ({
    path: "/chat/completions",
    headers: {},
    body: { messages: [{ role: "user", content }] },
  });
  const round = (text: string) => [
    rtvi("bot-llm-started"),
    rtvi("bot-llm-text", { text }),
    rtvi("bot-llm-stopped"),
  ];

  test("D13 allows native's Fish text without the recovery's sentences, and no other sentence", () => {
    const fish = (...flushed: string[]): FishSession => ({
      path: "/v1/tts/live",
      authorization: null,
      model: null,
      start: null,
      request: null,
      flushed,
      stopped: true,
    });
    const asked = [rtvi("bot-ready"), ...round("你好。"), ...round("嗯。好的。")];
    const pipedog = capture("pipedog", [...asked, ...round("好呀。")], {
      mind: [request("开场"), request("问题"), request(INTERRUPTED_EMPTY_TURN_PROMPT)],
      fish: [fish("你好。", "嗯。", "好的。", "好呀。")],
    });
    const native = (...flushed: string[]) =>
      capture("native", asked, {
        mind: [request("开场"), request("问题")],
        fish: [fish(...flushed)],
      });
    const fishRule = (twin: Twin) =>
      judge(twin).find((j) => j.difference.kind === "request" && j.difference.what === "fish text")
        ?.rule?.id ?? "UNEXPLAINED";
    const whole = { pipedog, native: native("你好。", "嗯。", "好的。") };
    expect(new Set(rules(whole))).toEqual(new Set(["D13"]));
    expect(fishRule(whole)).toBe("D13");
    // An ordinary sentence lost on native's side is not the recovery's.
    expect(fishRule({ pipedog, native: native("你好。", "嗯。") })).toBe("UNEXPLAINED");
    expect(fishRule({ pipedog, native: native("你好。", "好的。") })).toBe("UNEXPLAINED");
  });

  test("D13 allows the recovery request's mind usage, and no ordinary request's", () => {
    const mind = (records: number) =>
      Array.from({ length: records }, () =>
        usageRecord(
          {
            role: "mind",
            provider: "openrouter",
            model: "twin/mind-1",
            units: { inputTokens: 100, outputTokens: 10 },
          },
          0,
        ),
      );
    const asked = [rtvi("bot-ready"), ...round("你好。"), ...round("嗯。")];
    const recovered = (usage: UsageRecord[]) =>
      capture("pipedog", [...asked, ...round("好呀。")], {
        mind: [request("开场"), request("问题"), request(INTERRUPTED_EMPTY_TURN_PROMPT)],
        usage,
      });
    const pipedog = recovered(mind(3));
    const native = (records: number) =>
      capture("native", asked, { mind: [request("开场"), request("问题")], usage: mind(records) });
    const usage = (twin: Twin) =>
      judge(twin)
        .filter((j) => j.difference.kind === "usage")
        .map((j) => j.rule?.id ?? "UNEXPLAINED");
    expect(usage({ pipedog, native: native(2) })).toEqual(["D13"]);
    // An ordinary request's record lost on native's side is not the recovery's.
    expect(usage({ pipedog, native: native(1) })).toContain("UNEXPLAINED");
    expect(usage({ pipedog, native: native(0) })).toContain("UNEXPLAINED");
    // Nor is a record of usage no request of native's reported.
    const other = recovered([
      ...mind(2),
      usageRecord(
        { role: "mind", provider: "openrouter", model: "twin/mind-2", units: { inputTokens: 1 } },
        0,
      ),
    ]);
    expect(usage({ pipedog: other, native: native(2) })).toEqual(["UNEXPLAINED"]);
  });

  test("D7 allows a sentence late only where native's segmenter waits for the round's end", () => {
    const early = capture("native", [
      rtvi("bot-ready"),
      rtvi("bot-transcription", { text: "再见。" }),
      rtvi("bot-llm-started"),
      rtvi("bot-llm-text", { text: "你好。再见。" }),
      rtvi("bot-transcription", { text: "你好。" }),
      rtvi("bot-tts-started"),
      rtvi("bot-llm-stopped"),
      rtvi("bot-started-speaking"),
    ]);
    const pipedog = capture("pipedog", reply("late"));
    expect(rules({ pipedog, native: early })).toContain("UNEXPLAINED");
  });
});
