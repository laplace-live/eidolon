import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CHAIN_LIMITS as SERVER_CHAIN_LIMITS,
  CHAT_FORMAT as SERVER_CHAT_FORMAT,
  CHAT_WINDOW_MESSAGES as SERVER_CHAT_WINDOW_MESSAGES,
  DEFAULT_CHAIN_LIMIT as SERVER_DEFAULT_CHAIN_LIMIT,
  MAX_CHAIN_LIMIT as SERVER_MAX_CHAIN_LIMIT,
  MAX_IMAGE_BYTES as SERVER_MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE as SERVER_MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS as SERVER_MAX_IMAGE_PIXELS,
  MAX_LINE_FILES as SERVER_MAX_LINE_FILES,
  MAX_PARTICIPANTS as SERVER_MAX_PARTICIPANTS,
  MAX_TEXT_FILE_BYTES as SERVER_MAX_TEXT_FILE_BYTES,
  MAX_VOICE_MS as SERVER_MAX_VOICE_MS,
  REPLY_MODES as SERVER_REPLY_MODES,
  type ChatEvent as ServerChatEvent,
} from "@eidolon/chat";
import { describe, expect, test } from "vitest";
import { ChatSigner, fromViewer, MIN_CHAT_SECRET_LENGTH } from "../../../apps/bot/src/chat/sig.ts";
import {
  openChatWindow,
  CHAT_WINDOW_BYTES as SERVER_CHAT_WINDOW_BYTES,
  CHAT_WINDOW_EVENTS as SERVER_CHAT_WINDOW_EVENTS,
  CHAT_WINDOW_TOOL_BYTES as SERVER_CHAT_WINDOW_TOOL_BYTES,
  CHAT_WINDOW_TOOL_EVENTS as SERVER_CHAT_WINDOW_TOOL_EVENTS,
  PUBLIC_CHAIN_LIMIT as SERVER_PUBLIC_CHAIN_LIMIT,
  windowOf,
} from "../../../apps/bot/src/chat/window.ts";
import { fittedSize as serverFittedSize } from "../../../apps/bot/src/images.ts";
import type { ModelInventory as ServerModelInventory } from "../../../apps/bot/src/local/api.ts";
import { checkRig } from "../../../apps/bot/src/local/psd2live.ts";
import { AUDIO_QUALITIES as SERVER_AUDIO_QUALITIES } from "../../access/src/audio-quality.ts";
import { BOT_ABOUT } from "../../runtime/src/rtvi.ts";
import { inspectPsd2liveRig, type ModelInventory } from "../src/avatar/index.ts";
import { psd2liveRuntimeUrl } from "../src/avatar/psd2live/runtime.ts";
import { fittedSize } from "../src/chat/files.ts";
import {
  AUDIO_QUALITIES,
  buildWindow,
  CHAIN_LIMITS,
  CHAT_FORMAT,
  CHAT_WINDOW_BYTES,
  CHAT_WINDOW_EVENTS,
  CHAT_WINDOW_MESSAGES,
  CHAT_WINDOW_TOOL_BYTES,
  CHAT_WINDOW_TOOL_EVENTS,
  type ChatHeader,
  DEFAULT_CHAIN_LIMIT,
  MAX_CHAIN_LIMIT,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  MAX_LINE_FILES,
  MAX_PARTICIPANTS,
  MAX_TEXT_FILE_BYTES,
  MAX_TEXT_LENGTH,
  MAX_TURN_FILE_BYTES,
  MAX_VOICE_BYTES,
  MAX_VOICE_MS,
  NEVER_SENT,
  PUBLIC_CHAIN_LIMIT,
  parseBotReadyData,
  REPLY_MODES,
  STATE_EVENT_TYPES,
  VOICE_RECORDER_MIME_TYPES,
  type WireEvent,
} from "../src/index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("server and client SDK protocol parity", () => {
  test("chat log format and window budgets match server constants", () => {
    expect(CHAT_FORMAT).toBe(SERVER_CHAT_FORMAT);
    expect(MAX_PARTICIPANTS).toBe(SERVER_MAX_PARTICIPANTS);
    expect(CHAIN_LIMITS).toEqual(SERVER_CHAIN_LIMITS);
    expect(DEFAULT_CHAIN_LIMIT).toBe(SERVER_DEFAULT_CHAIN_LIMIT);
    expect(MAX_CHAIN_LIMIT).toBe(SERVER_MAX_CHAIN_LIMIT);
    expect(PUBLIC_CHAIN_LIMIT).toBe(SERVER_PUBLIC_CHAIN_LIMIT);
    expect(CHAT_WINDOW_EVENTS).toBe(SERVER_CHAT_WINDOW_EVENTS);
    expect(CHAT_WINDOW_BYTES).toBe(SERVER_CHAT_WINDOW_BYTES);
    expect(CHAT_WINDOW_TOOL_EVENTS).toBe(SERVER_CHAT_WINDOW_TOOL_EVENTS);
    expect(CHAT_WINDOW_TOOL_BYTES).toBe(SERVER_CHAT_WINDOW_TOOL_BYTES);
    expect(CHAT_WINDOW_MESSAGES).toBe(SERVER_CHAT_WINDOW_MESSAGES);
    expect(MAX_VOICE_MS).toBe(SERVER_MAX_VOICE_MS);
    expect(REPLY_MODES).toEqual(SERVER_REPLY_MODES);
    expect(MAX_LINE_FILES).toBe(SERVER_MAX_LINE_FILES);
    expect(MAX_IMAGE_BYTES).toBe(SERVER_MAX_IMAGE_BYTES);
    expect(MAX_IMAGE_PIXELS).toBe(SERVER_MAX_IMAGE_PIXELS);
    expect(MAX_IMAGE_EDGE).toBe(SERVER_MAX_IMAGE_EDGE);
    expect(MAX_TEXT_FILE_BYTES).toBe(SERVER_MAX_TEXT_FILE_BYTES);
  });

  test("prepareChatFile fits an image as the server does, so the server takes it as it is", () => {
    for (const [width, height] of [
      [1170, 2532],
      [4032, 3024],
      [6000, 1000],
      [2049, 2048],
      [12_345, 6789],
      [3001, 7],
    ] as const) {
      expect(fittedSize(width, height)).toEqual(serverFittedSize(width, height));
    }
  });

  test("route text and voice byte limits match apps/bot/src/chat/routes.ts", () => {
    const routesSource = readFileSync(join(ROOT, "apps/bot/src/chat/routes.ts"), "utf8");
    expect(routesSource).toContain(`const MAX_TEXT = ${MAX_TEXT_LENGTH};`);
    expect(routesSource).toContain("const MAX_VOICE_BYTES = 10 * 1024 * 1024;");
    expect(MAX_VOICE_BYTES).toBe(10 * 1024 * 1024);
    expect(routesSource).toContain("const MAX_TURN_FILE_BYTES = 12 * 1024 * 1024;");
    expect(MAX_TURN_FILE_BYTES).toBe(12 * 1024 * 1024);
  });

  test("audio qualities and bot-ready match the server", () => {
    expect(AUDIO_QUALITIES).toEqual(SERVER_AUDIO_QUALITIES);
    expect(VOICE_RECORDER_MIME_TYPES.length).toBeGreaterThan(0);

    const parsed = parseBotReadyData({
      version: "2.2.0",
      about: BOT_ABOUT,
    });
    expect(parsed.about).toEqual(BOT_ABOUT);
  });
});

const CHAT = "0190f5c8-0000-7000-8000-0000000000aa";
const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: CHAT,
  createdAt: 1000,
  participants: ["milky-green"],
};
const PERSONA = "milky-green";

/** mulberry32, so a log that fails can be built again from its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** About 10 KB of UTF-8, three bytes a character. */
const MEDIUM = "好".repeat(3400);
/** Too big for either share alone. */
const HUGE = "x".repeat(140 * 1024);

/**
 * A browser's log, from `seed`: the viewer's lines and hers, decisions, state, context, call marks,
 * kickoffs, failures, and batches of tool calls with their results, one sometimes missing, of
 * every size; some logs mostly tool events, others mostly lines.
 */
function generatedLog(seed: number): WireEvent[] {
  const random = seeded(seed);
  const pick = <T>(choices: readonly T[]): T => choices[Math.floor(random() * choices.length)]!;
  const text = () => {
    const r = random();
    return r < 0.03 ? HUGE : r < 0.15 ? MEDIUM : "嗯";
  };
  const toolShare = pick([0.1, 0.5, 0.85]);
  const length = Math.floor(random() * 420);
  const log: WireEvent[] = [];
  const add = (event: Omit<WireEvent, "seq" | "at">) =>
    log.push({ seq: log.length + 1, at: 1000 + log.length, ...event } as WireEvent);
  while (log.length < length) {
    if (random() < toolShare) {
      const turn = `t${log.length}`;
      const ids = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) => `${turn}-${i}`);
      for (const [i, callId] of ids.entries()) {
        add({
          type: "tool-call",
          persona: PERSONA,
          turn,
          callId,
          name: "recall_streams",
          arguments: { query: "上次" },
          ...(i === 0 && random() < 0.4 ? { said: "我查一下" } : {}),
        });
      }
      for (const callId of ids) {
        if (random() < 0.9) {
          add({ type: "tool-result", persona: PERSONA, turn, callId, result: { text: text() } });
        }
      }
      continue;
    }
    const kind = random();
    if (kind < 0.35) {
      add({ type: "message", id: `u${log.length}`, speaker: { kind: "user" }, text: text() });
    } else if (kind < 0.7) {
      add({
        type: "message",
        id: `m${log.length}`,
        speaker: { kind: "persona", id: PERSONA },
        text: text(),
      });
    } else if (kind < 0.78) {
      add({
        type: "decision",
        after: log.length,
        replies: [{ persona: PERSONA, mode: "text" }],
        source: "single",
      });
    } else if (kind < 0.86) {
      add({
        type: "context",
        persona: PERSONA,
        turn: `t${log.length}`,
        position: 0,
        role: "system",
        content: text(),
      });
    } else if (kind < 0.92) {
      add(
        pick<Omit<WireEvent, "seq" | "at">>([
          { type: "title", title: `第${log.length}次` },
          { type: "settings", replyMode: pick(["auto", "text", "voice"]) },
          { type: "participants", added: ["bea"] },
          { type: "participants", removed: ["bea"] },
        ]),
      );
    } else if (kind < 0.96) {
      add(
        random() < 0.5
          ? { type: "call-started", call: `call${log.length}`, persona: PERSONA }
          : { type: "call-ended", call: `call${log.length}`, reason: "hangup" },
      );
    } else if (kind < 0.98) {
      add({ type: "kickoff", persona: PERSONA, turn: `t${log.length}`, content: "打招呼" });
    } else {
      add({ type: "turn-failed", persona: PERSONA, turn: `t${log.length}`, error: "boom" });
    }
  }
  return log;
}

/**
 * What a store reads for a turn, as laplace's does: the newest `CHAT_WINDOW_EVENTS` events that
 * aren't `NEVER_SENT`, and every state event older than them.
 */
function hostRead(log: readonly WireEvent[]): WireEvent[] {
  const newest = log.filter((event) => !NEVER_SENT.has(event.type)).slice(-CHAT_WINDOW_EVENTS);
  const oldest = newest[0]?.seq ?? 0;
  const older = log.filter(
    (event) => event.seq < oldest && STATE_EVENT_TYPES.some((type) => type === event.type),
  );
  return [...older, ...newest];
}

const seqsOf = (events: readonly unknown[]) => events.map((event) => (event as WireEvent).seq);

describe("one window rule for the SDK and the server", () => {
  test("the server's window keeps exactly what buildWindow sends, from the whole log or a host's read", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const log = generatedLog(seed);
      const sent = buildWindow(HEADER, log).events;
      expect([seed, seqsOf(windowOf(log))]).toEqual([seed, seqsOf(sent)]);
      expect([seed, seqsOf(windowOf(sent))]).toEqual([seed, seqsOf(sent)]);
      expect([seed, seqsOf(buildWindow(HEADER, hostRead(log)).events)]).toEqual([
        seed,
        seqsOf(sent),
      ]);
      const kept = new Set(sent);
      const lostState = log.filter(
        (event) => STATE_EVENT_TYPES.some((type) => type === event.type) && !kept.has(event),
      );
      const callsWithoutResults = sent.filter(
        (call) =>
          call.type === "tool-call" &&
          log.some(
            (event) =>
              event.type === "tool-result" && event.callId === call.callId && !kept.has(event),
          ),
      );
      expect([seed, seqsOf(lostState), seqsOf(callsWithoutResults)]).toEqual([seed, [], []]);
    }
  });

  test("openChatWindow keeps whole what buildWindow sends, every signature verifying", async () => {
    const signer = await ChatSigner.create("k".repeat(MIN_CHAT_SECRET_LENGTH));
    for (const seed of [2, 5, 9]) {
      const log = await Promise.all(
        generatedLog(seed).map((event) =>
          fromViewer(event) ? event : signer.sign(CHAT, event as unknown as ServerChatEvent),
        ),
      );
      const sent = JSON.parse(JSON.stringify(buildWindow(HEADER, log as WireEvent[])));
      const opened = await openChatWindow(sent, signer);
      if (!opened.ok) throw new Error(opened.message);
      expect([seed, (await opened.store.read(CHAT)).events]).toEqual([seed, sent.events]);
    }
  });
});

describe("a model's inventory, read by the SDK and by the server", () => {
  test("inspectPsd2liveRig reads the test rig as the server's upload check does", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(ROOT, "apps/bot/test/local/fixtures/psd2live/tml.p2lrt")),
    );
    const server = checkRig(bytes);
    if (!server.ok) throw new Error(server.message);
    const sdk = await inspectPsd2liveRig(bytes, {
      runtime: new Uint8Array(readFileSync(psd2liveRuntimeUrl())),
    });
    expect(sdk).toEqual(server.inventory);
    // Each side's type takes the other's, so a field only one has fails the typecheck here.
    const asServer: ServerModelInventory = sdk;
    const asSdk: ModelInventory = server.inventory;
    expect(asServer).toEqual(asSdk);
  });
});
