import type { UserContext } from "@eidolon/access";
import type {
  Attachment,
  ChatEvent,
  ChatEventDraft,
  ChatHeader,
  ChatStreamLine,
  ParticipantId,
} from "@eidolon/chat";
import type { ContextProvider, LlmTool, ToolEffects, ToolSchema, TurnGate } from "@eidolon/core";
import type { UsageScope } from "@eidolon/providers";
import type { AudioClip, Speech, Transcript } from "@eidolon/providers/speech-batch";

export interface MindRequest {
  readonly system: string;
  /** OpenAI-shaped, with no system message: `system` carries it. */
  readonly messages: readonly unknown[];
  readonly tools: readonly ToolSchema[];
  /** Ends her reply where one appears, unwritten, where her provider takes it; at most 4. */
  readonly stop?: readonly string[];
  readonly signal: AbortSignal;
}

export interface MindToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Text as it streams, then a round's tool calls assembled whole, then the end. */
export type MindChunk =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool-calls"; readonly calls: readonly MindToolCall[] }
  | { readonly type: "done"; readonly finishReason: string | null };

/** The provider that fills a persona's mind role, without pipedog. */
export interface Mind {
  stream(request: MindRequest): AsyncIterable<MindChunk>;
}

export interface TurnRequest {
  readonly chat: { readonly header: ChatHeader; readonly events: readonly ChatEvent[] };
  readonly persona: ParticipantId;
  /** The local viewer in the local app. */
  readonly viewer: UserContext;
  /** A greeting: no user message, the greeting prompt instead. */
  readonly kickoff?: boolean;
  /** Interrupts the turn. */
  readonly signal: AbortSignal;
  /** Without it, an interruption cancels every tool, `cancelOnInterruption` or not. */
  readonly late?: LateTools;
  /**
   * "voice": her parts' voice variant, with her voice-style tool and its hint, and her finished
   * reply spoken by her voice role and stored as a voice message. Default "text". A mode still
   * being decided gets the voice variant, and is awaited only once her reply is written.
   */
  readonly mode?: "text" | "voice" | Promise<"text" | "voice">;
  /** Default: `{ source: "chat", session: <chat id> }`. */
  readonly usage?: UsageScope;
  /** A prompt she answers, stored as a developer `context` block at her view's end. */
  readonly nudge?: string;
}

/** What a call gives each of her turns: her reply is spoken live, and her tools act on the call. */
export interface CallHooks {
  /**
   * Her parts' voice variant, spoken live rather than saved: tools act through `effects`,
   * `ASYNC_TOOL_INSTRUCTIONS` joins her system instruction while an async tool is registered, and
   * an async tool reports through `onAsyncResult`. The turn's outputs gain `mind` and `notice`
   * lines, and its `tool` lines a `callId`.
   */
  readonly mode: "call";
  readonly effects: ToolEffects;
  /**
   * Ends her speech and resolves with what was heard. Awaited after the last round, or at once on
   * an abort or a failure; her message is its text, none when it is empty, `interrupted` unless
   * `complete`.
   */
  readonly heard: () => Promise<{ readonly text: string; readonly complete: boolean }>;
  /**
   * An async tool's settled result, during the turn or after it: one `tool-result` with stage
   * `final` or `cancelled`. Its `running` line was the turn's; nothing else reports its end.
   */
  readonly onAsyncResult: (events: readonly ChatEventDraft[]) => void;
  /** Cancels the async tools her turns start, as the call ends; each also stops at its timeout. */
  readonly asyncSignal?: AbortSignal;
  readonly usage?: UsageScope;
}

/** A turn in a call, which has no `late`: an async tool runs on through `onAsyncResult`. */
export type CallTurnRequest = Omit<TurnRequest, "mode" | "late" | "usage"> & CallHooks;

/** Takes a tool that runs on (`cancelOnInterruption: false`) when its turn is interrupted. */
export interface LateTools {
  /** Cancels them all. Each also stops at its own timeout. */
  readonly signal: AbortSignal;
  /**
   * Called before the interrupted turn ends, once per such tool, with what it adds to the chat
   * when it finishes: its result, then a message from her with the photos it took. Resolves to []
   * when it brought nothing, and never rejects.
   */
  add(name: string, events: Promise<readonly ChatEventDraft[]>): void;
}

/** A turn's stream lines, with its events as drafts: the caller numbers and stores them first. */
export type TurnOutput =
  | Exclude<ChatStreamLine, { type: "events" } | { type: "error" }>
  | { readonly type: "events"; readonly events: readonly ChatEventDraft[] };

/** A call turn's stream lines: a text turn's, with the lines only a call reads. */
export type CallTurnOutput =
  | Exclude<TurnOutput, { readonly type: "tool" }>
  | {
      /** One mind request: `started` just before it is sent, then `ended`, an abort included. */
      readonly type: "mind";
      readonly turn: string;
      readonly state: "started" | "ended";
      /** Why it failed, in the words an RTVI `error` carries. */
      readonly error?: string;
    }
  | {
      /** A context provider failed, and the turn went on without it: its `errorMessage`. */
      readonly type: "notice";
      readonly turn: string;
      readonly text: string;
    }
  | {
      readonly type: "tool";
      readonly turn: string;
      readonly name: string;
      readonly callId: string;
      /** An async tool's line is only `running`; its end comes through `onAsyncResult`. */
      readonly async: boolean;
      /** `cancelled`: it timed out, or her turn was interrupted while it ran. */
      readonly state: "running" | "done" | "failed" | "cancelled";
    };

/** What a persona brings to a turn. */
export interface PersonaParts {
  readonly systemInstruction: string;
  /** In the order a call runs them: Mem0, the stream archive, persona facts. */
  readonly providers: readonly { readonly label: string; readonly provider: ContextProvider }[];
  readonly gate: TurnGate | null;
  readonly tools: readonly LlmTool[];
  /** Her memories of the viewer, newest first, for the greeting. */
  memories(): Promise<readonly { readonly memory?: unknown }[]>;
}

export interface PartsOptions {
  /** The names of the chat's other personas, which her system instruction lists. */
  readonly others?: readonly string[];
  /** The voice variant: her voice-style tool, and its hint in her system instruction. */
  readonly voice?: boolean;
  /** A realtime model voices her: the prefix's realtime delivery line. Its voice never switches. */
  readonly realtime?: boolean;
  /** What the chat's parts are kept under, by default its id. */
  readonly chatKey?: string;
}

/** A persona's whole-message speech, through the roles of the persona whose scope it runs in. */
export interface SpeechDeps {
  /** Whether her voice role can speak a voice message: its provider has batch synthesis and a key. */
  canSpeak(): boolean;
  /** `text` in her voice role's voice, or in `voice` for this message alone. */
  synthesize(
    text: string,
    options: { readonly voice?: string; readonly signal: AbortSignal },
  ): Promise<Speech>;
  /** What `clip` says, heard by her hearing role. */
  transcribe(clip: AudioClip, options: { readonly signal: AbortSignal }): Promise<Transcript>;
}

/** Everything a turn takes from outside, so tests can stand in for any of it. */
export interface EngineDeps {
  /** The mind of the persona whose scope it is called in. */
  createMind(): Mind;
  /**
   * Her parts in `chat`: its providers keep what they saw of it, as a call's do, and ones opened on
   * a chat under way take up from its log what they had kept.
   */
  parts(
    persona: ParticipantId,
    viewer: UserContext,
    chat: TurnRequest["chat"],
    options?: PartsOptions,
  ): Promise<PersonaParts>;
  /** Stores a file in the turn's chat. */
  saveAttachment(bytes: Uint8Array, mime: string): Promise<Attachment>;
  fetchImage(url: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }>;
  newId(): string;
  /** Production's is `batchSpeech`, on her voice and hearing roles. */
  readonly speech: SpeechDeps;
}
