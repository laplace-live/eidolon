import { afterEach, describe, expect, test } from "bun:test";
import {
  CHAT_FORMAT,
  type ChatEventDraft,
  type ChatHeader,
  stampEvents,
  viewOf,
  viewWithBlocks,
} from "@eidolon/chat";
import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import { TurnConversation } from "../src/context.ts";

const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-000000000000",
  createdAt: 0,
  participants: ["milky"],
};

const user = (text: string): ChatEventDraft => ({
  type: "message",
  id: `u-${text}`,
  speaker: { kind: "user" },
  text,
});
const milky = (text: string): ChatEventDraft => ({
  type: "message",
  id: `m-${text}`,
  speaker: { kind: "persona", id: "milky" },
  text,
});

function view(drafts: readonly ChatEventDraft[]) {
  return viewOf(HEADER, stampEvents(drafts, 0, 1000), "milky", {
    windowMessages: 60,
    nameOf: (id) => id,
  });
}

const logs: LogRecord[] = [];
afterEach(() => {
  logs.length = 0;
  logger.setSink(consoleSink);
});

describe("TurnConversation", () => {
  test("records each inserted message at the position it went in", () => {
    const log = [user("早"), milky("早呀"), user("昨天播了什么")];
    const conversation = new TurnConversation(view(log), { persona: "milky", turn: "t1" });
    const messages = conversation.getMessages();
    messages.splice(1, 0, { role: "developer", content: "记得：喜欢猫" });
    conversation.setMessages(messages);
    const more = conversation.getMessages();
    more.splice(2, 0, { role: "system", content: "直播片段 A" });
    more.splice(4, 0, { role: "system", content: "设定 B" });
    conversation.setMessages(more);

    const recorded = conversation.takeRecorded();
    expect(recorded).toEqual([
      {
        type: "context",
        persona: "milky",
        turn: "t1",
        position: 1,
        role: "developer",
        content: "记得：喜欢猫",
      },
      {
        type: "context",
        persona: "milky",
        turn: "t1",
        position: 2,
        role: "system",
        content: "直播片段 A",
      },
      {
        type: "context",
        persona: "milky",
        turn: "t1",
        position: 4,
        role: "system",
        content: "设定 B",
      },
    ]);
    // What the log keeps rebuilds the list the providers left.
    expect(view([...log, ...recorded])).toEqual(conversation.getMessages() as never);
  });

  test("records a block from the log it replaces as removed, then the new one", () => {
    const log: ChatEventDraft[] = [
      user("嗨"),
      {
        type: "context",
        persona: "milky",
        turn: "t0",
        position: 1,
        role: "system",
        content: "概览：旧",
      },
      milky("嗨呀"),
      user("昨天播了什么"),
    ];
    const { messages, blocks } = viewWithBlocks(HEADER, stampEvents(log, 0, 1000), "milky", {
      windowMessages: 60,
      nameOf: (id) => id,
    });
    const conversation = new TurnConversation(messages, { persona: "milky", turn: "t1", blocks });
    // As setBlock replaces a prefix's block: the old one out, the new one in at its position.
    const kept = conversation
      .getMessages()
      .filter((message) => (message as { content?: unknown }).content !== "概览：旧");
    kept.splice(1, 0, { role: "system", content: "概览：新" });
    conversation.setMessages(kept);
    const recorded = conversation.takeRecorded();
    expect(recorded).toEqual([
      { type: "context-removed", persona: "milky", turn: "t1", seqs: [2] },
      {
        type: "context",
        persona: "milky",
        turn: "t1",
        position: 1,
        role: "system",
        content: "概览：新",
      },
    ]);
    expect(conversation.getMessages()).toEqual([
      { role: "user", content: "嗨" },
      { role: "system", content: "概览：新" },
      { role: "assistant", content: "嗨呀" },
      { role: "user", content: "昨天播了什么" },
    ]);
    expect(view([...log, ...recorded])).toEqual(conversation.getMessages() as never);
  });

  describe("a block put back unchanged", () => {
    const block = (position: number, content: string, turn = "t0"): ChatEventDraft => ({
      type: "context",
      persona: "milky",
      turn,
      position,
      role: "system",
      content,
    });
    // As the stream archive's setBlock: every block with the prefix out, the new one in.
    const setBlock = (conversation: TurnConversation, prefix: string, content: string) => {
      const kept = conversation
        .getMessages()
        .filter(
          (message) => !String((message as { content?: unknown }).content).startsWith(prefix),
        );
      kept.splice(1, 0, { role: "system", content });
      conversation.setMessages(kept);
    };
    const open = (log: readonly ChatEventDraft[]) => {
      const { messages, blocks } = viewWithBlocks(HEADER, stampEvents(log, 0, 1000), "milky", {
        windowMessages: 60,
        nameOf: (id) => id,
      });
      return new TurnConversation(messages, { persona: "milky", turn: "t1", blocks });
    };

    test("stays the log's block, so only what changed is recorded", () => {
      const log = [
        user("嗨"),
        block(1, "概览：A"),
        block(1, "回忆：旧"),
        milky("嗨呀"),
        user("昨天播了什么"),
      ];
      const conversation = open(log);
      setBlock(conversation, "概览：", "概览：A");
      setBlock(conversation, "回忆：", "回忆：新");
      const recorded = conversation.takeRecorded();
      expect(recorded).toEqual([
        { type: "context-removed", persona: "milky", turn: "t1", seqs: [3] },
        block(1, "回忆：新", "t1"),
      ]);
      expect(view([...log, ...recorded])).toEqual(conversation.getMessages() as never);
    });

    test("is recorded again when it moved among the log's lines", () => {
      const log = [user("嗨"), block(1, "概览：A"), milky("嗨呀"), user("昨天播了什么")];
      const conversation = open(log);
      const kept = conversation
        .getMessages()
        .filter((message) => (message as { content?: unknown }).content !== "概览：A");
      kept.splice(2, 0, { role: "system", content: "概览：A" });
      conversation.setMessages(kept);
      const recorded = conversation.takeRecorded();
      expect(recorded).toEqual([
        { type: "context-removed", persona: "milky", turn: "t1", seqs: [2] },
        block(2, "概览：A", "t1"),
      ]);
      expect(view([...log, ...recorded])).toEqual(conversation.getMessages() as never);
    });
  });

  test("hands out copies, so only setMessages changes the list", () => {
    const conversation = new TurnConversation([{ role: "user", content: "嗨" }], {
      persona: "milky",
      turn: "t1",
    });
    conversation.getMessages().push({ role: "system", content: "x" });
    expect(conversation.getMessages()).toEqual([{ role: "user", content: "嗨" }]);
    expect(conversation.takeRecorded()).toEqual([]);
  });

  test("leaves what the turn appends to its own events, and drains what it took", () => {
    const conversation = new TurnConversation([], { persona: "milky", turn: "t1" });
    conversation.append({ role: "user", content: "打个招呼" });
    expect(conversation.takeRecorded()).toEqual([]);
    conversation.setMessages([...conversation.getMessages(), { role: "system", content: "x" }]);
    expect(conversation.takeRecorded()).toHaveLength(1);
    expect(conversation.takeRecorded()).toEqual([]);
  });

  test("skips, with a warning, an inserted message the log can't hold", () => {
    logger.setSink((record) => logs.push(record));
    const conversation = new TurnConversation([], { persona: "milky", turn: "t1" });
    conversation.setMessages([
      { role: "assistant", content: "x" },
      { role: "system", content: [{ type: "text", text: "x" }] },
    ]);
    expect(conversation.takeRecorded()).toEqual([]);
    expect(conversation.getMessages()).toHaveLength(2);
    expect(logs.filter((record) => record.level === "WARNING")).toHaveLength(2);
  });

  test("keeps the tools a provider hides", () => {
    const conversation = new TurnConversation([], { persona: "milky", turn: "t1" });
    expect(conversation.hiddenTools).toEqual([]);
    conversation.setHiddenTools(["recall_streams"]);
    expect(conversation.hiddenTools).toEqual(["recall_streams"]);
    conversation.setHiddenTools([]);
    expect(conversation.hiddenTools).toEqual([]);
  });
});
