// The twin harness's own logic on made-up sequences, no call needed: the invariants, how a run is
// normalized and compared, and that each allowed.ts rule matches its difference and nothing else.
import { describe, expect, test } from "bun:test";
import type { Received } from "../fakes/peer.ts";
import type { ClientEvent } from "../fakes/realtime.ts";
import { checkInvariants, type WireMessage } from "../invariants.ts";
import {
  type Capture,
  judge,
  normalizeRealtime,
  normalizeRtvi,
  type Twin,
  violations,
} from "../twin.ts";

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
    realtime: [],
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
    expect(ALLOWED.map((rule): string => rule.id)).toEqual([
      ...Array.from({ length: 16 }, (_, i) => `D${i + 1}`),
      "E1",
      "E2",
      "E3",
      "E4",
      "E5",
      "E8",
    ]);
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

describe("a realtime call's invariants", () => {
  // The server ends the turn on its VAD and answers before it has transcribed it.
  const turn = [
    ready,
    m("user-started-speaking"),
    m("bot-interrupted"),
    m("user-stopped-speaking"),
    m("bot-llm-started"),
    ...said("你好"),
    m("bot-llm-stopped"),
  ];

  test("I2 holds as a final after its turn's start, and I9 waits for no transcript", () => {
    expect(ids(turn)).toEqual(["I9", "I2", "I2"]);
    expect(checkInvariants(turn, { native: true, realtime: true })).toEqual([]);
  });

  test("a final with no turn of the caller's before it still breaks I2", () => {
    const early = [ready, ...said("你好")];
    expect(checkInvariants(early, { native: true, realtime: true }).map((v) => v.id)).toEqual([
      "I2",
    ]);
  });
});

describe("normalizeRealtime", () => {
  test("the session as its updates leave it, item ids as ordinals, and no cut position", () => {
    const events: ClientEvent[] = [
      {
        type: "session.update",
        session: { instructions: "现在是 2026年11月10日 周二 19:53。S", tools: [] },
      },
      {
        type: "conversation.item.create",
        item: { id: "abc", type: "message", role: "user", content: [] },
      },
      { type: "session.update", session: { tools: [{ name: "t" }] } },
      { type: "conversation.item.delete", item_id: "abc" },
      { type: "conversation.item.truncate", item_id: "it1", content_index: 0, audio_end_ms: 412 },
      { type: "response.cancel" },
    ];
    expect(normalizeRealtime(events).map((n) => n.key)).toEqual([
      'session {"instructions":"现在是 <now>。S","tools":[{"name":"t"}]}',
      'conversation.item.create {"item":{"type":"message","role":"user","content":[]}}',
      'conversation.item.delete {"item":1}',
      'conversation.item.truncate {"item_id":"it1","content_index":0,"audio_end_ms":"<ms>"}',
      "response.cancel",
    ]);
  });
});

describe("allowed.ts: a realtime call's rules", () => {
  const session: ClientEvent = { type: "session.update", session: { instructions: "S" } };
  const on = (events: ClientEvent[] = []) => ({ realtime: [session, ...events] });
  const delta = (text: string, id: number) =>
    rtvi("bot-output", {
      text,
      text_type: "sentence",
      aggregated_by: "sentence",
      segment_id: id,
      spoken: true,
      will_be_spoken: false,
      spoken_status: "new",
    });
  const sentence = (text: string, status: "new" | "completed") =>
    rtvi("bot-output", {
      text,
      text_type: "sentence",
      aggregated_by: "sentence",
      segment_id: 1,
      spoken: status === "completed",
      will_be_spoken: true,
      spoken_status: status,
    });
  const greeting = {
    pipedog: [
      rtvi("bot-ready"),
      rtvi("bot-llm-started"),
      rtvi("bot-llm-started"),
      rtvi("bot-llm-text", { text: "你好呀，欢迎。" }),
      rtvi("bot-tts-started"),
      rtvi("bot-started-speaking"),
      delta("你好呀，", 8),
      rtvi("bot-tts-text", { text: "你好呀，" }),
      rtvi("bot-transcription", { text: "你好呀，欢迎。" }),
      rtvi("bot-tts-stopped"),
      rtvi("bot-llm-stopped"),
      delta("欢迎。", 9),
      rtvi("bot-tts-text", { text: "欢迎。" }),
      rtvi("bot-stopped-speaking"),
    ],
    native: [
      rtvi("bot-ready"),
      rtvi("bot-llm-started"),
      rtvi("bot-llm-text", { text: "你好呀，欢迎。" }),
      rtvi("bot-tts-started"),
      rtvi("bot-started-speaking"),
      rtvi("bot-transcription", { text: "你好呀，欢迎。" }),
      rtvi("bot-tts-stopped"),
      rtvi("bot-llm-stopped"),
      sentence("你好呀，欢迎。", "new"),
      sentence("你好呀，欢迎。", "completed"),
      rtvi("bot-tts-text", { text: "你好呀，欢迎。" }),
      rtvi("bot-stopped-speaking"),
    ],
  };

  test("E4 and E5 explain a realtime greeting, and E5 excuses pipedog's I5 there alone", () => {
    const twin = {
      pipedog: capture("pipedog", greeting.pipedog, on()),
      native: capture("native", greeting.native, on()),
    };
    expect([...new Set(rules(twin))].sort()).toEqual(["E4", "E5"]);
    expect(violations(twin)).toEqual({ pipedog: [], native: [] });
    // On a cascade call, the same differences are no allowed ones.
    const cascade = {
      pipedog: capture("pipedog", greeting.pipedog),
      native: capture("native", greeting.native),
    };
    expect(rules(cascade)).toContain("UNEXPLAINED");
    expect(violations(cascade).pipedog.map((v) => v.id)).toContain("I5");
  });

  test("E4 allows only her own sentences as native's bot-output", () => {
    const other = greeting.native.map((r) =>
      r.message.type === "bot-output" ? sentence("别的话。", "new") : r,
    );
    const twin = {
      pipedog: capture("pipedog", greeting.pipedog, on()),
      native: capture("native", other, on()),
    };
    expect(rules(twin)).toContain("UNEXPLAINED");
  });

  test("E3: native's interim is pipedog's deltas so far, joined", () => {
    const interims = (texts: string[]) => [
      rtvi("bot-ready"),
      rtvi("user-started-speaking"),
      rtvi("bot-interrupted"),
      ...texts.map((t) =>
        rtvi("user-input", { text: t, input_type: "transcription", final: false }),
      ),
    ];
    const pipedog = capture("pipedog", interims(["给我", "讲讲"]), on());
    expect(
      rules({ pipedog, native: capture("native", interims(["给我", "给我讲讲"]), on()) }),
    ).toEqual(["E3"]);
    expect(
      rules({ pipedog, native: capture("native", interims(["给我", "讲讲吧"]), on()) }),
    ).toEqual(["UNEXPLAINED"]);
  });

  test("E2: native's answer to a line pipedog never gave its model, and nothing once it did", () => {
    const typed = [
      rtvi("bot-ready"),
      rtvi("bot-interrupted"),
      rtvi("user-input", { text: "等一下", input_type: "chat", final: true }),
      rtvi("user-llm-text", { text: "等一下" }),
    ];
    const answer = [
      rtvi("bot-llm-started"),
      rtvi("bot-llm-text", { text: "好的。" }),
      rtvi("bot-llm-stopped"),
    ];
    const item: ClientEvent = {
      type: "conversation.item.create",
      item: {
        id: "x",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "等一下" }],
      },
    };
    const create: ClientEvent = { type: "response.create", response: {} };
    const usage = [
      { role: "realtime", provider: "openai", model: "m", source: "call", session: "s", units: {} },
    ] as unknown as Capture["usage"];
    const native = capture("native", [...typed, ...answer], { ...on([item, create]), usage });
    const twin = { pipedog: capture("pipedog", typed, on()), native };
    expect([...new Set(rules(twin))]).toEqual(["E2"]);
    // Once pipedog sent the line too, native's extra answer is no allowed difference.
    const answered = { pipedog: capture("pipedog", typed, on([item])), native };
    expect(rules(answered)).toContain("UNEXPLAINED");
  });

  test("E8: what pipedog sent after the fatal error that ended native's call", () => {
    const failed = [rtvi("bot-ready"), rtvi("error", { error: "Error: boom", fatal: false })];
    const after = rtvi("user-input", { text: "喂", input_type: "chat", final: true });
    const twin = {
      pipedog: capture("pipedog", [...failed, after], on()),
      native: capture("native", failed, on()),
    };
    expect(rules(twin)).toEqual(["E8"]);
    const going = {
      pipedog: capture("pipedog", [...failed, after], on()),
      native: capture(
        "native",
        [...failed, rtvi("bot-llm-started"), rtvi("bot-llm-stopped")],
        on(),
      ),
    };
    expect(rules(going)).toContain("UNEXPLAINED");
  });
});
