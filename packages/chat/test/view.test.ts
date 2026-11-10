import { describe, expect, test } from "bun:test";
import {
  CHAT_FORMAT,
  CHAT_WINDOW_MESSAGES,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  cancelledEnvelope,
  finalEnvelope,
  stampEvents,
  startedEnvelope,
  type ViewMessage,
  viewOf,
  viewWithBlocks,
} from "../src/index.ts";

const SOLO: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-000000000000",
  createdAt: 0,
  participants: ["milky"],
};
const GROUP: ChatHeader = { ...SOLO, participants: ["milky", "ruby", "ken"] };
const NAMES: Record<string, string> = { milky: "奶绿", ruby: "露比", ken: "Ken" };

function log(...drafts: ChatEventDraft[]): ChatEvent[] {
  return stampEvents(drafts, 0, 1000);
}

function view(
  events: readonly ChatEvent[],
  id = "milky",
  windowMessages = CHAT_WINDOW_MESSAGES,
  header = SOLO,
  viewerName?: string,
) {
  return viewOf(header, events, id, {
    windowMessages,
    nameOf: (persona) => NAMES[persona] ?? persona,
    ...(viewerName === undefined ? {} : { viewerName }),
  });
}

const groupView = (events: readonly ChatEvent[], id = "milky", viewerName = "小明") =>
  view(events, id, CHAT_WINDOW_MESSAGES, GROUP, viewerName);

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
const staged = (
  persona: string,
  callId: string,
  stage: "started" | "final" | "cancelled",
  value: Record<string, unknown> = {},
): ChatEventDraft => ({ type: "tool-result", persona, turn: "t", callId, result: value, stage });
const toolCall = (id: string, args = "{}"): ViewMessage => ({
  role: "assistant",
  tool_calls: [{ id, type: "function", function: { name: "take_selfie", arguments: args } }],
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
    const { messages, blocks } = viewWithBlocks(SOLO, events, "milky", {
      windowMessages: CHAT_WINDOW_MESSAGES,
      nameOf: (persona) => persona,
    });
    expect([...blocks]).toEqual([[messages[1] as ViewMessage, 8]]);
  });

  test("a call's arguments and result are written as pipedog's json.dumps writes them", () => {
    const events = log(
      user("自拍一张"),
      call("milky", "c1", { scene: "花店", tags: ["a", { b: null }] }),
      result("milky", "c1", { ok: true, sizes: [1, 2.5], 名字: "奶绿" }),
    );
    const [, assistant, tool] = view(events) as [ViewMessage, ViewMessage, ViewMessage];
    expect(assistant).toMatchObject({
      tool_calls: [{ function: { arguments: '{"scene": "花店", "tags": ["a", {"b": null}]}' } }],
    });
    expect(tool).toMatchObject({ content: '{"ok": true, "sizes": [1, 2.5], "名字": "奶绿"}' });
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
      toolCall("c1", '{"scene": "café"}'),
      { role: "tool", tool_call_id: "c1", content: '{"ok": true, "note": "已发送"}' },
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
      { type: "participants", removed: ["ruby"] },
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
      { role: "tool", tool_call_id: "c11", content: '{"n": 11}' },
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
      { role: "tool", tool_call_id: "c3", content: '{"n": 3}' },
      { role: "assistant", content: "a3" },
    ]);
  });

  test("a chat inside the window is whole, and a window of 0 is empty", () => {
    const events = chat(2);
    expect(view(events, "milky", 4).length).toBe(view(events, "milky", 100).length);
    expect(view(events, "milky", 0)).toEqual([]);
  });

  test("an async result whose call left the window comes as a developer message", () => {
    const events = log(
      user("u1"),
      call("milky", "c1"),
      staged("milky", "c1", "started"),
      from("milky", "a1"),
      user("u2"),
      from("milky", "a2"),
      staged("milky", "c1", "final", { ok: true }),
    );
    expect(view(events, "milky", 2)).toEqual([
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "developer", content: finalEnvelope("c1", '{"ok": true}') },
    ]);
  });
});

describe("viewOf, async calls", () => {
  const placeholder = (id: string): ViewMessage => ({
    role: "tool",
    tool_call_id: id,
    content: startedEnvelope(id),
  });

  test("a call still running holds pipedog's started placeholder", () => {
    const events = log(
      user("拍一张"),
      call("milky", "c1", { scene: "café" }),
      staged("milky", "c1", "started"),
      from("milky", "好呀，等我一下"),
    );
    expect(view(events)).toEqual([
      { role: "user", content: "拍一张" },
      toolCall("c1", '{"scene": "café"}'),
      placeholder("c1"),
      { role: "assistant", content: "好呀，等我一下" },
    ]);
  });

  test("a result before the conversation moved on settles in place, as a sync call's would", () => {
    const events = log(
      user("拍一张"),
      call("milky", "c1"),
      staged("milky", "c1", "started"),
      from("milky", "好呀"),
      staged("milky", "c1", "final", { ok: true, count: 1 }),
      call("milky", "c2"),
      staged("milky", "c2", "started"),
      staged("milky", "c2", "final"),
    );
    expect(view(events)).toEqual([
      { role: "user", content: "拍一张" },
      toolCall("c1"),
      { role: "tool", tool_call_id: "c1", content: '{"ok": true, "count": 1}' },
      { role: "assistant", content: "好呀" },
      toolCall("c2"),
      { role: "tool", tool_call_id: "c2", content: "COMPLETED" },
    ]);
  });

  test("a result after a user line or a recall block comes as a developer message", () => {
    const afterLine = log(
      user("拍一张"),
      call("milky", "c1"),
      staged("milky", "c1", "started"),
      from("milky", "好呀"),
      user("顺便唱首歌"),
      staged("milky", "c1", "final", { ok: true }),
    );
    expect(view(afterLine).slice(2)).toEqual([
      placeholder("c1"),
      { role: "assistant", content: "好呀" },
      { role: "user", content: "顺便唱首歌" },
      { role: "developer", content: finalEnvelope("c1", '{"ok": true}') },
    ]);
    const afterRecall = log(
      user("拍一张"),
      call("milky", "c1"),
      staged("milky", "c1", "started"),
      context("milky", 99, "memories", "developer"),
      staged("milky", "c1", "final"),
    );
    expect(view(afterRecall).slice(2)).toEqual([
      placeholder("c1"),
      { role: "developer", content: "memories" },
      { role: "developer", content: finalEnvelope("c1", "COMPLETED") },
    ]);
  });

  test("a cancelled call always settles with a developer message", () => {
    const events = log(
      user("拍一张"),
      call("milky", "c1"),
      staged("milky", "c1", "started"),
      staged("milky", "c1", "cancelled"),
    );
    expect(view(events).slice(2)).toEqual([
      placeholder("c1"),
      { role: "developer", content: cancelledEnvelope("c1") },
    ]);
  });

  test("another call's async messages don't move the conversation on", () => {
    const events = log(
      user("拍两张"),
      call("milky", "c1"),
      call("milky", "c2"),
      staged("milky", "c1", "started"),
      staged("milky", "c2", "started"),
      staged("milky", "c2", "cancelled"),
      staged("milky", "c1", "final", { ok: true }),
    );
    expect(view(events)).toEqual([
      { role: "user", content: "拍两张" },
      toolCall("c1"),
      { role: "tool", tool_call_id: "c1", content: '{"ok": true}' },
      toolCall("c2"),
      placeholder("c2"),
      { role: "developer", content: cancelledEnvelope("c2") },
    ]);
  });

  test("another persona's async calls are left out", () => {
    const events = log(
      user("拍一张"),
      call("ruby", "c1"),
      staged("ruby", "c1", "started"),
      staged("ruby", "c1", "final", { ok: true }),
      staged("ruby", "c1", "cancelled"),
    );
    expect(groupView(events)).toEqual([{ role: "user", content: "小明：拍一张" }]);
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
    expect(groupView(events, "milky")).toEqual([
      { role: "user", content: "小明：大家好" },
      { role: "user", content: "露比：你好呀\nKen：晚上好" },
      { role: "user", content: "小明：今天玩什么" },
      { role: "assistant", content: "玩恐怖游戏！" },
      { role: "user", content: "露比：不要啊" },
      { role: "system", content: "milky recall" },
      { role: "user", content: "露比：那我先走了" },
    ]);
  });

  test("each persona sees her own lines, context, kickoff and tools, and no one else's", () => {
    expect(groupView(events, "ruby")).toEqual([
      { role: "user", content: "小明：大家好" },
      { role: "system", content: "ruby recall" },
      { role: "assistant", content: "你好呀" },
      { role: "user", content: "Ken：晚上好" },
      { role: "user", content: "小明：今天玩什么" },
      { role: "user", content: "奶绿：玩恐怖游戏！" },
      { role: "assistant", content: "不要啊" },
      { role: "user", content: "ruby kickoff" },
      {
        role: "assistant",
        tool_calls: [
          { id: "r1", type: "function", function: { name: "take_selfie", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "r1", content: '{"ok": true}' },
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
    expect(groupView(folded)).toEqual([
      { role: "user", content: "露比：one" },
      { role: "system", content: "recall" },
      { role: "user", content: "露比：two\nKen：three" },
    ]);
  });

  test("the viewer's lines are 观众 without a name, and stay their own message", () => {
    const lines = log(user("大家好"), from("ruby", "你好呀"), user("在吗"));
    expect(groupView(lines, "milky", "")).toEqual([
      { role: "user", content: "观众：大家好" },
      { role: "user", content: "露比：你好呀" },
      { role: "user", content: "观众：在吗" },
    ]);
    expect(view(lines, "milky", CHAT_WINDOW_MESSAGES, GROUP)[0]).toEqual({
      role: "user",
      content: "观众：大家好",
    });
  });
});

describe("viewOf, labelling the viewer", () => {
  const chat = (...more: ChatEventDraft[]) =>
    log(user("你好"), from("milky", "嘿嘿"), ...more, user("再见"));

  test("a one-persona chat is unlabelled, whatever the viewer's name", () => {
    const solo: ViewMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "嘿嘿" },
      { role: "user", content: "再见" },
    ];
    expect(view(chat())).toEqual(solo);
    expect(view(chat(), "milky", CHAT_WINDOW_MESSAGES, SOLO, "小明")).toEqual(solo);
    expect(JSON.stringify(view(chat(), "milky", CHAT_WINDOW_MESSAGES, SOLO, "小明"))).toBe(
      '[{"role":"user","content":"你好"},{"role":"assistant","content":"嘿嘿"},' +
        '{"role":"user","content":"再见"}]',
    );
  });

  test("the participants as the log stands decide it, every line alike", () => {
    const added = chat({ type: "participants", added: ["ruby"] });
    expect(view(added, "milky", CHAT_WINDOW_MESSAGES, SOLO, "小明")).toEqual([
      { role: "user", content: "小明：你好" },
      { role: "assistant", content: "嘿嘿" },
      { role: "user", content: "小明：再见" },
    ]);
    const left = chat({ type: "participants", removed: ["ruby", "ken"] });
    expect(view(left, "milky", CHAT_WINDOW_MESSAGES, GROUP, "小明")).toEqual(view(chat()));
  });
});
