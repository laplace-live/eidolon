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
  | "catalog"
  | "plan";

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
  /**
   * Its transcript is in the index as it is now. False for a no-speech video, which has nothing to
   * index; the plan summary's `unindexed` leaves it out, so that count can reach 0.
   */
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
      /**
       * The last line of every run that didn't crash. The pipeline's comes after each stage's; a
       * `pipeline --dry-run --json` ends in the plan's, with stage "plan".
       */
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

/** The counts each summary carries, by name, under its stage; the web app reads them. */
export const SUMMARY_COUNTS = {
  download: ["requested", "succeeded", "failed", "newFiles"],
  expand: ["entries"],
  transcribe: ["total", "skipped", "skippedNoDate", "succeeded", "failed", "noSpeech"],
  refine: ["streams", "chunksNew", "chunksSkipped", "chunksFailed", "tokensIn", "tokensOut"],
  "ingest-streams": ["rows", "cacheHits", "embedded"],
  "ingest-facts": ["files", "rows", "cacheHits", "embedded"],
  catalog: ["broadcasts", "parts"],
  plan: ["videos", "downloadPending", "transcribePending", "noDate", "refinePending", "unindexed"],
  pipeline: ["stages", "failed", "aborted"],
} as const satisfies Partial<Record<Stage | "pipeline", readonly string[]>>;

/** A stage's summary counts before anything was counted. */
export function zeroCounts<S extends keyof typeof SUMMARY_COUNTS>(
  stage: S,
): Record<(typeof SUMMARY_COUNTS)[S][number], number> {
  return Object.fromEntries(SUMMARY_COUNTS[stage].map((key) => [key, 0])) as Record<
    (typeof SUMMARY_COUNTS)[S][number],
    number
  >;
}

type SummaryEvent = Extract<ProgressEvent, { type: "summary" }>;
type SummaryCost = Pick<SummaryEvent, "costUsd" | "costSource">;

/** What a summary calls the cost source an LLM or embedding usage reports. */
export const COST_SOURCES = {
  openrouter: "reported",
  estimate: "estimated",
  mixed: "estimated",
  unknown: "unpriced",
} as const satisfies Record<string, NonNullable<SummaryEvent["costSource"]>>;

/**
 * A summary's cost from what its requests reported: $0 when none was sent, as for a run the cache
 * served whole, and no amount when it is unpriced.
 */
export function costFields(
  usage: { readonly costUsd: number; readonly costSource: keyof typeof COST_SOURCES },
  sent: boolean,
): SummaryCost {
  if (!sent) return { costUsd: 0 };
  const costSource = COST_SOURCES[usage.costSource];
  return costSource === "unpriced" ? { costSource } : { costUsd: usage.costUsd, costSource };
}

/** A summary's cost from a price-table estimate; null when the table doesn't price it. */
export function estimatedCost(usd: number | null): SummaryCost {
  return usd === null ? { costSource: "unpriced" } : { costUsd: usd, costSource: "estimated" };
}

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
