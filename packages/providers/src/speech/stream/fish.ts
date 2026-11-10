// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/fish/src/tts.ts@ce8f8bc
//
// Fish Audio's live socket, one session per utterance: `start` names the voice, each segment goes
// as `text` and `flush`, and `stop` ends it, after which `finish` marks the exact end of its audio.
// Fish marks no segment boundaries, so segments go one at a time: the next is flushed once the
// last one's audio has gone quiet, which is where that segment ends. A session for the next
// utterance opens as one ends, so an utterance rarely waits for a handshake.
import { isPlainObject, logger } from "@eidolon/config";
import { voiceOf } from "../../resolve.ts";
import { accountUrl } from "../../stt/stream.ts";
import type { WsData } from "../../ws.ts";
import { PcmBytes } from "../pcm.ts";
import type { SpeechStream, Utterance } from "./index.ts";
import { packMsg, unpackMsg } from "./msgpack.ts";
import {
  AudioQueue,
  type KeyedSelection,
  SocketLink,
  SPEECH_STALL_MS,
  SPEECH_STALLED,
  SpokenText,
  scrubbed,
} from "./shared.ts";

export const FISH_URL = "wss://api.fish.audio/v1/tts/live";
const SAMPLE_RATE = 44100;
// A flush's audio came in one burst, so this is the event loop's margin alone
// (docs/benchmarks/2026-11-10-fish-flush).
export const FISH_SEGMENT_IDLE_MS = 100;

class Session {
  readonly voice: string | null;
  readonly link: SocketLink;
  owner: FishUtterance | null = null;

  constructor(stream: FishSpeech, voice: string | null) {
    this.voice = voice;
    const { apiKey, model } = stream.selection;
    this.link = new SocketLink({
      url: accountUrl(stream.selection, FISH_URL),
      headers: { Authorization: `Bearer ${apiKey}`, model },
      signal: stream.signal,
      provider: "Fish Audio",
      onMessage: (data) => this.owner?.message(data),
      onEnd: (error) => this.owner?.lost(error === null ? null : scrubbed(error, apiKey)),
      refused: (detail) => `Unknown error occurred: ${detail}`,
    });
    // The settings production pinned: Fish's best-quality latency mode, and no number
    // normalization, which reads years as cardinals.
    this.link.send(
      packMsg({
        event: "start",
        request: {
          text: "",
          sample_rate: SAMPLE_RATE,
          latency: "normal",
          format: "pcm",
          normalize: false,
          prosody: { speed: 1, volume: 0 },
          reference_id: voice,
        },
      }),
    );
  }
}

class FishUtterance implements Utterance {
  readonly audio = new AudioQueue();
  readonly #stream: FishSpeech;
  readonly #session: Session;
  readonly #pcm = new PcmBytes();
  /** Said, waiting for the segment flushed before them to end. */
  #queue: { readonly id: number; readonly text: string }[] = [];
  /** The segment flushed whose audio hasn't ended, and the last one flushed. */
  #flushed: number | null = null;
  #last: number | null = null;
  /** The flushed segment's stall until its first audio, then its idle after each. */
  #timer: ReturnType<typeof setTimeout> | undefined;
  #said = false;
  #ended = false;
  #stopped = false;

  constructor(stream: FishSpeech, session: Session) {
    this.#stream = stream;
    this.#session = session;
    session.owner = this;
  }

  say(segment: { readonly id: number; readonly text: string }): void {
    if (this.#ended || this.audio.closed) return;
    this.#queue.push(segment);
    this.#next();
  }

  end(): void {
    if (this.#ended || this.audio.closed) return;
    this.#ended = true;
    this.#next();
    // Here, not at the deferred stop: by then a voice switch's utterance may have ended and left
    // the spare in its voice, which this would replace.
    if (this.#said) this.#stream.preopen(this.#session.voice);
  }

  cancel(): void {
    if (this.audio.closed) return;
    this.#ended = true;
    this.#queue = [];
    this.#disarm();
    this.audio.drop();
    this.#release();
    if (this.#said) {
      void this.#session.link.close();
      this.#stream.preopen(this.#session.voice);
    } else {
      this.#stream.keep(this.#session);
    }
  }

  message(data: WsData): void {
    if (typeof data === "string") return;
    const message = unpackMsg(data);
    if (!isPlainObject(message)) return;
    if (message.event === "audio" && message.audio instanceof Uint8Array) {
      const seg = this.#flushed ?? this.#last;
      if (seg === null) return;
      const pcm = this.#pcm.push(message.audio);
      if (pcm.length > 0) this.audio.push({ kind: "pcm", seg, pcm });
      if (this.#flushed !== null) this.#arm(FISH_SEGMENT_IDLE_MS, () => this.#segmentEnded());
    } else if (message.event === "finish") {
      this.#disarm();
      this.#release();
      void this.#session.link.close();
      if (message.reason === "error") {
        this.audio.finish({ kind: "error", message: "Fish Audio server error during synthesis" });
      } else {
        logger.debug(`Fish Audio session finished: ${String(message.reason ?? "unknown")}`);
        if (this.#flushed !== null) this.audio.push({ kind: "seg-end", seg: this.#flushed });
        this.audio.finish({ kind: "end" });
      }
    }
  }

  lost(error: string | null): void {
    this.#disarm();
    this.#release();
    if (error === null) this.audio.drop();
    else this.audio.finish({ kind: "error", message: error });
  }

  /** Flushes the next segment once none is in flight, and stops once the last has been flushed. */
  #next(): void {
    while (this.#flushed === null) {
      const segment = this.#queue.shift();
      if (segment === undefined) break;
      const text = this.#stream.text.take(segment.text);
      if (text === null) {
        this.audio.push({ kind: "seg-end", seg: segment.id });
        continue;
      }
      this.#said = true;
      this.#flushed = segment.id;
      this.#last = segment.id;
      this.#session.link.send(packMsg({ event: "text", text }));
      this.#session.link.send(packMsg({ event: "flush" }));
      this.#arm(SPEECH_STALL_MS, () => this.#stalled());
    }
    if (!this.#ended || this.#stopped || this.#queue.length > 0) return;
    this.#stopped = true;
    if (!this.#said) {
      this.#release();
      this.audio.finish({ kind: "end" });
      this.#stream.keep(this.#session);
      return;
    }
    this.#session.link.send(packMsg({ event: "stop" }));
  }

  #segmentEnded(): void {
    if (this.#flushed === null || this.audio.closed) return;
    this.audio.push({ kind: "seg-end", seg: this.#flushed });
    this.#flushed = null;
    this.#next();
  }

  #stalled(): void {
    if (this.audio.closed) return;
    this.#queue = [];
    this.#release();
    this.audio.finish({ kind: "error", message: SPEECH_STALLED });
    void this.#session.link.close();
    this.#stream.preopen(this.#session.voice);
  }

  #arm(ms: number, then: () => void): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(then, ms);
  }

  #disarm(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #release(): void {
    if (this.#session.owner === this) this.#session.owner = null;
  }
}

export class FishSpeech implements SpeechStream {
  readonly sampleRate = SAMPLE_RATE;
  readonly selection: KeyedSelection;
  readonly text: SpokenText;
  readonly #controller = new AbortController();
  readonly #voice: string | null;
  readonly #sessions = new Set<Session>();
  #spare: Session | null = null;

  constructor(selection: KeyedSelection) {
    this.selection = selection;
    this.text = new SpokenText(selection);
    this.#voice = voiceOf(selection) ?? null;
    this.preopen(this.#voice);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  utterance(voice: string | null): Utterance {
    const wanted = voice ?? this.#voice;
    let session = this.#spare;
    if (session !== null && session.voice === wanted && session.link.alive) this.#spare = null;
    else session = this.#open(wanted);
    return new FishUtterance(this, session);
  }

  /** Opens the session the next utterance in `voice` takes, unless one is ready. */
  preopen(voice: string | null): void {
    const spare = this.#spare;
    if (this.signal.aborted || (spare !== null && spare.voice === voice && spare.link.alive)) {
      return;
    }
    this.keep(this.#open(voice));
  }

  /** Makes `session`, with nothing said on it, the next utterance's. */
  keep(session: Session): void {
    if (this.signal.aborted || !session.link.alive) {
      void session.link.close();
      return;
    }
    if (this.#spare !== null && this.#spare !== session) void this.#spare.link.close();
    this.#spare = session;
  }

  async close(): Promise<void> {
    this.#controller.abort();
    this.text.flush();
    await Promise.all([...this.#sessions].map((session) => session.link.close()));
  }

  #open(voice: string | null): Session {
    const session = new Session(this, voice);
    this.#sessions.add(session);
    void session.link.ended.then(() => this.#sessions.delete(session));
    return session;
  }
}
