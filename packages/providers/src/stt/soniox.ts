// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/soniox/src/stt.ts@ce8f8bc
//
// Soniox's real-time WebSocket API, with pipedog's settings: the local VAD ends each turn
// (`finalize`), so Soniox's own endpoint detection stays off.
// https://soniox.com/docs/stt/api-reference/websocket-api
import { logger, pyJsonDumps } from "@eidolon/config";
import type { Selection } from "../resolve.ts";
import type { WsConnection, WsData } from "../ws.ts";
import type { SttStream } from "./index.ts";
import { sonioxHints } from "./language.ts";
import { accountUrl, isPermanent, pcmBytes, textOf, WebsocketStt } from "./stream.ts";

const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const KEEPALIVE = '{"type": "keepalive"}';
const FINALIZE = '{"type": "finalize"}';
const END_TOKEN = "<end>";
const FINALIZED_TOKEN = "<fin>";
const KEEPALIVE_IDLE_MS = 1_000;

interface Token {
  readonly text: string;
  readonly is_final?: boolean;
}

export function sonioxUrl(selection: Selection): string {
  return accountUrl(selection, SONIOX_URL);
}

/** The configuration Soniox reads first on every connection. */
export function sonioxConfig(model: string, language: string | null): string {
  return pyJsonDumps({
    model,
    audio_format: "pcm_s16le",
    num_channels: 1,
    enable_endpoint_detection: false,
    max_endpoint_delay_ms: null,
    endpoint_sensitivity: null,
    endpoint_latency_adjustment_level: null,
    sample_rate: 16000,
    language_hints: sonioxHints(language),
    language_hints_strict: null,
    context: null,
    enable_speaker_diarization: false,
    enable_language_identification: false,
    client_reference_id: null,
  });
}

class SonioxStt extends WebsocketStt {
  readonly inputRate = 16000;
  readonly ttfsP99 = 0.35;
  readonly acknowledgesFinalize = true;
  protected readonly label = "SonioxSTTService";
  protected readonly url: string;
  protected readonly headers: Readonly<Record<string, string>>;
  readonly #config: string;
  /** Final tokens since the last endpoint token, which closes them into one segment. */
  #final: string[] = [];

  constructor(selection: Selection, language: string | null, signal: AbortSignal) {
    super(selection, signal);
    this.url = sonioxUrl(selection);
    this.headers = { Authorization: `Bearer ${selection.apiKey}` };
    this.#config = sonioxConfig(selection.model, language);
  }

  protected connectFailed(error: string): string {
    return `Unable to connect to Soniox: ${error}`;
  }

  protected override opened(socket: WsConnection): void {
    // pipedog starts each connection's reading with an empty buffer: a dropped socket's unended
    // final tokens are never sent.
    this.#final = [];
    socket.send(this.#config);
  }

  protected encode(pcm: Int16Array): WsData {
    return pcmBytes(pcm);
  }

  finalize(): void {
    if (this.socket?.open) this.socket.send(FINALIZE);
  }

  /** The segment heard up to an endpoint, if any. */
  #endpoint(): void {
    if (this.#final.length === 0) return;
    this.emit({ type: "final", text: this.#final.join(""), finalized: true });
    this.#final = [];
  }

  protected receive(data: WsData): boolean {
    const text = textOf(data);
    let content: {
      tokens?: readonly Token[];
      error_code?: unknown;
      error_message?: unknown;
      finished?: unknown;
    };
    try {
      content = JSON.parse(text);
    } catch {
      logger.warning(`Received non-JSON message: ${text}`);
      return true;
    }
    const pending: string[] = [];
    for (const token of content.tokens ?? []) {
      if (!token.is_final) pending.push(token.text);
      else if (token.text === FINALIZED_TOKEN && this.#final.length === 0)
        this.emit({ type: "finalized" });
      else if (token.text === END_TOKEN || token.text === FINALIZED_TOKEN) this.#endpoint();
      else this.#final.push(token.text);
    }
    // Final tokens go out as interim text too, until an endpoint makes them a segment.
    if (this.#final.length > 0 || pending.length > 0) {
      this.emit({ type: "interim", text: this.#final.join("") + pending.join("") });
    }
    const { error_code: code, error_message: message } = content;
    if (code || message) {
      this.#endpoint();
      this.fail(`Error: ${code} (_receive_messages) - ${message}`, isPermanent(code));
    }
    if (content.finished) {
      this.#endpoint();
      return false;
    }
    return true;
  }

  override async start(): Promise<void> {
    await super.start();
    this.keepIdleAlive(KEEPALIVE_IDLE_MS, () => KEEPALIVE);
  }
}

export async function openSonioxStt(
  selection: Selection,
  language: string | null,
  signal: AbortSignal,
): Promise<SttStream> {
  const stream = new SonioxStt(selection, language, signal);
  await stream.start();
  return stream;
}
