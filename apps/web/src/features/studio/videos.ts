// The videos tab's arithmetic: links typed in, what a link check found, and what a plan says is
// left to do and to spend.
import type { PlanVideo, PlaylistEntry } from "@eidolon/ingest/progress";
import type { JobOptions, PipelineStage, PLAN_SETTINGS as PlanSettings } from "@/lib/api";

/** The server refuses a longer URL. */
const MAX_URL_LENGTH = 2048;
const UNSAFE = /[\s\p{Cc}]/u;

/**
 * Bytes per second of downloaded audio, at 192 kbps: Bilibili's usual m4a, and above YouTube's
 * 128 kbps one, so a disk warning errs early.
 */
const AUDIO_BYTES_PER_SECOND = 24_000;

/** Longer audio is sliced before transcription, which takes ffmpeg. */
const FFMPEG_ABOVE_SECONDS = 300 * 60;

export interface Links {
  readonly urls: readonly string[];
  /** Lines that aren't an http(s) link. */
  readonly invalid: readonly string[];
}

function isLink(value: string): boolean {
  if (value.length > MAX_URL_LENGTH || UNSAFE.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** The links in `text`, one per line, each once; blank lines and `#` comments are skipped. */
export function parseLinks(text: string): Links {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!isLink(line)) invalid.push(line);
    else if (!urls.includes(line)) urls.push(line);
  }
  return { urls, invalid };
}

/** Entries each once, by id, in the order found. */
export function uniqueEntries(entries: readonly PlaylistEntry[]): PlaylistEntry[] {
  const seen = new Set<string>();
  const unique: PlaylistEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

/**
 * Whether the persona has an entry already: the same id, a part of it (`<id>_p2`), or the same
 * URL. Built once for the plan's videos, so each entry is a lookup.
 */
export function knownIn(videos: readonly PlanVideo[]): (entry: PlaylistEntry) => boolean {
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const video of videos) {
    ids.add(video.id);
    // Every id it is a part of: whatever precedes a `_p` in it.
    for (let at = video.id.indexOf("_p"); at !== -1; at = video.id.indexOf("_p", at + 1)) {
      ids.add(video.id.slice(0, at));
    }
    if (video.url !== undefined) urls.add(video.url);
  }
  return (entry) => ids.has(entry.id) || urls.has(entry.url);
}

export interface EntriesSummary {
  readonly count: number;
  /** The lengths the site reported, summed. */
  readonly durationSec: number;
  /** Entries whose length the site didn't report. */
  readonly unknownDuration: number;
}

export function summarizeEntries(entries: readonly PlaylistEntry[]): EntriesSummary {
  let durationSec = 0;
  let unknownDuration = 0;
  for (const entry of entries) {
    if (entry.durationSec === undefined) unknownDuration++;
    else durationSec += entry.durationSec;
  }
  return { count: entries.length, durationSec, unknownDuration };
}

/** About what `seconds` of video downloads to. */
export function estimateAudioBytes(seconds: number): number {
  return Math.round(seconds * AUDIO_BYTES_PER_SECOND);
}

export function needsFfmpeg(video: Pick<PlanVideo, "durationSec">): boolean {
  return (video.durationSec ?? 0) > FFMPEG_ABOVE_SECONDS;
}

/** Indexed, or there is nothing in it to index. */
export function isFinished(video: PlanVideo): boolean {
  return video.indexed || video.transcribe === "no-speech";
}

/** Work a paid run would do on it: a transcription, refining, or indexing. */
export function hasPaidWork(video: PlanVideo): boolean {
  if (video.transcribe === "pending") return true;
  if (video.refine !== null && video.refine.done < video.refine.chunks) return true;
  return !video.indexed && video.transcribe === "done";
}

/** The batches with a video still to download, oldest first. */
export function downloadBatches(videos: readonly PlanVideo[]): string[] {
  const batches = new Set<string>();
  for (const video of videos) {
    if (video.download === "pending" && video.batch !== undefined) batches.add(video.batch);
  }
  return [...batches].sort();
}

/**
 * The batch a paid run names, among those the plan knows. The run transcribes, refines and indexes
 * whatever is left of every video, and downloads only the batch's, so any batch serves:
 * `preferred`, else the oldest with work left, else the newest.
 */
export function runBatch(videos: readonly PlanVideo[], preferred: string | null): string | null {
  const batches = new Set<string>();
  const withWork = new Set<string>();
  for (const video of videos) {
    if (video.batch === undefined) continue;
    batches.add(video.batch);
    if (video.download === "pending" || hasPaidWork(video)) withWork.add(video.batch);
  }
  if (preferred !== null && batches.has(preferred)) return preferred;
  const pending = [...withWork].sort();
  if (pending.length > 0) return pending[0] as string;
  return [...batches].sort().at(-1) ?? null;
}

/** Every stage but download, which alone reads a batch's list. */
export const PAID_STAGES = ["transcribe", "refine", "ingest"] as const satisfies readonly Exclude<
  PipelineStage,
  "download"
>[];

/**
 * The paid run's options: runBatch's batch, whose videos it downloads first; without one, as when
 * every video sits in hand-made lists, the paid stages alone.
 */
export function paidRunOptions(
  videos: readonly PlanVideo[],
  preferred: string | null,
  transcribeConcurrency: number,
): JobOptions["pipeline"] {
  const batch = runBatch(videos, preferred);
  return batch === null
    ? { stages: PAID_STAGES, transcribeConcurrency }
    : { batch, transcribeConcurrency };
}

export interface PlanTotals {
  readonly videos: number;
  readonly finished: number;
  readonly downloadPending: number;
  readonly transcribePending: number;
  /** Downloaded without an upload date: the pipeline leaves them until one is given. */
  readonly noDate: number;
  /** Chunks still to refine, over the transcripts there are. */
  readonly refineChunks: number;
  /** Transcribed videos the index doesn't have yet. */
  readonly unindexed: number;
  readonly transcribeUsd: number;
  readonly refineUsd: number;
  /** Videos with paid work left whose cost can't be estimated. */
  readonly unpriced: number;
  /** Videos with paid work left. */
  readonly paidWork: number;
}

export function planTotals(videos: readonly PlanVideo[]): PlanTotals {
  const totals = {
    videos: videos.length,
    finished: 0,
    downloadPending: 0,
    transcribePending: 0,
    noDate: 0,
    refineChunks: 0,
    unindexed: 0,
    transcribeUsd: 0,
    refineUsd: 0,
    unpriced: 0,
    paidWork: 0,
  };
  for (const video of videos) {
    if (isFinished(video)) totals.finished++;
    if (video.download === "pending") totals.downloadPending++;
    if (video.transcribe === "pending") totals.transcribePending++;
    if (video.transcribe === "no-date") totals.noDate++;
    if (video.refine !== null) totals.refineChunks += video.refine.chunks - video.refine.done;
    if (!video.indexed && video.transcribe === "done") totals.unindexed++;
    totals.transcribeUsd += video.estimate.transcribeUsd ?? 0;
    totals.refineUsd += video.estimate.refineUsd ?? 0;
    if (hasPaidWork(video)) {
      totals.paidWork++;
      if (video.estimate.basis === "unpriced") totals.unpriced++;
    }
  }
  return totals;
}

/** The settings a plan reads besides her files, as the server keys its cached plans. */
export const PLAN_SETTINGS: typeof PlanSettings = [
  "transcription.provider",
  "transcription.model",
  "refine.provider",
  "refine.model",
  "knowledge.index",
];

/** Whether a save of `values` outdates the plan on screen. */
export function outdatesPlan(values: Readonly<Record<string, unknown>>): boolean {
  return PLAN_SETTINGS.some((path) => path in values);
}

export interface PlanProgress {
  /** The plan request failed: there is nothing to wait for. */
  readonly failed: boolean;
  /** No plan has answered yet. */
  readonly loading: boolean;
  /** The plan's job has ended and its events are read. */
  readonly ended: boolean;
  /** A plan was asked for anew: refreshed, or after a setting it reads was saved. */
  readonly asking: boolean;
}

/** A plan is being made, so what shows can't be acted on: the paid run waits for it. */
export function planRefreshing(progress: PlanProgress): boolean {
  return !progress.failed && (progress.loading || !progress.ended || progress.asking);
}
