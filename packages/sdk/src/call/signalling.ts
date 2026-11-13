import type { APIRequest } from "@pipecat-ai/client-js";
import { type FetchLike, normalizeBaseUrl } from "../chat/client.ts";
import { isJsonObject } from "../chat/parse.ts";
import type { EidolonConnectOptions } from "./types.ts";

export interface FetchIceServersOptions {
  readonly headers?: HeadersInit;
  readonly credentials?: RequestCredentials;
  readonly signal?: AbortSignal;
  readonly fetch?: FetchLike;
}

/** Fetches the TURN/STUN servers minted by `GET /api/ice-servers` (an empty list is valid). */
export async function fetchIceServers(
  baseUrl: string,
  options: FetchIceServersOptions = {},
): Promise<RTCIceServer[]> {
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}/api/ice-servers`;
  const res = await (options.fetch ?? fetch)(url, {
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!res.ok) throw new Error(`ICE servers unavailable (HTTP ${res.status})`);
  const body: unknown = await res.json();
  const servers = isJsonObject(body) ? body.iceServers : null;
  if (!Array.isArray(servers)) {
    throw new Error("ICE servers unavailable (malformed response)");
  }
  return servers as RTCIceServer[];
}

type SerializableValue = Exclude<APIRequest["requestData"], undefined>;

/** Copies `value` into Pipecat's recursive JSON `Serializable` type exactly as `JSON.stringify` does. */
export function toSerializableRequestData(value: unknown): SerializableValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : toSerializableRequestData(item)));
  }
  if (typeof value !== "object") return null;
  const object: { [key: string]: SerializableValue } = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined && typeof field !== "function") {
      object[key] = toSerializableRequestData(field);
    }
  }
  return object;
}

export function toApiRequest(options: EidolonConnectOptions): APIRequest {
  return {
    endpoint: options.endpoint,
    ...(options.headers === undefined ? {} : { headers: new Headers(options.headers) }),
    ...(options.requestData === undefined
      ? {}
      : { requestData: toSerializableRequestData(options.requestData) }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  };
}
