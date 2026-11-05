// laplace-download's library: the managed yt-dlp, URL lists and batches, its argv, the part check
// and playlist expansion.
export {
  DEFAULT_BROWSER,
  DEFAULT_FORMAT,
  defaultCookiesFile,
  defaultCookiesFromBrowser,
  parseProgressLine,
  type YtDlpArgvOptions,
  ytDlpArgs,
} from "./argv.ts";
export {
  BATCHES_DIR,
  type BatchDone,
  BV_ID,
  baselineLists,
  batchDonePath,
  batchLists,
  batchName,
  knownIds,
  listKey,
  localIsoSeconds,
  newIds,
  type PrepareBatchOptions,
  type PrepareBatchResult,
  pendingBatches,
  prepareBatch,
  readIds,
  writeBatch,
  writeBatchDone,
} from "./batches.ts";
export { type ExpandOptions, expandPlaylist } from "./playlist.ts";
export {
  audioFilesIn,
  bareWithParts,
  COOKIE_HINT,
  type DownloadFailure,
  type DownloadOptions,
  type DownloadReport,
  downloadSummaryEvent,
  downloadSummaryText,
  downloadUrls,
  emptyDownloadReport,
  PARTS_UNLISTED,
  YtDlpFailedError,
} from "./run.ts";
export { shlexSplit } from "./shlex.ts";
export { readUrlList } from "./url_list.ts";
export {
  managedYtDlpPath,
  resolveYtDlp,
  UPDATE_INTERVAL_MS,
  type YtDlp,
  type YtDlpOptions,
  YtDlpUnavailableError,
  ytDlpAsset,
} from "./ytdlp.ts";
