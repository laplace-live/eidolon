// Self-hosted open-source Fish Speech server (`POST /v1/tts`), streaming 44.1 kHz PCM.
import { voiceOf } from "../../resolve.ts";
import { fishSpeechRoot, pcmBody } from "../wav.ts";
import { HttpUtterance, SpeechError } from "./http.ts";
import type { SpeechStream, Utterance } from "./index.ts";
import { type KeyedSelection, SpokenText } from "./shared.ts";

const SAMPLE_RATE = 44100;
const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

export class FishSpeechSelfHosted implements SpeechStream {
  readonly sampleRate = SAMPLE_RATE;
  readonly #apiKey: string | undefined;
  readonly #text: SpokenText;
  readonly #controller = new AbortController();
  readonly #url: string;
  readonly #voice: string | null;

  constructor(selection: KeyedSelection) {
    this.#apiKey = selection.apiKey as string | undefined;
    this.#text = new SpokenText(selection);
    this.#url = `${fishSpeechRoot(selection.baseUrl ?? DEFAULT_BASE_URL)}/v1/tts`;
    this.#voice = voiceOf(selection) ?? null;
  }

  utterance(voice: string | null): Utterance {
    return new HttpUtterance(
      this.#text,
      (text, signal) => this.#audio(text, voice ?? this.#voice, signal),
      { closed: this.#controller.signal, secret: this.#apiKey ?? "" },
    );
  }

  async close(): Promise<void> {
    this.#controller.abort();
    this.#text.flush();
  }

  async *#audio(
    text: string,
    voice: string | null,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const speaker = voice || undefined;
    const response = await fetch(this.#url, {
      method: "POST",
      headers: {
        ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        ...(speaker === undefined ? {} : { reference_id: speaker }),
        format: "pcm",
        streaming: true,
        normalize: false,
      }),
      signal,
    });
    if (response.status !== 200) {
      const error = await response.text();
      throw new SpeechError(`Error getting audio (status: ${response.status}, error: ${error})`);
    }
    yield* pcmBody(response.body, SAMPLE_RATE);
  }
}
