import { networkInterfaces } from "node:os";
import type { AllowedOffer } from "@eidolon/access";
import { consoleSink, type LogLevel, type LogRecord, logger, setLogLevel } from "@eidolon/config";
import type { PcmSource } from "../src/audio_out.ts";

/** werift offers no loopback host candidate, so a peer on this machine needs another interface. */
export const CAN_DIAL = Object.values(networkInterfaces()).some((addresses) =>
  addresses?.some((a) => a.family === "IPv4" && !a.internal),
);

export interface LogCapture {
  messages(level?: LogLevel): string[];
  restore(): void;
}

/** Captures every log line at DEBUG; restore() puts the console back. */
export function captureLogs(): LogCapture {
  const records: LogRecord[] = [];
  setLogLevel("DEBUG");
  logger.setSink((record) => records.push(record));
  return {
    messages: (level) =>
      records.filter((r) => level === undefined || r.level === level).map((r) => r.message),
    restore: () => logger.setSink(consoleSink),
  };
}

/** An anonymous viewer's offer of `body`, let through. */
export function admission(body: Record<string, unknown>): AllowedOffer {
  return {
    allowed: true,
    user: { mid: null, uname: null, face: null, isLoggedIn: false },
    token: null,
    body,
    requestData: null,
    opusBitrateBps: 96000,
    clientIp: "127.0.0.1",
    quota: null,
  };
}

/** Resolves once `check` holds, polling the event loop. */
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

/** A 440 Hz tone at `rate`, counting what each pull asked for. */
export class ToneSource implements PcmSource {
  readonly rate: number;
  readonly pulls: number[] = [];
  #n = 0;

  constructor(rate: number) {
    this.rate = rate;
  }

  pull(samples: number): Int16Array {
    this.pulls.push(samples);
    return Int16Array.from({ length: samples }, () =>
      Math.round(8000 * Math.sin((2 * Math.PI * 440 * this.#n++) / this.rate)),
    );
  }
}

export const loud = (pcm: Int16Array) => pcm.some((s) => Math.abs(s) > 1000);
