import { describe, expect, test } from "bun:test";
import type { ChatEvent, ChatEventOf, Speaker } from "@eidolon/chat";
import {
  chatItems,
  manyVoices,
  previewText,
  retryText,
  startsRun,
  withoutPartialMarkup,
} from "./items";

const IMAGE = { kind: "image", name: `${"a".repeat(64)}.png`, mime: "image/png" } as const;

const EVENTS: ChatEvent[] = [
  { type: "kickoff", seq: 1, at: 1, persona: "mio", turn: "t1", content: "打个招呼" },
  {
    type: "context",
    seq: 2,
    at: 1,
    persona: "mio",
    turn: "t1",
    position: 0,
    role: "system",
    content: "recall",
  },
  {
    type: "message",
    seq: 3,
    at: 2,
    id: "m3",
    speaker: { kind: "persona", id: "mio" },
    text: "你好呀",
  },
  { type: "message", seq: 4, at: 3, id: "m4", speaker: { kind: "user" }, text: "拍张照" },
  {
    type: "decision",
    seq: 5,
    at: 3,
    after: 4,
    replies: [{ persona: "mio", mode: "text" }],
    source: "single",
  },
  {
    type: "tool-call",
    seq: 6,
    at: 4,
    persona: "mio",
    turn: "t2",
    callId: "c1",
    name: "take_selfie",
    arguments: {},
  },
  { type: "tool-result", seq: 7, at: 5, persona: "mio", turn: "t2", callId: "c1", result: {} },
  {
    type: "message",
    seq: 8,
    at: 6,
    id: "m8",
    speaker: { kind: "persona", id: "mio" },
    text: "",
    attachments: [IMAGE, { kind: "audio", name: "x.ogg", mime: "audio/ogg", durationMs: 1 }],
    interrupted: true,
  },
  { type: "title", seq: 9, at: 7, title: "照片" },
  { type: "message", seq: 10, at: 8, id: "m10", speaker: { kind: "user" }, text: "再来一张" },
  { type: "turn-failed", seq: 11, at: 9, persona: "mio", turn: "t3", error: "Timed out" },
];

describe("chatItems", () => {
  test("shows the lines said and the failures, and hides everything else", () => {
    const single = { source: "single", scores: {}, to: { kind: "user" } } as const;
    expect(chatItems(EVENTS)).toEqual([
      {
        kind: "persona",
        seq: 3,
        persona: "mio",
        text: "你好呀",
        images: [],
        voice: null,
        sentAsText: false,
        interrupted: false,
        cutOff: null,
        reason: null,
        call: false,
      },
      { kind: "user", seq: 4, text: "拍张照", voice: null, call: false },
      {
        kind: "persona",
        seq: 8,
        persona: "mio",
        text: "",
        images: [IMAGE],
        voice: null,
        sentAsText: false,
        interrupted: true,
        cutOff: null,
        reason: single,
        call: false,
      },
      { kind: "user", seq: 10, text: "再来一张", voice: null, call: false },
      { kind: "failed", seq: 11, persona: "mio", error: "Timed out" },
    ]);
  });

  test("drops her empty message when it carries no picture", () => {
    const empty: ChatEvent = {
      type: "message",
      seq: 1,
      at: 1,
      id: "m",
      speaker: { kind: "persona", id: "mio" },
      text: "",
      interrupted: true,
    };
    expect(chatItems([empty])).toEqual([]);
  });

  test("keeps her message her provider cut off, even with no words", () => {
    const cut = (seq: number, text: string, cutOff: "length" | "refusal"): ChatEvent => ({
      type: "message",
      seq,
      at: seq,
      id: `m${seq}`,
      speaker: { kind: "persona", id: "mio" },
      text,
      cutOff,
    });
    expect(chatItems([cut(1, "说到一", "length"), cut(2, "", "refusal")])).toMatchObject([
      { kind: "persona", seq: 1, text: "说到一", cutOff: "length" },
      { kind: "persona", seq: 2, text: "", cutOff: "refusal" },
    ]);
  });
});

describe("voice messages", () => {
  const AUDIO = { kind: "audio", name: `${"b".repeat(64)}.mp3`, mime: "audio/mpeg" } as const;
  const voice = (seq: number, speaker: Speaker, text: string) =>
    ({
      type: "message",
      seq,
      at: seq,
      id: `v${seq}`,
      speaker,
      text,
      modality: "voice",
      attachments: [AUDIO],
    }) as const satisfies ChatEvent;
  const userLine = (seq: number, text: string): ChatEvent => ({
    type: "message",
    seq,
    at: seq,
    id: `u${seq}`,
    speaker: { kind: "user" },
    text,
  });

  test("carry their audio and transcript, even when nothing in the viewer's could be heard", () => {
    expect(
      chatItems([
        voice(1, { kind: "user" }, ""),
        voice(2, { kind: "persona", id: "mio" }, "[笑]好呀"),
      ]),
    ).toMatchObject([
      { kind: "user", seq: 1, text: "", voice: AUDIO },
      { kind: "persona", seq: 2, text: "[笑]好呀", voice: AUDIO, sentAsText: false },
    ]);
  });

  test("audio on a message that isn't a voice message plays no part", () => {
    const [item] = chatItems([{ ...voice(1, { kind: "user" }, "hi"), modality: "text" }]);
    expect(item).toEqual({ kind: "user", seq: 1, text: "hi", voice: null, call: false });
    expect(chatItems([{ ...voice(2, { kind: "user" }, ""), modality: "text" }])).toEqual([]);
  });

  test("a voice that couldn't be made badges her message as sent as text, not a failure", () => {
    const her: ChatEvent = {
      type: "message",
      seq: 2,
      at: 2,
      id: "m2",
      speaker: { kind: "persona", id: "mio" },
      text: "好呀",
    };
    const failed = (seq: number, persona: string): ChatEvent => ({
      type: "turn-failed",
      seq,
      at: seq,
      persona,
      turn: "t1",
      error: "Fish Audio answered 402",
      code: "voice-failed",
    });
    const items = chatItems([userLine(1, "唱首歌"), her, failed(3, "mio")]);
    expect(items).toMatchObject([
      { kind: "user" },
      { kind: "persona", seq: 2, voice: null, sentAsText: true },
    ]);
    expect(retryText(items)).toBeNull();
    // Another persona's, or one with no message of hers right before it, badges nothing.
    expect(chatItems([her, failed(3, "ken")])).toMatchObject([{ sentAsText: false }]);
    expect(chatItems([userLine(1, "唱"), failed(2, "mio")])).toEqual([
      { kind: "user", seq: 1, text: "唱", voice: null, call: false },
    ]);
  });

  test("Retry sends a voice message again as its transcript, and one with none not at all", () => {
    const fails: ChatEvent = {
      type: "turn-failed",
      seq: 2,
      at: 2,
      persona: "mio",
      turn: "t",
      error: "x",
    };
    expect(retryText(chatItems([voice(1, { kind: "user" }, "你好"), fails]))).toBe("你好");
    expect(retryText(chatItems([voice(1, { kind: "user" }, ""), fails]))).toBeNull();
  });
});

describe("a group's lines", () => {
  const user = (seq: number): ChatEvent => ({
    type: "message",
    seq,
    at: seq,
    id: `u${seq}`,
    speaker: { kind: "user" },
    text: "大家好",
  });
  const her = (seq: number, id: string): ChatEvent => ({
    type: "message",
    seq,
    at: seq,
    id: `m${seq}`,
    speaker: { kind: "persona", id },
    text: `${id}在`,
  });
  const GROUP: ChatEvent[] = [
    user(1),
    {
      type: "decision",
      seq: 2,
      at: 2,
      after: 1,
      replies: [{ persona: "ken", mode: "text" }],
      source: "mention",
      scores: { addressed_ken: 0.9, addressed_mio: 0.1 },
    },
    her(3, "ken"),
    {
      type: "decision",
      seq: 4,
      at: 4,
      after: 3,
      replies: [{ persona: "mio", mode: "text" }],
      source: "fallback",
    },
    her(5, "mio"),
    her(6, "mio"),
  ];

  test("each reply carries the decision that chose her, and whose line it answered", () => {
    const reasons = chatItems(GROUP).flatMap((item) =>
      item.kind === "persona" ? [[item.persona, item.reason]] : [],
    );
    expect(reasons).toEqual([
      [
        "ken",
        {
          source: "mention",
          scores: { addressed_ken: 0.9, addressed_mio: 0.1 },
          to: { kind: "user" },
        },
      ],
      ["mio", { source: "fallback", scores: {}, to: { kind: "persona", id: "ken" } }],
      ["mio", { source: "fallback", scores: {}, to: { kind: "persona", id: "ken" } }],
    ]);
  });

  test("a photo landing after her interrupted turn carries that turn's decision", () => {
    const decision = (seq: number, after: number, persona: string, source: "mention" | "model") =>
      ({
        type: "decision",
        seq,
        at: seq,
        after,
        replies: [{ persona, mode: "text" }],
        source,
      }) as const;
    const photo: ChatEvent = {
      type: "message",
      seq: 8,
      at: 8,
      id: "m8",
      speaker: { kind: "persona", id: "mio" },
      text: "",
      attachments: [IMAGE],
    };
    const events: ChatEvent[] = [
      user(1),
      decision(2, 1, "mio", "mention"),
      {
        type: "tool-call",
        seq: 3,
        at: 3,
        persona: "mio",
        turn: "t1",
        callId: "c1",
        name: "take_selfie",
        arguments: {},
      },
      { ...(her(4, "mio") as ChatEventOf<"message">), interrupted: true },
      user(5),
      decision(6, 5, "mio", "model"),
      { type: "tool-result", seq: 7, at: 7, persona: "mio", turn: "t1", callId: "c1", result: {} },
      photo,
      her(9, "mio"),
    ];
    const reasons = (log: ChatEvent[]) =>
      chatItems(log).flatMap((item) => (item.kind === "persona" ? [item.reason?.source] : []));
    expect(reasons(events)).toEqual(["mention", "mention", "model"]);
    // Timed out, it brings no result to tie the photo to her turn.
    expect(reasons(events.filter((event) => event.seq !== 7))).toEqual([
      "mention",
      undefined,
      "model",
    ]);
  });

  test("a reply after a late result that brought no photo keeps its own decision", () => {
    const events: ChatEvent[] = [
      user(1),
      {
        type: "decision",
        seq: 2,
        at: 2,
        after: 1,
        replies: [{ persona: "mio", mode: "text" }],
        source: "mention",
      },
      {
        type: "tool-call",
        seq: 3,
        at: 3,
        persona: "mio",
        turn: "t1",
        callId: "c1",
        name: "take_selfie",
        arguments: {},
      },
      { ...(her(4, "mio") as ChatEventOf<"message">), interrupted: true },
      user(5),
      {
        type: "decision",
        seq: 6,
        at: 6,
        after: 5,
        replies: [{ persona: "mio", mode: "text" }],
        source: "model",
      },
      {
        type: "tool-result",
        seq: 7,
        at: 7,
        persona: "mio",
        turn: "t1",
        callId: "c1",
        result: { ok: false },
      },
      her(8, "mio"),
    ];
    expect(
      chatItems(events).flatMap((item) => (item.kind === "persona" ? [item.reason?.source] : [])),
    ).toEqual(["mention", "model"]);
  });

  test("a run of one speaker's lines starts where the speaker changes", () => {
    const items = chatItems(GROUP);
    expect(items.map((_, index) => startsRun(items, index))).toEqual([true, true, true, false]);
  });

  test("hold more than one voice once two personas have spoken", () => {
    expect(manyVoices(chatItems(GROUP))).toBe(true);
    expect(manyVoices(chatItems(GROUP.slice(0, 3)))).toBe(false);
    expect(manyVoices(chatItems(EVENTS))).toBe(false);
  });
});

describe("retryText", () => {
  test("is the viewer's last line when the chat ends in a failure", () => {
    expect(retryText(chatItems(EVENTS))).toBe("再来一张");
  });

  test("is the viewer's last line when her reply to it was cut off", () => {
    const asked = { kind: "user", seq: 1, text: "讲个长故事", voice: null, call: false } as const;
    const reply = {
      kind: "persona",
      seq: 2,
      persona: "mio",
      text: "从前",
      images: [],
      voice: null,
      sentAsText: false,
      interrupted: false,
      reason: null,
      call: false,
    } as const;
    expect(retryText([asked, { ...reply, cutOff: "length" }])).toBe("讲个长故事");
    expect(retryText([asked, { ...reply, cutOff: null }])).toBeNull();
  });

  test("is null once something followed the failure, or with no line to send", () => {
    const items = chatItems(EVENTS);
    expect(retryText(items.slice(0, -1))).toBeNull();
    expect(retryText([{ kind: "failed", seq: 1, persona: "mio", error: "x" }])).toBeNull();
  });
});

describe("calls", () => {
  const MIO = { kind: "persona", id: "mio" } as const;
  const said = (seq: number, speaker: Speaker, text: string, interrupted = false): ChatEvent => ({
    type: "message",
    seq,
    at: seq * 1000,
    id: `c${seq}`,
    speaker,
    text,
    modality: "call",
    ...(interrupted ? { interrupted } : {}),
  });
  const decided: ChatEvent = {
    type: "decision",
    seq: 2,
    at: 2000,
    after: 1,
    replies: [{ persona: "mio", mode: "text" }],
    source: "single",
  };
  const CALL: ChatEvent[] = [
    { type: "message", seq: 1, at: 1000, id: "u1", speaker: { kind: "user" }, text: "在吗" },
    decided,
    { type: "message", seq: 3, at: 3000, id: "m3", speaker: MIO, text: "在呢" },
    { type: "call-started", seq: 4, at: 4000, call: "k1", persona: "mio" },
    said(5, MIO, "喂？"),
    said(6, { kind: "user" }, "刚才说到哪了"),
    said(7, MIO, "说到你的猫", true),
    { type: "call-ended", seq: 8, at: 196_000, call: "k1", reason: "client" },
  ];

  test("its lines are messages marked as said on the call, with no decision behind hers", () => {
    expect(chatItems(CALL).slice(3, 6)).toEqual([
      {
        kind: "persona",
        seq: 5,
        persona: "mio",
        text: "喂？",
        images: [],
        voice: null,
        sentAsText: false,
        interrupted: false,
        cutOff: null,
        reason: null,
        call: true,
      },
      { kind: "user", seq: 6, text: "刚才说到哪了", voice: null, call: true },
      {
        kind: "persona",
        seq: 7,
        persona: "mio",
        text: "说到你的猫",
        images: [],
        voice: null,
        sentAsText: false,
        interrupted: true,
        cutOff: null,
        reason: null,
        call: true,
      },
    ]);
    expect(chatItems(CALL)[1]).toMatchObject({ kind: "persona", seq: 3, call: false });
  });

  test("its start and end are separators, each knowing whom it was with and how long it ran", () => {
    const items = chatItems(CALL);
    expect(items[2]).toEqual({
      kind: "call",
      seq: 4,
      edge: "started",
      persona: "mio",
      durationMs: 192_000,
    });
    expect(items[6]).toEqual({
      kind: "call",
      seq: 8,
      edge: "ended",
      persona: "mio",
      durationMs: 192_000,
    });
  });

  test("a call still on has no length yet, and an end without its start names no one", () => {
    expect(chatItems(CALL.slice(0, 6))[2]).toMatchObject({ edge: "started", durationMs: null });
    expect(chatItems(CALL.slice(7))).toEqual([
      { kind: "call", seq: 8, edge: "ended", persona: null, durationMs: null },
    ]);
  });

  test("her first line after a separator starts a run, and Retry never reaches back past one", () => {
    const items = chatItems(CALL);
    expect(items[1]).toMatchObject({ kind: "persona", persona: "mio" });
    expect(items[3]).toMatchObject({ kind: "persona", persona: "mio" });
    expect(startsRun(items, 3)).toBe(true);
    const failed: ChatEvent = {
      type: "turn-failed",
      seq: 9,
      at: 9,
      persona: "mio",
      turn: "t",
      error: "x",
    };
    expect(retryText(chatItems([...CALL, failed]))).toBeNull();
    expect(manyVoices(items)).toBe(false);
  });

  test("on a group call, each line takes the decision that chose her, and a follow-up none", () => {
    const BEA = { kind: "persona", id: "bea" } as const;
    const chose = (seq: number, after: number, ...personas: string[]): ChatEvent => ({
      type: "decision",
      seq,
      at: seq * 1000,
      after,
      replies: personas.map((persona) => ({ persona, mode: "text" })),
      source: "mention",
    });
    const items = chatItems([
      { type: "message", seq: 1, at: 1000, id: "u1", speaker: { kind: "user" }, text: "在吗" },
      chose(2, 1, "mio"),
      { type: "message", seq: 3, at: 3000, id: "m3", speaker: MIO, text: "在呢" },
      { type: "call-started", seq: 4, at: 4000, call: "k2", persona: "mio", group: true },
      said(5, { kind: "user" }, "@小露 你呢"),
      chose(6, 5, "bea"),
      said(7, BEA, "我也在"),
      said(8, MIO, "我拍好照片了"),
      { type: "call-ended", seq: 9, at: 64_000, call: "k2", reason: "hangup" },
    ]);
    expect(items[2]).toEqual({
      kind: "call",
      seq: 4,
      edge: "started",
      persona: "mio",
      group: true,
      durationMs: 60_000,
    });
    expect(items[4]).toMatchObject({
      kind: "persona",
      persona: "bea",
      call: true,
      reason: { source: "mention", to: { kind: "user" } },
    });
    // Her own follow-up, which no decision chose, and not the text turn's from before the call.
    expect(items[5]).toMatchObject({ kind: "persona", persona: "mio", call: true, reason: null });
  });
});

describe("withoutPartialMarkup", () => {
  test("drops a cue or tag cut off at the end, and nothing else", () => {
    expect(withoutPartialMarkup("真的</emp")).toBe("真的");
    expect(withoutPartialMarkup("<emphasis>真")).toBe("<emphasis>真");
    expect(withoutPartialMarkup("你好[温柔")).toBe("你好");
    expect(withoutPartialMarkup("你好[温柔地]")).toBe("你好[温柔地]");
    expect(withoutPartialMarkup("a <")).toBe("a ");
    expect(withoutPartialMarkup("3 < 5")).toBe("3 < 5");
  });

  test("leaves a preview without the fragment", () => {
    expect(previewText("嗯嗯。<emph")).toBe("嗯嗯。");
  });
});

describe("previewText", () => {
  test("keeps the words and cue emoji, and drops directions and tags", () => {
    expect(previewText("[温柔地]<whisper>晚安</whisper> [sighing]\n明天见")).toBe(
      "晚安 😮‍💨 明天见",
    );
    expect(previewText("[break]")).toBe("");
  });
});
