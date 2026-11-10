import type { UserContext } from "@eidolon/access";
import type {
  Attachment,
  ChatEvent,
  ChatEventDraft,
  ChatHeader,
  ChatStreamLine,
  ParticipantId,
} from "@eidolon/chat";
import type { ContextProvider, LlmTool, ToolSchema, TurnGate } from "@eidolon/core";

export interface MindRequest {
  readonly system: string;
  /** OpenAI-shaped, with no system message: `system` carries it. */
  readonly messages: readonly unknown[];
  readonly tools: readonly ToolSchema[];
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
}

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
  ): Promise<PersonaParts>;
  /** Stores a file in the turn's chat. */
  saveAttachment(bytes: Uint8Array, mime: string): Promise<Attachment>;
  fetchImage(url: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }>;
  newId(): string;
}
