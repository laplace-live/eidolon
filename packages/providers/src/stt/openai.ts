// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/openai/src/stt.ts@ce8f8bc
//
// OpenAI's Realtime API in transcription-only mode, with server VAD off: the local VAD commits
// each segment. It takes 24 kHz audio.
// https://platform.openai.com/docs/guides/realtime-transcription
import { logger, pyJsonDumps } from "@eidolon/config";
import type { Selection } from "../resolve.ts";
import type { WsData } from "../ws.ts";
import type { SttStream } from "./index.ts";
import { openaiLanguage } from "./language.ts";
import { pcmBase64, textOf, WebsocketStt } from "./stream.ts";

const SAMPLE_RATE = 24000;
const COMMIT = pyJsonDumps({ type: "input_audio_buffer.commit" });

/** The Realtime WebSocket under the account's API base, as its HTTP requests use that base. */
export function openaiSttUrl(selection: Selection): string {
  const base = (selection.baseUrl as string).replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/realtime?intent=transcription`;
}

/** The `session.update` that configures transcription once the session exists. */
export function openaiSessionUpdate(model: string, language: string | null): string {
  return pyJsonDumps({
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          transcription: { model, ...(language ? { language: openaiLanguage(language) } : {}) },
          turn_detection: null,
        },
      },
    },
  });
}

interface ServerEvent {
  readonly type?: unknown;
  readonly item_id?: unknown;
  readonly delta?: string;
  readonly transcript?: string;
  readonly error?: { readonly message?: string; readonly code?: string };
}

class OpenAIStt extends WebsocketStt {
  readonly inputRate = SAMPLE_RATE;
  readonly ttfsP99 = 1.66;
  protected readonly label = "OpenAIRealtimeSTTService";
  protected readonly url: string;
  protected readonly headers: Readonly<Record<string, string>>;
  readonly #sessionUpdate: string;
  /** Each segment's deltas so far, by item: OpenAI sends only what is new. */
  readonly #heard = new Map<unknown, string>();

  constructor(selection: Selection, language: string | null, signal: AbortSignal) {
    super(selection, signal);
    this.url = openaiSttUrl(selection);
    this.headers = { Authorization: `Bearer ${selection.apiKey}` };
    this.#sessionUpdate = openaiSessionUpdate(selection.model, language);
  }

  protected connectFailed(error: string): string {
    return `Error connecting to OpenAI Realtime STT: ${error}`;
  }

  protected encode(pcm: Int16Array): WsData {
    return pyJsonDumps({ type: "input_audio_buffer.append", audio: pcmBase64(pcm) });
  }

  finalize(): void {
    if (this.socket?.open) this.socket.send(COMMIT);
  }

  protected receive(data: WsData): boolean {
    let event: ServerEvent;
    try {
      event = JSON.parse(textOf(data));
    } catch {
      logger.warning("Failed to parse WebSocket message");
      return true;
    }
    switch (event.type) {
      case "session.created":
        this.#heard.clear();
        this.socket?.send(this.#sessionUpdate);
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const delta = event.delta ?? "";
        if (delta === "") break;
        const heard = (this.#heard.get(event.item_id) ?? "") + delta;
        this.#heard.set(event.item_id, heard);
        this.emit({ type: "interim", text: heard });
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        this.#heard.delete(event.item_id);
        const transcript = event.transcript ?? "";
        if (transcript !== "") this.emit({ type: "final", text: transcript, finalized: false });
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        this.#heard.delete(event.item_id);
        this.fail(
          `OpenAI Realtime STT error: ${event.error?.message ?? "Transcription failed"}`,
          false,
        );
        break;
      case "error": {
        const message = `OpenAI Realtime STT error [${event.error?.code ?? ""}]: ${event.error?.message ?? "Unknown error"}`;
        this.fail(message, false);
        throw new Error(message);
      }
    }
    return true;
  }
}

export async function openOpenAIStt(
  selection: Selection,
  language: string | null,
  signal: AbortSignal,
): Promise<SttStream> {
  const stream = new OpenAIStt(selection, language, signal);
  await stream.start();
  return stream;
}
