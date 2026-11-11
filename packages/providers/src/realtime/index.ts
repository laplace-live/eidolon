// A realtime voice model's session for the voice engine: it hears, thinks and speaks in one socket.
import type { ToolSchema } from "@eidolon/core";
import { hasKey, missingKey, selectRequired } from "../resolve.ts";
import { openRealtimeSession } from "./session.ts";

export interface RealtimeOptions {
  readonly instructions: string;
  readonly tools: readonly ToolSchema[];
  readonly voice: string;
  /** Null for xAI, which transcribes on its own; a null language lets OpenAI detect it. */
  readonly transcription: { readonly model: string; readonly language: string | null } | null;
  /** Aborting it closes the session. */
  readonly signal: AbortSignal;
}

export interface RealtimeSession {
  /** OpenAI 24000, xAI 16000. */
  readonly inputRate: number;
  readonly outputRate: 24000;
  /** Metered here; xAI drops it until `session.updated`. */
  appendAudio(pcm: Int16Array): void;
  /**
   * Resolves to the item's id once it is sent, which waits for `session.updated`, or once the
   * session has ended without sending it; xAI takes a system item as a user one.
   */
  addItem(item: { readonly role: "user" | "system"; readonly text: string }): Promise<string>;
  deleteItem(itemId: string): void;
  /**
   * Deferred until the session is ready. While a response is active it is owed instead, and sent
   * at that response's end if something was delivered that no response has taken in.
   */
  createResponse(): void;
  /** Also drops a response owed behind the one cancelled. */
  cancelResponse(): void;
  truncate(itemId: string, contentIndex: number, audioEndMs: number): void;
  /**
   * Answers a call the model is waiting on, once: `output` as the model reads it, a JSON result
   * (`pyJsonDumps` without `ensure_ascii`), `COMPLETED` or `CANCELLED`. A call it isn't waiting
   * on is dropped.
   */
  sendToolOutput(callId: string, output: string): void;
  /** Unknown and malformed server events are skipped. Ends after `close()` or a fatal `error`. */
  readonly events: AsyncIterable<RealtimeEvent>;
  /** Flushes the meter. */
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
  /** One per response, whoever asked for it. */
  | { readonly type: "response-started"; readonly responseId: string }
  /** A response may speak through several items, each with its own id. */
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
  /** The session has reported the response's usage by then; `error` when it failed. */
  | { readonly type: "response-done"; readonly responseId: string; readonly error?: string }
  /** Fatal: the server's error, or the socket closing under it. Nothing follows. */
  | { readonly type: "error"; readonly message: string; readonly fatal: boolean };

/** The realtime role in the current persona scope. Throws `missingKey` before connecting. */
export async function openRealtime(options: RealtimeOptions): Promise<RealtimeSession> {
  const selection = selectRequired("realtime");
  if (!hasKey(selection)) throw missingKey(selection);
  return openRealtimeSession(selection, options);
}
