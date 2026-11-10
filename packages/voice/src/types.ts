import type { UserContext } from "@eidolon/access";
import type { ChatEvent, ChatEventDraft, ChatHeader, ParticipantId } from "@eidolon/chat";
import type { ChatDeps, runChat, runTurn } from "@eidolon/engine";
import type { openRealtime } from "@eidolon/providers/realtime";
import type { openSpeech } from "@eidolon/providers/speech-stream";
import type { openStt } from "@eidolon/providers/stt";

/** Signed 16-bit mono samples. */
export type Pcm = Int16Array;

export interface PcmSource {
  readonly rate: number;
  /** Never blocks: zeros for whatever it doesn't have. */
  pull(samples: number): Pcm;
}

export type CloseReason = "client" | "bot" | "idle" | "error" | "shutdown";

export interface CallTransport {
  /** 16 kHz in 20 ms frames; it takes up the new track after every reconnect (`restart_pc`). */
  readonly audioIn: AsyncIterable<Pcm>;
  /** The transport's drift-free 10 ms clock pulls it, sending silence while it's empty. */
  attachSpeaker(source: PcmSource): void;
  /** App messages; pings and the signalling envelope never reach it. */
  readonly messages: AsyncIterable<unknown>;
  /** Queued until the data channel opens, at most 50. */
  send(message: Readonly<Record<string, unknown>>): void;
  /** Delivers app messages that arrived before the call was built, such as `client-ready`. */
  connect(): Promise<void>;
  /** Resolves when the peer closes, never on a disconnect it may come back from. */
  readonly closed: Promise<"client">;
  /** Sends `peerLeft`, then closes. */
  disconnect(): Promise<void>;
}

/** `joinSegments`: a space between segments unless either side of the join is CJK or a space. */
export type JoinSegments = (parts: readonly string[]) => string;

export type EarEvent =
  | { readonly type: "user-started" }
  /** The VAD hears speech; at most every 0.2 s, for the call's idle timer. */
  | { readonly type: "user-speaking" }
  | { readonly type: "interim"; readonly text: string }
  | { readonly type: "final"; readonly text: string }
  /** `text` joins the turn's finals (`joinSegments`); null when it had none. */
  | { readonly type: "user-stopped"; readonly text: string | null }
  | { readonly type: "stt-error"; readonly message: string; readonly fatal: boolean };

/** The reply, persona and segment a stretch of audio belongs to. */
export interface Tag {
  readonly reply: string;
  readonly persona: string;
  readonly seg: number;
}

/** What the Speaker's play cursor passes, posted as it passes it. */
export type CursorEvent =
  | { readonly type: "reply-start"; readonly reply: string; readonly persona: string }
  | { readonly type: "seg-start"; readonly tag: Tag }
  | { readonly type: "seg-end"; readonly tag: Tag }
  | { readonly type: "words"; readonly tag: Tag; readonly chars: number }
  | { readonly type: "drained" };

/** The call's one output queue. */
export interface Speaker extends PcmSource {
  readonly rate: 24000;
  enqueue(tag: Tag, pcm: Pcm): void;
  markSegEnd(tag: Tag): void;
  /** `atSample` counts from the start of the tag's audio. */
  markWords(
    tag: Tag,
    words: readonly { readonly chars: number; readonly atSample: number }[],
  ): void;
  /** Empties the queue at once: the reply it cut, if any, and how much of it had played. */
  clear(): { readonly reply: string | null; readonly playedMs: number };
  /** Milliseconds of reply `key`'s audio pulled so far; realtime truncates an item there. */
  playedMs(key: string): number;
  isSpeaking(): boolean;
}

/** What the listener heard of a reply: `complete` only when it drained uncancelled. */
export interface Heard {
  readonly text: string;
  readonly complete: boolean;
}

/** One reply's speech, from the mind's deltas to the audio the Speaker plays. */
export interface ReplySpeech {
  /** Raw mind text, cues included. */
  push(delta: string): void;
  /** At the end of each mind round: speaks what the segmenter still holds. */
  flush(): void;
  /** Flushes, ends the utterance so its audio plays out, and opens one in `voice`. */
  switchVoice(voice: string): void;
  cancel(): void;
  /** Ends the speech; resolves with what was heard once it drains or is cancelled. */
  heard(): Promise<Heard>;
}

/** The chat a call writes to: stamped at once, persisted in order. */
export interface CallLog {
  snapshot(): { readonly header: ChatHeader; readonly events: readonly ChatEvent[] };
  append(drafts: readonly ChatEventDraft[]): readonly ChatEvent[];
  flush(): Promise<void>;
}

/** Milliseconds on a monotonic clock, and timers on it; tests drive a fake. */
export interface Clock {
  now(): number;
  /** Returns the timer's cancel. */
  setTimer(ms: number, fire: () => void): () => void;
}

export interface CallDeps {
  /** A group call's director is `engine.director`, else the active persona's gate role's. */
  readonly engine: ChatDeps;
  readonly runTurn: typeof runTurn;
  /** A group call's answer to each line; a call with one persona never asks for it. */
  readonly runChat?: typeof runChat;
  readonly openStt: typeof openStt;
  readonly openSpeech: typeof openSpeech;
  readonly openRealtime: typeof openRealtime;
  /** The ONNX models' file paths. */
  readonly models: { readonly silero: string; readonly smartTurn: string };
  /** runtime's `BOT_ABOUT`, which `bot-ready` carries. */
  readonly about: { readonly library: string; readonly library_version: string };
  readonly clock: Clock;
}

export interface CallPlan {
  readonly id: string;
  /** The persona whose Call button started it; in a group call, her hearing role hears. */
  readonly host: ParticipantId;
  readonly viewer: UserContext;
  readonly log: CallLog;
  /** A group call never greets. */
  readonly greet: boolean;
  readonly realtime: boolean;
  /**
   * Every persona in the log's chat answers, one at a time in her own voice, as the director
   * chooses (`group.ts`). Never on a realtime model.
   */
  readonly group?: boolean;
}
