// Streaming speech synthesis for the voice engine: one stream per persona per call, one utterance
// per stretch of a reply in one voice.
import type { ProviderId } from "../../catalog.ts";
import { hasKey, missingKey, selectRequired } from "../../resolve.ts";
import { CartesiaSpeech } from "./cartesia.ts";
import { ElevenLabsSpeech } from "./elevenlabs.ts";
import { FishSpeech } from "./fish.ts";
import { MiniMaxSpeech } from "./minimax.ts";
import { OpenAISpeech } from "./openai.ts";
import type { KeyedSelection } from "./shared.ts";
import { SonioxSpeech } from "./soniox.ts";

export { SPEECH_STALL_MS, SPEECH_STALLED } from "./shared.ts";

export interface SpeechStream {
  /** The rate its audio comes at; Fish 44100, the others 24000. */
  readonly sampleRate: number;
  /** Null speaks in the selection's voice (`voiceOf`). */
  utterance(voice: string | null): Utterance;
  /** Ends every utterance still open and flushes the meter. */
  close(): Promise<void>;
}

export interface Utterance {
  /**
   * Strips markup unless the model reads it (fish-drama), meters what it sends, and sends it; a
   * segment left with nothing to say is sent to no one but still ends in order.
   */
  say(segment: { readonly id: number; readonly text: string }): void;
  /**
   * No more segments: Fish `stop` once the last is flushed, ElevenLabs `close_context`, Cartesia
   * `continue: false`, Soniox `text_end`; over HTTP, the requests made are the last.
   */
  end(): void;
  /** Stops at once: `audio` ends without an `end`. */
  cancel(): void;
  /** Ends after `end` or `error`, or at once on `cancel`. */
  readonly audio: AsyncIterable<UtteranceAudio>;
}

export type UtteranceAudio =
  | { readonly kind: "pcm"; readonly seg: number; readonly pcm: Int16Array }
  /**
   * Words of segment `seg` as they start: `chars` counts its letters and digits (`\p{L}`, `\p{N}`)
   * through each word, in the text it was sent with; `startMs` is from the segment's first sample
   * in this stream.
   */
  | {
      readonly kind: "words";
      readonly seg: number;
      readonly words: readonly { readonly chars: number; readonly startMs: number }[];
    }
  /** Every sample of `seg` has come; the next `pcm` is a later segment's. */
  | { readonly kind: "seg-end"; readonly seg: number }
  | { readonly kind: "end" }
  | { readonly kind: "error"; readonly message: string };

/** Each provider's streaming speech, by catalog id: one for every provider that offers it. */
export const SPEECH_STREAMS: {
  readonly [P in ProviderId]?: (selection: KeyedSelection) => SpeechStream;
} = {
  fish: (selection) => new FishSpeech(selection),
  elevenlabs: (selection) => new ElevenLabsSpeech(selection),
  cartesia: (selection) => new CartesiaSpeech(selection),
  soniox: (selection) => new SonioxSpeech(selection),
  minimax: (selection) => new MiniMaxSpeech(selection),
  openai: (selection) => new OpenAISpeech(selection),
};

/** The voice role in the current persona scope; throws before connecting without its key. */
export function openSpeech(): SpeechStream {
  const selection = selectRequired("voice");
  if (!hasKey(selection)) throw missingKey(selection);
  const open = SPEECH_STREAMS[selection.provider.id];
  if (open === undefined) {
    throw new Error(`${selection.provider.name} has no speech synthesis in Eidolon yet`);
  }
  return open(selection as KeyedSelection);
}
