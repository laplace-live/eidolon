// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/services/websocket_service.ts@ce8f8bc and packages/core/src/services/stt_service.ts@ce8f8bc
//
// What every live recognizer shares: its events, the meter, audio dropped unless the socket is
// open, the idle keepalive, and pipedog's rules for reconnecting a dropped socket.
import { logger } from "@eidolon/config";
import { Meter } from "../meter.ts";
import type { Selection } from "../resolve.ts";
import {
  backoffMs,
  connectWs,
  QuickFailureTracker,
  type WsConnection,
  type WsData,
  WsHandshakeError,
} from "../ws.ts";
import type { SttEvent, SttStream } from "./index.ts";

const RECONNECT_ATTEMPTS = 3;
const KEEPALIVE_CHECK_MS = 5_000;

// pipedog's permanent error categories (authentication, authorization, invalid request).
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

export function isPermanent(status: unknown): boolean {
  return typeof status === "number" && PERMANENT_STATUSES.has(status);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `url` under the origin of an account's own API base, its scheme made ws; else `url`. */
export function accountUrl(selection: Selection, url: string): string {
  if (selection.account.baseSource !== "account" || selection.baseUrl === undefined) return url;
  const base = new URL(selection.baseUrl);
  const target = new URL(url);
  return `${base.protocol.replace(/^http/, "ws")}//${base.host}${target.pathname}${target.search}`;
}

export function pcmBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

export function pcmBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

class EventQueue implements AsyncIterable<SttEvent> {
  readonly #items: SttEvent[] = [];
  #wake: (() => void) | null = null;
  #ended = false;

  push(event: SttEvent): void {
    if (this.#ended) return;
    this.#items.push(event);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SttEvent> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}

export abstract class SttBase implements SttStream {
  abstract readonly inputRate: 16000 | 24000;
  abstract readonly ttfsP99: number;
  /** pipedog's service name, which its log lines and error texts carry. */
  protected abstract readonly label: string;
  readonly events: AsyncIterable<SttEvent>;
  protected socket: WsConnection | null = null;
  /** Aborted by `close()`: no more reconnects, waits or socket. */
  protected readonly closing = new AbortController();
  /** Set by a fatal error: the stream sends nothing more and never reconnects. */
  protected unusable = false;
  /** The read-and-reconnect loop, which `close()` waits for. */
  protected loop: Promise<void> = Promise.resolve();
  #audioAt = performance.now();
  readonly #queue = new EventQueue();
  readonly #meter: Meter;
  readonly #detach: () => void;
  #closed: Promise<void> | null = null;

  constructor(selection: Selection, signal: AbortSignal) {
    this.#meter = new Meter(selection);
    this.events = this.#queue;
    const onAbort = () => void this.close();
    signal.addEventListener("abort", onAbort, { once: true });
    this.#detach = () => signal.removeEventListener("abort", onAbort);
  }

  /** What the socket carries for `pcm`. */
  protected abstract encode(pcm: Int16Array): WsData;
  abstract finalize(): void;

  send(pcm: Int16Array): void {
    if (this.closing.signal.aborted) return;
    this.#meter.add({ audioSeconds: pcm.length / this.inputRate });
    this.#audioAt = performance.now();
    if (!this.unusable && this.socket?.open) this.socket.send(this.encode(pcm));
  }

  protected emit(event: SttEvent): void {
    this.#queue.push(event);
  }

  protected fail(message: string, fatal: boolean): void {
    if (fatal) this.unusable = true;
    logger.error(`${this.label} error: ${message}`);
    this.emit({ type: "error", message, fatal });
  }

  /** Sends `message()` whenever no audio has gone out for `idleMs`, checking every 5 s. */
  protected keepIdleAlive(idleMs: number, message: () => WsData): void {
    this.#audioAt = performance.now();
    const timer = setInterval(() => {
      if (!this.socket?.open || performance.now() - this.#audioAt < idleMs) return;
      this.socket.send(message());
      this.#audioAt = performance.now();
    }, KEEPALIVE_CHECK_MS);
    this.closing.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  }

  /** Runs first in `close()`, while the socket is still open. */
  protected beforeClose(): void {}

  close(): Promise<void> {
    this.#closed ??= this.#shutdown();
    return this.#closed;
  }

  async #shutdown(): Promise<void> {
    this.#detach();
    this.beforeClose();
    this.closing.abort();
    await this.socket?.close();
    await this.loop;
    this.#meter.flush();
    this.#queue.end();
  }
}

/**
 * pipedog's `WebsocketService`: a socket that drops is reconnected at once, up to three attempts
 * 4 s apart, unless it dropped quickly three times running.
 */
export abstract class WebsocketStt extends SttBase {
  protected abstract readonly url: string;
  protected abstract readonly headers: Readonly<Record<string, string>>;
  /** The error text for a connection that failed with `error`. */
  protected abstract connectFailed(error: string): string;
  /** One message. False ends the read; throwing ends it as an error. */
  protected abstract receive(data: WsData): boolean;
  protected opened(_socket: WsConnection): void {}

  /** Connects once, then reads, and reconnects, in the background. */
  async start(): Promise<void> {
    await this.#connect();
    this.loop = this.#run();
  }

  async #connect(): Promise<WsConnection | null> {
    try {
      const socket = await connectWs(this.url, this.headers, this.closing.signal);
      this.socket = socket;
      this.opened(socket);
      return socket;
    } catch (error) {
      this.socket = null;
      if (this.closing.signal.aborted) return null;
      const fatal = error instanceof WsHandshakeError && isPermanent(error.status);
      this.fail(this.connectFailed(errorText(error)), fatal);
      return null;
    }
  }

  async #run(): Promise<void> {
    const quick = new QuickFailureTracker();
    while (!this.closing.signal.aborted) {
      const since = performance.now();
      const why = await this.#read();
      if (this.closing.signal.aborted || this.unusable) return;
      if (quick.record(performance.now() - since)) {
        this.fail(`${this.label} connection failed 3 times immediately after connecting`, true);
        return;
      }
      logger.warning(why);
      if (!(await this.#reconnect())) return;
    }
  }

  /** Reads until the socket ends, and says why it ended. */
  async #read(): Promise<string> {
    const socket = this.socket;
    if (socket === null) return `${this.label} error receiving messages: Websocket not connected`;
    try {
      for await (const data of socket.messages) {
        if (!this.receive(data)) break;
      }
    } catch (error) {
      return `${this.label} error receiving messages: ${errorText(error)}`;
    }
    const code = socket.closeCode;
    if (code === null || code === 1000 || code === 1001) {
      return `${this.label} connection closed by server`;
    }
    const detail =
      code === 1005 || code === 1006
        ? "no close frame received or sent"
        : `${code} ${socket.closeReason}`;
    return `${this.label} connection closed, but with an error: ${detail}`;
  }

  async #reconnect(): Promise<boolean> {
    const failed = `${this.label} websocket reconnection failed verification`;
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
      logger.warning(`${this.label} reconnecting, attempt ${attempt}`);
      await this.socket?.close();
      this.socket = null;
      const socket = await this.#connect();
      if (this.closing.signal.aborted) return false;
      if (socket?.open) {
        logger.info(`${this.label} reconnected successfully on attempt ${attempt}`);
        return true;
      }
      this.fail(`${this.label} reconnection attempt ${attempt} failed: ${failed}`, false);
      if (this.unusable) return false;
      await sleep(backoffMs(attempt), this.closing.signal);
      if (this.closing.signal.aborted) return false;
    }
    this.fail(
      `${this.label} failed to reconnect after ${RECONNECT_ATTEMPTS} attempts: ${failed}`,
      true,
    );
    return false;
  }
}
