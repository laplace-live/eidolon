// What a run reports while it works: the CLI prints these, or with --json writes one per line for
// the web app, which spawns the CLI and reads its stdout. Keep this module import-free: the web app
// imports its types (`@eidolon/ingest/progress`) without Bun or Node.

export type Stage =
  | "setup"
  | "download"
  | "expand"
  | "transcribe"
  | "refine"
  | "ingest-streams"
  | "ingest-facts"
  | "catalog";

export type ItemStatus = "start" | "done" | "skipped" | "failed" | "cancelled";

/** Why an item or stage ended as it did, for the web app to say in the viewer's language. */
export const EVENT_CODES = [
  "missing-credential",
  "auth-failed",
  "insufficient-credits",
  "rate-limited",
  "network",
  "locked",
  "ytdlp-unavailable",
  "cookies-unavailable",
  "ffmpeg-unavailable",
  "disk-full",
  "http-412",
  "no-upload-date",
  "no-speech",
  "cancelled",
] as const;

export type EventCode = (typeof EVENT_CODES)[number];

/**
 * Whose key, credit or quota an `auth-failed`, `insufficient-credits`, `rate-limited` or `network`
 * code is about: Soniox's, refine's (REFINE_API_KEY or OPENROUTER_API_KEY, at REFINE_BASE_URL or
 * OpenRouter) or the embedding API's (EMBED_API_KEY or OPENROUTER_API_KEY, at EMBED_BASE_URL or
 * OpenRouter). Absent when the code is about a video site yt-dlp was fetching from.
 */
export type Provider = "soniox" | "refine" | "embeddings";

/** One video a playlist, channel or series lists, as `download --expand` finds it. */
export interface PlaylistEntry {
  readonly url: string;
  /** The yt-dlp id: a Bilibili BV id, a YouTube video id. */
  readonly id: string;
  readonly title?: string;
  readonly durationSec?: number;
}

/** One video as the plan sees it: where each stage stands, and what the rest would cost. */
export interface PlanVideo {
  /** The yt-dlp id, which is the audio's stem: `BV1FbgM6QEw3_p1`. */
  readonly id: string;
  readonly url?: string;
  readonly batch?: string;
  readonly title?: string;
  readonly uploadDate?: string;
  readonly durationSec?: number;
  readonly download: "pending" | "done";
  readonly transcribe: "pending" | "done" | "no-speech" | "no-date";
  readonly refine: { readonly chunks: number; readonly done: number } | null;
  readonly indexed: boolean;
  readonly estimate: {
    readonly transcribeUsd?: number;
    readonly refineUsd?: number;
    readonly basis: "history" | "price-table" | "unpriced";
  };
}

export type ProgressEvent =
  | {
      readonly type: "stage";
      readonly stage: Stage;
      readonly status: "start" | "done" | "failed" | "skipped" | "cancelled";
      readonly total?: number;
      readonly message?: string;
      readonly code?: EventCode;
      readonly provider?: Provider;
    }
  | {
      readonly type: "item";
      readonly stage: Stage;
      /** The URL (download), audio file name (transcribe), stream id (refine) or fact file name. */
      readonly item: string;
      readonly video?: string;
      readonly status: ItemStatus;
      readonly index?: number;
      readonly total?: number;
      readonly message?: string;
      readonly code?: EventCode;
      readonly provider?: Provider;
      readonly costUsd?: number;
      /** The video ids a download created. */
      readonly outputs?: readonly string[];
    }
  | { readonly type: "entry"; readonly entry: PlaylistEntry }
  | {
      readonly type: "progress";
      readonly stage: Stage;
      readonly item?: string;
      readonly video?: string;
      readonly done: number;
      readonly total?: number;
      readonly unit: "bytes" | "chunks" | "rows" | "files" | "percent";
    }
  | { readonly type: "plan"; readonly video: PlanVideo }
  | {
      /** The last line of every run that didn't crash; the pipeline's comes after each stage's. */
      readonly type: "summary";
      readonly stage: Stage | "pipeline";
      readonly ok: boolean;
      readonly cancelled?: boolean;
      readonly counts: Readonly<Record<string, number>>;
      readonly durationSec: number;
      readonly costUsd?: number;
      readonly costSource?: "reported" | "estimated" | "unpriced";
      readonly failures?: readonly { readonly item: string; readonly error: string }[];
    };

/** The counts each stage's summary carries, by name; the web app reads them. */
export const SUMMARY_COUNTS = {
  download: ["requested", "succeeded", "failed", "newFiles"],
  expand: ["entries"],
  transcribe: ["total", "skipped", "skippedNoDate", "succeeded", "failed", "noSpeech"],
  refine: ["streams", "chunksNew", "chunksSkipped", "chunksFailed", "tokensIn", "tokensOut"],
  "ingest-streams": ["rows", "cacheHits", "embedded"],
  "ingest-facts": ["files", "rows", "cacheHits", "embedded"],
  catalog: ["broadcasts", "parts"],
} as const satisfies Partial<Record<Stage, readonly string[]>>;

export type ProgressSink = (event: ProgressEvent) => void;

export const noProgress: ProgressSink = () => {};

/** What every library entry point takes; each returns a report and never prints. */
export interface RunOptions {
  readonly onProgress?: ProgressSink;
  readonly signal?: AbortSignal;
}

/** One JSON line per event, each with the schema version `v` and a timestamp `t` in ms. */
export function ndjsonSink(
  write: (line: string) => void,
  now: () => number = Date.now,
): ProgressSink {
  return (event) => write(`${JSON.stringify({ v: 1, t: now(), ...event })}\n`);
}
