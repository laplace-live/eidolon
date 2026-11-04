import {
  CloudflareIceCache,
  cloudflareTurnKeyFromEnv,
  cloudflareTurnTtlFromEnv,
  type IcePayload,
} from "./cloudflare.ts";
import {
  browserIcePayload,
  type ServerIcePlan,
  type StaticIceEnv,
  serverIcePlan,
  staticIceFromEnv,
} from "./ice.ts";

/** One per process: `/api/ice-servers` and the signalling server share its credential cache. */
export interface IceService {
  /** Never rejects. */
  browserPayload(): Promise<IcePayload>;
  /** Never rejects. */
  serverPlan(): Promise<ServerIcePlan>;
}

export interface IceServiceOptions {
  readonly cache: Pick<CloudflareIceCache, "get">;
  readonly staticIce: StaticIceEnv;
}

export function createIceService(options: IceServiceOptions): IceService {
  const { cache, staticIce } = options;
  return {
    async browserPayload() {
      return browserIcePayload(await cache.get(), staticIce);
    },
    async serverPlan() {
      return serverIcePlan(await cache.get(), staticIce);
    },
  };
}

/** Reads the Cloudflare key, TTL and static ICE env once, when called. */
export function iceServiceFromEnv(options?: {
  fetch?: typeof fetch;
  now?: () => number;
}): IceService {
  return createIceService({
    cache: new CloudflareIceCache({
      key: cloudflareTurnKeyFromEnv(),
      ttlSec: cloudflareTurnTtlFromEnv(),
      fetch: options?.fetch,
      now: options?.now,
    }),
    staticIce: staticIceFromEnv(),
  });
}
