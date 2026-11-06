// The yt-dlp the download runs: YT_DLP_PATH's, else a copy this code installs from yt-dlp's GitHub
// releases into the data home and keeps current, since an outdated yt-dlp is what Bilibili answers
// with HTTP 412.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { envOptional, errorText, isPlainObject, logger, raceAbort } from "@eidolon/config";
import { which } from "../limit.ts";
import { acquireLock, binDir, LockedError, writeTextAtomic, YT_DLP_LOCK_KEY } from "../paths.ts";
import { noProgress, type RunOptions } from "../progress.ts";

const RELEASES = "https://github.com/yt-dlp/yt-dlp/releases";
/** How often the managed copy asks GitHub for a newer release. */
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const PROGRESS_STEP_BYTES = 1 << 20;

export interface YtDlp {
  readonly path: string;
  /** YT_DLP_PATH's binary, the managed copy, or one found on PATH; only "managed" is updated. */
  readonly source: "setting" | "managed" | "path";
  /** The managed copy's release tag. */
  readonly tag?: string;
}

/** No yt-dlp to run; the CLI exits 1, or reports code "ytdlp-unavailable" under --json. */
export class YtDlpUnavailableError extends Error {
  override name = "YtDlpUnavailableError";
  readonly code = "ytdlp-unavailable";
}

export interface YtDlpOptions extends RunOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Whether Linux's C library is musl; detected when omitted. */
  readonly musl?: boolean;
  /** The command named to a second process that finds the update lock taken. */
  readonly command?: string;
  /** Ask GitHub for a newer release even within UPDATE_INTERVAL_MS, as after an HTTP 412. */
  readonly force?: boolean;
  /** How often to retry the update lock while another process installs yt-dlp. */
  readonly lockPollMs?: number;
}

/** The release asset that runs on this machine, or null where yt-dlp publishes none. */
export function ytDlpAsset(platform: string, arch: string, musl: boolean): string | null {
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "linux") {
    const libc = musl ? "yt-dlp_musllinux" : "yt-dlp_linux";
    if (arch === "x64") return libc;
    if (arch === "arm64") return `${libc}_aarch64`;
  }
  if (platform === "win32") {
    if (arch === "x64") return "yt-dlp.exe";
    if (arch === "arm64") return "yt-dlp_arm64.exe";
  }
  return null;
}

function detectMusl(): boolean {
  return ["/lib/ld-musl-x86_64.so.1", "/lib/ld-musl-aarch64.so.1"].some((path) => existsSync(path));
}

/** Where the managed copy lives. */
export function managedYtDlpPath(platform: string = process.platform): string {
  return join(binDir(), platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

function stampPath(): string {
  return join(binDir(), "yt-dlp.stamp.json");
}

interface Stamp {
  readonly tag: string;
  readonly asset: string;
  readonly sha256: string;
  /** When GitHub was last asked for a newer release, in ms. */
  readonly checkedAt: number;
}

function readStamp(): Stamp | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(stampPath(), "utf8"));
    if (!isPlainObject(raw)) return null;
    const { tag, asset, sha256, checkedAt } = raw;
    const checked = typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
    if (typeof tag !== "string" || typeof asset !== "string" || typeof sha256 !== "string") {
      return null;
    }
    return { tag, asset, sha256, checkedAt: Number.isNaN(checked) ? 0 : checked };
  } catch {
    return null;
  }
}

/** The managed copy's release tag as its stamp records it; null without a readable stamp. */
export function managedYtDlpTag(): string | null {
  return readStamp()?.tag ?? null;
}

function writeStamp(stamp: Stamp): void {
  const { checkedAt, ...rest } = stamp;
  writeTextAtomic(
    stampPath(),
    `${JSON.stringify({ ...rest, checkedAt: new Date(checkedAt).toISOString() })}\n`,
  );
}

/**
 * The yt-dlp to run: YT_DLP_PATH's (sources.ytDlp), else the managed copy in `<home>/bin`,
 * installed on first use and checked against GitHub's latest release at most once per
 * UPDATE_INTERVAL_MS. Where yt-dlp publishes no build for this machine, or installing it fails,
 * one on PATH, with a warning. Throws YtDlpUnavailableError when there is none to run.
 */
export async function resolveYtDlp(opts: YtDlpOptions = {}): Promise<YtDlp> {
  const configured = envOptional("YT_DLP_PATH");
  if (configured !== undefined) {
    const path = which(configured);
    if (path === null) {
      throw new YtDlpUnavailableError(`yt-dlp not found at ${configured} (YT_DLP_PATH)`);
    }
    return { path, source: "setting" };
  }
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const asset = ytDlpAsset(platform, arch, opts.musl ?? (platform === "linux" && detectMusl()));
  if (asset === null) {
    const onPath = which("yt-dlp");
    if (onPath === null) {
      throw new YtDlpUnavailableError(
        `yt-dlp publishes no build for ${platform} ${arch}; install yt-dlp and set YT_DLP_PATH to it`,
      );
    }
    logger.warning(
      `yt-dlp publishes no build for ${platform} ${arch}; using ${onPath}, which is never updated`,
    );
    return { path: onPath, source: "path" };
  }
  return ensureManaged(asset, platform, opts);
}

function tryLock(command: string): (() => void) | null {
  try {
    return acquireLock(YT_DLP_LOCK_KEY, command);
  } catch (error) {
    if (error instanceof LockedError) return null;
    throw error;
  }
}

async function ensureManaged(asset: string, platform: string, opts: YtDlpOptions): Promise<YtDlp> {
  const now = opts.now ?? Date.now;
  const path = managedYtDlpPath(platform);
  const startedAt = now();
  // A forced check is due unless one ran after this call began, as another process's may have.
  const due = (stamp: Stamp | null): boolean =>
    !existsSync(path) ||
    stamp === null ||
    stamp.asset !== asset ||
    (opts.force ? stamp.checkedAt < startedAt : now() - stamp.checkedAt >= UPDATE_INTERVAL_MS);
  const current = (stamp: Stamp | null): YtDlp => ({
    path,
    source: "managed",
    ...(stamp?.tag ? { tag: stamp.tag } : {}),
  });

  const before = readStamp();
  if (!due(before)) return current(before);
  const command = opts.command ?? "laplace-download";
  let release = tryLock(command);
  if (release === null) {
    if (existsSync(path)) {
      logger.info("Another process is updating yt-dlp; this run keeps the current one");
      return current(before);
    }
    logger.info("Waiting for another process to install yt-dlp");
    while (release === null) {
      await raceAbort(Bun.sleep(opts.lockPollMs ?? 500), opts.signal);
      release = tryLock(command);
    }
  }
  try {
    const stamp = readStamp();
    if (!due(stamp)) return current(stamp);
    return await checkAndInstall(asset, path, stamp, opts, now, current);
  } finally {
    release();
  }
}

async function checkAndInstall(
  asset: string,
  path: string,
  stamp: Stamp | null,
  opts: YtDlpOptions,
  now: () => number,
  current: (stamp: Stamp | null) => YtDlp,
): Promise<YtDlp> {
  const fetchImpl = opts.fetch ?? fetch;
  const installed = existsSync(path) && stamp !== null && stamp.asset === asset ? stamp : null;
  // A failed check counts as a check, so an offline machine waits a day before trying again.
  const keep = (reason: unknown): YtDlp => {
    if (!existsSync(path)) {
      const onPath = which("yt-dlp");
      if (onPath === null) {
        throw new YtDlpUnavailableError(
          `Could not install yt-dlp: ${errorText(reason)}. Set YT_DLP_PATH to run another yt-dlp.`,
        );
      }
      logger.warning(
        `Could not install yt-dlp (${errorText(reason)}); using ${onPath}, which is never updated`,
      );
      return { path: onPath, source: "path" };
    }
    logger.warning(`Could not update yt-dlp (${errorText(reason)}); keeping the installed one`);
    const kept = {
      tag: stamp?.tag ?? "",
      asset: stamp?.asset ?? asset,
      sha256: stamp?.sha256 ?? "",
      checkedAt: now(),
    };
    writeStamp(kept);
    return current(kept);
  };

  let tag: string;
  try {
    tag = await latestTag(fetchImpl, opts.signal);
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    return keep(error);
  }
  if (installed !== null && installed.tag === tag) {
    writeStamp({ ...installed, checkedAt: now() });
    return { path, source: "managed", tag };
  }
  const onProgress = opts.onProgress ?? noProgress;
  logger.info(`Installing yt-dlp ${tag} (${asset}) into ${path}`);
  onProgress({ type: "stage", stage: "setup", status: "start", message: `yt-dlp ${tag}` });
  try {
    const sha256 = await install(asset, tag, path, fetchImpl, opts);
    writeStamp({ tag, asset, sha256, checkedAt: now() });
    onProgress({ type: "stage", stage: "setup", status: "done", message: `yt-dlp ${tag}` });
    return { path, source: "managed", tag };
  } catch (error) {
    if (opts.signal?.aborted) {
      onProgress({ type: "stage", stage: "setup", status: "cancelled" });
      throw error;
    }
    const failed = {
      type: "stage",
      stage: "setup",
      status: "failed",
      message: errorText(error),
    } as const;
    let kept: YtDlp;
    try {
      kept = keep(error);
    } catch (unavailable) {
      onProgress({ ...failed, code: "ytdlp-unavailable" });
      throw unavailable;
    }
    onProgress(failed);
    return kept;
  }
}

function checkSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The latest release's tag, read from where `releases/latest` redirects, so no API quota is spent. */
async function latestTag(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  const response = await fetchImpl(`${RELEASES}/latest`, {
    redirect: "manual",
    signal: checkSignal(signal),
  });
  await response.body?.cancel();
  const location = response.headers.get("location");
  const match = location
    ? /\/releases\/tag\/([^/]+)$/.exec(new URL(location, RELEASES).pathname)
    : null;
  if (match === null) {
    throw new Error(`GitHub named no latest release (HTTP ${response.status})`);
  }
  return decodeURIComponent(match[1] as string);
}

async function fetchOk(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const response = await fetchImpl(url, signal ? { signal } : {});
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response;
}

/** Downloads `asset` of release `tag` over `path`, checked against the release's SHA2-256SUMS. */
async function install(
  asset: string,
  tag: string,
  path: string,
  fetchImpl: typeof fetch,
  opts: YtDlpOptions,
): Promise<string> {
  const onProgress = opts.onProgress ?? noProgress;
  const base = `${RELEASES}/download/${encodeURIComponent(tag)}`;
  const sums = await (
    await fetchOk(fetchImpl, `${base}/SHA2-256SUMS`, checkSignal(opts.signal))
  ).text();
  const expected = sums
    .split("\n")
    .map((line) => /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim()))
    .find((match) => match?.[2] === asset)?.[1]
    ?.toLowerCase();
  if (expected === undefined) throw new Error(`SHA2-256SUMS of ${tag} lists no ${asset}`);
  mkdirSync(binDir(), { recursive: true });
  const tmp = join(binDir(), `yt-dlp.${process.pid}.tmp`);
  try {
    const response = await fetchOk(fetchImpl, `${base}/${asset}`, opts.signal);
    const length = Number(response.headers.get("content-length"));
    const total = Number.isFinite(length) && length > 0 ? { total: length } : {};
    const hash = createHash("sha256");
    const fd = openSync(tmp, "w");
    let done = 0;
    let reported = 0;
    try {
      for await (const chunk of response.body as ReadableStream<Uint8Array>) {
        hash.update(chunk);
        writeSync(fd, chunk);
        done += chunk.length;
        if (done - reported >= PROGRESS_STEP_BYTES) {
          reported = done;
          onProgress({
            type: "progress",
            stage: "setup",
            item: asset,
            done,
            unit: "bytes",
            ...total,
          });
        }
      }
    } finally {
      closeSync(fd);
    }
    onProgress({ type: "progress", stage: "setup", item: asset, done, unit: "bytes", ...total });
    const actual = hash.digest("hex");
    if (actual !== expected) {
      throw new Error(`${asset} of ${tag} doesn't match its checksum (${actual}, not ${expected})`);
    }
    chmodSync(tmp, 0o755);
    // Windows can't replace a running exe, but it can rename one.
    if (path.endsWith(".exe") && existsSync(path)) {
      rmSync(`${path}.old`, { force: true });
      renameSync(path, `${path}.old`);
    }
    renameSync(tmp, path);
    return actual;
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never created, or already renamed.
    }
    throw error;
  }
}
