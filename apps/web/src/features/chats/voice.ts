// Voice messages in a chat: what the recorder records, how long a clip may run, which replies play
// on their own, and the one bubble playing at a time.
import type { ChatEvent } from "@eidolon/chat";

/** Shorter than this is a slip of the finger, not a message. */
export const MIN_RECORDING_MS = 500;
/** A press held this long is hold-to-talk, and letting go sends; a shorter one is a click. */
export const HOLD_MS = 350;

// Safari may record MP4 alone.
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/mp4"] as const;

/** The type the recorder asks for: the first the browser records, or null when it records none. */
export function recordingType(isTypeSupported: (type: string) => boolean): string | null {
  return RECORDING_TYPES.find((type) => isTypeSupported(type)) ?? null;
}

/**
 * Whether a key press throws the take away: an Escape that no menu or sheet took to close itself,
 * which Radix marks with preventDefault before it reaches the window.
 */
export function cancelsTake(event: Pick<KeyboardEvent, "key" | "defaultPrevented">): boolean {
  return event.key === "Escape" && !event.defaultPrevented;
}

/** An audio element's `duration` in ms, or null while it isn't known (NaN, or Infinity). */
export function knownDuration(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** The seqs of her voice messages among `events`, which play on their own when they're new. */
export function voiceReplies(events: readonly ChatEvent[]): number[] {
  return events.flatMap((event) =>
    event.type === "message" &&
    event.speaker.kind === "persona" &&
    event.modality === "voice" &&
    event.attachments?.some((file) => file.kind === "audio") === true
      ? [event.seq]
      : [],
  );
}

/**
 * The replies left to play on their own once the first stops: the rest, if `next` and the tab
 * still has the focus, which it may have lost since they were queued; else none.
 */
export function afterAutoPlay(
  waiting: readonly number[],
  next: boolean,
  focused: boolean,
): readonly number[] {
  return next && focused ? waiting.slice(1) : [];
}

/**
 * Whether the next reply waiting plays after media event `type` on the one playing on its own;
 * null while it plays on. Playing through pauses too, just before it ends. A clip that breaks off,
 * its file lost or undecodable, is passed over like one played through.
 */
export function playsNextAfter(type: string, ended: boolean): boolean | null {
  if (type === "ended" || type === "error") return true;
  if (type === "pause") return ended ? null : false;
  return null;
}

type Playable = Pick<HTMLMediaElement, "pause">;

let playing: Playable | null = null;

/** `audio` starts playing: the bubble playing before it pauses. */
export function claimPlayback(audio: Playable): void {
  if (playing !== null && playing !== audio) playing.pause();
  playing = audio;
}

/** `audio` stopped playing. */
export function releasePlayback(audio: Playable): void {
  if (playing === audio) playing = null;
}

/**
 * A recorder's requests for the microphone, one under way at a time. A cancel lets go of it, so
 * its late answer, a grant or a refusal, never touches a start made since.
 */
export class MicRequests {
  #issued = 0;
  #pending: number | null = null;

  /** A new request's id, or null while one is under way. */
  begin(): number | null {
    if (this.#pending !== null) return null;
    this.#issued += 1;
    this.#pending = this.#issued;
    return this.#pending;
  }

  cancel(): void {
    this.#pending = null;
  }

  /** Request `id` was answered: whether it is still wanted. Either way it is no longer under way. */
  settle(id: number): boolean {
    if (this.#pending !== id) return false;
    this.#pending = null;
    return true;
  }
}
