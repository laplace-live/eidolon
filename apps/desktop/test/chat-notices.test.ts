// Chat notifications: baseline without firing, focus gating, plain-text markup parity with the
// SDK, voice/photo placeholders, group titles & peers, groupFor(), timeouts and streak logging.
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ChatEvent, ChatSummary } from "../../../packages/chat/src/format.ts";
import type { PersonaSummary } from "../../bot/src/local/api.ts";
import type { NoticeHandle } from "../src/main/background.ts";
import {
  type ChatNotice,
  ChatWatch,
  chatNoticeCommand,
  plainReplyText,
} from "../src/main/chat-notices.ts";
import type { BackendFetch } from "../src/main/quit-check.ts";
import { STRINGS } from "../src/main/strings.ts";
import { type Language, openChatCommand } from "../src/shared/bridge.ts";

const CHATS = "/api/local/chats";
const PERSONAS = "/api/local/personas";
const CHAT_1 = "0193a1b2-c3d4-7e5f-8a6b-111111111111";
const CHAT_2 = "0193a1b2-c3d4-7e5f-8a6b-222222222222";

const MILKY: PersonaSummary = {
  id: "milky-green",
  name: "明前奶绿",
  shortName: "奶绿",
  template: true,
  own: true,
  avatar: false,
  appearance: { model: null },
};
const RIN: PersonaSummary = { ...MILKY, id: "rin", name: "Rin", shortName: "Rin", template: false };
const KURO: PersonaSummary = {
  ...MILKY,
  id: "kuro",
  name: "Kuroha",
  shortName: "Kuro",
  template: false,
};

function summary(id: string, fields: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: null,
    participants: [MILKY.id],
    createdAt: 1_763_856_000_000,
    updatedAt: 1_763_856_000_000,
    lastText: null,
    lastSeq: 0,
    ...fields,
  };
}

function message(
  seq: number,
  fields: Partial<Extract<ChatEvent, { type: "message" }>> = {},
): ChatEvent {
  return {
    type: "message",
    seq,
    at: 1_763_856_000_000 + seq,
    id: `msg-${seq}`,
    speaker: { kind: "persona", id: MILKY.id },
    text: "Hello",
    ...fields,
  };
}

function chatServer() {
  const state = {
    chats: [] as ChatSummary[],
    events: new Map<string, ChatEvent[]>(),
    personas: [MILKY, RIN, KURO] as PersonaSummary[],
    fails: new Map<string, number | "never">(),
    holds: new Map<string, () => Promise<void>>(),
    requests: [] as { readonly path: string; readonly signal: AbortSignal }[],
  };
  const fetch: BackendFetch = async (path, { signal }) => {
    state.requests.push({ path, signal });
    const base = path.split("?")[0] as string;
    const hold = state.holds.get(path) ?? state.holds.get(base);
    if (hold !== undefined) await hold();
    const fail = state.fails.get(path) ?? state.fails.get(base);
    if (fail === "never") return new Promise<never>(() => {});
    const status = fail ?? 200;
    let body: unknown;
    if (path === CHATS) body = state.chats;
    else if (path === PERSONAS) body = { active: MILKY.id, personas: state.personas };
    else {
      const match = /^\/api\/local\/chats\/([^/?]+)\?afterSeq=(\d+)$/.exec(path);
      if (match === null) return { ok: false, status: 404, json: async () => ({}) };
      const [, id, afterRaw] = match;
      const after = Number(afterRaw);
      const events = (state.events.get(id as string) ?? []).filter((event) => event.seq > after);
      body = { events };
    }
    return { ok: status === 200, status, json: async () => body };
  };
  return Object.assign(state, {
    fetch,
    paths: () => state.requests.map(({ path }) => path),
  });
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function clock() {
  let now = 0;
  let ids = 0;
  const due = new Map<number, { readonly at: number; readonly run: () => void }>();
  const timers = {
    setTimeout: ((run: () => void, ms = 0) => {
      ids += 1;
      due.set(ids, { at: now + ms, run });
      return ids;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id?: number) => {
      if (id !== undefined) due.delete(id);
    }) as unknown as typeof clearTimeout,
  };
  return {
    timers,
    pending: (): number[] => [...due.values()].map(({ at }) => at - now).sort((a, b) => a - b),
    async advance(ms: number): Promise<void> {
      const until = now + ms;
      for (;;) {
        await settle();
        let first: [number, { readonly at: number; readonly run: () => void }] | undefined;
        for (const entry of due)
          if (first === undefined || entry[1].at < first[1].at) first = entry;
        if (first === undefined || first[1].at > until) break;
        due.delete(first[0]);
        now = first[1].at;
        first[1].run();
      }
      now = until;
    },
  };
}

function watching(language: Language = "en") {
  const time = clock();
  const backend = chatServer();
  const shown: ChatNotice[] = [];
  const lines: string[] = [];
  const app = { focused: false, lang: language };
  const watch = new ChatWatch({
    fetch: backend.fetch,
    focused: () => app.focused,
    strings: () => STRINGS[app.lang],
    show: (notice): NoticeHandle => {
      shown.push(notice);
      return { close() {} };
    },
    log: {
      info: (line) => lines.push(`info ${line}`),
      warn: (line) => lines.push(`warn ${line}`),
    },
    timers: time.timers,
  });
  return { time, backend, shown, lines, app, watch };
}

describe("plainReplyText", () => {
  test("matches the SDK's markup parser + web previewText across cues, directions and tags", async () => {
    const markupPath = join(import.meta.dirname, "../../../packages/sdk/src/markup.ts");
    const sdk = (await import(markupPath)) as {
      parseMarkup(
        source: string,
      ): readonly (
        | { readonly kind: "text"; readonly text: string }
        | { readonly kind: "cue"; readonly emoji: string }
        | { readonly kind: "direction" }
      )[];
      trimTrailingPartialCue(text: string): string;
    };
    const webPreview = (text: string): string =>
      sdk
        .parseMarkup(sdk.trimTrailingPartialCue(text))
        .map((token) =>
          token.kind === "text" ? token.text : token.kind === "cue" ? token.emoji : " ",
        )
        .join("")
        .replace(/\s+/g, " ")
        .trim();

    const samples = [
      "[温柔地笑着说] 晚上好呀，[chuckling] 今天过得怎么样？",
      "[break] [long-break]   你好<whisper>悄悄话</whisper>啊<emphasis>很棒</emphasis>",
      "<unknown>ignored</unknown> text [soft tone] end [trailing",
      "plain reply <partial",
      "[chuckling]   [happy]   ",
      "",
    ];
    for (const sample of samples) {
      expect([sample, plainReplyText(sample)]).toEqual([sample, webPreview(sample)]);
    }
  });
});

describe("ChatWatch", () => {
  test("baseline sets seen seqs without notifying, and focused skips chat event and persona reads", async () => {
    const { time, backend, shown, app, watch } = watching();
    backend.chats = [summary(CHAT_1, { lastSeq: 5 })];
    watch.ready();
    await time.advance(0);
    expect(shown).toEqual([]);
    expect(backend.paths()).toEqual([CHATS]);

    app.focused = true;
    backend.chats = [summary(CHAT_1, { lastSeq: 8 })];
    await time.advance(2_000);
    expect(backend.paths()).toEqual([CHATS, CHATS]);
    expect(shown).toEqual([]);

    app.focused = false;
    await time.advance(2_000);
    expect(backend.paths()).toEqual([CHATS, CHATS, CHATS]);
    expect(shown).toEqual([]);
    watch.stop();
  });

  test("notifies single chat replies with stripped text, voice & photo labels, skipping user/call/interrupted", async () => {
    const { time, backend, shown, app, watch } = watching("en");
    backend.chats = [summary(CHAT_1, { lastSeq: 1 })];
    watch.ready();
    await time.advance(0);

    backend.chats = [summary(CHAT_1, { lastSeq: 8 })];
    backend.events.set(CHAT_1, [
      message(2, { speaker: { kind: "user" }, text: "Hi" }),
      message(3, { modality: "call", text: "On call" }),
      message(4, { interrupted: true, text: "Cut off" }),
      message(5, { text: "" }),
      message(6, { text: "[gentle] [chuckling] \u202EHello\nworld  " }),
      message(7, { modality: "voice", text: "" }),
      message(8, {
        text: "",
        attachments: [
          { kind: "image", name: "a.png", mime: "image/png" },
          { kind: "image", name: "b.png", mime: "image/png" },
        ],
      }),
    ]);
    await time.advance(2_000);

    expect(shown).toEqual([
      {
        chat: CHAT_1,
        seq: 6,
        speakerId: MILKY.id,
        speakerName: "明前奶绿",
        groupTitle: null,
        groupPeers: [],
        body: "😄 Hello world",
      },
      {
        chat: CHAT_1,
        seq: 7,
        speakerId: MILKY.id,
        speakerName: "明前奶绿",
        groupTitle: null,
        groupPeers: [],
        body: "Sent a voice message",
      },
      {
        chat: CHAT_1,
        seq: 8,
        speakerId: MILKY.id,
        speakerName: "明前奶绿",
        groupTitle: null,
        groupPeers: [],
        body: "Sent 2 photos",
      },
    ]);

    app.lang = "zh-Hans";
    backend.chats = [summary(CHAT_1, { lastSeq: 10 })];
    backend.events.set(CHAT_1, [
      message(9, {
        text: "",
        attachments: [{ kind: "image", name: "c.png", mime: "image/png" }],
      }),
      message(10, { text: "[sighing] Hold on" }),
    ]);
    await time.advance(2_000);
    expect(shown.at(-2)?.body).toBe("发来了一张照片");
    expect(shown.at(-1)?.body).toBe("\u{1F62E}\u200D\u{1F4A8} Hold on");
    watch.stop();
  });

  test("notifies group chat replies with custom or participant-derived title and up to 2 peers", async () => {
    const { time, backend, shown, watch } = watching("zh-Hans");
    backend.chats = [
      summary(CHAT_1, { participants: [MILKY.id, RIN.id, KURO.id, "extra"], lastSeq: 1 }),
      summary(CHAT_2, { title: "Weekend Squad", participants: [MILKY.id, RIN.id], lastSeq: 1 }),
    ];
    watch.ready();
    await time.advance(0);

    backend.chats = [
      summary(CHAT_1, { participants: [MILKY.id, RIN.id, KURO.id, "extra"], lastSeq: 2 }),
      summary(CHAT_2, { title: "Weekend Squad", participants: [MILKY.id, RIN.id], lastSeq: 2 }),
    ];
    backend.events.set(CHAT_1, [
      message(2, { speaker: { kind: "persona", id: RIN.id }, text: "Hi all" }),
    ]);
    backend.events.set(CHAT_2, [
      message(2, { speaker: { kind: "persona", id: MILKY.id }, text: "See you!" }),
    ]);
    await time.advance(2_000);

    expect(shown).toEqual([
      {
        chat: CHAT_1,
        seq: 2,
        speakerId: RIN.id,
        speakerName: "Rin",
        groupTitle: "奶绿、Rin、Kuro、extra",
        groupPeers: [MILKY.id, KURO.id],
        body: "Hi all",
      },
      {
        chat: CHAT_2,
        seq: 2,
        speakerId: MILKY.id,
        speakerName: "明前奶绿",
        groupTitle: "Weekend Squad",
        groupPeers: [RIN.id],
        body: "See you!",
      },
    ]);
    watch.stop();
  });

  test("groupFor enriches TaskWatch notices for group chats, preserves persona Cf chars, and returns null for 1-on-1 chats", async () => {
    const { time, backend, watch } = watching("en");
    backend.personas = [
      ...backend.personas,
      { id: "kana", name: "Ka\u2060na\u0007", shortName: "" } as unknown as PersonaSummary,
    ];
    backend.chats = [
      summary(CHAT_1, { participants: [MILKY.id], lastSeq: 1 }),
      summary(CHAT_2, { participants: [MILKY.id, RIN.id, KURO.id], lastSeq: 1 }),
      summary("chat-kana", { participants: [MILKY.id, "kana"], lastSeq: 1 }),
    ];
    watch.ready();
    await time.advance(0);

    expect(await watch.groupFor(CHAT_1, MILKY.id)).toBeNull();
    expect(await watch.groupFor("00000000-0000-0000-0000-000000000000", MILKY.id)).toBeNull();
    expect(await watch.groupFor(CHAT_2, MILKY.id)).toEqual({
      groupTitle: "奶绿, Rin, Kuro",
      groupPeers: [RIN.id, KURO.id],
    });
    expect(await watch.groupFor("chat-kana", MILKY.id)).toEqual({
      groupTitle: "奶绿, Ka\u2060na",
      groupPeers: ["kana"],
    });
    watch.stop();
  });

  test("cancels emission if window gains focus while reading chat events", async () => {
    const { time, backend, shown, app, watch } = watching();
    backend.chats = [summary(CHAT_1, { lastSeq: 1 })];
    watch.ready();
    await time.advance(0);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.holds.set(`${CHATS}/${CHAT_1}`, () => gate);
    backend.events.set(CHAT_1, [message(2, { text: "Reply arrived during focus change" })]);
    backend.chats = [summary(CHAT_1, { lastSeq: 2 })];
    await time.advance(2_000);
    app.focused = true;
    release?.();
    await settle();
    await time.advance(0);
    expect(shown).toEqual([]);
    watch.stop();
  });

  test("logs failure streaks once, aborts after 10 s, preserves initial baseline after startup outage, and notifies after mid-run outage", async () => {
    const { time, backend, shown, lines, watch } = watching();
    backend.fails.set(CHATS, "never");
    watch.ready();
    await time.advance(0);
    await time.advance(10_000);
    expect(lines).toEqual([
      "warn Eidolon: chat notifications couldn't read the chats: no answer in 10 s",
    ]);

    await time.advance(12_000);
    expect(lines).toHaveLength(1);

    backend.fails.delete(CHATS);
    backend.chats = [summary(CHAT_1, { lastSeq: 3 })];
    await time.advance(2_000);
    expect(lines.at(-1)).toBe("info Eidolon: chat notifications read the chats again");
    expect(shown).toEqual([]);

    // Once baseline exists, recovering from a mid-run outage still notifies new replies.
    backend.fails.set(CHATS, 503);
    await time.advance(2_000);
    backend.fails.delete(CHATS);
    backend.chats = [summary(CHAT_1, { lastSeq: 4 })];
    backend.events.set(CHAT_1, [message(4, { text: "Back online" })]);
    await time.advance(2_000);
    expect(shown.map(({ seq, body }) => ({ seq, body }))).toEqual([
      { seq: 4, body: "Back online" },
    ]);

    expect(chatNoticeCommand({ chat: CHAT_1 })).toBe(openChatCommand(CHAT_1));
    watch.stop();
  });
});
