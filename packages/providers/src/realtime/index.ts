// A realtime voice model's session for the voice engine: it hears, thinks and speaks in one socket.
import type { ToolSchema } from "@eidolon/core";

export interface RealtimeOptions {
  readonly instructions: string;
  readonly tools: readonly ToolSchema[];
  readonly voice: string;
  /** Null for xAI, which transcribes on its own. */
  readonly transcription: { readonly model: string; readonly language: string } | null;
  readonly signal: AbortSignal;
}

export interface RealtimeSession {
  /** OpenAI 24000, xAI 16000. */
  readonly inputRate: number;
  readonly outputRate: 24000;
  /** xAI drops it until `session.updated`. */
  appendAudio(pcm: Int16Array): void;
  /** Resolves to the item's id; xAI takes a system item as a user one. */
  addItem(item: { readonly role: "user" | "system"; readonly text: string }): Promise<string>;
  deleteItem(itemId: string): void;
  /** Deferred until the session is ready, and owed while a response is active. */
  createResponse(): void;
  cancelResponse(): void;
  truncate(itemId: string, contentIndex: number, audioEndMs: number): void;
  /** `output` as the model reads it: a JSON result, `COMPLETED` or `CANCELLED`. */
  sendToolOutput(callId: string, output: string): void;
  /** Unknown server events are skipped. */
  readonly events: AsyncIterable<RealtimeEvent>;
  close(): Promise<void>;
}

export type RealtimeEvent =
  | { readonly type: "speech-started" }
  | { readonly type: "speech-stopped" }
  /** Cumulative for the item. */
  | {
      readonly type: "user-transcript";
      readonly itemId: string;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: "response-started"; readonly responseId: string }
  | {
      readonly type: "audio";
      readonly responseId: string;
      readonly itemId: string;
      readonly contentIndex: number;
      readonly pcm: Int16Array;
    }
  | {
      readonly type: "transcript-delta";
      readonly responseId: string;
      readonly itemId: string;
      readonly text: string;
    }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  /** The session has reported the response's usage by then. */
  | { readonly type: "response-done"; readonly responseId: string; readonly error?: string }
  | { readonly type: "error"; readonly message: string; readonly fatal: boolean };

/** The realtime role in the current persona scope. */
export async function openRealtime(_options: RealtimeOptions): Promise<RealtimeSession> {
  throw new Error("not implemented in this phase");
}
