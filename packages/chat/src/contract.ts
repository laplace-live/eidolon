// What every ChatStore promises, as a suite for any test runner with describe, test and expect:
// bun:test runs it on the JSONL store, and a browser store runs it under its own runner.
import { CHAT_FORMAT, type ChatEvent, type ChatHeader, type ChatStore } from "./format.ts";

export interface ContractRunner {
  describe(name: string, body: () => void): void;
  test(name: string, body: () => Promise<void>): void;
  expect(actual: unknown): { toBe(expected: unknown): void; toEqual(expected: unknown): void };
}

export interface ContractHooks<S extends ChatStore> {
  /** Leaves half an event after chat `id`'s last one, as a crash in the middle of an append would. */
  tearLastLine?(id: string, store: S): Promise<void>;
}

function header(createdAt: number, participants: readonly string[] = ["alice"]): ChatHeader {
  return { format: CHAT_FORMAT, id: crypto.randomUUID(), createdAt, participants };
}

function said(seq: number, at: number, text: string): ChatEvent {
  return { seq, at, type: "message", id: `m${seq}`, speaker: { kind: "user" }, text };
}

/** The code a store rejected with, "resolved" when it didn't. */
async function outcome(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return "resolved";
  } catch (e) {
    return (e as { code?: unknown } | null)?.code ?? e;
  }
}

/** Registers the suite; `makeStore` gives each test an empty store of its own. */
export function runChatStoreContract<S extends ChatStore>(
  runner: ContractRunner,
  makeStore: () => S | Promise<S>,
  hooks: ContractHooks<S> = {},
): void {
  const { describe, test, expect } = runner;

  describe("the ChatStore contract", () => {
    test("a new chat reads back its header and no events", async () => {
      const store = await makeStore();
      const chat = header(1000);
      await store.create(chat);
      expect(await store.read(chat.id)).toEqual({ header: chat, events: [] });
    });

    test("create rejects a taken id", async () => {
      const store = await makeStore();
      const chat = header(1000);
      await store.create(chat);
      expect(await outcome(store.create(chat))).toBe("exists");
    });

    test("an unknown chat is not found", async () => {
      const store = await makeStore();
      const id = crypto.randomUUID();
      expect(await outcome(store.read(id))).toBe("not-found");
      expect(await outcome(store.append(id, [said(1, 1000, "hi")]))).toBe("not-found");
      expect(await outcome(store.remove(id))).toBe("not-found");
    });

    test("appends continue seq from 1 across batches, every kind of event intact", async () => {
      const store = await makeStore();
      const chat = header(1000);
      await store.create(chat);
      const first: ChatEvent[] = [
        said(1, 1001, "第一行\n第二行"),
        {
          seq: 2,
          at: 1002,
          type: "decision",
          after: 1,
          replies: [{ persona: "alice", mode: "text" }],
          source: "single",
          scores: { addressed_alice: 0.9 },
        },
        {
          seq: 3,
          at: 1003,
          type: "context",
          persona: "alice",
          turn: "t1",
          position: 1,
          role: "developer",
          content: "recall",
        },
      ];
      const second: ChatEvent[] = [
        {
          seq: 4,
          at: 1004,
          type: "tool-call",
          persona: "alice",
          turn: "t1",
          callId: "c1",
          name: "take_selfie",
          arguments: { scene: "café", nested: { list: [1, "two"] } },
        },
        {
          seq: 5,
          at: 1005,
          type: "tool-result",
          persona: "alice",
          turn: "t1",
          callId: "c1",
          result: { ok: true },
        },
        {
          seq: 6,
          at: 1006,
          type: "message",
          id: "m6",
          speaker: { kind: "persona", id: "alice" },
          text: "看！",
          attachments: [{ kind: "image", name: `${"a".repeat(64)}.png`, mime: "image/png" }],
          interrupted: true,
        },
      ];
      await store.append(chat.id, first);
      await store.append(chat.id, second);
      expect(await store.read(chat.id)).toEqual({ header: chat, events: [...first, ...second] });
    });

    test("a batch that doesn't continue the log is rejected and writes nothing", async () => {
      const store = await makeStore();
      const chat = header(1000);
      await store.create(chat);
      expect(await outcome(store.append(chat.id, [said(2, 1001, "skips 1")]))).toBe("seq-gap");
      const kept = [said(1, 1001, "one"), said(2, 1002, "two")];
      await store.append(chat.id, kept);
      for (const batch of [
        [said(4, 1003, "skips 3")],
        [said(2, 1003, "repeats 2")],
        [said(0, 1003, "starts over")],
        [said(3, 1003, "three"), said(5, 1004, "skips 4")],
        [said(3, 1003, "three"), said(3, 1004, "three again")],
      ]) {
        expect(await outcome(store.append(chat.id, batch))).toBe("seq-gap");
      }
      expect((await store.read(chat.id)).events).toEqual(kept);
      await store.append(chat.id, [said(3, 1005, "three")]);
      expect((await store.read(chat.id)).events.map((event) => event.seq)).toEqual([1, 2, 3]);
    });

    test("an empty batch changes nothing", async () => {
      const store = await makeStore();
      const chat = header(1000);
      await store.create(chat);
      await store.append(chat.id, []);
      expect((await store.read(chat.id)).events).toEqual([]);
      expect((await store.list())[0]?.lastSeq).toBe(0);
    });

    test("appends made without waiting land in call order", async () => {
      const store = await makeStore();
      const chat = header(1000);
      await store.create(chat);
      await Promise.all([1, 2, 3].map((seq) => store.append(chat.id, [said(seq, 1000 + seq, "")])));
      expect((await store.read(chat.id)).events.map((event) => event.seq)).toEqual([1, 2, 3]);
    });

    test("afterSeq reads only the events after it", async () => {
      const store = await makeStore();
      const chat = header(1000);
      await store.create(chat);
      const events = [1, 2, 3, 4].map((seq) => said(seq, 1000 + seq, `line ${seq}`));
      await store.append(chat.id, events);
      expect((await store.read(chat.id, { afterSeq: 2 })).events).toEqual(events.slice(2));
      expect((await store.read(chat.id, { afterSeq: 0 })).events).toEqual(events);
      expect((await store.read(chat.id, { afterSeq: 4 })).events).toEqual([]);
      expect((await store.read(chat.id, { afterSeq: 2 })).header).toEqual(chat);
    });

    test("list puts the latest activity first, each chat summarized", async () => {
      const store = await makeStore();
      expect(await store.list()).toEqual([]);
      const older = header(1000, ["alice"]);
      const newer = header(2000, ["bob"]);
      await store.create(older);
      await store.create(newer);
      expect((await store.list()).map((summary) => summary.id)).toEqual([newer.id, older.id]);
      await store.append(older.id, [
        said(1, 3000, "hello"),
        {
          seq: 2,
          at: 3001,
          type: "message",
          id: "m2",
          speaker: { kind: "persona", id: "alice" },
          text: "hi there",
        },
        { seq: 3, at: 3002, type: "title", title: "Tea" },
        { seq: 4, at: 3003, type: "participants", added: ["carol"], removed: ["alice"] },
      ]);
      expect(await store.list()).toEqual([
        {
          id: older.id,
          title: "Tea",
          participants: ["carol"],
          createdAt: 1000,
          updatedAt: 3003,
          lastText: "hi there",
          lastSeq: 4,
        },
        {
          id: newer.id,
          title: null,
          participants: ["bob"],
          createdAt: 2000,
          updatedAt: 2000,
          lastText: null,
          lastSeq: 0,
        },
      ]);
    });

    test("remove forgets the chat and only it", async () => {
      const store = await makeStore();
      const gone = header(1000);
      const kept = header(2000);
      await store.create(gone);
      await store.create(kept);
      await store.append(gone.id, [said(1, 1001, "bye")]);
      await store.remove(gone.id);
      expect((await store.list()).map((summary) => summary.id)).toEqual([kept.id]);
      expect(await outcome(store.read(gone.id))).toBe("not-found");
      expect((await store.read(kept.id)).header).toEqual(kept);
    });

    const { tearLastLine } = hooks;
    if (tearLastLine !== undefined) {
      test("a torn last event is dropped on read, and the next append replaces it", async () => {
        const store = await makeStore();
        const chat = header(1000);
        await store.create(chat);
        const events = [said(1, 1001, "one"), said(2, 1002, "two")];
        await store.append(chat.id, events);
        await tearLastLine(chat.id, store);
        expect((await store.read(chat.id)).events).toEqual(events);
        expect((await store.list())[0]?.lastSeq).toBe(2);
        await store.append(chat.id, [said(3, 1003, "three")]);
        expect((await store.read(chat.id)).events).toEqual([...events, said(3, 1003, "three")]);
        expect((await store.list())[0]?.lastSeq).toBe(3);
      });
    }
  });
}
