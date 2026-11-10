// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/services/websocket_service.ts@ce8f8bc and packages/core/src/utils/network.ts@ce8f8bc
//
// The socket the streaming clients share, with the open and close timeouts and the reconnect
// pacing pipedog's services used.
import { logger } from "@eidolon/config";
import type { WebSocket as BunWebSocket, WebSocketOptions } from "bun";

// The DOM lib in tsconfig types the global WebSocket as the browser's, which takes no handshake
// headers and can't terminate; at runtime it is Bun's, which can.
const BunSocket = WebSocket as unknown as new (
  url: string,
  options: WebSocketOptions,
) => BunWebSocket;

const OPEN_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;

export type WsData = string | Uint8Array;

export interface WsConnection {
  readonly open: boolean;
  /** Dropped unless `open`: its owner hears of a close from `messages` ending. */
  send(data: WsData): void;
  /** Text as strings, binary as bytes; ends once the socket has closed and the rest is read. */
  readonly messages: AsyncIterable<WsData>;
  /** Null while open; 1006 when it ended without a close frame, 1005 when that had no code. */
  readonly closeCode: number | null;
  readonly closeReason: string;
  /** Waits up to 2 s for the peer to acknowledge, then drops the connection. */
  close(): Promise<void>;
}

/** The server refused the opening handshake; `status` is its HTTP status when Bun reports one. */
export class WsHandshakeError extends Error {
  override name = "WsHandshakeError";
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

/** Where a socket goes, for error texts: no query string or credentials. */
function describe(url: string): string {
  const parsed = URL.parse(url);
  return parsed === null ? "the websocket server" : `${parsed.origin}${parsed.pathname}`;
}

// Bun reports a refused upgrade only in the error event's text:
// "WebSocket connection to '<url>' failed: Expected 101 status code: 401".
function refused(where: string, event: ErrorEvent): WsHandshakeError {
  const text = event.message ?? "";
  const at = text.indexOf("failed: ");
  const detail = at < 0 ? "" : text.slice(at + "failed: ".length);
  const status = /Expected 101 status code: (\d{3})/.exec(text)?.[1];
  return new WsHandshakeError(
    `websocket connection to ${where} failed${detail === "" ? "" : `: ${detail}`}`,
    status === undefined ? null : Number(status),
  );
}

class Socket implements WsConnection {
  readonly #ws: BunWebSocket;
  readonly #queue: WsData[] = [];
  #wake: (() => void) | null = null;
  #closeCode: number | null = null;
  #closeReason = "";
  readonly #ended = Promise.withResolvers<void>();

  constructor(ws: BunWebSocket) {
    this.#ws = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", ({ data }) => {
      this.#queue.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
      this.#wake?.();
    });
    ws.addEventListener("close", ({ code, reason }) => this.ended(code, reason));
  }

  get open(): boolean {
    return this.#closeCode === null && this.#ws.readyState === WebSocket.OPEN;
  }

  get closeCode(): number | null {
    return this.#closeCode;
  }

  get closeReason(): string {
    return this.#closeReason;
  }

  get whenEnded(): Promise<void> {
    return this.#ended.promise;
  }

  send(data: WsData): void {
    if (this.open) this.#ws.send(data);
  }

  readonly messages: AsyncIterable<WsData> = {
    [Symbol.asyncIterator]: () => this.#read(),
  };

  async *#read(): AsyncGenerator<WsData> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closeCode !== null) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }

  async close(): Promise<void> {
    if (this.#closeCode !== null) return;
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.close(1000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#ended.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (this.#closeCode === null) {
      logger.debug(
        `Peer did not acknowledge the websocket close within ${CLOSE_TIMEOUT_MS / 1000}s; connection dropped`,
      );
      this.drop();
    }
  }

  drop(): void {
    this.#ws.terminate();
    this.ended(1006, "");
  }

  ended(code: number, reason: string): void {
    if (this.#closeCode !== null) return;
    this.#closeCode = code;
    this.#closeReason = reason;
    this.#ended.resolve();
    this.#wake?.();
  }
}

/**
 * Opens a socket with `headers` on the handshake. Aborting `signal` fails a handshake in progress
 * with its reason, and closes an open socket.
 */
export async function connectWs(
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<WsConnection> {
  signal.throwIfAborted();
  const where = describe(url);
  const ws = new BunSocket(url, { headers: { ...headers } });
  const socket = new Socket(ws);
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        settle();
        reject(error);
      };
      const onOpen = () => {
        settle();
        resolve();
      };
      const onError = (event: ErrorEvent) => fail(refused(where, event));
      const onClose = ({ code, reason }: CloseEvent) => {
        fail(
          new WsHandshakeError(
            `websocket connection to ${where} closed during handshake (${code} ${reason})`,
            null,
          ),
        );
      };
      const onAbort = () => fail(signal.reason);
      const timer = setTimeout(
        () => fail(new Error(`timed out during opening handshake with ${where}`)),
        OPEN_TIMEOUT_MS,
      );
      function settle() {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      }
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      signal.addEventListener("abort", onAbort);
    });
  } catch (error) {
    socket.drop();
    throw error;
  }
  const onAbort = () => void socket.close();
  signal.addEventListener("abort", onAbort, { once: true });
  void socket.whenEnded.then(() => signal.removeEventListener("abort", onAbort));
  return socket;
}

const BACKOFF_MIN_SECONDS = 4;
const BACKOFF_MAX_SECONDS = 10;

/** The wait before reconnect attempt `attempt` (from 1): 4 s, 4 s, 4 s, 8 s, then 10 s. */
export function backoffMs(attempt: number): number {
  return Math.max(BACKOFF_MIN_SECONDS, Math.min(2 ** (attempt - 1), BACKOFF_MAX_SECONDS)) * 1000;
}

const STABLE_MS = 5_000;
const QUICK_FAILURES_TO_GIVE_UP = 3;

/**
 * Catches a server that accepts the handshake and then drops the socket at once (a bad key, a
 * rejected setting), where backing off can't help.
 */
export class QuickFailureTracker {
  #count = 0;

  /** A failed connection that had been up `uptimeMs` (0 if it never opened); true: give up. */
  record(uptimeMs: number): boolean {
    this.#count = uptimeMs < STABLE_MS ? this.#count + 1 : 0;
    return this.#count >= QUICK_FAILURES_TO_GIVE_UP;
  }
}
