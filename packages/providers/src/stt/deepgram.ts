// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/deepgram/src/stt.ts@ce8f8bc
//
// Deepgram's live listening WebSocket with pipedog's query parameters. Unlike the other
// recognizers it reconnects on its own loop: every drop waits 4 s, and it gives up on a rejected
// handshake or three connections in a row that didn't stay up.
// https://developers.deepgram.com/reference/speech-to-text/listen-streaming
import { errorText, logger, pyJsonDumps } from "@eidolon/config";
import type { Selection } from "../resolve.ts";
import {
  backoffMs,
  connectWs,
  QuickFailureTracker,
  type WsConnection,
  WsHandshakeError,
} from "../ws.ts";
import type { SttStream } from "./index.ts";
import { accountUrl, pcmBytes, SttBase, sleep } from "./stream.ts";

const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";
const KEEPALIVE = pyJsonDumps({ type: "KeepAlive" });
const FINALIZE = pyJsonDumps({ type: "Finalize" });
const CLOSE_STREAM = pyJsonDumps({ type: "CloseStream" });
// Deepgram closes a connection idle for 10 s.
const KEEPALIVE_MS = 5_000;

/** Where a connection goes: pipedog's query, in its order. */
export function deepgramUrl(selection: Selection, language: string | null): string {
  const query = new URLSearchParams({
    detect_entities: "false",
    diarize: "false",
    dictation: "false",
    interim_results: "true",
    numerals: "false",
    punctuate: "true",
    smart_format: "false",
    model: selection.model,
    ...(language === null ? {} : { language }),
    encoding: "linear16",
    channels: "1",
    multichannel: "false",
    sample_rate: "16000",
  });
  return accountUrl(selection, `${DEEPGRAM_URL}?${query}`);
}

interface Results {
  readonly type?: unknown;
  readonly is_final?: unknown;
  readonly from_finalize?: unknown;
  readonly channel?: { readonly alternatives?: readonly { readonly transcript?: string }[] };
}

class DeepgramStt extends SttBase {
  readonly inputRate = 16000;
  readonly ttfsP99 = 0.35;
  readonly acknowledgesFinalize = true;
  protected readonly label = "DeepgramSTTService";
  readonly #url: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #ready = Promise.withResolvers<void>();
  /** `finalize()` was sent and Deepgram hasn't answered it yet. */
  #requested = false;
  /** Deepgram answered it: the next final is the finalized one. */
  #pending = false;

  constructor(selection: Selection, language: string | null, signal: AbortSignal) {
    super(selection, signal);
    this.#url = deepgramUrl(selection, language);
    this.#headers = { Authorization: `Token ${selection.apiKey}` };
  }

  /** Resolves once connected, or once it has given up, as pipedog's `_connect()` does. */
  start(): Promise<void> {
    this.loop = this.#run();
    return this.#ready.promise;
  }

  protected encode(pcm: Int16Array): Uint8Array {
    return pcmBytes(pcm);
  }

  finalize(): void {
    if (!this.socket?.open) return;
    this.#requested = true;
    this.socket.send(FINALIZE);
  }

  protected override beforeClose(): void {
    this.socket?.send(CLOSE_STREAM);
  }

  async #run(): Promise<void> {
    const quick = new QuickFailureTracker();
    try {
      while (!this.closing.signal.aborted) {
        let connectedAt: number | null = null;
        try {
          const socket = await connectWs(this.#url, this.#headers, this.closing.signal);
          connectedAt = performance.now();
          this.socket = socket;
          this.#ready.resolve();
          await this.#listen(socket);
        } catch (error) {
          if (this.closing.signal.aborted) return;
          const status = error instanceof WsHandshakeError ? error.status : null;
          if (status !== null && status >= 400 && status < 500) {
            const message = `Deepgram rejected the connection (status ${status}): ${errorText(error)}`;
            this.fail(message, true);
            return;
          }
          logger.warning(`${this.label}: Connection lost, will retry: ${errorText(error)}`);
          this.fail(`connection error: ${errorText(error)}`, false);
        } finally {
          this.socket = null;
        }
        if (this.closing.signal.aborted) return;
        const uptime = connectedAt === null ? 0 : performance.now() - connectedAt;
        if (quick.record(uptime)) {
          this.fail("connection failed to stay up 3 times in a row", true);
          return;
        }
        // pipedog backs off by the count of quick failures, which never passes 2 here.
        await sleep(backoffMs(1), this.closing.signal);
      }
    } finally {
      this.#ready.resolve();
    }
  }

  /** Reads until the socket ends; a broken read is reported, as the SDK's `on("error")` is. */
  async #listen(socket: WsConnection): Promise<void> {
    const keepalive = setInterval(() => socket.send(KEEPALIVE), KEEPALIVE_MS);
    try {
      for await (const data of socket.messages) {
        try {
          if (typeof data === "string") this.#receive(JSON.parse(data));
        } catch (error) {
          this.#broken(errorText(error));
          return;
        }
      }
      const code = socket.closeCode;
      if (code === null || code === 1000 || code === 1001 || this.closing.signal.aborted) return;
      this.#broken(
        code === 1005 || code === 1006
          ? "no close frame received or sent"
          : `${code} ${socket.closeReason}`,
      );
    } finally {
      clearInterval(keepalive);
      await socket.close();
    }
  }

  #broken(message: string): void {
    logger.warning(`${this.label} connection error, will retry: ${message}`);
    this.fail(message, false);
  }

  #receive(message: Results): void {
    if (message.type !== "Results") return;
    const transcript = message.channel?.alternatives?.[0]?.transcript ?? "";
    if (!message.is_final) {
      if (transcript.length === 0) return;
      // Words of a new turn: pipedog forgets an unclaimed finalize when the user speaks again.
      this.#pending = false;
      this.emit({ type: "interim", text: transcript });
      return;
    }
    if (message.from_finalize && this.#requested) {
      this.#requested = false;
      this.#pending = true;
      // Answered with no words. pipedog still passes the mark to the turn's next final.
      if (transcript.length === 0) this.emit({ type: "finalized" });
    }
    if (transcript.length === 0) return;
    this.emit({ type: "final", text: transcript, finalized: this.#pending });
    this.#pending = false;
  }
}

export async function openDeepgramStt(
  selection: Selection,
  language: string | null,
  signal: AbortSignal,
): Promise<SttStream> {
  const stream = new DeepgramStt(selection, language, signal);
  await stream.start();
  return stream;
}
