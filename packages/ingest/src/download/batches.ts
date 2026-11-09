// A persona's URL lists and batches: new videos go into a new batch under lists/batches/ holding
// only what no list has yet, and a batch without its .done.json is still pending.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import {
  partition,
  pyError,
  pyPathWithSuffix,
  pyRepr,
  pyStrip,
  sortedPy,
  splitlines,
} from "@eidolon/config";
import { writeTextAtomic } from "../paths.ts";

/** A Bilibili video id, as the archive and its URLs carry it. */
export const BV_ID = /^BV[0-9A-Za-z]{10}$/;
const VIDEO_PATH = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/;
const BILIBILI_HOSTS = new Set(["www.bilibili.com", "bilibili.com"]);

/** Where a batch is written, under a persona's lists folder. */
export const BATCHES_DIR = "batches";

const STRERROR: Readonly<Record<string, readonly [string, string]>> = {
  ENOENT: ["FileNotFoundError", "No such file or directory"],
  EACCES: ["PermissionError", "Permission denied"],
  EISDIR: ["IsADirectoryError", "Is a directory"],
  ENOTDIR: ["NotADirectoryError", "Not a directory"],
  EEXIST: ["FileExistsError", "File exists"],
};

/** An fs error as Python's OSError prints it: `[Errno 2] No such file or directory: 'x'`. */
function osError(error: unknown, path: string): unknown {
  const code = (error as { code?: unknown }).code;
  const known = typeof code === "string" ? STRERROR[code] : undefined;
  const errno =
    typeof code === "string" ? (constants.errno as Record<string, number>)[code] : undefined;
  if (known === undefined || errno === undefined) return error;
  return pyError(known[0], `[Errno ${errno}] ${known[1]}: ${pyRepr(path)}`);
}

/** CPython's UTF-8 decode error: where it starts and ends, and why. */
function utf8Error(bytes: Uint8Array): { start: number; end: number; reason: string } | null {
  for (let i = 0; i < bytes.length; ) {
    const lead = bytes[i] as number;
    if (lead < 0x80) {
      i++;
      continue;
    }
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      if (lead === 0xe0) lo = 0xa0;
      if (lead === 0xed) hi = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      if (lead === 0xf0) lo = 0x90;
      if (lead === 0xf4) hi = 0x8f;
    } else return { start: i, end: i + 1, reason: "invalid start byte" };
    for (let k = 1; k <= need; k++) {
      if (i + k >= bytes.length) {
        return { start: i, end: bytes.length, reason: "unexpected end of data" };
      }
      const byte = bytes[i + k] as number;
      if (k === 1 ? byte < lo || byte > hi : byte < 0x80 || byte > 0xbf) {
        return { start: i, end: i + k, reason: "invalid continuation byte" };
      }
    }
    i += need + 1;
  }
  return null;
}

const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** `path.read_text(encoding="utf-8")`, failing with Python's OSError and UnicodeDecodeError texts. */
function readText(path: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw osError(error, path);
  }
  const bad = utf8Error(bytes);
  if (bad !== null) {
    const where =
      bad.end === bad.start + 1
        ? `byte 0x${(bytes[bad.start] as number).toString(16).padStart(2, "0")} in position ${bad.start}`
        : `bytes in position ${bad.start}-${bad.end - 1}`;
    throw pyError("UnicodeDecodeError", `'utf-8' codec can't decode ${where}: ${bad.reason}`);
  }
  return UTF8.decode(bytes);
}

/**
 * urllib.parse.urlsplit's scheme and path, and its hostname (lowercased). Throws ValueError
 * "Invalid IPv6 URL" where urlsplit does.
 */
function urlSplit(input: string): { scheme: string; path: string; hostname: string | null } {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: urlsplit strips C0 controls and space.
  let url = input.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith("//")) {
    const ends = ["/", "?", "#"].map((c) => url.indexOf(c, 2)).filter((i) => i >= 0);
    const delim = ends.length > 0 ? Math.min(...ends) : url.length;
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    const open = netloc.includes("[");
    const close = netloc.includes("]");
    if (open !== close) throw pyError("ValueError", "Invalid IPv6 URL");
    if (open) {
      const [before, , bracketed] = partition(netloc.slice(netloc.lastIndexOf("@") + 1), "[");
      const [, , port] = partition(bracketed, "]");
      if (before || (port && !port.startsWith(":"))) {
        throw pyError("ValueError", "Invalid IPv6 URL");
      }
    }
  }
  url = partition(url, "#")[0];
  url = partition(url, "?")[0];
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  const [beforeBracket, bracket, bracketed] = partition(hostinfo, "[");
  const host = bracket ? partition(bracketed, "]")[0] : partition(beforeBracket, ":")[0];
  if (!host) return { scheme, path: url, hostname: null };
  const [name, percent, zone] = partition(host, "%");
  return { scheme, path: url, hostname: name.toLowerCase() + percent + zone };
}

function isBilibiliHost(hostname: string): boolean {
  return hostname === "bilibili.com" || hostname.endsWith(".bilibili.com") || hostname === "b23.tv";
}

/**
 * What a list line stands for: the BV id of a BV id or a www.bilibili.com/bilibili.com video URL,
 * an http(s) URL of another site as written, else null. Bilibili's other hosts (m., space.,
 * b23.tv) stay null.
 */
export function listKey(value: string): string | null {
  if (BV_ID.test(value)) return value;
  const url = urlSplit(value.startsWith("//") ? `https:${value}` : value);
  if (url.hostname !== null && BILIBILI_HOSTS.has(url.hostname)) {
    return VIDEO_PATH.exec(url.path)?.[1] ?? null;
  }
  const other =
    (url.scheme === "http" || url.scheme === "https") &&
    url.hostname !== null &&
    !isBilibiliHost(url.hostname);
  return other ? value : null;
}

/**
 * The keys (listKey) of a list's lines, each once in first-seen order, skipping blanks and `#`
 * comments. Throws ValueError `<path>:<line>: expected a BV ID or Bilibili video URL` at the
 * first line that names neither.
 */
export function readIds(path: string): string[] {
  const ids = new Set<string>();
  splitlines(readText(path)).forEach((raw, i) => {
    const value = pyStrip(raw);
    if (!value || value.startsWith("#")) return;
    const key = listKey(value);
    if (key === null) {
      throw pyError("ValueError", `${path}:${i + 1}: expected a BV ID or Bilibili video URL`);
    }
    ids.add(key);
  });
  return [...ids];
}

function listed(dir: string, keep: (name: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return sortedPy(names.filter(keep)).map((name) => join(dir, name));
}

/** The hand-made lists: every `*.txt` directly in `listsDir`, sorted (dotfiles aren't lists). */
export function baselineLists(listsDir: string): string[] {
  return listed(listsDir, (name) => name.endsWith(".txt") && !name.startsWith("."));
}

/** Every batch, oldest first: `batches/videos-*.txt`. */
export function batchLists(listsDir: string): string[] {
  return listed(
    join(listsDir, BATCHES_DIR),
    (name) => name.startsWith("videos-") && name.endsWith(".txt"),
  );
}

/** Every key (listKey) in the lists and batches under `listsDir`. */
export function knownIds(listsDir: string): Set<string> {
  const known = new Set<string>();
  for (const path of [...baselineLists(listsDir), ...batchLists(listsDir)]) {
    for (const id of readIds(path)) known.add(id);
  }
  return known;
}

/** `captured` minus `known`, in capture order. */
export function newIds(captured: readonly string[], known: ReadonlySet<string>): string[] {
  return captured.filter((id) => !known.has(id));
}

/** `<batch>.done.json`, written once a pipeline run over the batch finished cleanly. */
export function batchDonePath(batchPath: string): string {
  return pyPathWithSuffix(batchPath, ".done.json");
}

/** The batches without their .done.json, oldest first. */
export function pendingBatches(listsDir: string): string[] {
  return batchLists(listsDir).filter((path) => !existsSync(batchDonePath(path)));
}

/** What `<batch>.done.json` holds. */
export interface BatchDone {
  /** ISO 8601. */
  readonly finishedAt: string;
  readonly ids: readonly string[];
  /** The video ids (audio stems) the batch's URLs produced. */
  readonly parts: readonly string[];
  readonly exitCode: number;
}

/** Marks `batchPath` done, atomically. */
export function writeBatchDone(batchPath: string, done: BatchDone): void {
  writeTextAtomic(batchDonePath(batchPath), `${JSON.stringify(done, null, 2)}\n`);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `datetime.now().astimezone().isoformat(timespec="seconds")`: local time and its offset. */
export function localIsoSeconds(now: Date): string {
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** A batch's file name for `now`, in local time: `videos-2026-09-08-100209.txt`. */
export function batchName(now: Date): string {
  return (
    `videos-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`
  );
}

/** A key as a batch line: a BV id becomes its video URL, another site's URL stays as it is. */
function batchLine(id: string): string {
  return BV_ID.test(id) ? `https://www.bilibili.com/video/${id}` : id;
}

/**
 * Writes a new batch of `ids` under `listsDir/batches`, named for `now`, with `header` as `# `
 * comment lines. Never overwrites: a batch already named for this second throws FileExistsError.
 */
export function writeBatch(
  listsDir: string,
  ids: readonly string[],
  header: readonly string[],
  now: Date,
): string {
  const dir = join(listsDir, BATCHES_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, batchName(now));
  const text = [...header.map((line) => `# ${line}\n`), ...ids.map((id) => `${batchLine(id)}\n`)];
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    throw osError(error, path);
  }
  try {
    writeSync(fd, text.join(""));
  } finally {
    closeSync(fd);
  }
  return path;
}

/** What laplace-prepare-batch prints, its keys in this order. */
export interface PrepareBatchResult {
  readonly captured_count: number;
  readonly known_count: number;
  readonly new_count: number;
  readonly new_ids: readonly string[];
  /** Computed before the new batch is written. */
  readonly pending_batches: readonly string[];
  readonly created_batch: string | null;
  readonly dry_run: boolean;
}

export interface PrepareBatchOptions {
  readonly dryRun?: boolean;
  /** Where the capture came from, for the batch's `# Source:` line; no such line without it. */
  readonly source?: string;
  readonly now?: Date;
}

/**
 * Checks that `capture` holds exactly `expectedCount` distinct videos, then writes the ones no list
 * under `listsDir` has yet into a new batch (unless dry-run). Throws a ValueError or an OSError.
 */
export function prepareBatch(
  listsDir: string,
  capture: string,
  expectedCount: number,
  opts: PrepareBatchOptions = {},
): PrepareBatchResult {
  const captured = readIds(capture);
  if (expectedCount < 1 || captured.length !== expectedCount) {
    throw pyError(
      "ValueError",
      `Archive coverage mismatch: captured ${captured.length} unique IDs, ` +
        `expected ${expectedCount}; no batch written`,
    );
  }
  if (baselineLists(listsDir).length === 0) {
    throw pyError("ValueError", `No prepared URL lists found in ${listsDir}; check --persona`);
  }
  const known = knownIds(listsDir);
  const pending = pendingBatches(listsDir);
  const fresh = newIds(captured, known);
  const dryRun = opts.dryRun ?? false;
  let created: string | null = null;
  if (fresh.length > 0 && !dryRun) {
    const now = opts.now ?? new Date();
    const header = [
      ...(opts.source === undefined ? [] : [`Source: ${opts.source}`]),
      `Captured: ${localIsoSeconds(now)}`,
      `Archive total: ${expectedCount}; new BV IDs: ${fresh.length}`,
    ];
    created = writeBatch(listsDir, fresh, header, now);
  }
  return {
    captured_count: captured.length,
    known_count: known.size,
    new_count: fresh.length,
    new_ids: fresh,
    pending_batches: pending,
    created_batch: created,
    dry_run: dryRun,
  };
}
