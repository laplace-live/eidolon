// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/elevenlabs/src/tts.ts@ce8f8bc and packages/elevenlabs/src/tts_base.ts@ce8f8bc
//
// ElevenLabs' multi-context socket: one per voice, since the voice is in its URL, and a context per
// utterance. Each message's alignment times its own chunk's characters from that chunk's start.
import { isPlainObject, pyJsonDumps } from "@eidolon/config";
import { voiceOf } from "../../resolve.ts";
import type { WsData } from "../../ws.ts";
import { bytesOfBase64, PcmBytes } from "../pcm.ts";
import type { SpeechStream, Utterance } from "./index.ts";
import {
  AudioQueue,
  type KeyedSelection,
  SocketLink,
  SpokenText,
  scrubbed,
  socketUrl,
  within,
} from "./shared.ts";
import { WordTimeline } from "./timeline.ts";

export const ELEVENLABS_URL = "wss://api.elevenlabs.io";
const SAMPLE_RATE = 24000;
// ElevenLabs closes a socket that has been quiet for 20 s.
const KEEPALIVE_MS = 10_000;
const CLOSE_WAIT_MS = 2_000;

const decoder = new TextDecoder();

/** pipedog read `alignment`, falling back to `normalizedAlignment` when it is missing or empty. */
function alignmentOf(message: Record<string, unknown>): Record<string, unknown> | null {
  for (const candidate of [message.alignment, message.normalizedAlignment]) {
    if (isPlainObject(candidate) && Object.keys(candidate).length > 0) return candidate;
  }
  return null;
}

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

class Connection {
  readonly link: SocketLink;
  readonly contexts = new Map<string, ElevenLabsUtterance>();

  constructor(stream: ElevenLabsSpeech, voice: string | null) {
    const { apiKey, model } = stream.selection;
    const url =
      `${ELEVENLABS_URL}/v1/text-to-speech/${voice}/multi-stream-input` +
      `?model_id=${model}&output_format=pcm_${SAMPLE_RATE}&auto_mode=true`;
    this.link = new SocketLink({
      url: socketUrl(stream.selection, url),
      headers: { "xi-api-key": apiKey },
      signal: stream.signal,
      provider: "ElevenLabs",
      onMessage: (data) => this.#message(data),
      onEnd: (error) => this.drop(error === null ? null : scrubbed(error, apiKey)),
      refused: (detail) => `Unknown error occurred: ${detail}`,
      keepalive: { everyMs: KEEPALIVE_MS, message: () => pyJsonDumps(this.#keepalive()) },
    });
  }

  send(message: Record<string, unknown>): void {
    this.link.send(pyJsonDumps(message));
  }

  /** Ends every open context: with `error`, or quietly. */
  drop(error: string | null): void {
    for (const context of this.contexts.values()) context.lost(error);
    this.contexts.clear();
  }

  // A context's first message carries its voice settings, so a keepalive naming it before then
  // makes ElevenLabs refuse the context with a 1008.
  #keepalive(): Record<string, unknown> {
    const open = [...this.contexts.values()].filter((context) => context.keepsAlive);
    const latest = open.at(-1);
    return latest === undefined ? { text: "" } : { text: "", context_id: latest.id };
  }

  #message(data: WsData): void {
    const message: unknown = JSON.parse(typeof data === "string" ? data : decoder.decode(data));
    if (!isPlainObject(message)) return;
    this.contexts.get(String(message.contextId))?.message(message);
  }
}

class ElevenLabsUtterance implements Utterance {
  readonly audio = new AudioQueue();
  readonly id = crypto.randomUUID();
  readonly #stream: ElevenLabsSpeech;
  readonly #connection: Connection;
  readonly #timeline = new WordTimeline(SAMPLE_RATE, this.audio);
  readonly #pcm = new PcmBytes();
  #opened = false;
  #closed = false;
  #ended = false;

  constructor(stream: ElevenLabsSpeech, connection: Connection) {
    this.#stream = stream;
    this.#connection = connection;
    connection.contexts.set(this.id, this);
  }

  get keepsAlive(): boolean {
    return this.#opened && !this.#closed;
  }

  say(segment: { readonly id: number; readonly text: string }): void {
    if (this.#ended || this.audio.closed) return;
    const text = this.#stream.text.take(segment.text);
    this.#timeline.say(segment.id, text ?? "");
    if (text === null) return;
    if (!this.#opened) {
      this.#opened = true;
      this.#connection.send({ text: " ", context_id: this.id });
    }
    this.#connection.send({ text, context_id: this.id });
  }

  end(): void {
    if (this.#ended || this.audio.closed) return;
    this.#ended = true;
    if (!this.#opened) {
      this.#connection.contexts.delete(this.id);
      this.#timeline.finish();
      return;
    }
    this.#connection.send({ context_id: this.id, flush: true });
    this.#close();
  }

  cancel(): void {
    if (this.audio.closed) return;
    this.#ended = true;
    this.audio.drop();
    this.#connection.contexts.delete(this.id);
    if (this.#opened) this.#close();
  }

  message(message: Record<string, unknown>): void {
    if (message.isFinal === true) {
      this.#connection.contexts.delete(this.id);
      this.#timeline.finish();
      return;
    }
    const alignment = alignmentOf(message);
    if (alignment !== null) {
      const offset = this.#timeline.deliveredMs;
      const starts = numbers(alignment.charStartTimesMs).map((ms) => offset + ms);
      this.#timeline.chars(strings(alignment.chars), starts);
    }
    if (typeof message.audio === "string" && message.audio !== "") {
      this.#timeline.audio(this.#pcm.push(bytesOfBase64(message.audio)));
    }
  }

  lost(error: string | null): void {
    if (error === null) this.audio.drop();
    else this.audio.finish({ kind: "error", message: error });
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.send({ context_id: this.id, close_context: true });
  }
}

export class ElevenLabsSpeech implements SpeechStream {
  readonly sampleRate = SAMPLE_RATE;
  readonly selection: KeyedSelection;
  readonly text: SpokenText;
  readonly #controller = new AbortController();
  readonly #voice: string | null;
  readonly #connections = new Map<string | null, Connection>();

  constructor(selection: KeyedSelection) {
    this.selection = selection;
    this.text = new SpokenText(selection);
    this.#voice = voiceOf(selection) ?? null;
    this.#connection(this.#voice);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  utterance(voice: string | null): Utterance {
    return new ElevenLabsUtterance(this, this.#connection(voice ?? this.#voice));
  }

  async close(): Promise<void> {
    this.text.flush();
    // ElevenLabs closes the socket once asked to; closing first races it into a 1006.
    await Promise.all(
      [...this.#connections.values()].map(async (connection) => {
        connection.drop(null);
        if (connection.link.open) {
          connection.send({ close_socket: true });
          await within(connection.link.ended, CLOSE_WAIT_MS);
        }
        await connection.link.close();
      }),
    );
    this.#controller.abort();
  }

  #connection(voice: string | null): Connection {
    const existing = this.#connections.get(voice);
    if (existing?.link.alive) return existing;
    const connection = new Connection(this, voice);
    this.#connections.set(voice, connection);
    return connection;
  }
}
