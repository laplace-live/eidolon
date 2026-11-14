// What a call asks this server before its media flows: the ICE servers, then the offer. Both go
// with the session's proof, which the offer needs beside the cookie.
import {
  type EidolonConnectOptions,
  fetchIceServers as fetchServers,
} from "@laplace.live/eidolon-sdk";
import type { ChatCallRequestData } from "@/lib/api";
import { proofHeaders } from "@/lib/proof";

/** The page's own origin: the SDK joins it to root-relative paths. */
const SAME_ORIGIN = "";
const OFFER_PATH = "/api/offer";
/** The Opus preset the bot encodes the call with, as the public page sends by default. */
const AUDIO_QUALITY = "medium";

/** An empty list is a valid answer: without TURN the bot offers host candidates. */
export function fetchIceServers(): Promise<RTCIceServer[]> {
  return fetchServers(SAME_ORIGIN, { credentials: "same-origin", headers: proofHeaders() });
}

/**
 * The offer; its trickled ICE candidates go with the same headers. Without a target, it calls the
 * active persona with no chat.
 */
export function offerOptions(target?: ChatCallRequestData): EidolonConnectOptions {
  return {
    endpoint: OFFER_PATH,
    headers: proofHeaders(),
    requestData:
      target === undefined
        ? { audioQuality: AUDIO_QUALITY }
        : { audioQuality: AUDIO_QUALITY, ...target },
  };
}
