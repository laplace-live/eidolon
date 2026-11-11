// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/openai/src/tts.ts@ce8f8bc
//
// OpenAI's speech endpoint, whose `pcm` format is 24 kHz.
import { voiceOf } from "../../resolve.ts";
import { HttpUtterance, SpeechError } from "./http.ts";
import type { SpeechStream, Utterance } from "./index.ts";
import { type KeyedSelection, SpokenText } from "./shared.ts";

const SAMPLE_RATE = 24000;

export class OpenAISpeech implements SpeechStream {
  readonly sampleRate = SAMPLE_RATE;
  readonly #selection: KeyedSelection;
  readonly #text: SpokenText;
  readonly #controller = new AbortController();
  readonly #url: string;
  readonly #voice: string | null;

  constructor(selection: KeyedSelection) {
    this.#selection = selection;
    this.#text = new SpokenText(selection);
    this.#url = `${(selection.baseUrl as string).replace(/\/+$/, "")}/audio/speech`;
    this.#voice = voiceOf(selection) ?? null;
  }

  utterance(voice: string | null): Utterance {
    return new HttpUtterance(
      this.#text,
      (text, signal) => this.#audio(text, voice ?? this.#voice, signal),
      { closed: this.#controller.signal, secret: this.#selection.apiKey },
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
  ): AsyncGenerator<Uint8Array> {
    const { voices } = this.#selection.offer;
    if (voice === null) throw new SpeechError("OpenAI TTS voice must be specified");
    if (voices?.kind === "preset" && !voices.voices.includes(voice)) {
      throw new SpeechError(
        `OpenAI TTS voice '${voice}' is not supported ` +
          `(must be one of: ${[...voices.voices].sort().join(", ")})`,
      );
    }
    const response = await fetch(this.#url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#selection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: text,
        model: this.#selection.model,
        voice,
        response_format: "pcm",
      }),
      signal,
    });
    if (response.status !== 200) {
      const error = await response.text();
      throw new SpeechError(`Error getting audio (status: ${response.status}, error: ${error})`);
    }
    if (response.body === null) return;
    yield* response.body;
  }
}
