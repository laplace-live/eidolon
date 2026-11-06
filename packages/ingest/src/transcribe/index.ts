// laplace-transcribe's library: the Soniox REST client, the glossary context, ffmpeg and ffprobe,
// the transcript rendering, and the skip rules the pipeline shares.
export { apiContext, loadContext, type SonioxContext, summarizeContext } from "./context.ts";
export { closeMatches } from "./difflib.ts";
export { TranscribeError } from "./errors.ts";
export { ffmpegMissing, locateBinary } from "./media.ts";
export {
  DEFAULT_WINDOW_SEC,
  formatDur,
  formatTs,
  groupSegmentsIntoScenes,
  headingHint,
  isSlicedPayload,
  payloadDurationSec,
  payloadParts,
  pyFloorDiv,
  renderMarkdown,
  renderPayload,
  type Scene,
  type Segment,
  type SonioxToken,
  shortTs,
  type TokenPart,
  type TranscriptMeta,
  tokensToSegments,
} from "./render.ts";
export {
  type AudioStatus,
  audioStatus,
  configuredLanguage,
  configuredModel,
  DEFAULT_SONIOX_MODEL,
  dumpToken,
  estimateTranscribeUsd,
  glossaryPath,
  isoformat,
  listAudioFiles,
  MISSING_API_KEY,
  payloadPath,
  SLICE_MAX_MIN_DEFAULT,
  sonioxApiKey,
  type TranscribeOptions,
  type TranscribeResult,
  type TranscriptState,
  transcribeAudio,
  transcriptState,
} from "./run.ts";
export {
  SonioxApiError,
  SonioxClient,
  type SonioxClientOptions,
  SonioxConnectionError,
  SonioxError,
  type SonioxFile,
  type SonioxTranscript,
  type SonioxTranscription,
} from "./soniox.ts";
