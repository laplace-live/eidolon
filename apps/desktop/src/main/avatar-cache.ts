// On-disk cache of 256x256 PNG notification avatars fetched from the ready local backend,
// keyed by speaker and group peers and stored by content SHA-256 so native notification APIs
// read real local PNG files without holding auth tokens or decoding WebP.
import { hash, randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
  #failing = false;

  constructor(options: AvatarCacheOptions) {
    this.#options = options;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
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

      const sha = hash("sha256", bytes, "hex");
      const filePath = join(this.#options.folder, `${sha}.png`);
      if (!(await fileExists(filePath))) {
        await mkdir(this.#options.folder, { recursive: true });
        await writeAtomic(filePath, bytes);
      }

      await this.#remember(key, filePath);
      return filePath;
    } catch (error) {
      if (!this.#failing) {
        this.#failing = true;
        this.#options.log.warn(
          `Eidolon: notifications couldn't read an avatar: ${errorDetail(error)}`,
        );
      }
      const fallback = this.#paths.get(key);
      return fallback !== undefined && (await fileExists(fallback)) ? fallback : null;
    }
  }

  async #remember(key: string, filePath: string): Promise<void> {
    this.#paths.delete(key);
    this.#paths.set(key, filePath);
    const evict: string[] = [];
    while (this.#paths.size > this.#maxEntries) {
      const oldest = this.#paths.entries().next().value as [string, string] | undefined;
      if (oldest === undefined) break;
      this.#paths.delete(oldest[0]);
      // Keep the file if another active key (e.g. two personas using the fallback silhouette) shares it.
      if (![...this.#paths.values()].includes(oldest[1])) evict.push(oldest[1]);
    }
    await Promise.all(evict.map((path) => rm(path, { force: true }).catch(() => {})));
  }
}
