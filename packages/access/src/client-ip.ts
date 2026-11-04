import { envOptional, pyStrip } from "@eidolon/config";

/** The shared bucket for transports without a peer address. */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * `EIDOLON_REAL_IP_HEADER` (read per call) when set and present, else the peer address.
 *
 * Set the header (`cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`) behind a proxy;
 * `server.requestIP()` would otherwise be the proxy itself.
 */
export function resolveClientIp(headers: Headers, peerAddress: string | null | undefined): string {
  const name = pyStrip(envOptional("EIDOLON_REAL_IP_HEADER") ?? "").toLowerCase();
  if (name) {
    let value: string | null = null;
    try {
      value = headers.get(name);
    } catch {
      // Headers.get throws on a name that can't be a header (a space, non-ASCII); no request
      // can carry it, so it's absent.
    }
    // Headers.get joins repeated headers with ", ", so the first entry is the first header's.
    // Left-most X-Forwarded-For entry is the original client, but only trustworthy when the
    // proxy overwrites the header, as prod's Caddy does with CF-Connecting-IP.
    const first = value === null ? "" : pyStrip(value.split(",")[0] as string);
    if (first) return first;
  }
  return peerAddress ? peerAddress : UNKNOWN_CLIENT_IP;
}
