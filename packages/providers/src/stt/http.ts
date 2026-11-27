// HTTP Whisper-compatible STT (`POST {baseUrl}/audio/transcriptions`), segmented by the Ear's VAD.
import { AsyncQueue, errorText, withoutTrailingSlashes } from "@eidolon/config";
import { Meter } from "../meter.ts";
import { ProviderConfigError, type Selection } from "../resolve.ts";
import { scrubbed } from "../speech/stream/shared.ts";
import { encodeWav } from "../speech/wav.ts";
import type { SttEvent, SttStream } from "./index.ts";

const SAMPLE_RATE = 16000;
const TTFS_P99 = 1.5;
// Retain 500 ms before the VAD's started edge (VAD triggers ~200 ms after speech onset).
const PRE_ROLL_SAMPLES = SAMPLE_RATE * 0.5;
const MIN_SPEECH_SAMPLES = SAMPLE_RATE * 0.1;
const MAX_UTTERANCE_SAMPLES = SAMPLE_RATE * 60;
const REQUEST_TIMEOUT_MS = 30_000;

class HttpWhisperStt implements SttStream {
  readonly inputRate = SAMPLE_RATE;
  readonly ttfsP99 = TTFS_P99;
  readonly acknowledgesFinalize = true;
  readonly finalizeTimeoutMs: number;
  readonly events = new AsyncQueue<SttEvent>();

  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #model: string;
  readonly #language: string | null;
  readonly #secret: string;
  readonly #meter: Meter;
  readonly #timeoutMs: number;
  readonly #maxUtteranceSamples: number;
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #detach: () => void;

  #preRoll: Int16Array[] = [];
  #preRollSamples = 0;
  #utterance: Int16Array[] = [];
  #utteranceSamples = 0;
  #inSpeech = false;
  #closed = false;
  #chain: Promise<void> = Promise.resolve();

  constructor(
    selection: Selection,
    language: string | null,
    signal: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxUtteranceSamples = MAX_UTTERANCE_SAMPLES,
  ) {
    if (!selection.baseUrl) {
      throw new ProviderConfigError(`${selection.account.name} needs an API base`);
    }
    this.#url = `${withoutTrailingSlashes(selection.baseUrl)}/audio/transcriptions`;
    this.#secret = selection.apiKey ?? "";
    this.#headers = selection.apiKey ? { Authorization: `Bearer ${selection.apiKey}` } : {};
    this.#model = selection.model;
    this.#language = language;
    this.#meter = new Meter(selection);
    this.#timeoutMs = timeoutMs;
    this.#maxUtteranceSamples = maxUtteranceSamples;
    this.finalizeTimeoutMs = timeoutMs + 1_000;
    this.#signal = AbortSignal.any([signal, this.#controller.signal]);
    const onAbort = () => void this.close();
    if (signal.aborted) {
      this.#detach = () => {};
      void this.close();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      this.#detach = () => signal.removeEventListener("abort", onAbort);
    }
  }

  speechStarted(): void {
    if (this.#closed || this.#inSpeech) return;
    if (this.#preRollSamples > 0) {
      this.#utterance.push(...this.#preRoll);
      this.#utteranceSamples += this.#preRollSamples;
      this.#preRoll = [];
      this.#preRollSamples = 0;
    }
    this.#inSpeech = true;
  }

  send(pcm: Int16Array): void {
    if (this.#closed || pcm.length === 0) return;
    const copy = pcm.slice();
    if (this.#inSpeech) {
      let offset = 0;
      while (offset < copy.length) {
        const remaining = this.#maxUtteranceSamples - this.#utteranceSamples;
        const slice =
          copy.length - offset > remaining
            ? copy.subarray(offset, offset + remaining)
            : copy.subarray(offset);
        this.#utterance.push(slice);
        this.#utteranceSamples += slice.length;
        offset += slice.length;
        if (this.#utteranceSamples >= this.#maxUtteranceSamples) {
          this.#flushUtterance(false);
        }
      }
      return;
    }
    this.#preRoll.push(copy);
    this.#preRollSamples += copy.length;
    while (this.#preRollSamples > PRE_ROLL_SAMPLES && this.#preRoll.length > 0) {
      const oldest = this.#preRoll[0] as Int16Array;
      const excess = this.#preRollSamples - PRE_ROLL_SAMPLES;
      if (oldest.length <= excess) {
        this.#preRoll.shift();
        this.#preRollSamples -= oldest.length;
      } else {
        this.#preRoll[0] = oldest.subarray(excess);
        this.#preRollSamples -= excess;
      }
    }
  }

  finalize(): void {
    if (this.#closed) return;
    const hadSpeech = this.#inSpeech;
    this.#inSpeech = false;
    if (!hadSpeech || this.#utteranceSamples < MIN_SPEECH_SAMPLES) {
      this.#utterance = [];
      this.#utteranceSamples = 0;
      this.#chain = this.#chain.then(() => {
        if (!this.#closed) this.events.push({ type: "finalized" });
      });
      return;
    }
    this.#flushUtterance(true);
  }

  #flushUtterance(finalized: boolean): void {
    const sampleCount = this.#utteranceSamples;
    const chunks = this.#utterance;
    this.#utterance = [];
    this.#utteranceSamples = 0;
    const samples = concatPcm(chunks, sampleCount);
    this.#chain = this.#chain.then(() => this.#transcribe(samples, finalized));
  }

  async #transcribe(samples: Int16Array, finalized: boolean): Promise<void> {
    if (this.#closed || this.#signal.aborted) return;
    const wav = encodeWav(samples, SAMPLE_RATE);
    const form = new FormData();
    form.append("model", this.#model);
    if (this.#language !== null) form.append("language", this.#language);
    form.append("response_format", "json");
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    this.#meter.add({ audioSeconds: samples.length / SAMPLE_RATE });
    this.#meter.flush();
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([this.#signal, timeout]);
    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: this.#headers,
        body: form,
        signal,
      });
      if (!response.ok) {
        const body = scrubbed(await response.text(), this.#secret);
        if (!this.#closed) {
          this.events.push({
            type: "error",
            message: `OpenAI-compatible STT error (${response.status}): ${body || response.statusText}`,
            fatal: false,
          });
          if (finalized) this.events.push({ type: "finalized" });
        }
        return;
      }
      const parsed = (await response.json()) as { readonly text?: unknown };
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (!this.#closed) {
        if (text) this.events.push({ type: "final", text, finalized });
        else if (finalized) this.events.push({ type: "finalized" });
      }
    } catch (error) {
      if (this.#closed || this.#signal.aborted) return;
      const message = timeout.aborted
        ? `OpenAI-compatible STT timed out after ${this.#timeoutMs / 1000} s`
        : `OpenAI-compatible STT error: ${scrubbed(errorText(error), this.#secret)}`;
      this.events.push({
        type: "error",
        message,
        fatal: false,
      });
      if (finalized) this.events.push({ type: "finalized" });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.#controller.abort();
    this.#meter.flush();
    this.events.close();
  }
}

function concatPcm(chunks: readonly Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function openHttpWhisperStt(
  selection: Selection,
  language: string | null,
  signal: AbortSignal,
  options?: { readonly timeoutMs?: number; readonly maxUtteranceSamples?: number },
): Promise<SttStream> {
  return new HttpWhisperStt(
    selection,
    language,
    signal,
    options?.timeoutMs,
    options?.maxUtteranceSamples,
  );
}
