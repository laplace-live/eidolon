import WebSocket from "ws";
import { utf8Encode } from "./protocol/index.ts";

export function rawDataByteLength(data: WebSocket.RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return data.byteLength;
}

export function rawDataToUint8Array(data: WebSocket.RawData): Uint8Array {
  if (typeof data === "string") return utf8Encode(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function rawDataToText(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

export function sendWs(ws: WebSocket, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error("WebSocket is not open"));
      return;
    }
    ws.send(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function safeCloseWs(ws: WebSocket, code = 1000, reason = "Closed"): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  }
}

const guardedSockets = new WeakSet<WebSocket>();

/** Installs a socket-lifetime fallback error listener so detaching handshake handlers never leaves zero listeners. */
export function guardWsErrors(ws: WebSocket): void {
  if (guardedSockets.has(ws)) return;
  guardedSockets.add(ws);
  ws.on("error", () => {});
}

export function nextWsMessage(
  ws: WebSocket,
  timeoutMs: number,
  errors?: {
    readonly onTimeout?: () => Error;
    readonly onClose?: (code: number, reason: string) => Error;
    readonly onError?: (error: Error) => Error;
  },
): Promise<WebSocket.RawData> {
  guardWsErrors(ws);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(errors?.onTimeout?.() ?? new Error("Handshake timeout"))),
      timeoutMs,
    );
    const onMessage = (data: WebSocket.RawData) => finish(() => resolve(data));
    const onClose = (code: number, reason: Buffer) =>
      finish(() =>
        reject(
          errors?.onClose?.(code, reason.toString("utf8")) ??
            new Error("WebSocket closed during handshake"),
        ),
      );
    const onError = (err: Error) => finish(() => reject(errors?.onError?.(err) ?? err));
    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

export const DEFAULT_PRE_ATTACH_BUFFER_BYTES = 1024 * 1024;
export const DEFAULT_PRE_ATTACH_BUFFER_FRAMES = 256;

export interface WsFramePump {
  nextMessage(
    timeoutMs: number,
    errors?: {
      readonly onTimeout?: () => Error;
      readonly onClose?: (code: number, reason: string) => Error;
      readonly onError?: (error: Error) => Error;
    },
  ): Promise<WebSocket.RawData>;
  attach(handler: (raw: WebSocket.RawData) => void): void;
  clear(): void;
}

/**
 * Attaches a persistent, bounded frame buffer from handshake completion until the final Mux
 * message handler takes ownership, preventing frames sent right behind auth responses (or across
 * async manager waits) from being dropped and desynchronizing E2EE sequence numbers.
 */
export function createWsFramePump(
  ws: WebSocket,
  options: {
    readonly maxFrames?: number;
    readonly maxBytes?: number;
    readonly onOverflow?: () => void;
  } = {},
): WsFramePump {
  guardWsErrors(ws);
  const maxFrames = options.maxFrames ?? DEFAULT_PRE_ATTACH_BUFFER_FRAMES;
  const maxBytes = options.maxBytes ?? DEFAULT_PRE_ATTACH_BUFFER_BYTES;
  const queued: WebSocket.RawData[] = [];
  let queuedBytes = 0;
  let closed = false;
  let overflowed = false;
  let attached = false;
  let closeInfo: { readonly code: number; readonly reason: string } | null = null;
  let closeErr: Error | null = null;
  let waiter: {
    readonly resolve: (raw: WebSocket.RawData) => void;
    readonly rejectWithClose: (code: number, reason: string) => void;
    readonly rejectWithError: (err: Error) => void;
  } | null = null;

  const detach = () => {
    ws.off("message", onMessage);
    ws.off("close", onClose);
    ws.off("error", onError);
  };

  const clear = () => {
    closed = true;
    detach();
    queued.length = 0;
    queuedBytes = 0;
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      if (closeErr !== null) w.rejectWithError(closeErr);
      else w.rejectWithClose(closeInfo?.code ?? 1006, closeInfo?.reason ?? "");
    }
  };

  const onMessage = (raw: WebSocket.RawData) => {
    if (closed || attached) return;
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w.resolve(raw);
      return;
    }
    const size = rawDataByteLength(raw);
    if (queued.length >= maxFrames || queuedBytes + size > maxBytes) {
      overflowed = true;
      closeInfo = { code: 1008, reason: "Frame buffer overflow" };
      clear();
      options.onOverflow?.();
      return;
    }
    queuedBytes += size;
    queued.push(raw);
  };

  const onClose = (code: number, reason: Buffer) => {
    closeInfo = { code, reason: reason.toString("utf8") };
    clear();
  };
  const onError = (err: Error) => {
    closeErr = err;
    clear();
  };
  ws.on("message", onMessage);
  ws.on("close", onClose);
  ws.on("error", onError);

  return {
    nextMessage(timeoutMs, errors) {
      if (queued.length > 0) {
        const first = queued.shift()!;
        queuedBytes = Math.max(0, queuedBytes - rawDataByteLength(first));
        return Promise.resolve(first);
      }
      if (closeErr !== null) {
        return Promise.reject(errors?.onError?.(closeErr) ?? closeErr);
      }
      if (overflowed || closed || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(
          errors?.onClose?.(closeInfo?.code ?? 1006, closeInfo?.reason ?? "") ??
            new Error("WebSocket closed during handshake"),
        );
      }
      return new Promise<WebSocket.RawData>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (waiter === currentWaiter) waiter = null;
          fn();
        };
        const timer = setTimeout(
          () => finish(() => reject(errors?.onTimeout?.() ?? new Error("Handshake timeout"))),
          timeoutMs,
        );
        const currentWaiter = {
          resolve: (raw: WebSocket.RawData) => finish(() => resolve(raw)),
          rejectWithClose: (code: number, reason: string) =>
            finish(() =>
              reject(
                errors?.onClose?.(code, reason) ?? new Error("WebSocket closed during handshake"),
              ),
            ),
          rejectWithError: (err: Error) => finish(() => reject(errors?.onError?.(err) ?? err)),
        };
        waiter = currentWaiter;
      });
    },
    attach(handler) {
      if (closed || attached) return;
      attached = true;
      detach();
      const pending = queued.splice(0);
      queuedBytes = 0;
      ws.on("message", handler);
      for (const frame of pending) handler(frame);
    },
    clear,
  };
}
