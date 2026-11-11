// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/elevenlabs/src/stt.ts@ce8f8bc
//
// ElevenLabs' realtime speech-to-text WebSocket with manual commits: the local VAD ends each
// segment, so every committed transcript is final.
// https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
import { logger, pyJsonDumps } from "@eidolon/config";
import type { Selection } from "../resolve.ts";
import type { WsData } from "../ws.ts";
import type { SttStream } from "./index.ts";
import { elevenLabsLanguage } from "./language.ts";
import { accountUrl, pcmBase64, textOf, WebsocketStt } from "./stream.ts";

const ELEVENLABS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const SAMPLE_RATE = 16000;
const KEEPALIVE_IDLE_MS = 10_000;
// 100 ms of silence.
const KEEPALIVE_SILENCE = new Int16Array(SAMPLE_RATE / 10);

const COMMITTED: ReadonlySet<string> = new Set([
  "committed_transcript",
  "committed_transcript_with_timestamps",
]);

const ERROR_TYPES: ReadonlySet<string> = new Set([
  "error",
  "auth_error",
  "quota_exceeded",
  "transcriber_error",
  "input_error",
  "invalid_request",
  "commit_throttled",
  "unaccepted_terms",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
]);

/** Where a connection goes; pipedog writes the query unencoded. */
export function elevenLabsUrl(selection: Selection, language: string | null): string {
  const params = [`model_id=${selection.model}`];
  if (language) params.push(`language_code=${elevenLabsLanguage(language)}`);
  params.push(`audio_format=pcm_${SAMPLE_RATE}`, "commit_strategy=manual");
  return accountUrl(selection, `${ELEVENLABS_URL}?${params.join("&")}`);
}

function chunk(pcm: Int16Array, commit: boolean): string {
  return pyJsonDumps({
    message_type: "input_audio_chunk",
    audio_base_64: pcmBase64(pcm),
    commit,
    sample_rate: SAMPLE_RATE,
  });
}

const COMMIT = chunk(new Int16Array(0), true);

class ElevenLabsStt extends WebsocketStt {
  readonly inputRate = SAMPLE_RATE;
  readonly ttfsP99 = 0.41;
  readonly acknowledgesFinalize = false;
  protected readonly label = "ElevenLabsRealtimeSTTService";
  protected readonly url: string;
  protected readonly headers: Readonly<Record<string, string>>;

  constructor(selection: Selection, language: string | null, signal: AbortSignal) {
    super(selection, signal);
    this.url = elevenLabsUrl(selection, language);
    this.headers = { "xi-api-key": selection.apiKey as string };
  }

  protected connectFailed(error: string): string {
    return `Unable to connect to ElevenLabs Realtime STT: ${error}`;
  }

  protected encode(pcm: Int16Array): WsData {
    return chunk(pcm, false);
  }

  finalize(): void {
    if (this.socket?.open) this.socket.send(COMMIT);
  }

  protected receive(data: WsData): boolean {
    const text = textOf(data);
    let message: { message_type?: unknown; text?: unknown; error?: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      logger.warning(`Received non-JSON message: ${text}`);
      return true;
    }
    const type = String(message.message_type);
    if (type === "partial_transcript" || COMMITTED.has(type)) {
      const heard = String(message.text ?? "").trim();
      if (heard === "") return true;
      this.emit(
        type === "partial_transcript"
          ? { type: "interim", text: heard }
          : { type: "final", text: heard, finalized: true },
      );
    } else if (ERROR_TYPES.has(type)) {
      const detail = "error" in message ? message.error : `Unknown error - ${type}`;
      this.fail(`Error: ${detail}`, false);
    } else {
      logger.debug(`ElevenLabs STT message: ${type}`);
    }
    return true;
  }

  override async start(): Promise<void> {
    await super.start();
    this.keepIdleAlive(KEEPALIVE_IDLE_MS, () => chunk(KEEPALIVE_SILENCE, false));
  }
}

export async function openElevenLabsStt(
  selection: Selection,
  language: string | null,
  signal: AbortSignal,
): Promise<SttStream> {
  const stream = new ElevenLabsStt(selection, language, signal);
  await stream.start();
  return stream;
}
