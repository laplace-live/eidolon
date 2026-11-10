// A whole reply as one audio file in her voice role's voice, for a chat's voice message. Each
// provider is asked for MP3, the one format every one of them offers and every browser plays.
import { isPlainObject } from "@eidolon/config";
import { modelInfo } from "../../catalog.ts";
import { ProviderHttpError } from "../../http/errors.ts";
import { stripMarkup } from "../../markup.ts";
import { textUnits } from "../../pricing.ts";
import { hasKey, missingKey, ProviderConfigError, type Selection, voiceOf } from "../../resolve.ts";
import { reportUsage } from "../../usage.ts";
import { mp3DurationMs } from "./mp3.ts";
import { baseOf, type FetchOptions, send, spokenLanguage } from "./shared.ts";

export interface SynthesizeOptions extends FetchOptions {
  /** The voice for this reply alone, as her voice-style tool picks it; else her role's. */
  readonly voice?: string;
}

export interface Speech {
  readonly bytes: Uint8Array;
  readonly mime: string;
  /** The provider's figure, else measured from the MP3; null when neither says. */
  readonly durationMs: number | null;
}

interface Job {
  readonly selection: Selection & { readonly apiKey: string };
  readonly text: string;
  readonly voice: string | undefined;
  readonly options: FetchOptions;
}

const MP3 = "audio/mpeg";

async function mp3(response: Response): Promise<Speech> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, mime: MP3, durationMs: mp3DurationMs(bytes) };
}

function json(body: unknown): string {
  return JSON.stringify(body);
}

/** A voice the provider can't speak without. */
function named(voice: string | undefined, selection: Selection): string {
  if (voice !== undefined) return voice;
  throw new ProviderConfigError(
    `${selection.provider.name} needs a voice: set TTS_VOICE_ID, or pick one in her voice settings`,
  );
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("audio that isn't hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// The voices pipedog's MiniMax and Soniox services speak in when none is named, so a voice message
// sounds like a call.
const MINIMAX_DEFAULT_VOICE = "Calm_Woman";
const SONIOX_DEFAULT_VOICE = "Bryce";
// Soniox serves synthesis from its own host, not its API base.
const SONIOX_TTS_URL = "https://tts-rt.soniox.com/tts";
// The API version pipedog's Cartesia service speaks.
const CARTESIA_VERSION = "2026-03-01";

const SYNTHESIZERS: Readonly<Record<string, (job: Job) => Promise<Speech>>> = {
  async fish({ selection, text, voice, options }) {
    const response = await send(
      selection,
      `${baseOf(selection)}/v1/tts`,
      {
        headers: {
          Authorization: `Bearer ${selection.apiKey}`,
          "Content-Type": "application/json",
          model: selection.model,
        },
        // As a call asks: Fish's best-quality latency, and no normalization, which reads years badly.
        body: json({
          text,
          ...(voice === undefined ? {} : { reference_id: voice }),
          format: "mp3",
          mp3_bitrate: 128,
          latency: "normal",
          normalize: false,
        }),
      },
      options,
    );
    return mp3(response);
  },

  async openai({ selection, text, voice, options }) {
    const response = await send(
      selection,
      `${baseOf(selection)}/audio/speech`,
      {
        headers: {
          Authorization: `Bearer ${selection.apiKey}`,
          "Content-Type": "application/json",
        },
        body: json({
          model: selection.model,
          input: text,
          voice: named(voice, selection),
          response_format: "mp3",
        }),
      },
      options,
    );
    return mp3(response);
  },

  async elevenlabs({ selection, text, voice, options }) {
    const path = `/v1/text-to-speech/${encodeURIComponent(named(voice, selection))}`;
    const response = await send(
      selection,
      `${baseOf(selection)}${path}?output_format=mp3_44100_128`,
      {
        headers: { "xi-api-key": selection.apiKey, "Content-Type": "application/json" },
        body: json({ text, model_id: selection.model }),
      },
      options,
    );
    return mp3(response);
  },

  async cartesia({ selection, text, voice, options }) {
    const language = spokenLanguage();
    const response = await send(
      selection,
      `${baseOf(selection)}/tts/bytes`,
      {
        headers: {
          "X-API-Key": selection.apiKey,
          "Cartesia-Version": CARTESIA_VERSION,
          "Content-Type": "application/json",
        },
        body: json({
          model_id: selection.model,
          transcript: text,
          voice: { mode: "id", id: named(voice, selection) },
          output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
          ...(language === null ? {} : { language }),
        }),
      },
      options,
    );
    return mp3(response);
  },

  async minimax({ selection, text, voice, options }) {
    const groupId = selection.options.groupId;
    if (!groupId) {
      throw new ProviderConfigError(
        selection.account.isDefault
          ? "MiniMax needs a group id: set MINIMAX_GROUP_ID"
          : `The ${selection.account.name} account needs a group id: set it in Settings → Providers`,
      );
    }
    const response = await send(
      selection,
      `${baseOf(selection)}/t2a_v2?GroupId=${encodeURIComponent(groupId)}`,
      {
        headers: {
          Authorization: `Bearer ${selection.apiKey}`,
          "Content-Type": "application/json",
        },
        body: json({
          model: selection.model,
          text,
          stream: false,
          voice_setting: { voice_id: voice ?? MINIMAX_DEFAULT_VOICE, speed: 1, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
          output_format: "hex",
        }),
      },
      options,
    );
    // MiniMax answers 200 to a request it refuses, with the reason in base_resp.
    const body: unknown = await response.json();
    const status = isPlainObject(body) && isPlainObject(body.base_resp) ? body.base_resp : {};
    if (status.status_code !== 0) {
      const message = typeof status.status_msg === "string" ? status.status_msg : "no audio";
      throw new ProviderHttpError(
        selection.provider.name,
        200,
        `${message} (${String(status.status_code)})`,
      );
    }
    const data = isPlainObject(body) && isPlainObject(body.data) ? body.data : {};
    const extra = isPlainObject(body) && isPlainObject(body.extra_info) ? body.extra_info : {};
    const bytes = fromHex(typeof data.audio === "string" ? data.audio : "");
    const length = extra.audio_length;
    return {
      bytes,
      mime: MP3,
      durationMs: typeof length === "number" && length > 0 ? length : mp3DurationMs(bytes),
    };
  },

  async soniox({ selection, text, voice, options }) {
    const language = spokenLanguage();
    const response = await send(
      selection,
      SONIOX_TTS_URL,
      {
        headers: {
          Authorization: `Bearer ${selection.apiKey}`,
          "Content-Type": "application/json",
        },
        body: json({
          model: selection.model,
          voice: voice ?? SONIOX_DEFAULT_VOICE,
          text,
          audio_format: "mp3",
          ...(language === null ? {} : { language }),
        }),
      },
      options,
    );
    return mp3(response);
  },
};

export function canSynthesize(selection: Selection): boolean {
  return selection.role.category === "tts" && Object.hasOwn(SYNTHESIZERS, selection.provider.id);
}

/**
 * `text` spoken in `selection`'s voice, as one MP3. Her cues reach a model that reads them and are
 * taken out for any other, as a call's TTS gets them, and what it speaks is reported as used.
 */
export async function synthesize(
  selection: Selection,
  text: string,
  options: SynthesizeOptions = {},
): Promise<Speech> {
  const run = canSynthesize(selection) ? SYNTHESIZERS[selection.provider.id] : undefined;
  if (run === undefined) {
    throw new ProviderConfigError(`${selection.provider.name} has no batch speech synthesis`);
  }
  if (!hasKey(selection)) throw missingKey(selection);
  const markup = modelInfo(selection.provider.id, "tts", selection.model)?.markup;
  const spoken = stripMarkup(text, markup).trim();
  if (spoken === "") throw new Error("Nothing to say: the reply holds no words to speak");
  const speech = await run({
    selection: selection as Job["selection"],
    text: spoken,
    voice: options.voice ?? voiceOf(selection),
    options,
  });
  reportUsage({
    role: selection.role.id,
    provider: selection.provider.id,
    model: selection.model,
    units: textUnits(spoken),
  });
  return speech;
}
