// What a call asks this server before its media flows: the ICE servers, then the offer. Both go
// with the session's proof, which the offer needs beside the cookie.
import type { APIRequest } from "@pipecat-ai/client-js";
import { proofHeaders } from "@/lib/proof";

const OFFER_PATH = "/api/offer";
const ICE_SERVERS_PATH = "/api/ice-servers";
/** The Opus preset the bot encodes the call with, as the public page sends by default. */
const AUDIO_QUALITY = "medium";

/** An empty list is a valid answer: without TURN the bot offers host candidates. */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  const response = await fetch(ICE_SERVERS_PATH, {
    credentials: "same-origin",
    headers: proofHeaders(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  const servers =
    typeof body === "object" && body !== null
      ? (body as { iceServers?: unknown }).iceServers
      : null;
  if (!Array.isArray(servers)) throw new Error("malformed response");
  return servers;
}

/** The transport's offer request; its trickled ICE candidates go with the same headers. */
export function offerRequest(): APIRequest {
  return {
    endpoint: OFFER_PATH,
    headers: new Headers(proofHeaders()),
    requestData: { audioQuality: AUDIO_QUALITY },
  };
}
