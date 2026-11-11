// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/openai/src/open_ai_realtime_adapter.ts@ce8f8bc
//
// What a dialect of the realtime protocol settles, and the JSON both dialects share.

import { isPlainObject } from "@eidolon/config";
import type { ToolSchema } from "@eidolon/core";
import type { Selection } from "../resolve.ts";
import type { RealtimeOptions } from "./index.ts";

export type Json = Readonly<Record<string, unknown>>;

export interface Tokens {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

/** What differs between OpenAI's Realtime API and xAI's Voice Agent API. */
export interface Dialect {
  /** pipedog's service name, for log lines. */
  readonly label: string;
  /** For the texts a viewer may see. */
  readonly name: string;
  readonly inputRate: number;
  url(selection: Selection): string;
  /** The server event the session's configuration answers. */
  readonly configureOn: "session.created" | "conversation.created";
  session(options: RealtimeOptions, selection: Selection): Json;
  /** `response.create`'s `response`. */
  readonly response: Json;
  readonly systemRole: "system" | "user";
  /** Sent before `session.updated`, or dropped. */
  readonly audioBeforeReady: boolean;
  /** Transcripts trimmed, and an empty final dropped. */
  readonly trimTranscripts: boolean;
  /** What `response.done` reports; null for none. */
  tokens(event: Json): Tokens | null;
  /** A failed response's error text. */
  failure(response: Json): string;
  /** An error event that leaves the session usable. */
  benign(error: Json): boolean;
  /** A fatal error event's text. */
  fatal(event: Json): string;
  connectFailed(error: string): string;
}

/** OpenAI's error codes for a cancel with nothing to cancel, and for a second response. */
export const BENIGN_CODES: ReadonlySet<unknown> = new Set([
  "response_cancel_not_active",
  "conversation_already_has_active_response",
]);

/** The realtime WebSocket under the account's API base, as pipedog's services were given it. */
export function realtimeBase(selection: Selection): string {
  return `${(selection.baseUrl as string).replace(/\/+$/, "").replace(/^http/, "ws")}/realtime`;
}

/** The function tool format both dialects take. */
export function functionTools(tools: readonly ToolSchema[]): Json[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: { type: "object", properties: tool.properties, required: [...tool.required] },
  }));
}

export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function obj(value: unknown): Json {
  return isPlainObject(value) ? value : {};
}
