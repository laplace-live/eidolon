// An utterance over an HTTP speech API: a request per segment, at most two in flight, their audio
// played in the order the segments were said as it arrives.
import { errorText } from "@eidolon/config";
import { PcmBytes } from "../pcm.ts";
import type { Utterance } from "./index.ts";
import { AudioQueue, type SpokenText, scrubbed } from "./shared.ts";

const IN_FLIGHT = 2;

/** A failure whose message is what to report as it stands. */
export class SpeechError extends Error {
  override name = "SpeechError";
}

/** One segment's audio: little-endian 16-bit PCM bytes, in pieces of any length. */
export type FetchAudio = (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;

interface Job {
  readonly id: number;
  readonly text: string | null;
  readonly pcm: PcmBytes;
  /** Audio that came while an earlier segment was still playing. */
  held: Int16Array[];
  started: boolean;
  done: boolean;
}

export class HttpUtterance implements Utterance {
  readonly audio = new AudioQueue();
  readonly #text: SpokenText;
  readonly #fetchAudio: FetchAudio;
  readonly #secret: string;
  readonly #closed: AbortSignal;
  readonly #controller = new AbortController();
  readonly #cancel = () => this.cancel();
  #jobs: Job[] = [];
  #running = 0;
  #ended = false;

  /** `closed` aborts with the stream; `secret` never appears in an error. */
  constructor(
    text: SpokenText,
    fetchAudio: FetchAudio,
    options: { readonly closed: AbortSignal; readonly secret: string },
  ) {
    this.#text = text;
    this.#fetchAudio = fetchAudio;
    this.#secret = options.secret;
    this.#closed = options.closed;
    if (this.#closed.aborted) this.cancel();
    else this.#closed.addEventListener("abort", this.#cancel, { once: true });
  }

  say(segment: { readonly id: number; readonly text: string }): void {
    if (this.#ended || this.audio.closed) return;
    const text = this.#text.take(segment.text);
    this.#jobs.push({
      id: segment.id,
      text,
      pcm: new PcmBytes(),
      held: [],
      started: false,
      done: text === null,
    });
    this.#start();
    this.#settle();
  }

  end(): void {
    if (this.#ended || this.audio.closed) return;
    this.#ended = true;
    this.#settle();
  }

  cancel(): void {
    this.audio.drop();
    this.#stop();
  }

  #stop(): void {
    this.#ended = true;
    this.#jobs = [];
    this.#closed.removeEventListener("abort", this.#cancel);
    this.#controller.abort();
  }

  #start(): void {
    for (const job of this.#jobs) {
      if (this.#running >= IN_FLIGHT) return;
      if (job.started || job.text === null) continue;
      job.started = true;
      this.#running++;
      void this.#run(job, job.text);
    }
  }

  async #run(job: Job, text: string): Promise<void> {
    const { signal } = this.#controller;
    try {
      for await (const bytes of this.#fetchAudio(text, signal)) {
        const pcm = job.pcm.push(bytes);
        if (pcm.length === 0) continue;
        if (job === this.#jobs[0]) this.audio.push({ kind: "pcm", seg: job.id, pcm });
        else job.held.push(pcm);
      }
    } catch (error) {
      if (signal.aborted) return;
      const message =
        error instanceof SpeechError
          ? error.message
          : `Unknown error occurred: ${errorText(error)}`;
      this.audio.finish({ kind: "error", message: scrubbed(message, this.#secret) });
      this.#stop();
      return;
    } finally {
      this.#running--;
    }
    if (signal.aborted) return;
    job.done = true;
    this.#start();
    this.#settle();
  }

  /** Ends the segments at the head whose audio is all out, and the utterance once none are left. */
  #settle(): void {
    while (this.#jobs[0]?.done) {
      const job = this.#jobs.shift() as Job;
      this.audio.push({ kind: "seg-end", seg: job.id });
      const next = this.#jobs[0];
      if (next === undefined) break;
      for (const pcm of next.held) this.audio.push({ kind: "pcm", seg: next.id, pcm });
      next.held = [];
    }
    if (this.#ended && this.#jobs.length === 0 && !this.audio.closed) {
      this.#closed.removeEventListener("abort", this.#cancel);
      this.audio.finish({ kind: "end" });
    }
  }
}
