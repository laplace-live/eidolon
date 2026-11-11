// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/soniox/src/tts.ts@ce8f8bc
//
// Soniox's TTS socket: one per stream, carrying a stream per utterance, each opened by a config
// message that names its voice. Character timestamps count from the stream's start.
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

export const SONIOX_URL = "wss://tts-rt.soniox.com/tts-websocket";
const SAMPLE_RATE = 24000;
// Soniox drops a socket idle for 20 to 30 s.
const KEEPALIVE_MS = 20_000;
/** pipedog's voice when none is set. */
const DEFAULT_VOICE = "Bryce";

const decoder = new TextDecoder();

class SonioxUtterance implements Utterance {
  readonly audio = new AudioQueue();
  readonly id = crypto.randomUUID();
  readonly #stream: SonioxSpeech;
  readonly #link: SocketLink;
  readonly #timeline = new WordTimeline(SAMPLE_RATE, this.audio);
  readonly #pcm = new PcmBytes();
  #said = false;
  #ended = false;

  constructor(stream: SonioxSpeech, link: SocketLink, voice: string) {
    this.#stream = stream;
    this.#link = link;
    const { model } = stream.selection;
    const { language } = stream;
    // Opened before its text comes, so Soniox sets it up while the first sentence is still being
    // written.
    link.send(
      pyJsonDumps({
        stream_id: this.id,
        model,
        voice,
        audio_format: "pcm_s16le",
        ...(language === null ? {} : { language }),
        return_timestamps: true,
        sample_rate: SAMPLE_RATE,
      }),
    );
  }

  say(segment: { readonly id: number; readonly text: string }): void {
    if (this.#ended || this.audio.closed) return;
    const text = this.#stream.text.take(segment.text);
    this.#timeline.say(segment.id, text ?? "");
    if (text === null) return;
    this.#said = true;
    this.#link.send(pyJsonDumps({ text, text_end: false, stream_id: this.id }));
  }

  end(): void {
    if (this.#ended || this.audio.closed) return;
    this.#ended = true;
    if (!this.#said) {
      this.#cancelStream();
      this.#timeline.finish();
      return;
    }
    this.#link.send(pyJsonDumps({ text: "", text_end: true, stream_id: this.id }));
  }

  cancel(): void {
    if (this.audio.closed) return;
    this.#ended = true;
    this.audio.drop();
    this.#cancelStream();
  }

  message(message: Record<string, unknown>): void {
    const code = message.error_code;
    if (code !== undefined && code !== null) {
      this.#stream.streams.delete(this.id);
      this.lost(
        `Soniox TTS error ${String(code)} ${String(message.error_type ?? "")} (stream ${this.id}): ` +
          String(message.error_message ?? ""),
      );
      return;
    }
    if (message.terminated) {
      this.#stream.streams.delete(this.id);
      this.#timeline.finish();
      return;
    }
    const timestamps = message.timestamps;
    if (isPlainObject(timestamps)) {
      const chars = Array.isArray(timestamps.characters) ? timestamps.characters.map(String) : [];
      const starts = Array.isArray(timestamps.character_start_times_seconds)
        ? timestamps.character_start_times_seconds.map((seconds) => Number(seconds) * 1000)
        : [];
      this.#timeline.chars(chars, starts);
    }
    if (typeof message.audio === "string" && message.audio !== "") {
      this.#timeline.audio(this.#pcm.push(bytesOfBase64(message.audio)));
    }
  }

  lost(error: string | null): void {
    if (error === null) this.audio.drop();
    else
      this.audio.finish({ kind: "error", message: scrubbed(error, this.#stream.selection.apiKey) });
  }

  #cancelStream(): void {
    this.#stream.streams.delete(this.id);
    this.#link.send(pyJsonDumps({ stream_id: this.id, cancel: true }));
  }
}

export class SonioxSpeech implements SpeechStream {
  readonly sampleRate = SAMPLE_RATE;
  readonly selection: KeyedSelection;
  readonly text: SpokenText;
  readonly language = speechLanguage();
  readonly streams = new Map<string, SonioxUtterance>();
  readonly #controller = new AbortController();
  readonly #voice: string;
  #link: SocketLink;

  constructor(selection: KeyedSelection) {
    this.selection = selection;
    this.text = new SpokenText(selection);
    this.#voice = voiceOf(selection) ?? DEFAULT_VOICE;
    this.#link = this.#connect();
  }

  utterance(voice: string | null): Utterance {
    if (!this.#link.alive) this.#link = this.#connect();
    const utterance = new SonioxUtterance(this, this.#link, voice ?? this.#voice);
    this.streams.set(utterance.id, utterance);
    return utterance;
  }

  async close(): Promise<void> {
    this.#controller.abort();
    this.text.flush();
    await this.#link.close();
  }

  #connect(): SocketLink {
    return new SocketLink({
      url: accountUrl(this.selection, SONIOX_URL),
      headers: { Authorization: `Bearer ${this.selection.apiKey}` },
      signal: this.#controller.signal,
      provider: "Soniox TTS",
      onMessage: (data) => this.#message(data),
      onEnd: (error) => {
        for (const stream of this.streams.values()) stream.lost(error);
        this.streams.clear();
      },
      refused: (detail) => `Unable to connect to Soniox TTS: ${detail}`,
      keepalive: { everyMs: KEEPALIVE_MS, message: () => pyJsonDumps({ keep_alive: true }) },
    });
  }

  #message(data: WsData): void {
    const message: unknown = JSON.parse(typeof data === "string" ? data : decoder.decode(data));
    if (!isPlainObject(message)) return;
    this.streams.get(String(message.stream_id))?.message(message);
  }
}
