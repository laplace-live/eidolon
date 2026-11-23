// The update test's feed: the newer build's update files on loopback, as R2 serves a release's,
// from node:http. electron-updater reads latest*.yml, then downloads the file it names whole, or
// against the old version's blockmap in ranges, one a request: electron-builder.yml turns
// useMultipleRangeRequest off.
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pipeline } from "node:stream";

/** What latest*.yml says: its version, and the files its url: and path: keys name. */
export interface Manifest {
  readonly version: string | null;
  readonly files: readonly string[];
}

/** The manifest electron-updater reads on `platform`, from the "latest" channel. */
export function manifestName(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "latest-mac.yml" : "latest.yml";
}

/** A YAML scalar as electron-builder's manifests write one: plain, or quoted when it needs it. */
function scalar(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  return value;
}

/** latest*.yml, line by line as the upload job's sed reads it: flat keys, and files' url: items. */
export function readManifest(text: string): Manifest {
  let version: string | null = null;
  const files: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const top = /^version:\s*(.+?)\s*$/.exec(line);
    if (top !== null) version = scalar(top[1] as string);
    const file = /^\s*(?:-\s+)?(?:url|path):\s*(.+?)\s*$/.exec(line);
    if (file !== null) {
      const name = scalar(file[1] as string);
      if (!files.includes(name)) files.push(name);
    }
  }
  return { version, files };
}

/** The file electron-updater downloads from `manifest`: the zip on macOS, the setup on Windows. */
export function updateFile(manifest: Manifest, platform: NodeJS.Platform): string | null {
  const extension = platform === "darwin" ? ".zip" : ".exe";
  return manifest.files.find((name) => name.endsWith(extension)) ?? null;
}

/**
 * What electron-updater asks the feed for beside the manifest: each file it names, the update's
 * blockmap, and the old version's, whose name it makes by putting the old version wherever the
 * new one is in the update's.
 */
export function wantedNames(manifest: Manifest, update: string, oldVersion: string): string[] {
  const older =
    manifest.version === null ? update : update.replaceAll(manifest.version, oldVersion);
  return [...new Set([...manifest.files, `${update}.blockmap`, `${older}.blockmap`])];
}

const NEWER = /^latest[\w-]*\.yml$|\.(?:zip|dmg|exe|blockmap)$/;
const OLDER = /\.blockmap$/;

/**
 * The feed's files by name: the newer outputs' manifests, installers and blockmaps, and the older
 * outputs' blockmaps, which electron-updater compares to the newer one's for a differential
 * download. electron-builder's own files and the unpacked app stay out.
 */
export function feedFiles(oldOutputs: string, newOutputs: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const [folder, wanted] of [
    [newOutputs, NEWER],
    [oldOutputs, OLDER],
  ] as const) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !wanted.test(entry.name)) continue;
      if (files.has(entry.name)) {
        throw new Error(
          `${entry.name} is in both builds' outputs: were both built at the same version?`,
        );
      }
      files.set(entry.name, join(folder, entry.name));
    }
  }
  return files;
}

/** The part of a file a request asks for. */
export type ByteRange =
  | { readonly kind: "whole" }
  /** From `start` to `end`, both included. */
  | { readonly kind: "part"; readonly start: number; readonly end: number }
  /** Answered 416: past the end, several ranges, or nothing this feed reads as a range. */
  | { readonly kind: "refused" };

/**
 * A Range header's one range in a file of `size` bytes. A client that asks for parts never gets
 * the whole file instead, which electron-updater would write where the parts go.
 */
export function byteRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined) return { kind: "whole" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return { kind: "refused" };
  const [, first = "", last = ""] = match;
  if (first === "") {
    const length = Number(last);
    if (last === "" || length === 0 || size === 0) return { kind: "refused" };
    return { kind: "part", start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size || (last !== "" && Number(last) < start)) return { kind: "refused" };
  return { kind: "part", start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
}

/** The file a request's path names: its one segment, percent-decoded, without the query. */
export function requestedName(path: string): string | null {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  if (!pathname.startsWith("/")) return null;
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  return name === "" || name === "." || name === ".." || /[/\\]/.test(name) ? null : name;
}

/** One request the feed answered. */
export interface Served {
  readonly method: string;
  /** As the request sent it. */
  readonly path: string;
  /** The file it named, served or not; null for a path that names none. */
  readonly name: string | null;
  readonly range: string | null;
  readonly status: number;
  /** The body's bytes read from the file. */
  readonly bytes: number;
  /** False when the connection ended before the response did. */
  readonly complete: boolean;
}

export interface Feed {
  /** `http://127.0.0.1:<port>/`. */
  readonly url: string;
  /** Each request answered, in order. */
  readonly served: readonly Served[];
  close(): Promise<void>;
}

export interface FeedOptions {
  /** 0 for a free one. */
  readonly port?: number;
  readonly onServed?: (served: Served) => void;
}

function contentType(name: string): string {
  return name.endsWith(".yml") ? "text/yaml; charset=utf-8" : "application/octet-stream";
}

/** Serves `files`, by name, on 127.0.0.1: GET and HEAD, whole or one range a request. */
export async function startFeed(
  files: ReadonlyMap<string, string>,
  { port = 0, onServed }: FeedOptions = {},
): Promise<Feed> {
  const served: Served[] = [];
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    const name = requestedName(path);
    const range = request.headers.range ?? null;
    let bytes = 0;
    response.once("close", () => {
      const entry: Served = {
        method,
        path,
        name,
        range,
        status: response.statusCode,
        bytes,
        complete: response.writableFinished,
      };
      served.push(entry);
      onServed?.(entry);
    });
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const file = name === null ? undefined : files.get(name);
    if (name === null || file === undefined) {
      response.writeHead(404).end();
      return;
    }
    const size = statSync(file).size;
    const part = byteRange(request.headers.range, size);
    if (part.kind === "refused") {
      response.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    const [start, end] = part.kind === "part" ? [part.start, part.end] : [0, size - 1];
    const length = end - start + 1;
    response.writeHead(part.kind === "part" ? 206 : 200, {
      "accept-ranges": "bytes",
      "content-type": contentType(name),
      "content-length": length,
      ...(part.kind === "part" ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (method === "HEAD" || length === 0) {
      response.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    stream.on("data", (chunk) => {
      bytes += chunk.length;
    });
    // Either side ending early ends the other, a client's dropped connection included.
    pipeline(stream, response, () => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    throw new Error(`the feed can't listen on 127.0.0.1:${port}: ${(error as Error).message}`);
  }
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}/`,
    served,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What the feed served of `name`: whole, in ranges, only errors, or nothing. */
export function servedSummary(served: readonly Served[], name: string): string {
  const asked = served.filter((entry) => entry.name === name && entry.method === "GET");
  if (asked.length === 0) return `${name} never asked for`;
  const whole = asked.filter((entry) => entry.status === 200);
  const parts = asked.filter((entry) => entry.status === 206);
  const total = (entries: readonly Served[]) => size(entries.reduce((sum, e) => sum + e.bytes, 0));
  const said: string[] = [];
  if (whole.length > 0) {
    said.push(`whole${whole.length > 1 ? ` ${whole.length} times` : ""} (${total(whole)})`);
  }
  if (parts.length > 0) {
    said.push(`in ${parts.length} range${parts.length > 1 ? "s" : ""} (${total(parts)})`);
  }
  if (said.length === 0) said.push([...new Set(asked.map((entry) => entry.status))].join(", "));
  return `${name} ${said.join(" and ")}`;
}

/**
 * Whether the feed served `platform`'s first update as electron-updater should fetch it: the
 * manifest, then on Windows both blockmaps and the setup in ranges alone, diffed against the setup
 * the install cached; on macOS the zip, which a Mac has no copy of to diff against until it has
 * updated once.
 */
export function servedUpdate(
  served: readonly Served[],
  platform: NodeJS.Platform,
  files: {
    readonly manifest: string;
    readonly update: string;
    readonly blockmaps: readonly string[];
  },
): boolean {
  const answered = (name: string, statuses: readonly number[]) =>
    served.some(
      (entry) =>
        entry.method === "GET" &&
        entry.name === name &&
        statuses.includes(entry.status) &&
        entry.complete,
    );
  if (!answered(files.manifest, [200])) return false;
  if (platform === "darwin") return answered(files.update, [200, 206]);
  const whole = served.some(
    (entry) => entry.method === "GET" && entry.name === files.update && entry.status === 200,
  );
  return (
    files.blockmaps.every((name) => answered(name, [200])) &&
    answered(files.update, [206]) &&
    !whole
  );
}
