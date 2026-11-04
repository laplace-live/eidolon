// Cloudflare TURN credentials, the ICE servers for the browser and for the bot's own peer
// connection, and the SDP candidate filter and scrub that keep a relay-only origin hidden.
export { relayCanReach } from "./address.ts";
export {
  candidateReachable,
  dropUnreachableCandidates,
  scrubRelayRelatedAddresses,
} from "./candidates.ts";
export {
  CF_MIN_REFRESH_SEC,
  CF_MINT_TIMEOUT_MS,
  CF_REFRESH_MARGIN_SEC,
  CLOUDFLARE_TURN_API,
  CloudflareIceCache,
  type CloudflareIceCacheOptions,
  type CloudflareTurnKey,
  cloudflareGenerateIceServersUrl,
  cloudflareTurnKeyFromEnv,
  cloudflareTurnTtlFromEnv,
  DEFAULT_CF_TURN_TTL_SEC,
  type IcePayload,
  type MintOptions,
  mintCloudflareIce,
} from "./cloudflare.ts";
export {
  browserIcePayload,
  isUsableTurnUrl,
  preferTurnUrl,
  type ServerIcePlan,
  type ServerIceServer,
  type StaticIceEnv,
  serverIcePlan,
  staticIceFromEnv,
} from "./ice.ts";
export {
  createIceService,
  type IceService,
  type IceServiceOptions,
  iceServiceFromEnv,
} from "./service.ts";
