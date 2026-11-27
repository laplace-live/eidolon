// Live speech recognition for the voice engine, one stream per call.
import { envOptional } from "@eidolon/config";
import type { ProviderId } from "../catalog.ts";
import { hasKey, missingKey, type Selection, selectRequired } from "../resolve.ts";
import { openDeepgramStt } from "./deepgram.ts";
import { openElevenLabsStt } from "./elevenlabs.ts";
import { openHttpWhisperStt } from "./http.ts";
import { openOpenAIStt } from "./openai.ts";
import { openSonioxStt } from "./soniox.ts";

export type SttEvent =
  /** Everything heard since the last final; OpenAI's deltas accumulated. */
  | { readonly type: "interim"; readonly text: string }
  /** One segment. */
  | { readonly type: "final"; readonly text: string; readonly finalized: boolean }
  /** `finalize()` answered with no words: Soniox's bare `<fin>`, Deepgram's empty answer. */
  | { readonly type: "finalized" }
  | { readonly type: "error"; readonly message: string; readonly fatal: boolean };

export interface SttStream {
  /** OpenAI 24000, the others 16000. */
  readonly inputRate: 16000 | 24000;
  /** Seconds: Soniox .35, Deepgram .35, ElevenLabs .41, OpenAI 1.66. */
  readonly ttfsP99: number;
  /**
   * Every `finalize()` gets an answer, `finalized` if it has no words: Soniox and Deepgram.
   * ElevenLabs and OpenAI answer a commit with no words with nothing.
   */
  readonly acknowledgesFinalize: boolean;
  /** How long (ms) a finalized turn waits before timing out; defaults to `FINALIZE_ACK_CAP_MS`. */
  readonly finalizeTimeoutMs?: number;
  /** Metered here; dropped while the socket isn't open. */
  send(pcm: Int16Array): void;
  /** Marks speech onset so chunked recognizers latch pre-roll for the coming utterance. */
  speechStarted?(): void;
  /** Soniox `finalize`, Deepgram `Finalize`, ElevenLabs and OpenAI commit. */
  finalize(): void;
  readonly events: AsyncIterable<SttEvent>;
  /** Flushes the meter. */
  close(): Promise<void>;
}

/** Each provider's live speech recognition, by catalog id: one for every provider that offers it. */
export const STT_STREAMS: {
  readonly [P in ProviderId]?: (
    selection: Selection,
    language: string | null,
    signal: AbortSignal,
  ) => Promise<SttStream>;
} = {
  soniox: openSonioxStt,
  deepgram: openDeepgramStt,
  elevenlabs: openElevenLabsStt,
  openai: openOpenAIStt,
  "openai-compatible": (selection, language, signal) =>
    selection.account.options.sttProtocol?.toLowerCase() === "realtime"
      ? openOpenAIStt(selection, language, signal)
      : openHttpWhisperStt(selection, language, signal),
};

/** The hearing role in the current persona scope. Throws `missingKey` before connecting. */
export async function openStt(signal: AbortSignal): Promise<SttStream> {
  const selection = selectRequired("hearing");
  if (!hasKey(selection)) throw missingKey(selection);
  signal.throwIfAborted();
  const open = STT_STREAMS[selection.provider.id];
  if (open === undefined) {
    throw new Error(`${selection.provider.name} has no live speech recognition in Eidolon yet`);
  }
  const stream = await open(selection, sttLanguage(selection), signal);
  signal.throwIfAborted();
  return stream;
}

/**
 * The language viewers speak with her, for the providers that want one: STT_LANGUAGE, else her
 * videos' language, else Mandarin. `none` lets the provider detect it.
 */
export function spokenLanguage(): string | null {
  const language = envOptional("STT_LANGUAGE") ?? envOptional("TRANSCRIBE_LANGUAGE") ?? "zh";
  return language.trim().toLowerCase() === "none" ? null : language.trim();
}

/** The language a call's hearing role listens for; null lets the provider detect it. */
export function sttLanguage(selection: Selection): string | null {
  if (selection.provider.id !== "soniox") return spokenLanguage();
  // Soniox detects the language; only an explicit STT_LANGUAGE becomes a hint.
  const language = envOptional("STT_LANGUAGE");
  return language && language !== "none" ? language : null;
}
