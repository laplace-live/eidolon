import WebSocket from "ws";
import { utf8Encode } from "./protocol/index.ts";

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

export function nextWsMessage(
  ws: WebSocket,
  timeoutMs: number,
  errors?: {
    readonly onTimeout?: () => Error;
    readonly onClose?: (code: number, reason: string) => Error;
    readonly onError?: (error: Error) => Error;
  },
): Promise<WebSocket.RawData> {
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
