// What a run reports while it works: the CLI prints these, or with --json writes one per line for
// the web app, which spawns the CLI and reads its stdout.

export type Stage =
  | "setup"
  | "download"
  | "transcribe"
  | "refine"
  | "ingest-streams"
  | "ingest-facts"
  | "catalog";

export type ItemStatus = "start" | "done" | "skipped" | "failed" | "cancelled";

export type EventCode =
  | "missing-credential"
  | "locked"
  | "ytdlp-unavailable"
  | "http-412"
  | "no-upload-date"
  | "no-speech"
  | "cancelled";

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
      readonly costUsd?: number;
      /** The video ids a download created. */
      readonly outputs?: readonly string[];
    }
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
