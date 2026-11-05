// laplace-download: fetches the audio of a URL list's videos with yt-dlp, one process per URL.
import { errorText, logger, pyRepr } from "@eidolon/config";
import {
  acquireLock,
  download,
  type EventCode,
  LockedError,
  ndjsonSink,
  noProgress,
  sourceFolder,
  sourcesLockKey,
} from "@eidolon/ingest";
import {
  ArgparseExit,
  commandPersona,
  type Namespace,
  PATH,
  type ParserSpec,
  parseArgs,
  parserError,
} from "./argparse.ts";
import { type CommandDeps, reportExit, resolveIo } from "./io.ts";

const PROG = "laplace-download";

const USAGE = `usage: laplace-download [-h] [--vods-dir VODS_DIR] [--format FORMAT]
                        [--cookies-from-browser COOKIES_FROM_BROWSER]
                        [--cookies COOKIES] [--yt-dlp-args YT_DLP_ARGS]
                        [--persona PERSONA] [--json] [--expand URL]
                        [url_list]
`;

export const DOWNLOAD_PARSER: ParserSpec = {
  prog: PROG,
  usage: USAGE,
  help: `${USAGE}
Download bilibili (or any yt-dlp-supported) audio from a URL list.

positional arguments:
  url_list              Path to a text file with one URL per line (# comments
                        and blank lines ignored).

options:
  -h, --help            show this help message and exit
  --vods-dir VODS_DIR   Where to store downloaded audio (default: the
                        persona's vods/ in the data home's sources).
  --format FORMAT       yt-dlp format spec (default: 'bestaudio[ext=m4a]').
  --cookies-from-browser COOKIES_FROM_BROWSER
                        Browser to read cookies from (default:
                        YT_DLP_COOKIES_FROM_BROWSER, else chrome). Pass an
                        empty string to disable.
  --cookies COOKIES     Path to a cookies.txt file (default: YT_DLP_COOKIES).
                        yt-dlp writes the cookies it used back into it.
  --yt-dlp-args YT_DLP_ARGS
                        Extra args forwarded to yt-dlp as a single shell-
                        quoted string. Example: --yt-dlp-args="--rate-limit 2M
                        --sleep-interval 5". Using a single string instead of
                        REMAINDER avoids argparse swallowing flags placed
                        after the URL list path.
  --persona PERSONA     Persona whose sources to use (default: the active
                        persona).
  --json                Report progress as JSON lines on stdout; the summary
                        goes to stderr.
  --expand URL          Print the video URLs of a playlist, channel or series,
                        one per line, and exit. With --json, one entry event per
                        video instead.
`,
  actions: [
    { dest: "url_list", flags: [], kind: "store", nargs: "?", type: PATH },
    { dest: "vods_dir", flags: ["--vods-dir"], kind: "store", type: PATH },
    { dest: "format", flags: ["--format"], kind: "store", default: download.DEFAULT_FORMAT },
    { dest: "cookies_from_browser", flags: ["--cookies-from-browser"], kind: "store" },
    { dest: "cookies", flags: ["--cookies"], kind: "store", type: PATH },
    { dest: "yt_dlp_args", flags: ["--yt-dlp-args"], kind: "store", default: "" },
    { dest: "persona", flags: ["--persona"], kind: "store" },
    { dest: "json", flags: ["--json"], kind: "store_true" },
    { dest: "expand", flags: ["--expand"], kind: "store" },
  ],
};

export interface DownloadDeps extends CommandDeps {
  /** How the managed yt-dlp is installed and updated; tests fake GitHub here. */
  readonly ytDlpOptions?: download.DownloadOptions["ytDlpOptions"];
}

/** The parsed command line, with the persona it runs for. Throws ArgparseExit. */
function parse(argv: readonly string[]): { ns: Namespace; persona: string } {
  const ns = parseArgs(DOWNLOAD_PARSER, argv);
  const persona = commandPersona(DOWNLOAD_PARSER, ns.persona as string | null);
  if (ns.expand !== null) {
    if (ns.url_list !== null) {
      throw parserError(DOWNLOAD_PARSER, "argument url_list: not allowed with argument --expand");
    }
  } else if (ns.url_list === null) {
    throw parserError(DOWNLOAD_PARSER, "the following arguments are required: url_list");
  }
  return { ns, persona };
}

/**
 * `--expand`: the playlist's video URLs printed one per line, or under --json an entry event per
 * video, then the expansion's summary.
 */
async function expand(
  url: string,
  options: download.ExpandOptions & { readonly print: ((url: string) => void) | null },
): Promise<number> {
  const emit = options.onProgress ?? noProgress;
  const started = performance.now();
  const summary = (ok: boolean, entries: number, extra: object = {}) =>
    emit({
      type: "summary",
      stage: "expand",
      ok,
      counts: { entries },
      durationSec: (performance.now() - started) / 1000,
      ...extra,
    });
  emit({ type: "stage", stage: "expand", status: "start" });
  try {
    const entries = await download.expandPlaylist(url, options);
    for (const entry of entries) options.print?.(entry.url);
    emit({ type: "stage", stage: "expand", status: "done", total: entries.length });
    summary(true, entries.length);
    return 0;
  } catch (error) {
    if (options.signal?.aborted) {
      emit({ type: "stage", stage: "expand", status: "cancelled", code: "cancelled" });
      summary(false, 0, { cancelled: true });
      return 1;
    }
    if (
      !(
        error instanceof download.YtDlpUnavailableError ||
        error instanceof download.YtDlpFailedError
      )
    ) {
      throw error;
    }
    logger.error(error.message);
    const { code } = error;
    emit({
      type: "stage",
      stage: "expand",
      status: "failed",
      message: error.message,
      ...(code === undefined ? {} : { code }),
    });
    summary(false, 0, { failures: [{ item: url, error: error.message }] });
    return 1;
  }
}

/** The `laplace-download` command; resolves to its exit code. */
export async function downloadMain(
  argv: readonly string[],
  deps: DownloadDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  let parsed: { ns: Namespace; persona: string };
  try {
    parsed = parse(argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const { ns, persona } = parsed;
  const browserFlag = ns.cookies_from_browser as string | null;
  // An explicit empty value means no browser, as Python's `or None` read it.
  const cookiesFromBrowser =
    browserFlag === null ? download.defaultCookiesFromBrowser() : browserFlag || null;
  const cookiesFile = (ns.cookies as string | null) ?? download.defaultCookiesFile();
  if (cookiesFromBrowser && cookiesFile) {
    logger.warning(
      `Cookies come from ${cookiesFromBrowser} and from ${cookiesFile}: yt-dlp loads both, ` +
        `and writes the merged cookies back into ${cookiesFile}.`,
    );
  }
  // An unbalanced quote throws here, before the list is read, as in Python.
  const extraArgs = download.shlexSplit((ns.yt_dlp_args as string) || "");
  const ytDlpOptions = { command: PROG, ...deps.ytDlpOptions };

  const json = ns.json as boolean;
  const onProgress = json ? ndjsonSink(io.stdout) : noProgress;

  if (ns.expand !== null) {
    return expand(ns.expand as string, {
      cookiesFromBrowser,
      cookiesFile,
      extraArgs,
      ytDlpOptions,
      onProgress,
      signal: deps.signal,
      print: json ? null : (url) => io.stdout(`${url}\n`),
    });
  }

  const urlList = ns.url_list as string;
  const vodsDir = (ns.vods_dir as string | null) ?? sourceFolder(persona, "vods");
  const format = ns.format as string;
  // With --json, stdout carries only events.
  const human = json ? io.stderr : io.stdout;
  const failBeforeStart = (message: string, code?: EventCode): number => {
    logger.error(message);
    onProgress({
      type: "stage",
      stage: "download",
      status: "failed",
      message,
      ...(code ? { code } : {}),
    });
    onProgress({ ...download.downloadSummaryEvent(download.emptyDownloadReport(0)), ok: false });
    return 1;
  };

  let release: () => void;
  try {
    release = acquireLock(sourcesLockKey(persona), PROG);
  } catch (error) {
    if (error instanceof LockedError) return failBeforeStart(error.message, error.code);
    throw error;
  }
  try {
    let urls: string[];
    try {
      urls = download.readUrlList(urlList);
    } catch (error) {
      if (error instanceof Error && error.name === "FileNotFoundError") {
        return failBeforeStart(errorText(error));
      }
      throw error;
    }
    if (urls.length === 0) {
      logger.warning(`No URLs in ${urlList}.`);
      onProgress({ type: "stage", stage: "download", status: "skipped", total: 0 });
      onProgress(download.downloadSummaryEvent(download.emptyDownloadReport(0)));
      return 0;
    }
    logger.info(
      `Downloading ${urls.length} URL(s) to ${vodsDir}/ ` +
        `(format=${pyRepr(format)}, cookies_from_browser=${pyRepr(cookiesFromBrowser)})`,
    );
    const report = await download.downloadUrls(urls, {
      vodsDir,
      format,
      cookiesFromBrowser,
      cookiesFile,
      extraArgs,
      onProgress,
      output: json ? "events" : "inherit",
      onOutput: (line) => io.stderr(`${line}\n`),
      ytDlpOptions,
      signal: deps.signal,
    });
    // No yt-dlp ran, so there is no summary to print; the error is logged.
    if (report.error !== null) return 1;
    human(download.downloadSummaryText(report, vodsDir));
    return report.failedUrls.length > 0 || report.cancelled ? 1 : 0;
  } finally {
    release();
  }
}
