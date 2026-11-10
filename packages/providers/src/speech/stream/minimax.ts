// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/minimax/src/tts.ts@ce8f8bc
//
// MiniMax's T2A HTTP API, streamed: the body is `data:` blocks of JSON whose audio is hex PCM.
import { logger, pyJsonDumps } from "@eidolon/config";
import { voiceOf } from "../../resolve.ts";
import { HttpUtterance, SpeechError } from "./http.ts";
import type { SpeechStream, Utterance } from "./index.ts";
import { type KeyedSelection, SpokenText } from "./shared.ts";

const SAMPLE_RATE = 24000;
/** pipedog's voice when none is set. */
const DEFAULT_VOICE = "Calm_Woman";
const MARKER = "data:";

/** A block's audio; nothing for one that carries `extra_info`, the whole reply's audio again. */
function audioOf(block: string): Uint8Array | null {
  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch {
    logger.error(`MiniMax sent a block that isn't JSON: ${block.slice(0, 100)}`);
    return null;
  }
  if (typeof data !== "object" || data === null || "extra_info" in data) return null;
  const audio = (data as { data?: { audio?: unknown } }).data?.audio;
  return typeof audio === "string" && audio !== ""
    ? new Uint8Array(Buffer.from(audio, "hex"))
    : null;
}

export class MiniMaxSpeech implements SpeechStream {
  readonly sampleRate = SAMPLE_RATE;
  readonly #selection: KeyedSelection;
  readonly #text: SpokenText;
  readonly #controller = new AbortController();
  readonly #url: string;
  readonly #voice: string;

  constructor(selection: KeyedSelection) {
    const groupId = selection.options.groupId;
    if (!groupId) {
      throw new Error(
        selection.account.isDefault
          ? "MiniMax needs a group id: set MINIMAX_GROUP_ID"
          : `The ${selection.account.name} account needs a group id: set it in Settings → Providers`,
      );
    }
    this.#selection = selection;
    this.#text = new SpokenText(selection);
    this.#url = `${(selection.baseUrl as string).replace(/\/+$/, "")}/t2a_v2?GroupId=${groupId}`;
    this.#voice = voiceOf(selection) ?? DEFAULT_VOICE;
  }

  utterance(voice: string | null): Utterance {
    const { apiKey } = this.#selection;
    return new HttpUtterance(
      this.#text,
      (text, signal) => this.#audio(text, voice ?? this.#voice, signal),
      { closed: this.#controller.signal, secret: apiKey },
    );
  }

  async close(): Promise<void> {
    this.#controller.abort();
    this.#text.flush();
  }

  async *#audio(text: string, voice: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#selection.apiKey}`,
      },
      body: pyJsonDumps({
        stream: true,
        voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { bitrate: 128000, format: "pcm", channel: 1, sample_rate: SAMPLE_RATE },
        model: this.#selection.model,
        text,
      }),
      signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new SpeechError(`MiniMax TTS error: HTTP ${response.status}`);
    }
    if (response.body === null) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      // A block is whole once the next one has begun.
      for (;;) {
        const start = buffer.indexOf(MARKER);
        const next = start < 0 ? -1 : buffer.indexOf(MARKER, start + MARKER.length);
        if (next < 0) {
          if (start > 0) buffer = buffer.slice(start);
          break;
        }
        const audio = audioOf(buffer.slice(start + MARKER.length, next));
        if (audio !== null) yield audio;
        buffer = buffer.slice(next);
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith(MARKER)) {
      const audio = audioOf(buffer.slice(MARKER.length));
      if (audio !== null) yield audio;
    }
  }
}
