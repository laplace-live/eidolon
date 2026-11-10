import { describe, expect, test } from "bun:test";
import {
  CHAT_FORMAT,
  CHAT_WINDOW_MESSAGES,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  stampEvents,
  type ViewMessage,
  viewOf,
  viewWithBlocks,
} from "../src/index.ts";

const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-000000000000",
  createdAt: 0,
  participants: ["milky", "ruby"],
};
const NAMES: Record<string, string> = { milky: "奶绿", ruby: "露比", ken: "Ken" };

function log(...drafts: ChatEventDraft[]): ChatEvent[] {
  return stampEvents(drafts, 0, 1000);
}

function view(events: readonly ChatEvent[], id = "milky", windowMessages = CHAT_WINDOW_MESSAGES) {
  return viewOf(HEADER, events, id, {
    windowMessages,
    nameOf: (persona) => NAMES[persona] ?? persona,
  });
}

const user = (text: string): ChatEventDraft => ({
  type: "message",
  id: `u-${text}`,
  speaker: { kind: "user" },
  text,
});
const from = (persona: string, text: string, extra: object = {}): ChatEventDraft => ({
  type: "message",
  id: `${persona}-${text}`,
  speaker: { kind: "persona", id: persona },
  text,
  ...extra,
});
const context = (
  persona: string,
  position: number,
  content: string,
  role: "system" | "user" | "developer" = "system",
): ChatEventDraft => ({ type: "context", persona, turn: "t", position, role, content });
const call = (
  persona: string,
  callId: string,
  args: Record<string, unknown> = {},
): ChatEventDraft => ({
  type: "tool-call",
  persona,
  turn: "t",
  callId,
  name: "take_selfie",
  arguments: args,
});
const result = (
  persona: string,
  callId: string,
  value: Record<string, unknown>,
): ChatEventDraft => ({
  type: "tool-result",
  persona,
  turn: "t",
  callId,
  result: value,
});

describe("viewOf, one persona", () => {
  test("her kickoff, her lines and the viewer's alternate as a call's would", () => {
    const events = log(
      { type: "kickoff", persona: "milky", turn: "t0", content: "打个招呼" },
      from("milky", "晚上好呀"),
      user("你好"),
      from("milky", "嘿嘿"),
    );
    expect(view(events)).toEqual([
      { role: "user", content: "打个招呼" },
      { role: "assistant", content: "晚上好呀" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "嘿嘿" },
    ]);
  });

  test("context blocks splice in at their positions in seq order, so they accumulate", () => {
    const events = log(
      { type: "kickoff", persona: "milky", turn: "t0", content: "kickoff" },
      from("milky", "hi"),
      user("one"),
      context("milky", 1, "memories 1", "developer"),
      context("milky", 99, "facts 1"),
      from("milky", "reply 1"),
      user("two"),
      context("milky", 1, "memories 2", "developer"),
      from("milky", "reply 2"),
    );
    expect(view(events)).toEqual([
      { role: "user", content: "kickoff" },
      { role: "developer", content: "memories 2" },
      { role: "developer", content: "memories 1" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "one" },
      { role: "system", content: "facts 1" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "two" },
      { role: "assistant", content: "reply 2" },
    ]);
  });

  test("context-removed takes her named blocks out, wherever they moved to", () => {
    const events = log(
      user("one"),
      context("milky", 1, "recent 1"),
      context("ruby", 1, "ruby's"),
      from("milky", "reply 1"),
      user("two"),
      { type: "context-removed", persona: "ruby", turn: "t2", seqs: [2] },
      { type: "context-removed", persona: "milky", turn: "t2", seqs: [2, 3, 404] },
      context("milky", 1, "recent 2"),
      from("milky", "reply 2"),
    );
    expect(view(events)).toEqual([
      { role: "user", content: "one" },
      { role: "system", content: "recent 2" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "two" },
      { role: "assistant", content: "reply 2" },
    ]);
    const { messages, blocks } = viewWithBlocks(HEADER, events, "milky", {
      windowMessages: CHAT_WINDOW_MESSAGES,
      nameOf: (persona) => persona,
    });
    expect([...blocks]).toEqual([[messages[1] as ViewMessage, 8]]);
  });

  test("her tool calls become tool_calls, each followed by its result", () => {
    const events = log(
      user("自拍一张"),
      call("milky", "c1", { scene: "café" }),
      call("milky", "c2"),
      call("milky", "c3"),
      result("milky", "c1", { ok: true, note: "已发送" }),
      result("milky", "c2", {}),
      from("milky", "给你看", {
        attachments: [{ kind: "image", name: `${"a".repeat(64)}.png`, mime: "image/png" }],
      }),
    );
    const toolCall = (id: string, args: string): ViewMessage => ({
      role: "assistant",
      tool_calls: [{ id, type: "function", function: { name: "take_selfie", arguments: args } }],
    });
    expect(view(events)).toEqual([
      { role: "user", content: "自拍一张" },
      toolCall("c1", '{"scene":"café"}'),
      { role: "tool", tool_call_id: "c1", content: '{"ok":true,"note":"已发送"}' },
      toolCall("c2", "{}"),
      { role: "tool", tool_call_id: "c2", content: "COMPLETED" },
      toolCall("c3", "{}"),
      { role: "tool", tool_call_id: "c3", content: "CANCELLED" },
      { role: "assistant", content: "给你看" },
    ]);
  });

  test("an interrupted line keeps what she said; an empty one is left out", () => {
    const events = log(
      user("讲个故事"),
      from("milky", "从前有", { interrupted: true }),
      user("等等"),
      from("milky", "", {
        attachments: [{ kind: "image", name: `${"b".repeat(64)}.png`, mime: "image/png" }],
      }),
    );
    expect(view(events)).toEqual([
      { role: "user", content: "讲个故事" },
      { role: "assistant", content: "从前有" },
      { role: "user", content: "等等" },
    ]);
  });

  test("bookkeeping events add nothing", () => {
    const events = log(
      user("hi"),
      {
        type: "decision",
        after: 1,
        replies: [{ persona: "milky", mode: "text" }],
        source: "single",
      },
      { type: "turn-failed", persona: "milky", turn: "t1", error: "timeout" },
      { type: "title", title: "Tea" },
      { type: "participants", added: ["ruby"] },
      { type: "settings", replyMode: "text", chainLimit: 2 },
      { type: "call-started", call: "c", persona: "milky" },
      { type: "call-ended", call: "c", reason: "hangup" },
    );
    expect(view(events)).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("viewOf's window", () => {
  /** `turns` exchanges, each a user line, a context block and her reply with a tool call. */
  function chat(turns: number): ChatEvent[] {
    const drafts: ChatEventDraft[] = [];
    for (let n = 1; n <= turns; n++) {
      drafts.push(
        user(`u${n}`),
        context("milky", 99, `ctx${n}`),
        call("milky", `c${n}`),
        result("milky", `c${n}`, { n }),
        from("milky", `a${n}`),
      );
    }
    return log(...drafts);
  }

  test("keeps the last windowMessages lines and the context and tools after them", () => {
    const messages = view(chat(40));
    const lines = messages.filter(
      (m) => "content" in m && (m.role === "user" || m.role === "assistant"),
    );
    expect(lines.length).toBe(CHAT_WINDOW_MESSAGES);
    expect(messages[0]).toEqual({ role: "user", content: "u11" });
    expect(messages.slice(1, 5)).toEqual([
      { role: "system", content: "ctx11" },
      {
        role: "assistant",
        tool_calls: [
          { id: "c11", type: "function", function: { name: "take_selfie", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c11", content: '{"n":11}' },
      { role: "assistant", content: "a11" },
    ]);
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "a40" });
    expect(messages.some((m) => "content" in m && m.content === "ctx10")).toBe(false);
  });

  test("opens on a user line, not on one of hers", () => {
    const messages = view(chat(3), "milky", 3);
    expect(messages).toEqual([
      { role: "user", content: "u3" },
      { role: "system", content: "ctx3" },
      {
        role: "assistant",
        tool_calls: [
          { id: "c3", type: "function", function: { name: "take_selfie", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c3", content: '{"n":3}' },
      { role: "assistant", content: "a3" },
    ]);
  });

  test("a chat inside the window is whole, and a window of 0 is empty", () => {
    const events = chat(2);
    expect(view(events, "milky", 4).length).toBe(view(events, "milky", 100).length);
    expect(view(events, "milky", 0)).toEqual([]);
  });
});

describe("viewOf, a group", () => {
  const events = log(
    user("大家好"),
    from("ruby", "你好呀"),
    from("ken", "晚上好"),
    user("今天玩什么"),
    from("milky", "玩恐怖游戏！"),
    from("ruby", "不要啊"),
    context("milky", 99, "milky recall"),
    context("ruby", 1, "ruby recall"),
    { type: "kickoff", persona: "ruby", turn: "k", content: "ruby kickoff" },
    call("ruby", "r1"),
    result("ruby", "r1", { ok: true }),
    from("ruby", "那我先走了"),
  );

  test("others' runs fold into one user message of 名字：lines; hers stay assistant", () => {
    expect(view(events, "milky")).toEqual([
      { role: "user", content: "大家好" },
      { role: "user", content: "露比：你好呀\nKen：晚上好" },
      { role: "user", content: "今天玩什么" },
      { role: "assistant", content: "玩恐怖游戏！" },
      { role: "user", content: "露比：不要啊" },
      { role: "system", content: "milky recall" },
      { role: "user", content: "露比：那我先走了" },
    ]);
  });

  test("each persona sees her own lines, context, kickoff and tools, and no one else's", () => {
    expect(view(events, "ruby")).toEqual([
      { role: "user", content: "大家好" },
      { role: "system", content: "ruby recall" },
      { role: "assistant", content: "你好呀" },
      { role: "user", content: "Ken：晚上好" },
      { role: "user", content: "今天玩什么" },
      { role: "user", content: "奶绿：玩恐怖游戏！" },
      { role: "assistant", content: "不要啊" },
      { role: "user", content: "ruby kickoff" },
      {
        role: "assistant",
        tool_calls: [
          { id: "r1", type: "function", function: { name: "take_selfie", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "r1", content: '{"ok":true}' },
      { role: "assistant", content: "那我先走了" },
    ]);
  });

  test("a block spliced in after a run starts the next run afresh", () => {
    const folded = log(
      from("ruby", "one"),
      context("milky", 99, "recall"),
      from("ruby", "two"),
      from("ken", "three"),
    );
    expect(view(folded)).toEqual([
      { role: "user", content: "露比：one" },
      { role: "system", content: "recall" },
      { role: "user", content: "露比：two\nKen：three" },
    ]);
  });
});
