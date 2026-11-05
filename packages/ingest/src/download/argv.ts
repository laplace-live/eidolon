// yt-dlp's command line for one URL, and the cookie settings that feed it.
import { envOptional, pyPath } from "@eidolon/config";
import type { YtDlp } from "./ytdlp.ts";

export const DEFAULT_FORMAT = "bestaudio[ext=m4a]";
export const DEFAULT_BROWSER = "chrome";
/** yt-dlp names each file by its id, so a multi-part video lands as `<BV>_p1.m4a`, `_p2`, … */
const OUTPUT_TEMPLATE = "%(id)s.%(ext)s";

/** Starts each progress line yt-dlp prints for --json; the rest of the line is a JSON array. */
const PROGRESS_MARK = "[eidolon] ";
// `|null` turns a missing field into a JSON null instead of yt-dlp's bare NA placeholder.
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_MARK}[%(info.id|null)j,%(progress.downloaded_bytes|null)j,` +
  "%(progress.total_bytes|null)j,%(progress.total_bytes_estimate|null)j]";

/**
 * YouTube's pages carry JavaScript challenges that yt-dlp solves with a runtime it finds, only
 * Deno by default; the Bun running this is always there. yt-dlp still prefers a Deno it finds, and
 * has deprecated Bun: past the last Bun it supports, it warns and runs it anyway
 * (https://github.com/yt-dlp/yt-dlp/issues/16766). Only the managed yt-dlp, always a current
 * release, gets the flag: a YT_DLP_PATH or PATH one may predate it and would fail every URL.
 */
export function jsRuntimeArgs(ytDlp: Pick<YtDlp, "source">): string[] {
  return ytDlp.source === "managed" ? ["--js-runtimes", `bun:${process.execPath}`] : [];
}

/**
 * `--cookies-from-browser`'s default: YT_DLP_COOKIES_FROM_BROWSER (sources.cookiesFromBrowser),
 * where `none` means no browser, else chrome.
 */
export function defaultCookiesFromBrowser(): string | null {
  const value = envOptional("YT_DLP_COOKIES_FROM_BROWSER");
  if (value === undefined) return DEFAULT_BROWSER;
  return value === "none" ? null : value;
}

/** `--cookies`'s default: YT_DLP_COOKIES (sources.cookiesFile). */
export function defaultCookiesFile(): string | null {
  const value = envOptional("YT_DLP_COOKIES");
  return value === undefined ? null : pyPath(value);
}

export interface YtDlpArgvOptions {
  readonly vodsDir: string;
  readonly format: string;
  /** null: no browser's cookies. */
  readonly cookiesFromBrowser: string | null;
  readonly cookiesFile: string | null;
  /** `--yt-dlp-args`, split; after the defaults, so they override them. */
  readonly extraArgs: readonly string[];
  /** Progress as one parseable line per update on stdout, for --json. */
  readonly progressLines?: boolean;
  /** The yt-dlp these arguments are for, which decides jsRuntimeArgs. */
  readonly ytDlp: Pick<YtDlp, "source">;
}

/**
 * `_build_yt_dlp_cmd`'s arguments, plus `--ignore-config` (a user config could move the files or
 * drop the info.json the stream date comes from), the managed yt-dlp's JavaScript runtime for
 * YouTube, and `--` before the URL, so a list line starting with `-` is never read as an option.
 */
export function ytDlpArgs(url: string, opts: YtDlpArgvOptions): string[] {
  const args = [
    "--ignore-config",
    ...jsRuntimeArgs(opts.ytDlp),
    "-f",
    opts.format,
    "-o",
    pyPath(`${opts.vodsDir}/${OUTPUT_TEMPLATE}`),
    // The info.json is the stream date's only source, and --no-overwrites keeps it write-once, so
    // a re-run or a newer yt-dlp can't change the date a stream id was built from.
    "--write-info-json",
    "--no-overwrites",
    "--no-write-playlist-metafiles",
  ];
  if (opts.cookiesFromBrowser) args.push("--cookies-from-browser", opts.cookiesFromBrowser);
  if (opts.cookiesFile) args.push("--cookies", opts.cookiesFile);
  args.push(...opts.extraArgs);
  if (opts.progressLines) {
    args.push("--newline", "--progress-template", PROGRESS_TEMPLATE, "--progress-delta", "0.5");
  }
  args.push("--", url);
  return args;
}

/** One progress update parsed from a PROGRESS_MARK line, or null for any other line. */
export function parseProgressLine(
  line: string,
): { video?: string; done: number; total?: number } | null {
  if (!line.startsWith(PROGRESS_MARK)) return null;
  let fields: unknown;
  try {
    fields = JSON.parse(line.slice(PROGRESS_MARK.length));
  } catch {
    return null;
  }
  if (!Array.isArray(fields)) return null;
  const [id, done, total, estimate] = fields as unknown[];
  const size = typeof total === "number" ? total : estimate;
  return {
    ...(typeof id === "string" ? { video: id } : {}),
    done: typeof done === "number" ? done : 0,
    ...(typeof size === "number" ? { total: Math.round(size) } : {}),
  };
}
