import { CString, dlopen, FFIType } from "bun:ffi";
import { networkInterfaces } from "node:os";
import type { AllowedOffer } from "@eidolon/access";
import { consoleSink, type LogLevel, type LogRecord, logger } from "@eidolon/config";
import { type Frame, OutputTransportMessageUrgentFrame } from "@pipedog/core/frames/frames";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { BaseTransport } from "@pipedog/core/transports/base_transport";
import { configureLogging } from "../src/logging.ts";

/** werift offers no loopback host candidate, so a peer on this machine needs another interface. */
export const CAN_DIAL = Object.values(networkInterfaces()).some((addresses) =>
  addresses?.some((a) => a.family === "IPv4" && !a.internal),
);

/** Candidate rules that keep every candidate, for a peer on this machine. */
export const PASS_THROUGH_RULES = {
  dropUnreachableCandidates: (sdp: string) => ({ sdp, dropped: [] }),
  candidateReachable: () => true,
  scrubRelayRelatedAddresses: (sdp: string) => sdp,
};

/** An anonymous viewer's offer, let through. */
export function admission(body: Record<string, unknown>): AllowedOffer {
  return {
    allowed: true,
    user: { mid: null, uname: null, face: null, isLoggedIn: false },
    token: null,
    body,
    requestData: { audioQuality: "medium" },
    opusBitrateBps: 96000,
    clientIp: "127.0.0.1",
    quota: null,
  };
}

export interface LogCapture {
  readonly records: LogRecord[];
  messages(level?: LogLevel): string[];
  restore(): void;
}

/** Captures every log line, pipedog's included, at DEBUG; restore() puts the console back. */
export function captureLogs(): LogCapture {
  const records: LogRecord[] = [];
  configureLogging({ level: "DEBUG" });
  logger.setSink((record) => records.push(record));
  return {
    records,
    messages: (level) =>
      records.filter((r) => level === undefined || r.level === level).map((r) => r.message),
    restore: () => logger.setSink(consoleSink),
  };
}

/** Sets (or, for undefined, deletes) env vars; the returned function restores them. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.entries(vars).map(([name]) => [name, process.env[name]] as const);
  const apply = (entries: readonly (readonly [string, string | undefined])[]) => {
    for (const [name, value] of entries) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(Object.entries(vars));
  return () => apply(saved);
}

/** `name` as getenv reads it, which process.env doesn't change under Bun; null when unset. */
export function cEnv(name: string): string | null {
  const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    getenv: { args: [FFIType.cstring], returns: FFIType.ptr },
  });
  try {
    const value = libc.symbols.getenv(Buffer.from(`${name}\0`));
    return value === null ? null : new CString(value).toString();
  } finally {
    libc.close();
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Resolves once `check` holds, polling the event loop. */
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A processor that passes every frame on, standing in for a service. */
export class PassThrough extends FrameProcessor {
  readonly #seen: ((frame: Frame) => void) | undefined;

  constructor(name: string, seen?: (frame: Frame) => void) {
    super({ name });
    this.#seen = seen;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    this.#seen?.(frame);
    await this.pushFrame(frame, direction);
  }
}

/** A transport whose input and output pass frames through and whose events tests fire. */
export class FakeTransport extends BaseTransport {
  /** The urgent messages the output would send the browser, as RTVI's server messages are. */
  readonly sent: unknown[] = [];
  readonly #input = new PassThrough("FakeInput");
  readonly #output = new PassThrough("FakeOutput", (frame) => {
    if (frame instanceof OutputTransportMessageUrgentFrame) this.sent.push(frame.message);
  });

  constructor() {
    super();
    this._registerEventHandler("on_client_connected");
    this._registerEventHandler("on_client_disconnected");
  }

  input(): FrameProcessor {
    return this.#input;
  }

  output(): FrameProcessor {
    return this.#output;
  }

  emit(eventName: string): Promise<void> {
    return this._callEventHandler(eventName, this);
  }
}
