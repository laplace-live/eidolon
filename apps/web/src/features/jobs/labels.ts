// What the job pages call the codes the CLI and the API define: commands, stages, states, units
// and the reasons a step failed.
import type {
  EventCode,
  ItemStatus,
  ProgressEvent,
  Provider,
  Stage,
} from "@eidolon/ingest/progress";
import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import type { JobCommand } from "@/lib/api";
import type { Outcome } from "@/lib/jobs";

type StageStatus = Extract<ProgressEvent, { type: "stage" }>["status"];
type CountedUnit = Exclude<
  Extract<ProgressEvent, { type: "progress" }>["unit"],
  "bytes" | "percent"
>;

export const COMMAND_LABELS: Readonly<Record<JobCommand, MessageDescriptor>> = {
  pipeline: msg`Video Pipeline`,
  download: msg`Download`,
  expand: msg`Read Link`,
  transcribe: msg`Transcribe`,
  refine: msg`Refine Transcripts`,
  "ingest-streams": msg`Index Streams`,
  "ingest-facts": msg`Index Facts`,
  "build-stream-catalog": msg`Build Stream Catalog`,
  plan: msg`Plan`,
};

/** What each command does, as its page says. */
export const COMMAND_ABOUT: Readonly<Record<JobCommand, MessageDescriptor>> = {
  pipeline: msg`Downloads, transcribes, refines and indexes her videos. Each step skips what's already done.`,
  download: msg`Downloads the audio of her videos with yt-dlp.`,
  expand: msg`Reads a playlist, channel or series link and lists the videos in it.`,
  transcribe: msg`Turns a video's audio into a transcript with Soniox.`,
  refine: msg`Cleans up her transcripts with the refine model.`,
  "ingest-streams": msg`Indexes her stream transcripts, so she can recall past broadcasts.`,
  "ingest-facts": msg`Indexes her fact files: what she knows about herself.`,
  "build-stream-catalog": msg`Builds the date-by-date overview of her broadcasts from the transcripts.`,
  plan: msg`Works out what the video pipeline would do and what it would cost, without running it.`,
};

export const STAGE_LABELS: Readonly<Record<Stage | "pipeline", MessageDescriptor>> = {
  setup: msg`yt-dlp`,
  expand: msg`Read Link`,
  download: msg`Download`,
  transcribe: msg`Transcribe`,
  refine: msg`Refine`,
  "ingest-streams": msg`Index Streams`,
  "ingest-facts": msg`Index Facts`,
  catalog: msg`Stream Catalog`,
  plan: msg`Plan`,
  pipeline: msg`Pipeline`,
};

export const OUTCOME_TEXT: Readonly<Record<Outcome, MessageDescriptor>> = {
  running: msg`Running`,
  succeeded: msg({ message: "Done", context: "job status" }),
  failed: msg`Failed`,
  crashed: msg`Stopped unexpectedly`,
  cancelled: msg`Cancelled`,
  interrupted: msg`Interrupted`,
};

export const STAGE_STATUS_TEXT: Readonly<Record<StageStatus, MessageDescriptor>> = {
  start: msg({ message: "Running", context: "job stage" }),
  done: msg`Done`,
  failed: msg`Failed`,
  skipped: msg`Skipped`,
  cancelled: msg`Cancelled`,
};

/** An item's state, lowercase, as it ends a log line. */
export const ITEM_STATUS_WORDS: Readonly<Record<ItemStatus, MessageDescriptor>> = {
  start: msg`started`,
  done: msg`done`,
  skipped: msg`skipped`,
  failed: msg`failed`,
  cancelled: msg`cancelled`,
};

/** Why a step failed or was skipped. */
export const EVENT_REASONS: Readonly<Record<EventCode, MessageDescriptor>> = {
  "missing-credential": msg`An API key this step needs isn't set, so nothing was sent.`,
  "auth-failed": msg`The provider refused the API key.`,
  "insufficient-credits": msg`The provider account is out of credit.`,
  "rate-limited": msg`The provider is limiting requests. Try again later.`,
  network: msg`The request got no answer. Check the network connection.`,
  locked: msg`Another run is already working on this persona.`,
  "ytdlp-unavailable": msg`yt-dlp isn't installed and couldn't be installed.`,
  "cookies-unavailable": msg`yt-dlp couldn't read the browser's cookies, or the site asked for them.`,
  "ffmpeg-unavailable": msg`Audio over 5 hours needs ffmpeg to split it. Install ffmpeg and try again.`,
  "disk-full": msg`The disk is full.`,
  "http-412": msg`The site refused yt-dlp, usually because it is out of date.`,
  "no-upload-date": msg`This video has no upload date, so it can't be placed among the streams.`,
  "no-speech": msg`No speech was heard in this audio.`,
  cancelled: msg`Cancelled.`,
};

/** The service a failure reason is about. */
export const PROVIDER_LABELS: Readonly<Record<Provider, MessageDescriptor>> = {
  soniox: msg`Soniox`,
  refine: msg`Refine API`,
  embeddings: msg`Embedding API`,
};

/** "3 of 10 rows", in the unit the CLI counts. */
export function countedText(unit: CountedUnit, done: string, total: string): string {
  switch (unit) {
    case "chunks":
      return t`${done} of ${total} chunks`;
    case "rows":
      return t`${done} of ${total} rows`;
    case "files":
      return t`${done} of ${total} files`;
  }
}

/** A log line for a stage that ended: "Download finished". */
export function stageEndText(status: Exclude<StageStatus, "start">, stage: string): string {
  switch (status) {
    case "done":
      return t`${stage} finished`;
    case "failed":
      return t`${stage} failed`;
    case "skipped":
      return t`${stage} skipped`;
    case "cancelled":
      return t`${stage} cancelled`;
  }
}
