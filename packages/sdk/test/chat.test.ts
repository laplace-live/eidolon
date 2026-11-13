import { beforeAll, describe, expect, test } from "bun:test";
import {
  advanceSummary,
  attachmentExtension,
  attachmentKind,
  attachmentMimeOf,
  type BrowserChatRecord,
  type BrowserChatStore,
  buildWindow,
  CHAT_WINDOW_EVENTS,
  ChatBusyError,
  type ChatHeader,
  ChatRequestError,
  ChatStoreError,
  type ChatStreamLine,
  chatLineEventOf,
  chatLocksAvailable,
  chatTextOf,
  chatViewReducer,
  closeDanglingCall,
  createChat,
  createChatAvailability,
  downloadMissingFiles,
  EMPTY_CHAT_VIEW,
  eventItems,
  fetchChatFile,
  herAttachments,
  holdChatLock,
  isAttachmentName,
  isChatEvent,
  isChatHeader,
  isChatId,
  joinSegments,
  liveItems,
  NEVER_SENT,
  newChatHeader,
  normalizeBaseUrl,
  type OwnEventDraft,
  parseStreamLine,
  probeChatEndpoint,
  recorderMimeType,
  sendChatTurn,
  separator,
  stampEvents,
  startChatCall,
  streamTurn,
  summarize,
  uuidv7,
  type WireEvent,
  withChatLock,
} from "../src/index.ts";

class FakeLockManager {
  readonly #held = new Set<string>();
  readonly #waiters = new Map<string, (() => void)[]>();

  async request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T> {
    if (this.#held.has(name)) {
      if (options.ifAvailable) return await callback(null);
      await new Promise<void>((resolve) => {
        const list = this.#waiters.get(name) ?? [];
        list.push(resolve);
        this.#waiters.set(name, list);
      });
    }
    this.#held.add(name);
    try {
      return await callback({ name, mode: "exclusive" });
    } finally {
      this.#held.delete(name);
      const next = this.#waiters.get(name)?.shift();
      if (next) next();
    }
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis.navigator, "locks", {
    value: new FakeLockManager(),
    configurable: true,
  });
});

class InMemoryBrowserChatStore implements BrowserChatStore<BrowserChatRecord> {
  readonly #records = new Map<string, BrowserChatRecord>();
  readonly #events = new Map<string, WireEvent[]>();
  readonly #files = new Map<string, Blob>();

  async list(): Promise<BrowserChatRecord[]> {
    return [...this.#records.values()];
  }

  async create(header: ChatHeader, baseUrl: string): Promise<BrowserChatRecord> {
    if (!isChatHeader(header)) throw new ChatStoreError("invalid", "invalid header");
    const summary = summarize(header, []);
    const record: BrowserChatRecord = { ...summary, header, baseUrl };
    this.#records.set(header.id, record);
    this.#events.set(header.id, []);
    return record;
  }

  async get(id: string): Promise<BrowserChatRecord | null> {
    return this.#records.get(id) ?? null;
  }

  async read(
    id: string,
    options?: { readonly afterSeq?: number },
  ): Promise<{ header: ChatHeader; events: WireEvent[] }> {
    const record = this.#records.get(id);
    if (!record) throw new ChatStoreError("not-found", id);
    const afterSeq = options?.afterSeq ?? 0;
    const events = (this.#events.get(id) ?? []).filter((e) => e.seq > afterSeq);
    return { header: record.header, events };
  }

  async window(id: string) {
    const record = this.#records.get(id);
    if (!record) throw new ChatStoreError("not-found", id);
    return buildWindow(record.header, this.#events.get(id) ?? []);
  }

  async append(
    id: string,
    events: readonly WireEvent[],
    options?: { readonly allowGap?: boolean },
  ): Promise<BrowserChatRecord> {
    const record = this.#records.get(id);
    if (!record) throw new ChatStoreError("not-found", id);
    const current = this.#events.get(id) ?? [];
    let prev = current.at(-1)?.seq ?? 0;
    for (const event of events) {
      if (options?.allowGap ? event.seq <= prev : event.seq !== prev + 1) {
        throw new ChatStoreError("seq-gap", `bad seq ${event.seq}`);
      }
      prev = event.seq;
    }
    const nextEvents = [...current, ...events];
    this.#events.set(id, nextEvents);
    const nextRecord = advanceSummary(record, events);
    this.#records.set(id, nextRecord);
    return nextRecord;
  }

  async appendOwn(
    id: string,
    drafts: readonly OwnEventDraft[],
    at: number = Date.now(),
  ): Promise<WireEvent[]> {
    const current = this.#events.get(id);
    if (!current) throw new ChatStoreError("not-found", id);
    const stamped = stampEvents(drafts, current.at(-1)?.seq ?? 0, at);
    await this.append(id, stamped);
    return stamped;
  }

  async remove(id: string): Promise<void> {
    this.#records.delete(id);
    this.#events.delete(id);
  }

  async putFile(chatId: string, name: string, blob: Blob): Promise<boolean> {
    this.#files.set(`${chatId}/${name}`, blob);
    return true;
  }

  async getFile(chatId: string, name: string): Promise<Blob | null> {
    return this.#files.get(`${chatId}/${name}`) ?? null;
  }

  async missingFiles(chatId: string): Promise<string[]> {
    const events = this.#events.get(chatId) ?? [];
    return herAttachments(events)
      .map((att) => att.name)
      .filter((name) => !this.#files.has(`${chatId}/${name}`));
  }
}

function ndjsonResponse(lines: readonly unknown[]): Response {
  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("uuidv7 and chat parsing", () => {
  test("uuidv7 generates valid sortable chat ids", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(isChatId(a)).toBe(true);
    expect(isChatId(b)).toBe(true);
    expect(a < b).toBe(true);
    expect(isChatId("not-a-uuid")).toBe(false);
  });

  test("attachment helpers, text validation, and segment joiners match wire rules", () => {
    const validJpg = `${"a".repeat(64)}.jpg`;
    expect(isAttachmentName(validJpg)).toBe(true);
    expect(isAttachmentName("../etc/passwd")).toBe(false);
    expect(attachmentMimeOf(validJpg)).toBe("image/jpeg");
    expect(attachmentExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("audio/ogg")).toBe("audio");

    expect(chatTextOf("  你好  ")).toBe("你好");
    expect(chatTextOf("   ")).toBeNull();
    expect(chatTextOf("bad\u0000char")).toBeNull();

    expect(separator("Hello.", "World")).toBe(" ");
    expect(separator("你好。", "世界")).toBe("");
    // Supplementary-plane CJK (U+20BB7) must not receive an ASCII space on either boundary.
    expect(separator("𠮷", "abc")).toBe("");
    expect(separator("abc", "𠮷")).toBe("");
    expect(joinSegments(["Hello.", "World"])).toBe("Hello. World");
    expect(joinSegments(["你好。", "世界！"])).toBe("你好。世界！");
    expect(recorderMimeType((type) => type.startsWith("audio/mp4"))).toBe(
      "audio/mp4;codecs=mp4a.40.2",
    );

    expect(
      isChatEvent({
        seq: 1,
        at: 1,
        type: "context",
        persona: "milky-green",
        turn: "t1",
        position: 0,
        role: "invalid-role",
        content: "x",
      }),
    ).toBe(false);
    expect(
      isChatEvent({
        seq: 1,
        at: 1,
        type: "call-started",
        call: "c1",
        persona: "milky-green",
        group: false,
      }),
    ).toBe(false);
  });

  test("parseStreamLine and chatLineEventOf validate server payloads", () => {
    expect(parseStreamLine({ type: "started", turn: "t1", persona: "milky-green" })).toEqual({
      type: "started",
      turn: "t1",
      persona: "milky-green",
    });
    expect(parseStreamLine("not an object")).toBeNull();
    expect(parseStreamLine({ type: "events", events: [{ bad: true }] })).toBeNull();
    expect(NEVER_SENT.has("context")).toBe(true);

    const chatLine = chatLineEventOf({
      type: "chat-line",
      event: {
        seq: 2,
        at: 100,
        type: "message",
        id: "m1",
        speaker: { kind: "persona", id: "milky-green" },
        text: "早安！",
        modality: "call",
        sig: "hmac",
      },
    });
    expect(chatLine?.text).toBe("早安！");
    expect(chatLineEventOf({ type: "other", event: {} })).toBeNull();
  });
});

describe("window builder, locks, availability, and session lifecycle", () => {
  test("buildWindow keeps older state events ahead of newest 120 events and drops NEVER_SENT", () => {
    const header = newChatHeader(["milky-green"], 1000);
    const titleEvent: WireEvent = { seq: 1, at: 1001, type: "title", title: "Pinned title" };
    const contextEvent: WireEvent = {
      seq: 2,
      at: 1002,
      type: "context",
      persona: "milky-green",
      turn: "t0",
      position: 0,
      role: "system",
      content: "recall",
    };
    const filler: WireEvent[] = Array.from({ length: 130 }, (_, idx) => ({
      seq: idx + 3,
      at: 1003 + idx,
      type: "message" as const,
      id: `m-${idx}`,
      speaker: { kind: "user" as const },
      text: `msg-${idx}`,
    }));
    const win = buildWindow(header, [titleEvent, contextEvent, ...filler]);
    expect(win.events).toHaveLength(1 + CHAT_WINDOW_EVENTS);
    expect(win.events[0]).toEqual(titleEvent);
    expect(win.events.some((e) => e.type === "context")).toBe(false);
    expect(isChatEvent(win.events[0]!)).toBe(true);
  });

  test("withChatLock and holdChatLock reject concurrent operations with ChatBusyError", async () => {
    expect(chatLocksAvailable()).toBe(true);
    const chatId = uuidv7();
    const release = await holdChatLock(chatId);
    await expect(withChatLock(chatId, async () => "never")).rejects.toBeInstanceOf(ChatBusyError);
    release();
    await Promise.resolve();
    expect(await withChatLock(chatId, async () => "ok")).toBe("ok");
  });

  test("probeChatEndpoint and createChatAvailability classify HTTP 405/404/500 statuses", async () => {
    const repeatedSlashes = `  https://bot.example/${"/".repeat(50_000)}path///  `;
    expect(normalizeBaseUrl(repeatedSlashes)).toBe(`https://bot.example/${"/".repeat(50_000)}path`);
    expect(normalizeBaseUrl("   ///   ")).toBe("");

    expect(
      await probeChatEndpoint("https://bot.example/", {
        fetch: async () => new Response("", { status: 405 }),
      }),
    ).toBe("on");
    expect(
      await probeChatEndpoint("https://bot.example/", {
        fetch: async () => new Response("not found", { status: 404 }),
      }),
    ).toBe("off");
    expect(
      await probeChatEndpoint("https://bot.example/", {
        fetch: async () => new Response("err", { status: 502 }),
      }),
    ).toBe("unreachable");

    let calls = 0;
    const check = createChatAvailability({
      fetch: async () => {
        calls++;
        return new Response("", { status: 405 });
      },
    });
    expect(await check("https://bot.example/")).toBe("on");
    expect(await check("https://bot.example")).toBe("on");
    expect(calls).toBe(1);

    await expect(
      (async () => {
        for await (const _ of streamTurn({
          baseUrl: "https://bot.example",
          chat: { header: newChatHeader(["milky-green"], 1), events: [] },
          text: "hi",
          fetch: async () =>
            new Response(JSON.stringify({ error: "Too many turns", retry_after: 30 }), {
              status: 429,
            }),
        })) {
          // unreachable
        }
      })(),
    ).rejects.toMatchObject({ status: 429, code: "rate-limited", retryAfter: 30 });

    // Blank Retry-After header yields null rather than 0; custom abort reasons rethrow unwrapped.
    await expect(
      (async () => {
        for await (const _ of streamTurn({
          baseUrl: "https://bot.example",
          chat: { header: newChatHeader(["milky-green"], 1), events: [] },
          text: "hi",
          fetch: async () =>
            new Response("rate limited", { status: 429, headers: { "retry-after": "   " } }),
        })) {
          // unreachable
        }
      })(),
    ).rejects.toMatchObject({ status: 429, code: "rate-limited", retryAfter: null });

    const controller = new AbortController();
    const customReason = new Error("caller-cancelled");
    controller.abort(customReason);
    await expect(
      (async () => {
        for await (const _ of streamTurn({
          baseUrl: "https://bot.example",
          chat: { header: newChatHeader(["milky-green"], 1), events: [] },
          text: "hi",
          signal: controller.signal,
          fetch: async (_url, init) => {
            throw init?.signal?.reason;
          },
        })) {
          // unreachable
        }
      })(),
    ).rejects.toBe(customReason);
  });

  test("sendChatTurn, downloadMissingFiles, startChatCall, closeDanglingCall, and chatViewReducer", async () => {
    const store = new InMemoryBrowserChatStore();
    const chat = await createChat(store, ["milky-green"], "https://bot.example/", 100);
    const photoName = `${"b".repeat(64)}.png`;

    const seenLines: ChatStreamLine["type"][] = [];
    let view = EMPTY_CHAT_VIEW;
    const fakeFetch = async (url: string): Promise<Response> => {
      if (url.endsWith("/api/chat/turn")) {
        return ndjsonResponse([
          { type: "started", turn: "t1", persona: "milky-green" },
          { type: "delta", turn: "t1", text: "你好" },
          { type: "tool", turn: "t1", name: "take_selfie", state: "running" },
          {
            type: "events",
            events: [
              {
                seq: 1,
                at: 101,
                type: "message",
                id: "u1",
                speaker: { kind: "user" },
                text: "嗨",
              },
              {
                seq: 2,
                at: 102,
                type: "message",
                id: "a1",
                speaker: { kind: "persona", id: "milky-green" },
                text: "你好呀",
                attachments: [{ kind: "image", name: photoName, mime: "image/png" }],
                sig: "sig-1",
              },
            ],
          },
          { type: "ended", turn: "t1" },
        ]);
      }
      if (url.endsWith(`/api/chat/files/${photoName}`)) {
        return new Response(new Blob(["png-bytes"], { type: "image/png" }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };

    const missingCallbacks: string[][] = [];
    const result = await sendChatTurn(
      { store, fetch: fakeFetch },
      {
        chatId: chat.id,
        text: "嗨",
        onMissingFiles: (names) => missingCallbacks.push(names),
        onLine: (line) => {
          seenLines.push(line.type);
          view = chatViewReducer(view, { type: "line", line });
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(missingCallbacks).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(seenLines).toEqual(["started", "delta", "tool", "events", "ended"]);
    expect(liveItems(view.live)).toEqual([]);
    expect(await downloadMissingFiles({ store, fetch: fakeFetch }, chat.id)).toEqual([]);
    expect((await store.getFile(chat.id, photoName))?.size).toBe(9);

    await expect(
      fetchChatFile({
        baseUrl: "https://bot.example",
        name: "not-an-attachment",
        fetch: fakeFetch,
      }),
    ).rejects.toBeInstanceOf(ChatRequestError);

    expect(
      await fetchChatFile({
        baseUrl: "https://bot.example",
        name: `${"c".repeat(64)}.png`,
        fetch: fakeFetch,
      }),
    ).toBeNull();

    const call = await startChatCall({ store, fetch: fakeFetch }, chat.id, "milky-green");
    expect(await closeDanglingCall(store, chat.id)).toBe(false);
    expect(
      await call.receive({
        type: "chat-line",
        event: {
          seq: 5,
          at: 200,
          type: "message",
          id: "c1",
          speaker: { kind: "persona", id: "milky-green" },
          text: "电话里也听得到吗？",
          modality: "call",
          sig: "sig-2",
        },
      }),
    ).toBe(true);
    await call.end("hangup");

    const { events: allEvents } = await store.read(chat.id);
    const rows = eventItems(allEvents);
    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "message", "call"]);
    const endedRow = rows.at(-1);
    expect(endedRow?.kind === "call" ? endedRow.edge : null).toBe("ended");

    // Empty-text persona message with cutOff renders as a cut-off item; reactive "loaded" settles live turns.
    const refusalEvent: WireEvent = {
      seq: 10,
      at: 300,
      type: "message",
      id: "r1",
      speaker: { kind: "persona", id: "milky-green" },
      text: "",
      cutOff: "refusal",
    };
    const cutOffRows = eventItems([refusalEvent]);
    expect(cutOffRows).toHaveLength(1);
    expect(cutOffRows[0]).toMatchObject({ kind: "message", text: "", cutOff: "refusal" });

    let liveView = chatViewReducer(EMPTY_CHAT_VIEW, {
      type: "line",
      line: { type: "started", turn: "t9", persona: "milky-green" },
    });
    liveView = chatViewReducer(liveView, { type: "loaded", events: [refusalEvent] });
    expect(liveItems(liveView.live)).toEqual([]);
    const beforeReload = liveView.events[0];
    liveView = chatViewReducer(liveView, { type: "loaded", events: [{ ...refusalEvent }] });
    expect(liveView.events[0]).toBe(beforeReload);

    // Replaying historical persona messages via "loaded" does not settle an active newer turn.
    liveView = chatViewReducer(liveView, {
      type: "line",
      line: { type: "started", turn: "t10", persona: "milky-green" },
    });
    liveView = chatViewReducer(liveView, {
      type: "line",
      line: { type: "delta", turn: "t10", text: "还在说" },
    });
    liveView = chatViewReducer(liveView, { type: "loaded", events: [refusalEvent] });
    expect(liveView.live.find((l) => l.turn === "t10")?.settled).toBe(false);
    liveView = chatViewReducer(liveView, {
      type: "line",
      line: { type: "delta", turn: "t10", text: "呢" },
    });
    expect(liveItems(liveView.live)).toMatchObject([
      { kind: "live", turn: "t10", text: "还在说呢" },
    ]);
    liveView = chatViewReducer(liveView, {
      type: "loaded",
      events: [{ ...refusalEvent, seq: 11, id: "r2", text: "说完啦" }],
    });
    expect(liveItems(liveView.live)).toEqual([]);
  });
});
