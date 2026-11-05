// The videos a playlist, channel or series URL lists, for building a batch without a browser.
import { pyStrip, splitlines } from "@eidolon/config";
import { terminateOnAbort } from "../limit.ts";
import type { RunOptions } from "../progress.ts";
import { defaultCookiesFile, defaultCookiesFromBrowser } from "./argv.ts";
import { exitStatus, stderrTail, YtDlpFailedError } from "./run.ts";
import { resolveYtDlp, type YtDlp, type YtDlpOptions } from "./ytdlp.ts";

export interface ExpandOptions extends RunOptions {
  /** null: no browser's cookies; omitted: defaultCookiesFromBrowser(). */
  readonly cookiesFromBrowser?: string | null;
  readonly cookiesFile?: string | null;
  readonly extraArgs?: readonly string[];
  readonly ytDlp?: YtDlp;
  readonly ytDlpOptions?: Omit<YtDlpOptions, keyof RunOptions | "force">;
}

/**
 * Each video URL `url` lists, in its order, through yt-dlp's `--flat-playlist`, which names the
 * entries without extracting them. A single video's URL lists itself.
 */
export async function expandPlaylist(url: string, opts: ExpandOptions = {}): Promise<string[]> {
  const ytDlp =
    opts.ytDlp ??
    (await resolveYtDlp({
      ...opts.ytDlpOptions,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }));
  const browser =
    opts.cookiesFromBrowser === undefined ? defaultCookiesFromBrowser() : opts.cookiesFromBrowser;
  const cookies = opts.cookiesFile === undefined ? defaultCookiesFile() : opts.cookiesFile;
  // webpage_url, not url: for a single video, url is the media stream's address.
  const args = ["--ignore-config", "--flat-playlist", "--print", "webpage_url"];
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
  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
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
    );
  }
  return splitlines(stdout)
    .map((line) => pyStrip(line))
    .filter((line) => line !== "");
}
