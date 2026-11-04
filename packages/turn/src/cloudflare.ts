import {
  envInt,
  envOptional,
  httpxStatusMessage,
  isJsonObject,
  logger,
  pyTruthy,
} from "@eidolon/config";

export const CLOUDFLARE_TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
export const DEFAULT_CF_TURN_TTL_SEC = 3600;
// Refresh slightly before expiry so an in-flight credential never goes stale mid-call. Floor of
// 60s in case TTL is set very short for testing.
export const CF_REFRESH_MARGIN_SEC = 300;
export const CF_MIN_REFRESH_SEC = 60;
export const CF_MINT_TIMEOUT_MS = 10_000;

/** The browser's `/api/ice-servers` body: Cloudflare's payload verbatim, or the env fallback. */
export type IcePayload = Readonly<Record<string, unknown>>;

export interface CloudflareTurnKey {
  readonly keyId: string;
  readonly apiToken: string;
}

/** Null unless CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_KEY_API_TOKEN are both non-empty. */
export function cloudflareTurnKeyFromEnv(): CloudflareTurnKey | null {
  const keyId = envOptional("CLOUDFLARE_TURN_KEY_ID");
  const apiToken = envOptional("CLOUDFLARE_TURN_KEY_API_TOKEN");
  return keyId !== undefined && apiToken !== undefined ? { keyId, apiToken } : null;
}

export function cloudflareTurnTtlFromEnv(): number {
  return envInt("CLOUDFLARE_TURN_TTL_SEC", DEFAULT_CF_TURN_TTL_SEC);
}

export function cloudflareGenerateIceServersUrl(keyId: string): string {
  return `${CLOUDFLARE_TURN_API}/${keyId}/credentials/generate-ice-servers`;
}

function jsonKind(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

export interface MintOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** One mint; null after a WARNING on any failure. Never rejects; logs neither token nor credential. */
export async function mintCloudflareIce(
  key: CloudflareTurnKey,
  ttlSec: number,
  options: MintOptions = {},
): Promise<IcePayload | null> {
  const url = cloudflareGenerateIceServersUrl(key.keyId);
  let failure: string;
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: ttlSec }),
      // Like httpx's default: a 3xx is a failed mint, never a second request.
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? CF_MINT_TIMEOUT_MS),
    });
    if (response.ok) {
      const body: unknown = await response.json();
      if (isJsonObject(body)) return body;
      failure = `expected a JSON object, got ${jsonKind(body)}`;
    } else {
      failure = httpxStatusMessage(response, url, { spaceBeforeEmptyReason: true });
    }
  } catch (e) {
    failure = String(e);
  }
  logger.warning(`[WebRTC] Cloudflare TURN mint failed: ${failure}`);
  return null;
}

export interface CloudflareIceCacheOptions {
  /** Null when Cloudflare TURN is not configured: `get()` then resolves null without a request. */
  readonly key: CloudflareTurnKey | null;
  readonly ttlSec: number;
  readonly fetch?: typeof fetch;
  /** Seconds on a monotonic clock. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

const monotonicSeconds = (): number => performance.now() / 1000;

/** One per process: the browser payload and the bot's own ICE share these credentials. */
export class CloudflareIceCache {
  readonly #key: CloudflareTurnKey | null;
  readonly #ttlSec: number;
  readonly #mint: MintOptions;
  readonly #now: () => number;
  #cache: IcePayload | null = null;
  #expiry = 0;
  #inflight: Promise<IcePayload | null> | null = null;

  constructor(options: CloudflareIceCacheOptions) {
    this.#key = options.key;
    this.#ttlSec = options.ttlSec;
    this.#mint = { fetch: options.fetch, timeoutMs: options.timeoutMs };
    this.#now = options.now ?? monotonicSeconds;
  }

  /** Cached, freshly minted, stale, or null. Callers during a mint share its result. */
  get(): Promise<IcePayload | null> {
    const now = this.#now();
    // An empty `{}` is never a hit: the next call mints again instead of serving it until expiry.
    if (pyTruthy(this.#cache) && now < this.#expiry) return Promise.resolve(this.#cache);
    this.#inflight ??= this.#refresh(now).finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #refresh(now: number): Promise<IcePayload | null> {
    if (this.#key === null) return this.#cache;
    const fresh = await mintCloudflareIce(this.#key, this.#ttlSec, this.#mint);
    // Stale-on-failure: Cloudflare TURN keeps accepting a credential for ~30s past its expiry,
    // and a stale credential is strictly better than dropping the call. The expiry stays put,
    // so the next call mints again.
    if (fresh === null) return this.#cache;
    const refreshIn = Math.max(this.#ttlSec - CF_REFRESH_MARGIN_SEC, CF_MIN_REFRESH_SEC);
    this.#cache = fresh;
    this.#expiry = now + refreshIn;
    // refreshIn, not expiry - now: once the monotonic clock passes ~800 s, that difference rounds
    // to 3299.999… on about one mint in twenty and would log as 3299s.
    logger.info(
      `[WebRTC] Minted fresh Cloudflare TURN credentials (TTL ${this.#ttlSec}s, refresh in ${Math.trunc(refreshIn)}s)`,
    );
    return fresh;
  }
}
