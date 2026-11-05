// fixtures/download/download.golden.json is what download.golden.py printed through Python's
// tools/download.py and prepare_batch.py, with fake-yt-dlp.sh as yt-dlp; "<WORK>" stands for that
// run's folder. The download tests here and in apps/cli replay its inputs.
import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DOWNLOAD_FIXTURES = join(import.meta.dir, "fixtures", "download");

export interface RunGolden {
  name: string;
  initial: string[];
  urls: string[];
  extra: string;
  browser: string | null;
  cookies: string | null;
  argv: string[][];
  requested: number;
  succeeded: number;
  failed: [string, string][];
  new_files: string[];
  files: string[];
  summary: string;
  logs: [string, string][];
}

export interface MainGolden {
  name: string;
  list: string | null;
  argv: string[];
  code: number | null;
  raises: string | null;
  stdout: string;
  logs: [string, string][];
  argv_calls: string[][];
}

export interface PrepareGolden {
  name: string;
  capture: string;
  expected: number;
  dry_run: boolean;
  drop?: string[];
  extra?: Record<string, string>;
  result: Record<string, unknown> | null;
  error: string | null;
  created_text: string | null;
}

export interface DownloadGolden {
  shlex: { text: string; tokens?: string[]; error?: string }[];
  url_list: { text: string; urls: string[]; missing: string };
  argv: {
    url: string;
    vods_dir: string;
    format: string;
    browser: string | null;
    cookies: string | null;
    extra: string;
    argv: string[];
  }[];
  summary: {
    vods_dir: string;
    requested: number;
    succeeded: number;
    failed: [string, string][];
    new: number;
    duration: number;
    text: string;
  }[];
  runs: RunGolden[];
  main: MainGolden[];
  prepare_files: Record<string, string | { b64: string }>;
  prepare: PrepareGolden[];
  prepare_main: { argv: string[]; code: number; error: string }[];
}

export const downloadGolden = JSON.parse(
  readFileSync(join(DOWNLOAD_FIXTURES, "download.golden.json"), "utf8"),
) as DownloadGolden;

/** fake-yt-dlp.sh as an executable `yt-dlp` in `dir`; git may not keep the fixture's mode. */
export function installFakeYtDlp(dir: string): string {
  const path = join(dir, "yt-dlp");
  copyFileSync(join(DOWNLOAD_FIXTURES, "fake-yt-dlp.sh"), path);
  chmodSync(path, 0o755);
  return path;
}

/** Every argv the fake recorded, in call order. */
export function readArgvLog(path: string): string[][] {
  if (!existsSync(path)) return [];
  const fields = readFileSync(path, "utf8").split("\0").slice(0, -1);
  const calls: string[][] = [];
  for (let i = 0; i < fields.length; ) {
    const n = Number(fields[i]);
    calls.push(fields.slice(i + 1, i + 1 + n));
    i += 1 + n;
  }
  return calls;
}

/** Python's yt-dlp arguments with the port's two additions: --ignore-config first, -- before the URL. */
export function withPortArgs(python: readonly string[]): string[] {
  return ["--ignore-config", ...python.slice(0, -1), "--", python.at(-1) as string];
}
