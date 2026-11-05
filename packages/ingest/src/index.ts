// The offline chain that builds a persona's index from videos and fact files: download, transcribe,
// refine, ingest and the stream catalog. A library: it reports through progress events and never
// parses argv or prints.
export * as catalog from "./catalog.ts";
export * as download from "./download/index.ts";
export * as extractUsers from "./extract_users.ts";
export { type Failure, failureOf, sharedFailure } from "./failure.ts";
export * as ingestFacts from "./ingest_facts.ts";
export * as ingestStreams from "./ingest_streams.ts";
export {
  type ChildProcess,
  CLEANUP_LIMIT_MS,
  createLimiter,
  KILL_GRACE_MS,
  type Limiter,
  runWithSignals,
  type SignalHost,
  terminate,
  terminateOnAbort,
} from "./limit.ts";
export {
  acquireLock,
  binDir,
  canonicalPath,
  embedCachePath,
  indexLockKey,
  indexWritePath,
  LockedError,
  type SourceFolder,
  sourceFolder,
  sourcesDir,
  sourcesLockKey,
  YT_DLP_LOCK_KEY,
} from "./paths.ts";
export * as pipeline from "./pipeline.ts";
export {
  EVENT_CODES,
  type EventCode,
  type ItemStatus,
  ndjsonSink,
  noProgress,
  type PlanVideo,
  type PlaylistEntry,
  type ProgressEvent,
  type ProgressSink,
  type Provider,
  type RunOptions,
  type Stage,
  SUMMARY_COUNTS,
} from "./progress.ts";
export * as refine from "./refine/index.ts";
export {
  AUDIO_EXTENSIONS,
  emptySidecar,
  infoJsonPath,
  iterStreams,
  loadSidecar,
  type ParsedStream,
  parseStream,
  readUploadDate,
  type StreamChunk,
  saveSidecar,
  splitIntoChunks,
  streamId,
  transcriptPath,
} from "./streams.ts";
export * as transcribe from "./transcribe/index.ts";
