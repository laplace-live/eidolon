// The twin harness's own logic on made-up sequences, no call needed: the invariants, how a run is
// normalized and compared, and that each allowed.ts rule matches its difference and nothing else.
import { describe, expect, test } from "bun:test";
import { INTERRUPTED_EMPTY_TURN_PROMPT } from "@eidolon/context";
import { type UsageRecord, usageRecord } from "@eidolon/providers";
import type { FishSession } from "../fakes/fish.ts";
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

describe("allowed.ts: Fish's sentences reported as they play (D11, D12)", () => {
  const A = "嗯，今天花店来了好多新的花。";
  const B = "你想先看哪一种呢？";
  const C = "好呀，那我们慢慢聊。";
  const session: FishSession = {
    path: "/v1/tts/live",
    authorization: null,
    model: null,
    start: null,
    request: null,
    flushed: [A, B, C],
    stopped: true,
  };
  const fish = { fish: [session] };
  const report = (id: number, text: string, status: "new" | "completed") =>
    rtvi("bot-output", {
      text,
      text_type: "sentence",
      aggregated_by: "sentence",
      segment_id: id,
      spoken: status === "completed",
      will_be_spoken: true,
      spoken_status: status,
      spoken_progress: {
        accumulated_text: status === "new" ? "" : text,
        remaining_text: status === "new" ? text : "",
      },
    });
  /** A sentence reported whole: new, completed, and its bot-tts-text. */
  const played = (id: number, text: string) => [
    report(id, text, "new"),
    report(id, text, "completed"),
    rtvi("bot-tts-text", { text }),
  ];
  const answer = (...sentences: string[]) => [
    rtvi("bot-llm-started"),
    rtvi("bot-llm-text", { text: sentences.join("") }),
    ...sentences.flatMap((text, i) =>
      i === 0
        ? [rtvi("bot-transcription", { text }), rtvi("bot-tts-started")]
        : [rtvi("bot-transcription", { text })],
    ),
    rtvi("bot-llm-stopped"),
    rtvi("bot-started-speaking"),
  ];
  const typed = (text: string) => rtvi("user-input", { text, input_type: "chat", final: true });

  test("D12: lines typed while she speaks land among native's later reports, whichever side moves", () => {
    const [x, y, z] = [typed("一"), typed("二"), typed("三")];
    const pipedog = (...meanwhile: Received[]) =>
      capture(
        "pipedog",
        [rtvi("bot-ready"), ...answer(A, B), ...played(1, A), ...played(2, B), ...meanwhile],
        fish,
      );
    const native = (...meanwhile: Received[]) =>
      capture(
        "native",
        [
          rtvi("bot-ready"),
          ...answer(A, B),
          ...played(1, A),
          report(2, B, "new"),
          ...meanwhile,
          report(2, B, "completed"),
          rtvi("bot-tts-text", { text: B }),
        ],
        fish,
      );
    // The alignment moves the line in one, and the two reports in the other.
    expect(rules({ pipedog: pipedog(x), native: native(x) })).toEqual(["D12"]);
    expect(rules({ pipedog: pipedog(x, y, z), native: native(x, y, z) })).toEqual(["D12", "D12"]);
    // Without Fish, as on a realtime call, or moved past a message other than a report, no.
    const elsewhere = { fish: [] };
    expect(
      rules({
        pipedog: capture("pipedog", [...pipedog(x).received], elsewhere),
        native: capture("native", [...native(x).received], elsewhere),
      }),
    ).toEqual(["UNEXPLAINED"]);
    const early = capture(
      "native",
      [rtvi("bot-ready"), x, ...answer(A, B), ...played(1, A), ...played(2, B)],
      fish,
    );
    expect(rules({ pipedog: pipedog(x), native: early })).toEqual(["UNEXPLAINED"]);
    // A report that lands in her next reply is no allowed difference either.
    const replies = (late: boolean) => [
      rtvi("bot-ready"),
      ...answer(A),
      report(1, A, "new"),
      ...(late ? [] : [report(1, A, "completed"), rtvi("bot-tts-text", { text: A })]),
      rtvi("bot-stopped-speaking"),
      x,
      y,
      z,
      ...answer(C),
      ...(late ? [report(1, A, "completed"), rtvi("bot-tts-text", { text: A })] : []),
      ...played(2, C),
    ];
    expect(
      rules({
        pipedog: capture("pipedog", replies(false), fish),
        native: capture("native", replies(true), fish),
      }),
    ).toEqual(["UNEXPLAINED", "UNEXPLAINED"]);
  });

  test("D12: her reports move past other messages, never past each other", () => {
    const pipedog = capture(
      "pipedog",
      [rtvi("bot-ready"), ...answer(A, B), ...played(1, A), ...played(2, B)],
      fish,
    );
    const native = (...reports: Received[]) =>
      capture("native", [rtvi("bot-ready"), ...answer(A, B), ...reports], fish);
    const [newA, completedA, textA] = played(1, A);
    const [newB, completedB, textB] = played(2, B);
    // B completing before A, where the alignment moves A's reports, and B new before A completed,
    // where it moves B's.
    const swaps = [
      [newA, newB, completedB, textB, completedA, textA],
      [newA, newB, completedA, textA, completedB, textB],
    ] as Received[][];
    for (const reports of swaps) {
      expect(rules({ pipedog, native: native(...reports) })).toContain("UNEXPLAINED");
    }
  });

  // Her reply of A and B cut off while A plays, then C: pipedog reported A and B whole at her first
  // audio and kept both; native reported A new, kept nothing, and numbers C one sentence earlier.
  const cut = [rtvi("user-started-speaking"), rtvi("bot-interrupted")];
  const after = (...reports: Received[]) => [
    rtvi("bot-stopped-speaking"),
    rtvi("user-stopped-speaking"),
    ...answer(C),
    ...reports,
    rtvi("bot-stopped-speaking"),
  ];
  const question = { role: "user", content: "给我讲讲花店" };
  const lines = (kept: string | null, earlier: readonly unknown[] = []) => [
    ...earlier,
    question,
    ...(kept === null ? [] : [{ role: "assistant", content: kept }]),
    { role: "user", content: "等一下" },
  ];
  const request = (messages: readonly unknown[]) => ({
    path: "/chat/completions",
    headers: {},
    body: { messages: [{ role: "system", content: "你是花店的店员。" }, ...messages] },
  });
  /** The requests for the cut reply and for C, and what she would see next. */
  const asked = (kept: string | null, earlier: readonly unknown[] = []) => ({
    mind: [request([...earlier, question]), request(lines(kept, earlier))],
    conversation: lines(kept, earlier),
  });
  const bargeIn = {
    pipedog: capture(
      "pipedog",
      [
        rtvi("bot-ready"),
        ...answer(A, B),
        ...played(1, A),
        ...played(2, B),
        ...cut,
        ...after(...played(3, C)),
      ],
      { ...fish, ...asked(`${A} ${B}`) },
    ),
    native: (
      o: {
        readonly heard?: Received[];
        readonly kept?: string | null;
        /** The segment id native gives C. */
        readonly next?: number;
      } = {},
    ) =>
      capture(
        "native",
        [
          rtvi("bot-ready"),
          ...answer(A, B),
          ...(o.heard ?? [report(1, A, "new")]),
          ...cut,
          ...after(...played(o.next ?? 7, C)),
        ],
        { ...fish, ...asked(o.kept === undefined ? null : o.kept) },
      ),
  };

  /** The rules for the RTVI differences against `bargeIn.pipedog`, or for the others. */
  const kept = (rtviOnly: boolean, native: Capture) =>
    judge({ pipedog: bargeIn.pipedog, native })
      .filter((j) => (j.difference.kind === "rtvi") === rtviOnly)
      .map((j) => j.rule?.id ?? "UNEXPLAINED");

  test("D12: a cut reply reports fewer sentences on native, and its next ones run an ordinal behind", () => {
    const twin = { pipedog: bargeIn.pipedog, native: bargeIn.native() };
    const judged = judge(twin).filter((j) => j.difference.kind === "rtvi");
    expect(judged.map((j) => j.rule?.id ?? "UNEXPLAINED")).toEqual(Array(7).fill("D12"));
    expect(
      judged.map((j) => (j.difference.kind === "rtvi" ? j.difference.change : null)).sort(),
    ).toEqual(["changed", "changed", ...Array(5).fill("pipedog-only")]);
    // Reports native had that aren't the first of pipedog's are no allowed difference, nor C
    // numbered further back than the sentences native never reported.
    expect(kept(true, bargeIn.native({ heard: [report(2, B, "new")] }))).toContain("UNEXPLAINED");
    expect(kept(true, bargeIn.native({ next: 1 }))).toEqual([
      "UNEXPLAINED",
      "UNEXPLAINED",
      ...Array(5).fill("D12"),
    ]);
    // Nor are sentences missing from a reply that played out before the caller spoke.
    const unreported = capture(
      "native",
      [
        rtvi("bot-ready"),
        ...answer(A, B),
        ...played(1, A),
        rtvi("bot-stopped-speaking"),
        ...cut,
        ...after(...played(7, C)).slice(1),
      ],
      fish,
    );
    expect(kept(true, unreported)).toContain("UNEXPLAINED");
  });

  test("D11: her cut message keeps fewer whole sentences on native, or none, and nothing else", () => {
    expect(kept(false, bargeIn.native())).toEqual(["D11", "D11"]);
    expect(kept(false, bargeIn.native({ kept: A }))).toEqual(["D11", "D11"]);
    expect(kept(false, bargeIn.native({ kept: "嗯，今天" }))).toEqual([
      "UNEXPLAINED",
      "UNEXPLAINED",
    ]);
    // A reply that played out before the caller spoke was not cut off.
    const whole = capture(
      "native",
      [rtvi("bot-ready"), ...answer(A, B), ...played(1, A), rtvi("bot-stopped-speaking"), ...cut],
      { ...fish, ...asked(null) },
    );
    expect(kept(false, whole)).toEqual(["UNEXPLAINED", "UNEXPLAINED"]);
  });

  test("D11 allows only the cut message, not an older line of hers its first sentence matches", () => {
    // Lines from the chat before the call, her last the cut reply's first sentence.
    const earlier = [
      { role: "user", content: "早" },
      { role: "assistant", content: A },
    ];
    const withEarlier = (side: Capture, kept: string | null, lines: readonly unknown[]) =>
      capture(side.engine, [...side.received], { ...fish, ...asked(kept, lines) });
    const pipedog = withEarlier(bargeIn.pipedog, `${A} ${B}`, earlier);
    const others = (native: Capture) =>
      judge({ pipedog, native })
        .filter((j) => j.difference.kind !== "rtvi")
        .map((j) => j.rule?.id ?? "UNEXPLAINED");
    expect(others(withEarlier(bargeIn.native(), null, earlier))).toEqual(["D11", "D11"]);
    expect(others(withEarlier(bargeIn.native(), null, earlier.slice(0, 1)))).toEqual([
      "UNEXPLAINED",
      "UNEXPLAINED",
      "D11",
      "UNEXPLAINED",
      "D11",
    ]);
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
