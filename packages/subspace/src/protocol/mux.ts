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
  readonly #clientBodies = new Map<
    number,
    {
      controller: ReadableStreamDefaultController<Uint8Array> | null;
      closed: boolean;
      cleanup?: () => void;
    }
  >();
  readonly #hostRequests = new Map<
    number,
    {
      readonly abort: AbortController;
      readonly bodyController: ReadableStreamDefaultController<Uint8Array> | null;
      bodyClosed: boolean;
    }
  >();
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
    const sendAbort = (): void => {
      if (aborted || this.#closed) return;
      aborted = true;
      const pending = this.#pendingResponses.get(streamId);
      if (pending !== undefined) {
        this.#pendingResponses.delete(streamId);
        pending.reject(new Error("Request aborted"));
      }
      const controller = this.#takeClientStream(streamId);
      if (controller !== null) {
        try {
          controller.error(new Error("Request aborted"));
        } catch {
          // Ignore already-closed stream controller.
        }
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
          isAborted: () => aborted,
          onError: async () => {
            void this.#emit(MUX_FRAME.REQ_ABORT, streamId);
          },
        });
      }
      return await promise;
    } catch (error) {
      this.#pendingResponses.delete(streamId);
      throw error;
    } finally {
      // Remove listener once completed, or bind cleanup onto the active response stream so closing
      // the HTTP response never fires a late REQ_ABORT on a finished tunnel stream.
      const activeStream = this.#clientBodies.get(streamId);
      if (activeStream !== undefined && !activeStream.closed) {
        activeStream.cleanup = () => input.signal?.removeEventListener("abort", sendAbort);
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
      case MUX_FRAME.RES_ERR:
        this.#onResErr(streamId, utf8Decode(payload));
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
    for (const stream of this.#clientBodies.values()) {
      if (!stream.closed) {
        stream.closed = true;
        stream.cleanup?.();
        try {
          stream.controller?.error(error);
        } catch {
          // Stream may already be cancelled/closed.
        }
      }
    }
    this.#clientBodies.clear();
    for (const req of this.#hostRequests.values()) {
      req.abort.abort(error);
      if (!req.bodyClosed) {
        req.bodyClosed = true;
        try {
          req.bodyController?.error(error);
        } catch {
          // Ignore closed controller.
        }
      }
    }
    this.#hostRequests.clear();
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
    readonly bodyFrame: MuxFrameType;
    readonly endFrame: MuxFrameType;
    readonly isAborted: () => boolean;
    readonly onError: (error: unknown) => Promise<void>;
  }): Promise<void> {
    const reader = input.body.getReader();
    try {
      for (;;) {
        if (input.isAborted() || this.#closed) {
          await reader.cancel().catch(() => {});
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined && value.byteLength > 0) {
          for (const chunk of splitChunks(value)) {
            if (input.isAborted() || this.#closed) {
              await reader.cancel().catch(() => {});
              return;
            }
            await this.#sendFrame(encodeMuxFrame(input.bodyFrame, input.streamId, chunk));
          }
        }
      }
      if (!input.isAborted() && !this.#closed) {
        await this.#sendFrame(encodeMuxFrame(input.endFrame, input.streamId));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      await input.onError(error);
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
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = hasBody
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
          cancel: () => {
            abort.abort();
          },
        })
      : null;
    const entry = { abort, bodyController, bodyClosed: !hasBody };
    this.#hostRequests.set(streamId, entry);

    void this.#runHostRequest(streamId, host, head, body, abort.signal);
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
      this.#hostRequests.delete(streamId);
    }
  }

  #onReqBody(streamId: number, payload: Uint8Array): void {
    const req = this.#hostRequests.get(streamId);
    if (req === undefined || req.bodyClosed || req.bodyController === null) return;
    try {
      req.bodyController.enqueue(new Uint8Array(payload));
    } catch {
      req.bodyClosed = true;
    }
  }

  #onReqEnd(streamId: number): void {
    const req = this.#hostRequests.get(streamId);
    if (req === undefined || req.bodyClosed) return;
    req.bodyClosed = true;
    try {
      req.bodyController?.close();
    } catch {
      // Ignore already closed controller.
    }
  }

  #onReqAbort(streamId: number): void {
    const req = this.#hostRequests.get(streamId);
    if (req === undefined) return;
    req.abort.abort();
    if (!req.bodyClosed) {
      req.bodyClosed = true;
      try {
        req.bodyController?.error(new Error("Client aborted request"));
      } catch {
        // Ignore already closed controller.
      }
    }
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
    const streamState: {
      controller: ReadableStreamDefaultController<Uint8Array> | null;
      closed: boolean;
      cleanup?: () => void;
    } = { controller: null, closed: false };
    this.#clientBodies.set(streamId, streamState);
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamState.controller = controller;
      },
      cancel: () => {
        if (this.#takeClientStream(streamId) !== null) {
          void this.#emit(MUX_FRAME.REQ_ABORT, streamId);
        }
      },
    });
    pending.resolve({
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
      body,
    });
  }

  #takeClientStream(streamId: number): ReadableStreamDefaultController<Uint8Array> | null {
    const stream = this.#clientBodies.get(streamId);
    if (stream === undefined || stream.closed) return null;
    stream.closed = true;
    this.#clientBodies.delete(streamId);
    stream.cleanup?.();
    return stream.controller;
  }

  #failOrCloseClientStream(streamId: number, error: Error | null): void {
    const pending = this.#pendingResponses.get(streamId);
    if (pending !== undefined) {
      this.#pendingResponses.delete(streamId);
      pending.reject(error ?? new Error("Response ended before headers"));
      return;
    }
    const controller = this.#takeClientStream(streamId);
    if (controller === null) return;
    try {
      if (error === null) controller.close();
      else controller.error(error);
    } catch {
      // Ignore already closed stream.
    }
  }

  #onResBody(streamId: number, payload: Uint8Array): void {
    const stream = this.#clientBodies.get(streamId);
    if (stream === undefined || stream.closed || stream.controller === null) return;
    try {
      stream.controller.enqueue(new Uint8Array(payload));
    } catch {
      this.#takeClientStream(streamId);
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
