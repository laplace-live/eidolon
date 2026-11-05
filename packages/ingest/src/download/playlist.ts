// The videos a playlist, channel or series URL lists, for building a batch without a browser.
import { isPlainObject, pyStrip } from "@eidolon/config";
import { terminateOnAbort } from "../limit.ts";
import { noProgress, type PlaylistEntry, type RunOptions } from "../progress.ts";
import { defaultCookiesFile, defaultCookiesFromBrowser, jsRuntimeArgs } from "./argv.ts";
import { exitStatus, forEachLine, stderrTail, YtDlpFailedError, ytDlpFailureCode } from "./run.ts";
import { resolveYtDlp, type YtDlp, type YtDlpOptions } from "./ytdlp.ts";

// One JSON object per entry, of the fields yt-dlp has. webpage_url, not url: for a single video,
// url is the media stream's address.
const ENTRY_TEMPLATE = "%(.{webpage_url,id,title,duration})j";

export interface ExpandOptions extends RunOptions {
  /** null: no browser's cookies; omitted: defaultCookiesFromBrowser(). */
  readonly cookiesFromBrowser?: string | null;
  readonly cookiesFile?: string | null;
  readonly extraArgs?: readonly string[];
  readonly ytDlp?: YtDlp;
  readonly ytDlpOptions?: Omit<YtDlpOptions, keyof RunOptions | "force">;
}

function entryOf(line: string): PlaylistEntry | null {
  let fields: unknown;
  try {
    fields = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(fields)) return null;
  const { webpage_url: url, id, title, duration } = fields;
  if (typeof url !== "string" || typeof id !== "string") return null;
  return {
    url,
    id,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof duration === "number" ? { durationSec: duration } : {}),
  };
}

/**
 * Each video `url` lists, in its order, through yt-dlp's `--flat-playlist`, which names the
 * entries without extracting them; a single video's URL lists itself. Emits an `entry` event for
 * each as yt-dlp prints it. Throws YtDlpFailedError, with the code its stderr points to, when
 * yt-dlp fails.
 */
export async function expandPlaylist(
  url: string,
  opts: ExpandOptions = {},
): Promise<PlaylistEntry[]> {
  const emit = opts.onProgress ?? noProgress;
  const ytDlp =
    opts.ytDlp ??
    (await resolveYtDlp({
      ...opts.ytDlpOptions,
      onProgress: opts.onProgress,
      signal: opts.signal,
    }));
  const browser =
    opts.cookiesFromBrowser === undefined ? defaultCookiesFromBrowser() : opts.cookiesFromBrowser;
  const cookies = opts.cookiesFile === undefined ? defaultCookiesFile() : opts.cookiesFile;
  const args = [
    "--ignore-config",
    ...jsRuntimeArgs(ytDlp),
    "--flat-playlist",
    "--print",
    ENTRY_TEMPLATE,
  ];
  if (browser) args.push("--cookies-from-browser", browser);
  if (cookies) args.push("--cookies", cookies);
  args.push(...(opts.extraArgs ?? []), "--", url);
  const child = Bun.spawn([ytDlp.path, ...args], {
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = terminateOnAbort(child, opts.signal);
  const entries: PlaylistEntry[] = [];
  let stderr: string;
  try {
    [stderr] = await Promise.all([
      new Response(child.stderr).text(),
      forEachLine(child.stdout, (line) => {
        const entry = entryOf(pyStrip(line));
        if (entry === null) return;
        entries.push(entry);
        emit({ type: "entry", entry });
      }),
    ]);
    await child.exited;
  } finally {
    stop();
  }
  if (opts.signal?.aborted) throw opts.signal.reason;
  const status = exitStatus(child);
  if (status !== 0) {
    throw new YtDlpFailedError(
      `yt-dlp failed (exit=${status}). stderr tail:\n    ${stderrTail(stderr)}`,
      ytDlpFailureCode(stderr),
    );
  }
  return entries;
}
