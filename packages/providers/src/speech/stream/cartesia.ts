// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/cartesia/src/tts.ts@ce8f8bc
//
// Cartesia's socket: one per stream, a context per utterance, with the voice in every message. Its
// word timestamps count from the context's start.
import { isPlainObject, pyJsonDumps } from "@eidolon/config";
import { voiceOf } from "../../resolve.ts";
import { accountUrl } from "../../stt/stream.ts";
import type { WsData } from "../../ws.ts";
import { bytesOfBase64, PcmBytes } from "../pcm.ts";
import type { SpeechStream, Utterance } from "./index.ts";
import {
  AudioQueue,
  type KeyedSelection,
  SocketLink,
  SpokenText,
  scrubbed,
  speechLanguage,
} from "./shared.ts";
import { WordTimeline } from "./timeline.ts";

export const CARTESIA_URL = "wss://api.cartesia.ai/tts/websocket";
/** The API version pipedog's messages are written against. */
const CARTESIA_VERSION = "2026-03-01";
const SAMPLE_RATE = 24000;
/** Cartesia's SSML tags, which its word timestamps can carry. */
const TAGS = /<\/?(?:spell|emotion|break|volume|speed)\b[^>]*>/gi;

const decoder = new TextDecoder();
const untagged = (text: string) => text.replace(TAGS, "");

class CartesiaUtterance implements Utterance {
  readonly audio = new AudioQueue();
  readonly id = crypto.randomUUID();
  readonly #stream: CartesiaSpeech;
  readonly #link: SocketLink;
  readonly #voice: string | null;
  readonly #timeline = new WordTimeline(SAMPLE_RATE, this.audio);
  readonly #pcm = new PcmBytes();
  #said = false;
  #ended = false;

  constructor(stream: CartesiaSpeech, link: SocketLink, voice: string | null) {
    this.#stream = stream;
    this.#link = link;
    this.#voice = voice;
  }

  say(segment: { readonly id: number; readonly text: string }): void {
    if (this.#ended || this.audio.closed) return;
    const text = this.#stream.text.take(segment.text);
    this.#timeline.say(segment.id, untagged(text ?? ""));
    if (text === null) return;
    this.#said = true;
    this.#link.send(this.#message(text, true));
  }

  end(): void {
    if (this.#ended || this.audio.closed) return;
    this.#ended = true;
    if (!this.#said) {
      this.#stream.contexts.delete(this.id);
      this.#timeline.finish();
      return;
    }
    this.#link.send(this.#message("", false));
  }

  cancel(): void {
    if (this.audio.closed) return;
    this.#ended = true;
    this.audio.drop();
    this.#stream.contexts.delete(this.id);
    if (this.#said) this.#link.send(pyJsonDumps({ context_id: this.id, cancel: true }));
  }

  message(message: Record<string, unknown>): void {
    switch (message.type) {
      case "chunk":
        if (typeof message.data === "string") {
          this.#timeline.audio(this.#pcm.push(bytesOfBase64(message.data)));
        }
        return;
      case "timestamps": {
        const timestamps = isPlainObject(message.word_timestamps) ? message.word_timestamps : {};
        const words = Array.isArray(timestamps.words) ? timestamps.words.map(String) : [];
        const starts = Array.isArray(timestamps.start) ? timestamps.start.map(Number) : [];
        this.#timeline.words(
          words.map(untagged),
          starts.map((seconds) => seconds * 1000),
        );
        return;
      }
      case "done":
        this.#stream.contexts.delete(this.id);
        this.#timeline.finish();
        return;
      case "error":
        this.#stream.contexts.delete(this.id);
        this.lost(`Error: ${JSON.stringify(message)}`);
        return;
    }
  }

  lost(error: string | null): void {
    if (error === null) this.audio.drop();
    else
      this.audio.finish({ kind: "error", message: scrubbed(error, this.#stream.selection.apiKey) });
  }

  #message(transcript: string, more: boolean): string {
    const { model } = this.#stream.selection;
    const language = this.#stream.language;
    return pyJsonDumps({
      transcript,
      continue: more,
      context_id: this.id,
      model_id: model,
      voice: { mode: "id", id: this.#voice },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
      add_timestamps: true,
      use_normalized_timestamps: false,
      // Cartesia's own buffering stacked on the segmenter's would only add latency.
      max_buffer_delay_ms: 0,
      ...(language === null ? {} : { language }),
    });
  }
}

export class CartesiaSpeech implements SpeechStream {
  readonly sampleRate = SAMPLE_RATE;
  readonly selection: KeyedSelection;
  readonly text: SpokenText;
  readonly language = speechLanguage();
  readonly contexts = new Map<string, CartesiaUtterance>();
  readonly #controller = new AbortController();
  readonly #voice: string | null;
  #link: SocketLink;

  constructor(selection: KeyedSelection) {
    this.selection = selection;
    this.text = new SpokenText(selection);
    this.#voice = voiceOf(selection) ?? null;
    this.#link = this.#connect();
  }

  utterance(voice: string | null): Utterance {
    // Cartesia drops a socket after five idle minutes.
    if (!this.#link.alive) this.#link = this.#connect();
    const utterance = new CartesiaUtterance(this, this.#link, voice ?? this.#voice);
    this.contexts.set(utterance.id, utterance);
    return utterance;
  }

  async close(): Promise<void> {
    this.#controller.abort();
    this.text.flush();
    await this.#link.close();
  }

  #connect(): SocketLink {
    const { apiKey } = this.selection;
    return new SocketLink({
      url: accountUrl(this.selection, CARTESIA_URL),
      headers: { "X-API-Key": apiKey, "Cartesia-Version": CARTESIA_VERSION },
      signal: this.#controller.signal,
      provider: "Cartesia",
      onMessage: (data) => this.#message(data),
      onEnd: (error) => {
        for (const context of this.contexts.values()) context.lost(error);
        this.contexts.clear();
      },
      refused: (detail) => `Unknown error occurred: ${detail}`,
    });
  }

  #message(data: WsData): void {
    const message: unknown = JSON.parse(typeof data === "string" ? data : decoder.decode(data));
    if (!isPlainObject(message)) return;
    this.contexts.get(String(message.context_id))?.message(message);
  }
}
