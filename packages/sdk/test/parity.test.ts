import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CHAT_FORMAT as SERVER_CHAT_FORMAT,
  CHAT_WINDOW_MESSAGES as SERVER_CHAT_WINDOW_MESSAGES,
  DEFAULT_CHAIN_LIMIT as SERVER_DEFAULT_CHAIN_LIMIT,
  MAX_CHAIN_LIMIT as SERVER_MAX_CHAIN_LIMIT,
  MAX_PARTICIPANTS as SERVER_MAX_PARTICIPANTS,
  MAX_VOICE_MS as SERVER_MAX_VOICE_MS,
  REPLY_MODES as SERVER_REPLY_MODES,
} from "@eidolon/chat";
import {
  CHAT_WINDOW_BYTES as SERVER_CHAT_WINDOW_BYTES,
  CHAT_WINDOW_EVENTS as SERVER_CHAT_WINDOW_EVENTS,
  PUBLIC_CHAIN_LIMIT as SERVER_PUBLIC_CHAIN_LIMIT,
} from "../../../apps/bot/src/chat/window.ts";
import { selfiePaths as webSelfiePaths } from "../../../apps/web/src/features/call/selfie.ts";
import {
  STUCK_DELAY_MS as WEB_STUCK_DELAY_MS,
  THINKING_DELAY_MS as WEB_THINKING_DELAY_MS,
} from "../../../apps/web/src/features/call/watchdog.ts";
import {
  PAIRED_TAGS as WEB_PAIRED_TAGS,
  parseMarkup as webParseMarkup,
} from "../../../apps/web/src/lib/markup.ts";
import { AUDIO_QUALITIES as SERVER_AUDIO_QUALITIES } from "../../access/src/audio-quality.ts";
import { BOT_ABOUT } from "../../runtime/src/rtvi.ts";
import {
  AUDIO_QUALITIES,
  CHAT_FORMAT,
  CHAT_WINDOW_BYTES,
  CHAT_WINDOW_EVENTS,
  CHAT_WINDOW_MESSAGES,
  CUE_EMOJI,
  DEFAULT_CHAIN_LIMIT,
  isPauseCue,
  MAX_CHAIN_LIMIT,
  MAX_PARTICIPANTS,
  MAX_TEXT_LENGTH,
  MAX_VOICE_BYTES,
  MAX_VOICE_MS,
  PAIRED_TAGS,
  PUBLIC_CHAIN_LIMIT,
  parseBotReadyData,
  parseMarkup,
  REPLY_MODES,
  STUCK_DELAY_MS,
  selfiePaths,
  THINKING_DELAY_MS,
  VOICE_RECORDER_MIME_TYPES,
} from "../src/index.ts";

const ROOT = resolve(import.meta.dir, "../../..");

describe("server and client SDK protocol parity", () => {
  test("chat log format and window budgets match server constants", () => {
    expect(CHAT_FORMAT).toBe(SERVER_CHAT_FORMAT);
    expect(MAX_PARTICIPANTS).toBe(SERVER_MAX_PARTICIPANTS);
    expect(DEFAULT_CHAIN_LIMIT).toBe(SERVER_DEFAULT_CHAIN_LIMIT);
    expect(MAX_CHAIN_LIMIT).toBe(SERVER_MAX_CHAIN_LIMIT);
    expect(PUBLIC_CHAIN_LIMIT).toBe(SERVER_PUBLIC_CHAIN_LIMIT);
    expect(CHAT_WINDOW_EVENTS).toBe(SERVER_CHAT_WINDOW_EVENTS);
    expect(CHAT_WINDOW_BYTES).toBe(SERVER_CHAT_WINDOW_BYTES);
    expect(CHAT_WINDOW_MESSAGES).toBe(SERVER_CHAT_WINDOW_MESSAGES);
    expect(MAX_VOICE_MS).toBe(SERVER_MAX_VOICE_MS);
    expect(REPLY_MODES).toEqual(SERVER_REPLY_MODES);
  });

  test("route text and voice byte limits match apps/bot/src/chat/routes.ts", () => {
    const routesSource = readFileSync(join(ROOT, "apps/bot/src/chat/routes.ts"), "utf8");
    expect(routesSource).toContain(`const MAX_TEXT = ${MAX_TEXT_LENGTH};`);
    expect(routesSource).toContain("const MAX_VOICE_BYTES = 10 * 1024 * 1024;");
    expect(MAX_VOICE_BYTES).toBe(10 * 1024 * 1024);
  });

  test("audio qualities, markup cues, watchdog delays, selfie validation, and bot-ready match server and web", () => {
    expect(AUDIO_QUALITIES).toEqual(SERVER_AUDIO_QUALITIES);
    expect(PAIRED_TAGS).toEqual(WEB_PAIRED_TAGS);
    expect(THINKING_DELAY_MS).toBe(WEB_THINKING_DELAY_MS);
    expect(STUCK_DELAY_MS).toBe(WEB_STUCK_DELAY_MS);
    expect(VOICE_RECORDER_MIME_TYPES.length).toBeGreaterThan(0);

    for (const [cue, emoji] of CUE_EMOJI) {
      expect(webParseMarkup(`[${cue}]`)).toEqual([{ kind: "cue", start: 0, name: cue, emoji }]);
    }
    for (const pause of ["break", "long-break"]) {
      expect(isPauseCue(pause)).toBe(true);
      expect(parseMarkup(`[${pause}] hi`)).toEqual(webParseMarkup(`[${pause}] hi`));
    }

    const selfiePayload = {
      type: "selfie",
      urls: ["/api/selfie/ok_1.png", "https://evil.example/x.png", "/api/selfie/../bad.png"],
    };
    expect(selfiePaths(selfiePayload)).toEqual(webSelfiePaths(selfiePayload));

    const parsed = parseBotReadyData({
      version: "2.2.0",
      about: BOT_ABOUT,
    });
    expect(parsed.about).toEqual(BOT_ABOUT);
  });
});
