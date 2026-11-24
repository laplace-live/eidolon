import type { ChatEvent } from "@eidolon/chat";
import { describe, expect, test } from "vitest";
import { onChatFact, saidFacts, tellCompanion } from "./chat-facts";
import type { ChatFact } from "./protocol";

const CHAT = "0199a3f2-7c1e-7d40-9b6a-3f5e8c2d1a07";
const AUDIO = { kind: "audio", name: `${"d".repeat(64)}.mp3`, mime: "audio/mpeg" } as const;
/** A time the chat was written at, in ms since the epoch: never a seq. */
const AT = 1_763_900_000_000;

function message(seq: number, fields: Partial<ChatEvent & { type: "message" }>): ChatEvent {
  return {
    type: "message",
    seq,
    at: AT + seq,
    id: `m${seq}`,
    speaker: { kind: "persona", id: "milky-green" },
    text: "",
    ...fields,
  } as ChatEvent;
}

describe("saidFacts", () => {
  test("tells each of her messages, voice messages too, and nothing else", () => {
    const events: ChatEvent[] = [
      message(1, { speaker: { kind: "user" }, text: "在吗？" }),
      { type: "decision", seq: 2, at: AT + 2, after: 1, replies: [], source: "single" },
      message(3, { text: "[开心地] 在呀！" }),
      message(4, { text: "听我说哦", modality: "voice", attachments: [AUDIO] }),
      message(5, { text: "我在通话里说的", modality: "call" }),
      message(6, { speaker: { kind: "user" }, text: "好呀", modality: "voice" }),
      { type: "title", seq: 7, at: AT + 7, title: "闲聊" },
      message(8, { speaker: { kind: "persona", id: "hazel" }, text: "我也在" }),
    ];
    expect(saidFacts(CHAT, events)).toEqual([
      { type: "said", persona: "milky-green", chat: CHAT, seq: 3, text: "[开心地] 在呀！" },
      { type: "said", persona: "milky-green", chat: CHAT, seq: 4, text: "听我说哦" },
      { type: "said", persona: "hazel", chat: CHAT, seq: 8, text: "我也在" },
    ]);
  });

  test("a line with none of her messages tells nothing", () => {
    expect(saidFacts(CHAT, [message(1, { speaker: { kind: "user" }, text: "hi" })])).toEqual([]);
    expect(saidFacts(CHAT, [])).toEqual([]);
  });
});

describe("tellCompanion", () => {
  const said: ChatFact = { type: "said", persona: "milky-green", chat: CHAT, seq: 3, text: "嗯" };
  const voice: ChatFact = {
    type: "voice",
    persona: "milky-green",
    chat: CHAT,
    seq: 4,
    text: "听我说哦",
    file: AUDIO.name,
    state: "playing",
    position: 0,
  };

  test("hands each fact to every listener until it unsubscribes", () => {
    const first: ChatFact[] = [];
    const second: ChatFact[] = [];
    const stopFirst = onChatFact((fact) => first.push(fact));
    const stopSecond = onChatFact((fact) => second.push(fact));
    tellCompanion(said);
    stopFirst();
    tellCompanion(voice);
    stopSecond();
    tellCompanion(said);
    expect(first).toEqual([said]);
    expect(second).toEqual([said, voice]);
  });
});
