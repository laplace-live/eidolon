// A recorded clip as text, through her hearing role's provider, for a chat's voice message.
import { envOptional } from "@eidolon/config";
import { costOf, priceOf, type Units } from "../../pricing.ts";
import { hasKey, missingKey, ProviderConfigError, type Selection } from "../../resolve.ts";
import { reportUsage } from "../../usage.ts";
import { baseMime, baseOf, record, send, spokenLanguage, upload, withTimeLimit } from "./shared.ts";
import { type SonioxOptions, sonioxTranscribe } from "./soniox.ts";

export interface AudioClip {
  readonly bytes: Uint8Array;
  /** `audio/webm`, `audio/ogg`, `audio/mp4` or `audio/mpeg`, codecs and all. */
  readonly mime: string;
  /** Its length, where the caller knows it (the recorder's clock), for a provider that won't say. */
  readonly durationMs?: number;
}

export interface TranscribeOptions extends SonioxOptions {
  /** A two-letter language hint, or null to let the provider detect it; unset, a call's. */
  readonly language?: string | null;
}

export interface Transcript {
  /** Trimmed; empty when nothing was heard. */
  readonly text: string;
  /** The provider's figure, else the clip's; null when neither says. */
  readonly durationMs: number | null;
}

interface Heard {
  readonly text: string;
  readonly durationMs: number | null;
  readonly units?: Units;
}

interface Job {
  readonly selection: Selection & { readonly apiKey: string };
  readonly audio: AudioClip;
  readonly model: string;
  readonly language: string | null;
  readonly options: TranscribeOptions;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

interface Transcriber {
  /** The hearing model for a clip: a provider's realtime-only models have an async twin. */
  readonly model?: (model: string) => string;
  /** The hint a call would give, where it isn't `spokenLanguage()`. */
  readonly language?: () => string | null;
  readonly run: (job: Job) => Promise<Heard>;
}

const TRANSCRIBERS: Readonly<Record<string, Transcriber>> = {
  openai: {
    // gpt-realtime-whisper serves the Realtime API's transcription sessions alone.
    model: (model) => (model === "gpt-realtime-whisper" ? "gpt-4o-transcribe" : model),
    async run({ selection, audio, model, language, options }) {
      const response = await send(
        selection,
        `${baseOf(selection)}/audio/transcriptions`,
        {
          headers: { Authorization: `Bearer ${selection.apiKey}` },
          body: upload(audio, { model, language, response_format: "json" }),
        },
        options,
      );
      const body = record(await response.json());
      const usage = record(body.usage);
      const seconds = usage.type === "duration" ? count(usage.seconds) : undefined;
      return {
        text: typeof body.text === "string" ? body.text : "",
        durationMs: seconds === undefined ? null : Math.round(seconds * 1000),
        units:
          usage.type === "tokens"
            ? { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) }
            : {},
      };
    },
  },

  deepgram: {
    async run({ selection, audio, model, language, options }) {
      const query = new URLSearchParams({ model, punctuate: "true" });
      if (language === null) query.set("detect_language", "true");
      else query.set("language", language);
      const response = await send(
        selection,
        `${baseOf(selection)}/v1/listen?${query}`,
        {
          headers: {
            Authorization: `Token ${selection.apiKey}`,
            "Content-Type": baseMime(audio.mime),
          },
          body: audio.bytes as Uint8Array<ArrayBuffer>,
        },
        options,
      );
      const body = record(await response.json());
      const channel = record((record(body.results).channels as unknown[] | undefined)?.[0]);
      const best = record((channel.alternatives as unknown[] | undefined)?.[0]);
      const seconds = count(record(body.metadata).duration);
      return {
        text: typeof best.transcript === "string" ? best.transcript : "",
        durationMs: seconds === undefined ? null : Math.round(seconds * 1000),
      };
    },
  },

  elevenlabs: {
    model: (model) => model.replace(/_realtime$/, ""),
    async run({ selection, audio, model, language, options }) {
      const response = await send(
        selection,
        `${baseOf(selection)}/v1/speech-to-text`,
        {
          headers: { "xi-api-key": selection.apiKey },
          // Without event tags, the transcript holds only words, as a call's does.
          body: upload(audio, {
            model_id: model,
            language_code: language,
            tag_audio_events: "false",
          }),
        },
        options,
      );
      const body = record(await response.json());
      return { text: typeof body.text === "string" ? body.text : "", durationMs: null };
    },
  },

  soniox: {
    model: (model) => model.replace(/^stt-rt-/, "stt-async-"),
    // As a call: Soniox detects the language, and only STT_LANGUAGE becomes a hint.
    language: () => {
      const language = envOptional("STT_LANGUAGE")?.trim();
      return language === undefined || language.toLowerCase() === "none" ? null : language;
    },
    run: ({ selection, audio, model, language, options }) =>
      sonioxTranscribe(selection, audio, model, language, options),
  },
};

/**
 * How long hearing a clip may take, all its requests together: 30 s, and a second more for every
 * two seconds of audio, at most 90 s. A clip of unknown length gets the most.
 */
export function transcribeTimeoutMs(durationMs: number | undefined): number {
  return Math.min(
    30_000 + Math.ceil((durationMs ?? Number.POSITIVE_INFINITY) / 2000) * 1000,
    90_000,
  );
}

export function canTranscribe(selection: Selection): boolean {
  return selection.role.category === "stt" && Object.hasOwn(TRANSCRIBERS, selection.provider.id);
}

/** What `audio` says, heard by `selection`'s provider; the audio it heard is reported as used. */
export async function transcribe(
  selection: Selection,
  audio: AudioClip,
  options: TranscribeOptions = {},
): Promise<Transcript> {
  const transcriber = canTranscribe(selection) ? TRANSCRIBERS[selection.provider.id] : undefined;
  if (transcriber === undefined) {
    throw new ProviderConfigError(`${selection.provider.name} has no batch speech recognition`);
  }
  if (!hasKey(selection)) throw missingKey(selection);
  const model = transcriber.model?.(selection.model) ?? selection.model;
  const language =
    options.language !== undefined ? options.language : (transcriber.language ?? spokenLanguage)();
  const heard = await withTimeLimit(
    selection,
    transcribeTimeoutMs(audio.durationMs),
    options,
    (bounded) =>
      transcriber.run({
        selection: selection as Job["selection"],
        audio,
        model,
        language,
        options: bounded,
      }),
  );
  const durationMs = heard.durationMs ?? audio.durationMs ?? null;
  const units: Units = {
    ...heard.units,
    ...(durationMs === null ? {} : { audioSeconds: durationMs / 1000 }),
  };
  // An async model is priced under the transcription role, the hearing role's under its own.
  const price = priceOf(selection.provider.id, "transcription", model);
  reportUsage({
    role: selection.role.id,
    provider: selection.provider.id,
    model,
    units,
    estimatedUsd: price === undefined ? null : costOf(price, units),
  });
  return { text: heard.text.trim(), durationMs };
}
