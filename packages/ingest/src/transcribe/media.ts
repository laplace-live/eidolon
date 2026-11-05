// ffprobe for an audio file's length and ffmpeg to cut one that Soniox's per-file cap won't take.
// Both are optional binaries on PATH; an aborted run stops them.
import { existsSync, readFileSync } from "node:fs";
import {
  loadsPy,
  pyFixed,
  pyGet,
  pyNumber,
  pyParseFloat,
  pyPathName,
  pyStrip,
} from "@eidolon/config";
import { terminateOnAbort, which } from "../limit.ts";
import { infoJsonPath } from "../streams.ts";
import { TranscribeError } from "./errors.ts";

const PROBE_TIMEOUT_MS = 30_000;

/** `binary` as given, else `name` found on PATH; null when there is none. */
export function locateBinary(binary: string | null | undefined, name: string): string | null {
  return binary === undefined ? which(name) : binary;
}

/**
 * The audio's length in seconds by ffprobe, or null when ffprobe is missing, fails or prints no
 * number.
 */
export async function probeDurationSec(
  path: string,
  options: { readonly ffprobe?: string | null; readonly signal?: AbortSignal } = {},
): Promise<number | null> {
  const ffprobe = locateBinary(options.ffprobe, "ffprobe");
  if (!ffprobe) return null;
  const { signal } = options;
  signal?.throwIfAborted();
  const argv = [
    ffprobe,
    ...["-v", "error", "-show_entries", "format=duration"],
    ...["-of", "default=noprint_wrappers=1:nokey=1", path],
  ];
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn(argv, {
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const release = terminateOnAbort(child, signal);
  try {
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    signal?.throwIfAborted();
    return code === 0 ? pyParseFloat(pyStrip(out)) : null;
  } catch {
    if (signal?.aborted) throw signal.reason;
    return null;
  } finally {
    release();
  }
}

/** The `duration` yt-dlp wrote to the audio's `.info.json`, or null. */
export function infoJsonDurationSec(audioPath: string): number | null {
  const path = infoJsonPath(audioPath);
  if (!existsSync(path)) return null;
  try {
    return pyNumber(pyGet(loadsPy(readFileSync(path, "utf8")), "duration"));
  } catch {
    return null;
  }
}

export function ffmpegMissing(): TranscribeError {
  return new TranscribeError(
    "ffmpeg not found on PATH — required for --auto-slice. Install ffmpeg " +
      "(brew install ffmpeg / apt install ffmpeg) and retry.",
    "ffmpeg-unavailable",
  );
}

/**
 * Cuts `[startSec, startSec + durationSec)` of `audio` to `outPath`. `-c copy` cuts at a keyframe,
 * a few seconds off at worst; the merge places each part at its requested start, so the transcript
 * stays monotonic. `-vn` drops cover art, which would only make the upload bigger.
 */
export async function ffmpegSlice(
  audio: string,
  slice: { readonly startSec: number; readonly durationSec: number; readonly outPath: string },
  options: { readonly ffmpeg?: string | null; readonly signal?: AbortSignal } = {},
): Promise<void> {
  const ffmpeg = locateBinary(options.ffmpeg, "ffmpeg");
  if (!ffmpeg) throw ffmpegMissing();
  const { signal } = options;
  signal?.throwIfAborted();
  const child = Bun.spawn(
    [
      ffmpeg,
      ...["-nostdin", "-loglevel", "error", "-y"],
      ...["-ss", pyFixed(slice.startSec, 3), "-t", pyFixed(slice.durationSec, 3)],
      ...["-i", audio, "-c", "copy", "-vn", "-map_metadata", "-1", slice.outPath],
    ],
    { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const release = terminateOnAbort(child, signal);
  let stderr: string;
  let code: number;
  try {
    [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  } finally {
    release();
  }
  signal?.throwIfAborted();
  if (code !== 0) {
    throw new TranscribeError(
      `ffmpeg slice failed (exit=${code}) for ${pyPathName(audio)} ` +
        `[${pyFixed(slice.startSec, 1)}s + ${pyFixed(slice.durationSec, 1)}s]:\n${pyStrip(stderr)}`,
    );
  }
}
