// I1–I10 (scripts/e2e/invariants.ts) on made-up sequences, as e2e-call.ts checks a real call's.
import { describe, expect, test } from "bun:test";
import { checkInvariants, type WireMessage } from "../scripts/e2e/invariants.ts";

const m = (type: string, data?: Record<string, unknown>): WireMessage =>
  data === undefined ? { type } : { type, data };

const ready = m("bot-ready", { version: "2.2.0" });
const said = (text: string, final = true) => [
  m("user-input", { text, input_type: "transcription", final, user_id: "" }),
  m("user-transcription", { text, user_id: "", final }),
];
const output = (id: number, status: string) =>
  m("bot-output", { segment_id: id, spoken_status: status, text: "嗯。" });

/** A turn and her reply. */
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

const ids = (messages: WireMessage[], pipedog = false) =>
  checkInvariants(messages, { pipedog }).map((v) => v.id);

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

  test("I6: every bot-tts-started is stopped, unless pipedog ran the call", () => {
    const open = CALL.filter((message) => message.type !== "bot-tts-stopped");
    expect(ids(open)).toEqual(["I6"]);
    expect(ids(open, true)).toEqual([]);
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
    expect(checkInvariants(turn, { realtime: true })).toEqual([]);
  });

  test("a final with no turn of the caller's before it still breaks I2", () => {
    const early = [ready, ...said("你好")];
    expect(checkInvariants(early, { realtime: true }).map((v) => v.id)).toEqual(["I2"]);
  });
});
