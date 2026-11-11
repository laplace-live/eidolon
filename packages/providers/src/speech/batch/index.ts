// Batch speech: one request makes a whole voice message, or hears one. A call speaks through
// speech/stream instead.
import type { Selection } from "../../resolve.ts";
import { canSynthesize } from "./synthesize.ts";
import { canTranscribe } from "./transcribe.ts";

export { mp3DurationMs } from "./mp3.ts";
export { recordingDurationMs } from "./recording.ts";
export { type Speech, type SynthesizeOptions, synthesize } from "./synthesize.ts";
export {
  type AudioClip,
  type TranscribeOptions,
  type Transcript,
  transcribe,
} from "./transcribe.ts";

export interface SpeechSupport {
  /** A voice role whose provider can speak a whole reply. */
  readonly synthesize: boolean;
  /** A hearing role whose provider can hear a recorded clip. */
  readonly transcribe: boolean;
}

/** What batch speech `selection` offers, whatever its key; a role of no speech offers neither. */
export function speechSupport(selection: Selection): SpeechSupport {
  return { synthesize: canSynthesize(selection), transcribe: canTranscribe(selection) };
}
