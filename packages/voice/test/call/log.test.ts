import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ChatEvent, ChatEventDraft } from "@eidolon/chat";
import { consoleSink, logger } from "@eidolon/config";
import { callLog, memoryCallLog } from "../../src/call/log.ts";
import { HEADER } from "./harness.ts";

let logs: string[];
beforeEach(() => {
  logs = [];
  logger.setSink((record) => logs.push(record.message));
  setSystemTime(new Date(5_000));
});
afterEach(() => {
  logger.setSink(consoleSink);
  setSystemTime();
});

const line = (text: string): ChatEventDraft => ({
  type: "message",
  id: `m-${text}`,
  speaker: { kind: "user" },
  text,
  modality: "call",
});

describe("memoryCallLog", () => {
  test("numbers and times a batch as it is appended, and the next snapshot has it", () => {
    const log = memoryCallLog(HEADER);
    expect(log.append([line("一"), line("二")])).toMatchObject([
      { seq: 1, at: 5_000, text: "一" },
      { seq: 2, at: 5_000, text: "二" },
    ]);
    expect(log.append([line("三")])).toMatchObject([{ seq: 3 }]);
    expect(log.append([])).toEqual([]);
    const { header, events } = log.snapshot();
    expect(header).toBe(HEADER);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("a snapshot is a copy the log doesn't change", () => {
    const log = memoryCallLog(HEADER);
    log.append([line("一")]);
    const before = log.snapshot();
    log.append([line("二")]);
    expect(before.events).toHaveLength(1);
  });
});

describe("callLog", () => {
  test("writes each batch once the one before it is written, in order", async () => {
    const written: number[][] = [];
    const log = callLog({ header: HEADER, events: [] }, async (events) => {
      await Bun.sleep(events[0]?.seq === 1 ? 5 : 0);
      written.push(events.map((e) => e.seq));
    });
    log.append([line("一")]);
    log.append([line("二"), line("三")]);
    await log.flush();
    expect(written).toEqual([[1], [2, 3]]);
  });

  test("goes on from the chat it was given", () => {
    const earlier = { ...line("早"), seq: 4, at: 1 } as ChatEvent;
    const log = callLog({ header: HEADER, events: [earlier] }, async () => {});
    expect(log.append([line("一")])).toMatchObject([{ seq: 5 }]);
    expect(log.snapshot().events).toHaveLength(2);
  });

  test("a batch that fails to write is logged, and the call keeps it", async () => {
    const written: number[] = [];
    const log = callLog({ header: HEADER, events: [] }, async (events) => {
      if (events[0]?.seq === 1) throw new Error("disk full");
      written.push(...events.map((e) => e.seq));
    });
    log.append([line("一")]);
    log.append([line("二")]);
    await log.flush();
    expect(written).toEqual([2]);
    expect(log.snapshot().events).toHaveLength(2);
    expect(logs).toEqual([`[voice] Call ${HEADER.id}'s log lost events: disk full`]);
  });
});
