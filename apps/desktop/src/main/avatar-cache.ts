// On-disk cache of 256x256 PNG notification avatars fetched from the ready local backend,
// keyed by speaker and group peers and stored by content SHA-256 so native notification APIs
// read real local PNG files without holding auth tokens or decoding WebP.
import { hash, randomBytes } from "node:crypto";
import { access, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SLUG_PATTERN } from "../shared/bridge.ts";

const DEFAULT_MAX_ENTRIES = 64;
const REQUEST_TIMEOUT_MS = 10_000;

export interface AvatarBackendResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type AvatarBackendFetch = (
  path: string,
  init: { readonly signal: AbortSignal },
) => Promise<AvatarBackendResponse>;

export interface AvatarCacheOptions {
  readonly folder: string;
  readonly fetch: AvatarBackendFetch;
  readonly log: { info(message: string): void; warn(message: string): void };
  readonly maxEntries?: number;
}

function errorDetail(error: unknown): string {
  const parts: string[] = [];
  for (let at = error; at !== undefined; at = at instanceof Error ? at.cause : undefined) {
    parts.push(at instanceof Error ? at.message : String(at));
  }
  return parts.join(": ");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, bytes);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function canonicalPeers(speakerId: string, groupPeers: readonly string[]): string[] | null {
  const peers: string[] = [];
  for (const peer of groupPeers) {
    if (!SLUG_PATTERN.test(peer)) return null;
    if (peer !== speakerId && !peers.includes(peer)) peers.push(peer);
    if (peers.length === 2) break;
  }
  return peers;
}

export class NotificationAvatarCache {
  readonly #options: AvatarCacheOptions;
  readonly #maxEntries: number;
  /** Query key (`speaker|peer1,peer2`) → cached PNG file path, oldest-used first. */
  readonly #paths = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<string | null>>();
  /** Pre-existing `.png` paths from prior launches, oldest mtime first, not yet in `#paths`. */
  readonly #staleFiles: string[] = [];
  #pruned = false;
  #io: Promise<void> = Promise.resolve();
  #failing = false;

  constructor(options: AvatarCacheOptions) {
    this.#options = options;
    this.#maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  /**
   * Fetches and caches the 256x256 circular PNG for `speakerId` (and up to two `groupPeers`),
   * returning a local `.png` path or null when unavailable. Fails open and logs once per streak.
   */
  async resolve(
    speakerId: string,
    groupPeers: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!SLUG_PATTERN.test(speakerId)) return null;
    const peers = canonicalPeers(speakerId, groupPeers);
    if (peers === null) return null;
    if (signal?.aborted) return null;

    const key = `${speakerId}|${peers.join(",")}`;
    let pending = this.#inflight.get(key);
    if (pending === undefined) {
      pending = this.#fetchAndStore(key, speakerId, peers).finally(() => {
        if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
      });
      this.#inflight.set(key, pending);
    }
    if (signal === undefined) return pending;

    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          onAbort = () => resolve(null);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  async #fetchAndStore(
    key: string,
    speakerId: string,
    peers: readonly string[],
  ): Promise<string | null> {
    const query = peers.length > 0 ? `?group=${peers.join(",")}` : "";
    const urlPath = `/api/local/personas/${speakerId}/notification-avatar${query}`;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      const response = await this.#options.fetch(urlPath, { signal: timeout });
      if (!response.ok) throw new Error(`GET ${urlPath} answered ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error(`GET ${urlPath} returned an empty body`);
      if (this.#failing) {
        this.#failing = false;
        this.#options.log.info("Eidolon: notifications read avatars again");
      }

      return await this.#commit(key, bytes);
    } catch (error) {
      if (!this.#failing) {
        this.#failing = true;
        this.#options.log.warn(
          `Eidolon: notifications couldn't read an avatar: ${errorDetail(error)}`,
        );
      }
      return await this.#inIo(async () => {
        const fallback = this.#paths.get(key);
        return fallback !== undefined && (await fileExists(fallback)) ? fallback : null;
      });
    }
  }

  async #inIo<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#io.then(work, work);
    this.#io = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #pruneFolderOnce(): Promise<void> {
    if (this.#pruned) return;
    this.#pruned = true;
    await mkdir(this.#options.folder, { recursive: true });
    const entries = await readdir(this.#options.folder, { withFileTypes: true });
    const pngs: { readonly path: string; readonly mtimeMs: number }[] = [];
    const temps: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = join(this.#options.folder, entry.name);
      if (entry.name.endsWith(".tmp")) temps.push(full);
      else if (entry.name.endsWith(".png")) {
        const info = await stat(full).catch(() => null);
        if (info !== null) pngs.push({ path: full, mtimeMs: info.mtimeMs });
      }
    }
    await Promise.all(temps.map((path) => rm(path, { force: true }).catch(() => {})));
    pngs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const item of pngs) this.#staleFiles.push(item.path);
  }

  async #commit(key: string, bytes: Uint8Array): Promise<string> {
    return await this.#inIo(async () => {
      await this.#pruneFolderOnce();
      const sha = hash("sha256", bytes, "hex");
      const filePath = join(this.#options.folder, `${sha}.png`);
      const staleIndex = this.#staleFiles.indexOf(filePath);
      if (staleIndex !== -1) this.#staleFiles.splice(staleIndex, 1);

      if (!(await fileExists(filePath))) await writeAtomic(filePath, bytes);

      const previous = this.#paths.get(key);
      this.#paths.delete(key);
      this.#paths.set(key, filePath);

      const candidates: string[] = [];
      if (previous !== undefined && previous !== filePath) candidates.push(previous);
      while (this.#paths.size > this.#maxEntries) {
        const oldest = this.#paths.entries().next().value as [string, string] | undefined;
        if (oldest === undefined) break;
        this.#paths.delete(oldest[0]);
        candidates.push(oldest[1]);
      }

      const active = new Set(this.#paths.values());
      const evict = new Set<string>();
      for (const path of candidates) {
        if (!active.has(path)) evict.add(path);
      }
      while (
        active.size + this.#staleFiles.length > this.#maxEntries &&
        this.#staleFiles.length > 0
      ) {
        const stale = this.#staleFiles.shift();
        if (stale !== undefined && !active.has(stale)) evict.add(stale);
      }
      await Promise.all([...evict].map((path) => rm(path, { force: true }).catch(() => {})));
      return filePath;
    });
  }
}
