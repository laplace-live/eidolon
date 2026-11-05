// laplace-download's loop: one yt-dlp process per URL, in order, so one bad URL never stops the
// rest; the run's report and the summary Python printed.
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { constants } from "node:os";
import {
  errorText,
  logger,
  pyFixed,
  pyPath,
  pyPathStem,
  pyPathSuffix,
  pyStrip,
  sortedPy,
  splitlines,
} from "@eidolon/config";
import type { Subprocess } from "bun";
import { terminateOnAbort } from "../limit.ts";
import {
  type EventCode,
  noProgress,
  type ProgressEvent,
  type ProgressSink,
  type RunOptions,
} from "../progress.ts";
import { AUDIO_EXTENSIONS } from "../streams.ts";
import {
  DEFAULT_FORMAT,
  defaultCookiesFile,
  defaultCookiesFromBrowser,
  parseProgressLine,
  ytDlpArgs,
} from "./argv.ts";
import { resolveYtDlp, type YtDlp, type YtDlpOptions, YtDlpUnavailableError } from "./ytdlp.ts";

/** Why a URL fails when yt-dlp fell back to a bare `<id>` next to its `<id>_p<N>` parts. */
export const PARTS_UNLISTED = "yt-dlp could not list the video's parts; it may be outdated";

// Reading a browser's cookie store fails in yt-dlp's cookies.py with these words; a site that wants
// cookies says so in the same terms.
const COOKIE_TROUBLE =
  /^ERROR:.*(?:cookie|browser|keyring|keychain|dpapi|local state|kwallet|secretstorage)/im;
/** Added to a failure whose yt-dlp error is about cookies. */
export const COOKIE_HINT =
  "yt-dlp reads cookies from YT_DLP_COOKIES_FROM_BROWSER (sources.cookiesFromBrowser; none for " +
  "no browser) and YT_DLP_COOKIES (sources.cookiesFile), or --cookies-from-browser and --cookies";
const HTTP_412 = /HTTP Error 412\b/;
const HTTP_429 = /HTTP Error 429\b/;
const DISK_FULL = /No space left on device|\[Errno 28\]/i;
// What yt-dlp's urllib and requests handlers pass along when a site can't be reached.
const NETWORK =
  /^ERROR:.*(?:timed out|Connection (?:refused|reset|aborted)|Network is unreachable|No route to host|Name or service not known|nodename nor servname|Temporary failure in name resolution|Failed to resolve|getaddrinfo failed)/im;

/** The event code a failed yt-dlp's stderr points to, if any. */
export function ytDlpFailureCode(stderr: string): EventCode | undefined {
  if (DISK_FULL.test(stderr)) return "disk-full";
  if (COOKIE_TROUBLE.test(stderr)) return "cookies-unavailable";
  if (HTTP_412.test(stderr)) return "http-412";
  if (HTTP_429.test(stderr)) return "rate-limited";
  if (NETWORK.test(stderr)) return "network";
  return undefined;
}

export interface DownloadFailure {
  readonly url: string;
  readonly error: string;
}

export interface DownloadReport {
  readonly requestedUrls: number;
  /** URLs yt-dlp finished with 0, including the ones --no-overwrites found already downloaded. */
  readonly succeededUrls: number;
  readonly failedUrls: readonly DownloadFailure[];
  /**
   * Audio files that appeared in the folder during the run, sorted. A listing diff, so it holds
   * even though yt-dlp prints nothing for a file it finds already downloaded.
   */
  readonly newFiles: readonly string[];
  readonly durationSec: number;
  /** The signal stopped the run before every URL was tried. */
  readonly cancelled: boolean;
}

export interface DownloadOptions extends RunOptions {
  readonly vodsDir: string;
  readonly format?: string;
  /** null: no browser's cookies; omitted: defaultCookiesFromBrowser(). */
  readonly cookiesFromBrowser?: string | null;
  /** Omitted: defaultCookiesFile(). */
  readonly cookiesFile?: string | null;
  readonly extraArgs?: readonly string[];
  /**
   * "inherit" passes yt-dlp's output straight through, its progress bar live on this process's
   * stdout. "events" reads it instead: progress becomes progress events, every other line goes to
   * `onOutput`.
   */
  readonly output?: "inherit" | "events";
  readonly onOutput?: (line: string) => void;
  /** The yt-dlp to run; resolveYtDlp() when omitted. */
  readonly ytDlp?: YtDlp;
  /** How the managed yt-dlp is installed and updated. */
  readonly ytDlpOptions?: Omit<YtDlpOptions, keyof RunOptions | "force">;
}

function isAudioFile(dir: string, name: string): boolean {
  if (!AUDIO_EXTENSIONS.has(pyPathSuffix(name))) return false;
  try {
    return statSync(`${dir}/${name}`).isFile();
  } catch {
    return false;
  }
}

/** `_audio_files_in`: the names of the regular files directly in `dir` with an audio suffix. */
export function audioFilesIn(dir: string): Set<string> {
  return new Set(listNames(dir).filter((name) => isAudioFile(dir, name)));
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The ids with both a bare `<id>.<ext>` audio file and `<id>_p<N>` ones among `names`: what
 * yt-dlp leaves when its call listing a multi-part video's parts fails, and it downloads part 1
 * again under the bare id.
 */
export function bareWithParts(names: Iterable<string>): string[] {
  const stems = new Set<string>();
  for (const name of names) {
    if (AUDIO_EXTENSIONS.has(pyPathSuffix(name))) stems.add(pyPathStem(name));
  }
  const parted = new Set<string>();
  for (const stem of stems) {
    const match = /^(.*)_p\d+$/s.exec(stem);
    if (match) parted.add(match[1] as string);
  }
  return sortedPy([...stems].filter((stem) => parted.has(stem)));
}

/** The exit status as Python's subprocess reports it: a signal's death is minus its number. */
export function exitStatus(child: Pick<Subprocess, "exitCode" | "signalCode">): number {
  const { exitCode, signalCode } = child;
  if (exitCode !== null) return exitCode;
  if (signalCode === null) return -1;
  return -(typeof signalCode === "number" ? signalCode : (constants.signals[signalCode] ?? 0));
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  // text=True: UTF-8 with universal newlines.
  const bytes = await new Response(stream).arrayBuffer();
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replace(/\r\n?/g, "\n");
}

/** Calls `onLine` with each line of `stream` as it arrives, decoded as UTF-8. */
export async function forEachLine(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n")) {
      onLine(pending.slice(0, nl).replace(/\r$/, ""));
      pending = pending.slice(nl + 1);
    }
  }
  pending += decoder.decode();
  if (pending) onLine(pending);
}

interface Outcome {
  readonly status: number;
  readonly stderr: string;
}

async function runYtDlp(
  ytDlp: YtDlp,
  args: readonly string[],
  url: string,
  opts: DownloadOptions,
  onProgress: ProgressSink,
): Promise<Outcome> {
  const events = opts.output === "events";
  const child = Bun.spawn([ytDlp.path, ...args], {
    // Bun spawns with the environment the process started with unless told otherwise; Python's
    // children saw what load_dotenv set, such as a proxy for yt-dlp.
    env: process.env,
    stdin: "inherit",
    stdout: events ? "pipe" : "inherit",
    stderr: "pipe",
  });
  const stop = terminateOnAbort(child, opts.signal);
  try {
    const onOutput = opts.onOutput ?? (() => {});
    const [stderr] = await Promise.all([
      readText(child.stderr),
      events
        ? forEachLine(child.stdout as ReadableStream<Uint8Array>, (line) => {
            const progress = parseProgressLine(line);
            if (progress === null) onOutput(line);
            else
              onProgress({
                type: "progress",
                stage: "download",
                item: url,
                unit: "bytes",
                ...progress,
              });
          })
        : null,
    ]);
    await child.exited;
    return { status: exitStatus(child), stderr };
  } finally {
    stop();
  }
}

/** yt-dlp exited non-zero where the whole call fails with it, as in expandPlaylist. */
export class YtDlpFailedError extends Error {
  override name = "YtDlpFailedError";
  /** What its stderr points to, as ytDlpFailureCode reads it. */
  readonly code: EventCode | undefined;
  constructor(message: string, code?: EventCode) {
    super(message);
    this.code = code;
  }
}

/** Python's stderr tail: its last six lines, indented under the first. */
export function stderrTail(stderr: string): string {
  return splitlines(pyStrip(stderr)).slice(-6).join("\n    ") || "(no stderr captured)";
}

/** Removes the files of `ids` this URL's run created, and only those. */
function removeCreated(
  dir: string,
  created: ReadonlySet<string>,
  ids: readonly string[],
): string[] {
  const removed: string[] = [];
  for (const name of sortedPy(created)) {
    const id = name.endsWith(".info.json") ? name.slice(0, -".info.json".length) : null;
    const stem = id ?? (AUDIO_EXTENSIONS.has(pyPathSuffix(name)) ? pyPathStem(name) : null);
    if (stem === null || !ids.includes(stem)) continue;
    unlinkSync(`${dir}/${name}`);
    removed.push(name);
  }
  return removed;
}

/**
 * `download_urls`: runs yt-dlp on each URL in turn into `opts.vodsDir`, never stopping at a
 * failed one; the report carries each failure's stderr tail. Throws YtDlpUnavailableError when
 * there is no yt-dlp to run. Once `opts.signal` aborts, no URL starts and the running one is
 * stopped.
 */
export async function downloadUrls(
  urls: readonly string[],
  opts: DownloadOptions,
): Promise<DownloadReport> {
  const onProgress = opts.onProgress ?? noProgress;
  const { signal, vodsDir } = opts;
  const total = urls.length;
  const failedUrls: DownloadFailure[] = [];
  const codes: (EventCode | undefined)[] = [];
  let succeededUrls = 0;
  let cancelled = false;
  let started = performance.now();
  let before: Set<string> | null = null;
  const finish = (): DownloadReport => {
    const initial = before;
    const report: DownloadReport = {
      requestedUrls: total,
      succeededUrls,
      failedUrls,
      newFiles:
        initial === null
          ? []
          : sortedPy([...audioFilesIn(vodsDir)].filter((name) => !initial.has(name))).map((name) =>
              pyPath(`${vodsDir}/${name}`),
            ),
      durationSec: initial === null ? 0 : (performance.now() - started) / 1000,
      cancelled,
    };
    // A code every failed URL shares is the stage's, as when the cookies are unreadable for all.
    const [code] = codes;
    const shared = code !== undefined && codes.every((other) => other === code);
    onProgress({
      type: "stage",
      stage: "download",
      status: cancelled ? "cancelled" : failedUrls.length > 0 ? "failed" : "done",
      ...(!cancelled && shared ? { code } : {}),
    });
    onProgress(downloadSummaryEvent(report));
    return report;
  };

  onProgress({ type: "stage", stage: "download", status: "start", total });
  let ytDlp: YtDlp;
  try {
    ytDlp = opts.ytDlp ?? (await resolveYtDlp({ ...opts.ytDlpOptions, onProgress, signal }));
  } catch (error) {
    if (signal?.aborted) {
      cancelled = true;
      return finish();
    }
    if (error instanceof YtDlpUnavailableError) {
      onProgress({
        type: "stage",
        stage: "download",
        status: "failed",
        code: error.code,
        message: error.message,
      });
      onProgress({ ...downloadSummaryEvent(emptyDownloadReport(total)), ok: false });
    }
    throw error;
  }

  mkdirSync(vodsDir, { recursive: true });
  started = performance.now();
  before = audioFilesIn(vodsDir);
  const format = opts.format ?? DEFAULT_FORMAT;
  const cookiesFromBrowser =
    opts.cookiesFromBrowser === undefined ? defaultCookiesFromBrowser() : opts.cookiesFromBrowser;
  const cookiesFile = opts.cookiesFile === undefined ? defaultCookiesFile() : opts.cookiesFile;
  let checkedAfter412 = false;

  for (const [i, url] of urls.entries()) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const index = i + 1;
    logger.info(`[${index}/${total}] ${url}`);
    onProgress({ type: "item", stage: "download", item: url, index, total, status: "start" });
    const namesBefore = new Set(listNames(vodsDir));
    const args = ytDlpArgs(url, {
      vodsDir,
      format,
      cookiesFromBrowser,
      cookiesFile,
      extraArgs: opts.extraArgs ?? [],
      progressLines: opts.output === "events",
    });
    const item = { type: "item", stage: "download", item: url, index, total } as const;
    let outcome: Outcome;
    try {
      outcome = await runYtDlp(ytDlp, args, url, opts, onProgress);
    } catch (error) {
      const message = errorText(error);
      logger.error(`  ✗ subprocess error: ${message}`);
      failedUrls.push({ url, error: message });
      codes.push(undefined);
      onProgress({ ...item, status: "failed", message });
      continue;
    }
    const namesAfter = listNames(vodsDir);
    const created = new Set(namesAfter.filter((name) => !namesBefore.has(name)));
    const createdAudio = [...created].filter((name) => isAudioFile(vodsDir, name));
    const outputs = (): string[] => sortedPy(createdAudio.map(pyPathStem));

    if (signal?.aborted) {
      cancelled = true;
      onProgress({ ...item, status: "cancelled", outputs: outputs() });
      break;
    }
    if (outcome.status !== 0) {
      const tail = stderrTail(outcome.stderr);
      logger.error(`  ✗ yt-dlp failed (exit=${outcome.status}). stderr tail:\n    ${tail}`);
      let error = `exit=${outcome.status}: ${tail}`;
      if (COOKIE_TROUBLE.test(outcome.stderr)) {
        logger.warning(`    ${COOKIE_HINT}`);
        error += `\n    ${COOKIE_HINT}`;
      }
      failedUrls.push({ url, error });
      const code = ytDlpFailureCode(outcome.stderr);
      codes.push(code);
      onProgress({
        ...item,
        status: "failed",
        message: error,
        outputs: outputs(),
        ...(code === undefined ? {} : { code }),
      });
      if (HTTP_412.test(outcome.stderr) && ytDlp.source === "managed" && !checkedAfter412) {
        checkedAfter412 = true;
        try {
          ytDlp = await resolveYtDlp({ ...opts.ytDlpOptions, onProgress, signal, force: true });
        } catch (updateError) {
          if (signal?.aborted) {
            cancelled = true;
            break;
          }
          logger.warning(`Could not update yt-dlp after HTTP 412: ${errorText(updateError)}`);
        }
      }
      continue;
    }

    const duplicates = bareWithParts(namesAfter).filter((id) =>
      createdAudio.some((name) => pyPathStem(name) === id),
    );
    if (duplicates.length > 0) {
      const removed = removeCreated(vodsDir, created, duplicates);
      logger.error(`  ✗ ${PARTS_UNLISTED}; removed ${removed.join(", ")}`);
      failedUrls.push({ url, error: PARTS_UNLISTED });
      codes.push(undefined);
      const kept = outputs().filter((id) => !duplicates.includes(id));
      onProgress({ ...item, status: "failed", message: PARTS_UNLISTED, outputs: kept });
      continue;
    }
    succeededUrls++;
    onProgress({ ...item, status: "done", outputs: outputs() });
  }
  return finish();
}

/** A report of no work: `total` URLs asked for, none tried. */
export function emptyDownloadReport(total: number): DownloadReport {
  return {
    requestedUrls: total,
    succeededUrls: 0,
    failedUrls: [],
    newFiles: [],
    durationSec: 0,
    cancelled: false,
  };
}

/** The download stage's summary event. */
export function downloadSummaryEvent(
  report: DownloadReport,
): Extract<ProgressEvent, { type: "summary" }> {
  return {
    type: "summary",
    stage: "download",
    ok: !report.cancelled && report.failedUrls.length === 0,
    ...(report.cancelled ? { cancelled: true } : {}),
    counts: {
      requested: report.requestedUrls,
      succeeded: report.succeededUrls,
      failed: report.failedUrls.length,
      newFiles: report.newFiles.length,
    },
    durationSec: report.durationSec,
    ...(report.failedUrls.length > 0
      ? { failures: report.failedUrls.map(({ url, error }) => ({ item: url, error })) }
      : {}),
  };
}

/** `print_summary`'s text: the block laplace-download and laplace-pipeline print after a download. */
export function downloadSummaryText(report: DownloadReport, vodsDir: string): string {
  const rule = "=".repeat(60);
  const lines = [
    "",
    rule,
    "Download Summary",
    rule,
    `URLs requested: ${report.requestedUrls}`,
    `URLs succeeded: ${report.succeededUrls}`,
    `URLs failed:    ${report.failedUrls.length}`,
    `New audio:      ${report.newFiles.length} files in ${vodsDir}/`,
    `Duration:       ${pyFixed(report.durationSec, 1)}s`,
  ];
  if (report.failedUrls.length > 0) {
    lines.push("", "Failures (re-run the same command to retry these):");
    for (const { url, error } of report.failedUrls) {
      const first = error ? (splitlines(error)[0] ?? "") : "(no detail)";
      lines.push(`  ✗ ${url}\n      ${first}`);
    }
  }
  lines.push(rule);
  return `${lines.join("\n")}\n`;
}
