// werift, like aiortc, uses only the first STUN and the first TURN URL it is given, so the bot's
// own list is chosen here. Browsers use every URL Cloudflare returns.
import { envOptional } from "@eidolon/config";
import type { IcePayload } from "./cloudflare.ts";

export interface StaticIceEnv {
  readonly stunUrl: string | undefined;
  readonly turnUrl: string | undefined;
  readonly turnUsername: string | undefined;
  readonly turnCredential: string | undefined;
}

/** WEBRTC_STUN_URL, WEBRTC_TURN_URL, WEBRTC_TURN_USERNAME and WEBRTC_TURN_CREDENTIAL. */
export function staticIceFromEnv(): StaticIceEnv {
  return {
    stunUrl: envOptional("WEBRTC_STUN_URL"),
    turnUrl: envOptional("WEBRTC_TURN_URL"),
    turnUsername: envOptional("WEBRTC_TURN_USERNAME"),
    turnCredential: envOptional("WEBRTC_TURN_CREDENTIAL"),
  };
}

/**
 * Cloudflare's payload verbatim, else the static env servers.
 *
 * An empty list is a valid answer: with no TURN the bot keeps host candidates, so a localhost
 * browser connects without any server.
 */
export function browserIcePayload(cf: IcePayload | null, staticIce: StaticIceEnv): IcePayload {
  if (cf !== null) return cf;
  const servers: Record<string, unknown>[] = [];
  if (staticIce.stunUrl) servers.push({ urls: [staticIce.stunUrl] });
  if (staticIce.turnUrl) {
    servers.push({
      urls: [staticIce.turnUrl],
      username: staticIce.turnUsername ?? "",
      credential: staticIce.turnCredential ?? "",
    });
  }
  return { iceServers: servers };
}

/**
 * Whether `candidate` is a better TURN URL for us than `current`.
 *
 * TCP wins over UDP, which is not the usual advice — UDP is the better media transport. It is
 * about what Cloudflare will relay: measured between this host and a client on a UDP-blocked
 * network, a TCP allocation delivers to a UDP one, but a UDP allocation never receives from a TCP
 * one. Since the restricted clients are exactly the ones who need a relay, allocating over TCP is
 * what lets their checks arrive. Both legs still run over Cloudflare's backbone.
 */
export function preferTurnUrl(candidate: string, current: string): boolean {
  return candidate.includes("transport=tcp") && !current.includes("transport=tcp");
}

/** Whether werift's ICE server parser accepts `url` as a TURN server; it skips any other. */
export function isUsableTurnUrl(url: string): boolean {
  const matched = /^(stun|stuns|turn|turns):(.+)$/i.exec(url.trim());
  const scheme = matched?.[1]?.toLowerCase();
  if (scheme !== "turn" && scheme !== "turns") return false;
  const rest = matched?.[2] as string;
  const prefixed = rest.split("?", 1)[0] as string;
  const authority = prefixed.startsWith("//") ? prefixed.slice(2) : prefixed;
  if (authority === "" || (authority.startsWith("[") && !authority.includes("]"))) return false;
  const transport = new URLSearchParams(rest.split("?")[1] ?? "").get("transport");
  if (transport === null || transport === "tcp") return true;
  return transport === "udp" && scheme === "turn";
}

export interface ServerIceServer {
  readonly urls: string;
  readonly username: string | null;
  readonly credential: string | null;
}

/** What the server's own peer connection uses: at most one STUN and one TURN (TCP preferred). */
export interface ServerIcePlan {
  readonly iceServers: readonly ServerIceServer[];
  /** Relay-only gathering; true only when a TURN URL with credentials is present. */
  readonly relayOnly: boolean;
  readonly turnUrl: string | null;
}

interface Choice {
  readonly stun: string | null;
  readonly turn: ServerIceServer | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function chooseCloudflare(cf: IcePayload): Choice {
  let stun: string | null = null;
  let turn: ServerIceServer | null = null;
  const entries = Array.isArray(cf.iceServers) ? (cf.iceServers as unknown[]) : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const { urls, username, credential } = entry as Record<string, unknown>;
    const list = typeof urls === "string" ? [urls] : Array.isArray(urls) ? urls : [];
    for (const url of list) {
      if (typeof url !== "string") continue;
      if (stun === null && url.startsWith("stun:")) {
        stun = url;
      } else if (url.startsWith("turn:") || url.startsWith("turns:")) {
        if (turn === null || preferTurnUrl(url, turn.urls)) {
          turn = {
            urls: url,
            username: stringOrNull(username),
            credential: stringOrNull(credential),
          };
        }
      }
    }
  }
  return { stun, turn };
}

function chooseStatic(staticIce: StaticIceEnv): Choice {
  return {
    stun: staticIce.stunUrl || null,
    turn: staticIce.turnUrl
      ? {
          urls: staticIce.turnUrl,
          username: staticIce.turnUsername ?? null,
          credential: staticIce.turnCredential ?? null,
        }
      : null,
  };
}

/**
 * At most one STUN and one TURN server, and whether to gather relay candidates only.
 *
 * Logs nothing; runtime warns about a TURN server without credentials, once per new connection.
 */
export function serverIcePlan(cf: IcePayload | null, staticIce: StaticIceEnv): ServerIcePlan {
  const { stun, turn } = cf !== null ? chooseCloudflare(cf) : chooseStatic(staticIce);
  const stunServers = stun === null ? [] : [{ urls: stun, username: null, credential: null }];
  // No TURN means relay-only would gather nothing at all, so leave those connections alone: a
  // local dev run with no TURN still works on host candidates, and a TURN outage degrades to
  // exposed rather than dead.
  if (turn === null) return { iceServers: stunServers, relayOnly: false, turnUrl: null };
  // werift's relay policy keeps host and srflx candidates out only when it can parse the TURN
  // URL and the entry carries a username and credential.
  if (isUsableTurnUrl(turn.urls) && turn.username && turn.credential) {
    return { iceServers: [turn], relayOnly: true, turnUrl: turn.urls };
  }
  return { iceServers: [...stunServers, turn], relayOnly: false, turnUrl: turn.urls };
}
