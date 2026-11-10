import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "@eidolon/chat";
import { chatItems, previewText, retryText, withoutPartialMarkup } from "./items";

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
    expect(chatItems(EVENTS)).toEqual([
      {
        kind: "persona",
        seq: 3,
        persona: "mio",
        text: "你好呀",
        images: [],
        interrupted: false,
        cutOff: null,
      },
      { kind: "user", seq: 4, text: "拍张照" },
      {
        kind: "persona",
        seq: 8,
        persona: "mio",
        text: "",
        images: [IMAGE],
        interrupted: true,
        cutOff: null,
      },
      { kind: "user", seq: 10, text: "再来一张" },
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

describe("retryText", () => {
  test("is the viewer's last line when the chat ends in a failure", () => {
    expect(retryText(chatItems(EVENTS))).toBe("再来一张");
  });

  test("is the viewer's last line when her reply to it was cut off", () => {
    const asked = { kind: "user", seq: 1, text: "讲个长故事" } as const;
    const reply = {
      kind: "persona",
      seq: 2,
      persona: "mio",
      text: "从前",
      images: [],
      interrupted: false,
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
