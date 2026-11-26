import { utf8Decode, utf8Encode } from "./encoding.ts";

export const MUX_FRAME = {
  REQ_HEAD: 0x01,
  REQ_BODY: 0x02,
  REQ_END: 0x03,
  REQ_ABORT: 0x04,
  RES_HEAD: 0x05,
  RES_BODY: 0x06,
  RES_END: 0x07,
  RES_ERR: 0x08,
  STREAM_CREDIT: 12,
  REQ_STOP: 13,
  CALL_UDP_OPEN: 0x10,
  CALL_UDP_DATA: 0x11,
  CALL_UDP_CLOSE: 0x12,
  PING: 0x20,
  PONG: 0x21,
} as const;

export type MuxFrameType = (typeof MUX_FRAME)[keyof typeof MUX_FRAME];

/** Chunk bodies below 128 KiB so large transfers never block interactive turns or audio packets. */
export const MAX_MUX_CHUNK = 128 * 1024;
const MUX_HEADER_BYTES = 5;
const STREAM_WINDOW_BYTES = 4 * 1024 * 1024;

export interface MuxHttpHead {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly [string, string][];
}

export interface MuxResponseHead {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly [string, string][];
}

export interface MuxCallOpen {
  readonly hostPort: number;
}

export interface MuxHttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly [string, string][];
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface MuxCallChannelHandle {
  readonly channelId: number;
  sendDatagram(data: Uint8Array): void;
  close(): void;
  onDatagram(listener: (data: Uint8Array) => void): void;
  onClose(listener: () => void): void;
}

export interface MuxHostHandlers {
  onHttpRequest(
    head: MuxHttpHead,
    body: ReadableStream<Uint8Array> | null,
    signal: AbortSignal,
  ): Promise<{
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly [string, string][];
    readonly body: ReadableStream<Uint8Array> | null;
  }>;
  onCallOpen?(
    channelId: number,
    hostPort: number,
    bridge: {
      sendDatagram(data: Uint8Array): void;
      close(): void;
    },
  ): {
    sendToHost(data: Uint8Array): void;
    close(): void;
  } | null;
}

export function encodeMuxFrame(
  type: MuxFrameType,
  streamId: number,
  payload?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const len = payload?.byteLength ?? 0;
  const out = new Uint8Array(MUX_HEADER_BYTES + len);
  out[0] = type;
  const view = new DataView(out.buffer);
  view.setUint32(1, streamId >>> 0, false);
  if (payload !== undefined && len > 0) out.set(payload, MUX_HEADER_BYTES);
  return out;
}

export function decodeMuxFrame(frame: Uint8Array): {
  readonly type: MuxFrameType;
  readonly streamId: number;
  readonly payload: Uint8Array;
} {
  if (frame.byteLength < MUX_HEADER_BYTES) {
    throw new Error(`Mux frame truncated (${frame.byteLength} bytes)`);
  }
  const type = frame[0]! as MuxFrameType;
  const view = new DataView(frame.buffer, frame.byteOffset, MUX_HEADER_BYTES);
  const streamId = view.getUint32(1, false);
  return { type, streamId, payload: frame.subarray(MUX_HEADER_BYTES) };
}

function splitChunks(data: Uint8Array): Uint8Array[] {
  if (data.byteLength <= MAX_MUX_CHUNK) return [data];
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += MAX_MUX_CHUNK) {
    parts.push(data.subarray(offset, offset + MAX_MUX_CHUNK));
  }
  return parts;
}

function hasNoResponseBody(status: number, method: string): boolean {
  return method === "HEAD" || status === 204 || status === 205 || status === 304;
}

type CreditDirection = typeof MUX_FRAME.REQ_BODY | typeof MUX_FRAME.RES_BODY;

function creditKey(direction: CreditDirection, streamId: number): string {
  return `${direction}:${streamId}`;
}

function encodeCredit(direction: CreditDirection, bytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(5);
  out[0] = direction;
  new DataView(out.buffer).setUint32(1, bytes >>> 0, false);
  return out;
}

function decodeCredit(
  payload: Uint8Array,
): { readonly direction: CreditDirection; readonly bytes: number } | null {
  if (payload.byteLength !== 5) return null;
  const direction = payload[0];
  if (direction !== MUX_FRAME.REQ_BODY && direction !== MUX_FRAME.RES_BODY) return null;
  const bytes = new DataView(payload.buffer, payload.byteOffset + 1, 4).getUint32(0, false);
  return { direction, bytes };
}

interface FlowControlledStream {
  readonly stream: ReadableStream<Uint8Array>;
  readonly push: (chunk: Uint8Array) => boolean;
  readonly finish: () => void;
  readonly fail: (error: Error) => void;
  readonly isClosed: () => boolean;
  setCleanup(fn: (() => void) | undefined): void;
}

function createFlowControlledStream(options: {
  readonly onPullBytes: (bytes: number) => void;
  readonly onComplete?: () => void;
  readonly onCancel?: (wasEnded: boolean) => void;
}): FlowControlledStream {
  const chunks: Uint8Array[] = [];
  let queuedBytes = 0;
  let ended = false;
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let pullWake: (() => void) | null = null;
  let cleanup: (() => void) | undefined;

  const wakePull = () => {
    const wake = pullWake;
    pullWake = null;
    wake?.();
  };

  const runCleanup = () => {
    const fn = cleanup;
    cleanup = undefined;
    fn?.();
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        controller = ctrl;
      },
      async pull(ctrl) {
        while (chunks.length === 0 && !ended && !closed) {
          await new Promise<void>((resolve) => {
            pullWake = resolve;
          });
        }
        if (closed) return;
        if (chunks.length > 0) {
          const chunk = chunks.shift()!;
          queuedBytes -= chunk.byteLength;
          ctrl.enqueue(chunk);
          if (chunk.byteLength > 0) options.onPullBytes(chunk.byteLength);
          return;
        }
        if (ended) {
          closed = true;
          runCleanup();
          options.onComplete?.();
          try {
            ctrl.close();
          } catch {
            // Ignore already closed controller.
          }
        }
      },
      cancel() {
        if (closed) return;
        closed = true;
        const wasEnded = ended;
        chunks.length = 0;
        queuedBytes = 0;
        wakePull();
        runCleanup();
        options.onCancel?.(wasEnded);
      },
    },
    { highWaterMark: 0 },
  );

  return {
    stream,
    isClosed: () => closed,
    setCleanup(fn) {
      cleanup = fn;
    },
    push(payload) {
      if (closed) return true;
      if (queuedBytes + payload.byteLength > STREAM_WINDOW_BYTES) return false;
      chunks.push(new Uint8Array(payload));
      queuedBytes += payload.byteLength;
      wakePull();
      return true;
    },
    finish() {
      if (closed) return;
      ended = true;
      wakePull();
    },
    fail(error) {
      if (closed) return;
      closed = true;
      chunks.length = 0;
      queuedBytes = 0;
      wakePull();
      runCleanup();
      try {
        controller?.error(error);
      } catch {
        // Ignore already closed controller.
      }
    },
  };
}

/**
 * Bidirectional HTTP stream + UDP call datagram multiplexer over an already-authenticated
 * Subspace E2EE byte transport. Pure WebStreams/WebCrypto so mobile clients share it directly.
 */
export class MuxEndpoint {
  readonly #sendFrame: (frame: Uint8Array) => Promise<void>;
  readonly #host?: MuxHostHandlers;
  #nextId = 1;
  #closed = false;

  readonly #pendingResponses = new Map<
    number,
    {
      readonly resolve: (response: MuxHttpResponse) => void;
      readonly reject: (error: Error) => void;
      readonly method: string;
    }
  >();
  readonly #clientBodies = new Map<number, FlowControlledStream>();
  readonly #hostRequests = new Map<
    number,
    {
      readonly abort: AbortController;
      readonly bodyStream: FlowControlledStream | null;
    }
  >();
  readonly #sendCredits = new Map<
    string,
    {
      credit: number;
      wake: (() => void) | null;
      readonly cancel: () => void;
    }
  >();
  readonly #clientUploads = new Map<number, () => void>();
  readonly #clientCalls = new Map<
    number,
    {
      onData: ((data: Uint8Array) => void) | null;
      onClose: (() => void) | null;
      closed: boolean;
    }
  >();
  readonly #hostCalls = new Map<
    number,
    {
      sendToHost(data: Uint8Array): void;
      close(): void;
    }
  >();
  readonly #pings = new Map<
    number,
    {
      readonly startedAt: number;
      readonly resolve: (latencyMs: number) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  constructor(options: {
    readonly sendFrame: (frame: Uint8Array) => Promise<void>;
    readonly host?: MuxHostHandlers;
  }) {
    this.#sendFrame = options.sendFrame;
    this.#host = options.host;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async request(input: {
    readonly method: string;
    readonly path: string;
    readonly headers: readonly [string, string][];
    readonly body: ReadableStream<Uint8Array> | null;
    readonly signal?: AbortSignal;
  }): Promise<MuxHttpResponse> {
    if (this.#closed) throw new Error("Subspace tunnel is closed");
    if (input.signal?.aborted) throw new Error("Request aborted");
    const streamId = this.#nextId++;
    const headBytes = utf8Encode(
      JSON.stringify({
        method: input.method,
        path: input.path,
        headers: input.headers,
      } satisfies MuxHttpHead),
    );
    const { promise, resolve, reject } = Promise.withResolvers<MuxHttpResponse>();
    // Signal abort can reject synchronously while REQ_HEAD is still flushing, before `await promise`.
    promise.catch(() => {});
    this.#pendingResponses.set(streamId, { resolve, reject, method: input.method });

    let aborted = false;
    let uploadStopped = false;
    const hasUploadBody = input.body !== null && input.method !== "GET" && input.method !== "HEAD";
    if (hasUploadBody) {
      this.#clientUploads.set(streamId, () => {
        if (uploadStopped) return;
        uploadStopped = true;
        this.#sendCredits.get(creditKey(MUX_FRAME.REQ_BODY, streamId))?.cancel();
      });
    }
    const sendAbort = (): void => {
      if (aborted || this.#closed) return;
      aborted = true;
      const pending = this.#pendingResponses.get(streamId);
      if (pending !== undefined) {
        this.#pendingResponses.delete(streamId);
        pending.reject(new Error("Request aborted"));
      }
      const stream = this.#clientBodies.get(streamId);
      if (stream !== undefined) {
        this.#clientBodies.delete(streamId);
        stream.fail(new Error("Request aborted"));
      }
      void this.#emit(MUX_FRAME.REQ_ABORT, streamId);
    };
    input.signal?.addEventListener("abort", sendAbort, { once: true });

    try {
      await this.#sendFrame(encodeMuxFrame(MUX_FRAME.REQ_HEAD, streamId, headBytes));
      if (input.method === "GET" || input.method === "HEAD") {
        void input.body?.cancel().catch(() => {});
      } else if (input.body === null) {
        await this.#sendFrame(encodeMuxFrame(MUX_FRAME.REQ_END, streamId));
      } else {
        void this.#pumpStreamBody({
          streamId,
          body: input.body,
          bodyFrame: MUX_FRAME.REQ_BODY,
          endFrame: MUX_FRAME.REQ_END,
          signal: input.signal,
          isAborted: () => aborted || uploadStopped,
          onError: async (error) => {
            const pending = this.#pendingResponses.get(streamId);
            if (pending !== undefined) {
              this.#pendingResponses.delete(streamId);
              pending.reject(error instanceof Error ? error : new Error(String(error)));
            }
            void this.#emit(MUX_FRAME.REQ_ABORT, streamId);
          },
        }).finally(() => {
          this.#clientUploads.delete(streamId);
        });
      }
      return await promise;
    } catch (error) {
      this.#clientUploads.delete(streamId);
      this.#pendingResponses.delete(streamId);
      throw error;
    } finally {
      // Remove listener once completed, or bind cleanup onto the active response stream so closing
      // the HTTP response never fires a late REQ_ABORT on a finished tunnel stream.
      const activeStream = this.#clientBodies.get(streamId);
      if (activeStream !== undefined && !activeStream.isClosed()) {
        activeStream.setCleanup(() => input.signal?.removeEventListener("abort", sendAbort));
      } else {
        input.signal?.removeEventListener("abort", sendAbort);
      }
    }
  }

  /** Opens a UDP call forwarding channel bound to `hostPort` on the remote SubspaceHost. */
  openCallChannel(hostPort: number): MuxCallChannelHandle {
    if (this.#closed) throw new Error("Subspace tunnel is closed");
    const channelId = this.#nextId++;
    const state = {
      onData: null as ((data: Uint8Array) => void) | null,
      onClose: null as (() => void) | null,
      closed: false,
    };
    this.#clientCalls.set(channelId, state);
    void this.#emit(
      MUX_FRAME.CALL_UDP_OPEN,
      channelId,
      utf8Encode(JSON.stringify({ hostPort } satisfies MuxCallOpen)),
    );
    return {
      channelId,
      sendDatagram: (data) => {
        if (!state.closed && !this.#closed) {
          void this.#emit(MUX_FRAME.CALL_UDP_DATA, channelId, data);
        }
      },
      close: () => {
        if (state.closed) return;
        state.closed = true;
        this.#clientCalls.delete(channelId);
        void this.#emit(MUX_FRAME.CALL_UDP_CLOSE, channelId);
      },
      onDatagram: (listener) => {
        state.onData = listener;
      },
      onClose: (listener) => {
        state.onClose = listener;
      },
    };
  }

  async ping(timeoutMs = 5_000): Promise<number> {
    if (this.#closed) throw new Error("Subspace tunnel is closed");
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const timer = setTimeout(() => {
      this.#pings.delete(id);
      reject(new Error("Subspace ping timeout"));
    }, timeoutMs);
    this.#pings.set(id, {
      startedAt: performance.now(),
      resolve: (ms) => {
        clearTimeout(timer);
        resolve(ms);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    await this.#emit(MUX_FRAME.PING, id);
    return promise;
  }

  async handleFrame(rawFrame: Uint8Array): Promise<void> {
    if (this.#closed) return;
    const { type, streamId, payload } = decodeMuxFrame(rawFrame);
    switch (type) {
      case MUX_FRAME.PING:
        await this.#emit(MUX_FRAME.PONG, streamId, payload);
        return;
      case MUX_FRAME.PONG: {
        const entry = this.#pings.get(streamId);
        if (entry !== undefined) {
          this.#pings.delete(streamId);
          entry.resolve(Math.max(1, Math.round(performance.now() - entry.startedAt)));
        }
        return;
      }
      case MUX_FRAME.REQ_HEAD:
        this.#onReqHead(streamId, payload);
        return;
      case MUX_FRAME.REQ_BODY:
        this.#onReqBody(streamId, payload);
        return;
      case MUX_FRAME.REQ_END:
        this.#onReqEnd(streamId);
        return;
      case MUX_FRAME.REQ_ABORT:
        this.#onReqAbort(streamId);
        return;
      case MUX_FRAME.RES_HEAD:
        this.#onResHead(streamId, payload);
        return;
      case MUX_FRAME.RES_BODY:
        this.#onResBody(streamId, payload);
        return;
      case MUX_FRAME.RES_END:
        this.#onResEnd(streamId);
        return;
      case MUX_FRAME.RES_ERR: {
        let message = "Remote request failed";
        try {
          message = utf8Decode(payload) || message;
        } catch {
          // Invalid UTF-8 error payload falls back to generic remote error.
        }
        this.#onResErr(streamId, message);
        return;
      }
      case MUX_FRAME.STREAM_CREDIT: {
        const credit = decodeCredit(payload);
        if (credit !== null && credit.bytes > 0) {
          const entry = this.#sendCredits.get(creditKey(credit.direction, streamId));
          if (entry !== undefined) {
            entry.credit += credit.bytes;
            const wake = entry.wake;
            entry.wake = null;
            wake?.();
          }
        }
        return;
      }
      case MUX_FRAME.REQ_STOP:
        this.#clientUploads.get(streamId)?.();
        return;
      case MUX_FRAME.CALL_UDP_OPEN:
        this.#onCallOpen(streamId, payload);
        return;
      case MUX_FRAME.CALL_UDP_DATA:
        this.#hostCalls.get(streamId)?.sendToHost(payload);
        this.#clientCalls.get(streamId)?.onData?.(payload);
        return;
      case MUX_FRAME.CALL_UDP_CLOSE: {
        const hostCall = this.#hostCalls.get(streamId);
        if (hostCall !== undefined) {
          this.#hostCalls.delete(streamId);
          hostCall.close();
        }
        const clientCall = this.#clientCalls.get(streamId);
        if (clientCall !== undefined && !clientCall.closed) {
          clientCall.closed = true;
          this.#clientCalls.delete(streamId);
          clientCall.onClose?.();
        }
        return;
      }
    }
  }

  close(reason = "Subspace tunnel closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error(reason);
    for (const pending of this.#pendingResponses.values()) pending.reject(error);
    this.#pendingResponses.clear();
    for (const stream of this.#clientBodies.values()) stream.fail(error);
    this.#clientBodies.clear();
    for (const req of this.#hostRequests.values()) {
      req.abort.abort(error);
      req.bodyStream?.fail(error);
    }
    this.#hostRequests.clear();
    for (const stop of this.#clientUploads.values()) stop();
    this.#clientUploads.clear();
    for (const entry of this.#sendCredits.values()) entry.cancel();
    this.#sendCredits.clear();
    for (const call of this.#clientCalls.values()) {
      if (!call.closed) {
        call.closed = true;
        call.onClose?.();
      }
    }
    this.#clientCalls.clear();
    for (const hostCall of this.#hostCalls.values()) hostCall.close();
    this.#hostCalls.clear();
    for (const ping of this.#pings.values()) ping.reject(error);
    this.#pings.clear();
  }

  async #emit(type: MuxFrameType, streamId: number, payload?: Uint8Array): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#sendFrame(encodeMuxFrame(type, streamId, payload));
    } catch {
      // Transport closure is handled by close().
    }
  }

  async #pumpStreamBody(input: {
    readonly streamId: number;
    readonly body: ReadableStream<Uint8Array>;
    readonly bodyFrame: CreditDirection;
    readonly endFrame: MuxFrameType;
    readonly signal?: AbortSignal;
    readonly isAborted: () => boolean;
    readonly onError: (error: unknown) => Promise<void>;
  }): Promise<void> {
    const key = creditKey(input.bodyFrame, input.streamId);
    const reader = input.body.getReader();
    let cancelled = false;
    const creditEntry = {
      credit: STREAM_WINDOW_BYTES,
      wake: null as (() => void) | null,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        const wake = creditEntry.wake;
        creditEntry.wake = null;
        wake?.();
        void reader.cancel().catch(() => {});
      },
    };
    this.#sendCredits.set(key, creditEntry);
    input.signal?.addEventListener("abort", creditEntry.cancel, { once: true });
    if (input.signal?.aborted || input.isAborted() || this.#closed) {
      creditEntry.cancel();
    }

    const isDoneOrAborted = () =>
      cancelled || input.isAborted() || Boolean(input.signal?.aborted) || this.#closed;

    try {
      for (;;) {
        if (isDoneOrAborted()) {
          await reader.cancel().catch(() => {});
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined && value.byteLength > 0) {
          for (const chunk of splitChunks(value)) {
            while (creditEntry.credit < chunk.byteLength && !isDoneOrAborted()) {
              await new Promise<void>((resolve) => {
                creditEntry.wake = resolve;
              });
            }
            if (isDoneOrAborted()) {
              await reader.cancel().catch(() => {});
              return;
            }
            creditEntry.credit -= chunk.byteLength;
            await this.#sendFrame(encodeMuxFrame(input.bodyFrame, input.streamId, chunk));
          }
        }
      }
      if (!isDoneOrAborted()) {
        await this.#sendFrame(encodeMuxFrame(input.endFrame, input.streamId));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (!isDoneOrAborted()) {
        await input.onError(error);
      }
    } finally {
      this.#sendCredits.delete(key);
      input.signal?.removeEventListener("abort", creditEntry.cancel);
      try {
        reader.releaseLock();
      } catch {
        // Ignore if reader was already released or errored.
      }
    }
  }

  #onReqHead(streamId: number, payload: Uint8Array): void {
    const host = this.#host;
    if (host === undefined) return;
    let head: MuxHttpHead;
    try {
      head = JSON.parse(utf8Decode(payload)) as MuxHttpHead;
    } catch {
      void this.#emit(MUX_FRAME.RES_ERR, streamId, utf8Encode("Invalid request head"));
      return;
    }
    const abort = new AbortController();
    const hasBody = head.method !== "GET" && head.method !== "HEAD";
    const bodyStream = hasBody
      ? createFlowControlledStream({
          onPullBytes: (bytes) => {
            void this.#emit(
              MUX_FRAME.STREAM_CREDIT,
              streamId,
              encodeCredit(MUX_FRAME.REQ_BODY, bytes),
            );
          },
          onCancel: (wasEnded) => {
            if (!wasEnded && !abort.signal.aborted) {
              void this.#emit(MUX_FRAME.REQ_STOP, streamId);
            }
          },
        })
      : null;
    this.#hostRequests.set(streamId, { abort, bodyStream });

    void this.#runHostRequest(streamId, host, head, bodyStream?.stream ?? null, abort.signal);
  }

  async #runHostRequest(
    streamId: number,
    host: MuxHostHandlers,
    head: MuxHttpHead,
    body: ReadableStream<Uint8Array> | null,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const res = await host.onHttpRequest(head, body, signal);
      if (body !== null && !body.locked) {
        void body.cancel().catch(() => {});
      }
      if (signal.aborted || this.#closed) {
        await res.body?.cancel().catch(() => {});
        return;
      }
      const resHead = utf8Encode(
        JSON.stringify({
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        } satisfies MuxResponseHead),
      );
      await this.#sendFrame(encodeMuxFrame(MUX_FRAME.RES_HEAD, streamId, resHead));
      if (res.body === null || hasNoResponseBody(res.status, head.method)) {
        await res.body?.cancel().catch(() => {});
        await this.#sendFrame(encodeMuxFrame(MUX_FRAME.RES_END, streamId));
        return;
      }
      await this.#pumpStreamBody({
        streamId,
        body: res.body,
        bodyFrame: MUX_FRAME.RES_BODY,
        endFrame: MUX_FRAME.RES_END,
        signal,
        isAborted: () => signal.aborted,
        onError: async (error) => {
          if (!signal.aborted && !this.#closed) {
            await this.#emit(
              MUX_FRAME.RES_ERR,
              streamId,
              utf8Encode(error instanceof Error ? error.message : String(error)),
            );
          }
        },
      });
    } catch (error) {
      if (!signal.aborted && !this.#closed) {
        await this.#emit(
          MUX_FRAME.RES_ERR,
          streamId,
          utf8Encode(error instanceof Error ? error.message : String(error)),
        );
      }
    } finally {
      if (body !== null && !body.locked) {
        void body.cancel().catch(() => {});
      }
      this.#hostRequests.delete(streamId);
    }
  }

  #onReqBody(streamId: number, payload: Uint8Array): void {
    const req = this.#hostRequests.get(streamId);
    if (req === undefined || req.bodyStream === null || req.bodyStream.isClosed()) return;
    if (!req.bodyStream.push(payload)) {
      const err = new Error("Request stream exceeded flow control window");
      req.abort.abort(err);
      req.bodyStream.fail(err);
      this.#hostRequests.delete(streamId);
      void this.#emit(MUX_FRAME.RES_ERR, streamId, utf8Encode(err.message));
    }
  }

  #onReqEnd(streamId: number): void {
    const req = this.#hostRequests.get(streamId);
    if (req === undefined || req.bodyStream === null) return;
    req.bodyStream.finish();
  }

  #onReqAbort(streamId: number): void {
    const req = this.#hostRequests.get(streamId);
    if (req === undefined) return;
    req.abort.abort();
    req.bodyStream?.fail(new Error("Client aborted request"));
    this.#hostRequests.delete(streamId);
  }

  #onResHead(streamId: number, payload: Uint8Array): void {
    const pending = this.#pendingResponses.get(streamId);
    if (pending === undefined) return;
    this.#pendingResponses.delete(streamId);
    let head: MuxResponseHead;
    try {
      head = JSON.parse(utf8Decode(payload)) as MuxResponseHead;
    } catch {
      pending.reject(new Error("Malformed response head"));
      return;
    }
    if (hasNoResponseBody(head.status, pending.method)) {
      pending.resolve({
        status: head.status,
        statusText: head.statusText,
        headers: head.headers,
        body: null,
      });
      return;
    }
    const bodyStream = createFlowControlledStream({
      onPullBytes: (bytes) => {
        void this.#emit(MUX_FRAME.STREAM_CREDIT, streamId, encodeCredit(MUX_FRAME.RES_BODY, bytes));
      },
      onComplete: () => {
        this.#clientBodies.delete(streamId);
      },
      onCancel: (wasEnded) => {
        this.#clientBodies.delete(streamId);
        if (!wasEnded) void this.#emit(MUX_FRAME.REQ_ABORT, streamId);
      },
    });
    this.#clientBodies.set(streamId, bodyStream);
    pending.resolve({
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
      body: bodyStream.stream,
    });
  }

  #failOrCloseClientStream(streamId: number, error: Error | null): void {
    this.#clientUploads.get(streamId)?.();
    const pending = this.#pendingResponses.get(streamId);
    if (pending !== undefined) {
      this.#pendingResponses.delete(streamId);
      pending.reject(error ?? new Error("Response ended before headers"));
      return;
    }
    const stream = this.#clientBodies.get(streamId);
    if (stream === undefined) return;
    if (error === null) {
      stream.finish();
      return;
    }
    this.#clientBodies.delete(streamId);
    stream.fail(error);
  }

  #onResBody(streamId: number, payload: Uint8Array): void {
    const stream = this.#clientBodies.get(streamId);
    if (stream === undefined || stream.isClosed()) return;
    if (!stream.push(payload)) {
      this.#clientBodies.delete(streamId);
      stream.fail(new Error("Response stream exceeded flow control window"));
      void this.#emit(MUX_FRAME.REQ_ABORT, streamId);
    }
  }

  #onResEnd(streamId: number): void {
    this.#failOrCloseClientStream(streamId, null);
  }

  #onResErr(streamId: number, message: string): void {
    this.#failOrCloseClientStream(streamId, new Error(message || "Remote request failed"));
  }

  #onCallOpen(streamId: number, payload: Uint8Array): void {
    const open = this.#host?.onCallOpen;
    if (open === undefined) {
      void this.#emit(MUX_FRAME.CALL_UDP_CLOSE, streamId);
      return;
    }
    let parsed: MuxCallOpen;
    try {
      parsed = JSON.parse(utf8Decode(payload)) as MuxCallOpen;
    } catch {
      void this.#emit(MUX_FRAME.CALL_UDP_CLOSE, streamId);
      return;
    }
    const bridge = open(streamId, parsed.hostPort, {
      sendDatagram: (data) => {
        if (!this.#closed) void this.#emit(MUX_FRAME.CALL_UDP_DATA, streamId, data);
      },
      close: () => {
        this.#hostCalls.delete(streamId);
        void this.#emit(MUX_FRAME.CALL_UDP_CLOSE, streamId);
      },
    });
    if (bridge === null) {
      void this.#emit(MUX_FRAME.CALL_UDP_CLOSE, streamId);
      return;
    }
    this.#hostCalls.set(streamId, bridge);
  }
}
