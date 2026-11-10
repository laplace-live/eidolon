// What passes between e2e-call.ts (Bun) and the page it drives (browser bundle).

export const LEVEL_INTERVAL_MS = 100;
export const FLOOR_DB = -120;

/** `wire`: an RTVI message exactly as it crossed the data channel, before client-js read it. */
export type EntrySource = "rtvi" | "wire" | "http" | "pc" | "harness" | "console" | "level";

/** One observation, stamped with the observer's wall clock in epoch milliseconds. */
export interface PageEntry {
  at: number;
  source: EntrySource;
  event: string;
  data?: unknown;
}

/** RMS of the last 100 ms of each track in dBFS, `null` before the track exists. */
export interface LevelSample {
  bot: number | null;
  mic: number | null;
}

export interface ConnectOptions {
  baseUrl: string;
  /** Mute the mic from its first capture until `askByVoice`, so the bot hears silence first. */
  holdMic: boolean;
}

export type ConnectResult = { ok: true; botReady: unknown } | { ok: false; error: unknown };

export interface E2EPage {
  connect(options: ConnectOptions): Promise<ConnectResult>;
  sendText(text: string): Promise<string>;
  askByVoice(): Promise<void>;
  /** Says the WAV at `url` over the mic, in place of its track, and resolves once it has played. */
  bargeIn(url: string): Promise<{ durationMs: number }>;
  stats(): Promise<unknown>;
  disconnect(): Promise<void>;
}

declare global {
  interface Window {
    e2e?: E2EPage;
    e2eEmit?: (entry: PageEntry) => Promise<void>;
  }
}
