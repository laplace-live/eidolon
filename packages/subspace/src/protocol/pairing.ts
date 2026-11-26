import { z } from "zod";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64Url,
  utf8Decode,
  utf8Encode,
} from "./encoding.ts";

export const PAIRING_SCHEME = "eidolon";
export const PAIRING_HOST = "pair";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isValidDirectHost(host: string): boolean {
  if (/[\s/@?#]/.test(host)) return false;
  if (/^[A-Za-z0-9.-]+$/.test(host)) return true;
  if (!/^(?:\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:.]+)$/.test(host) || !host.includes(":")) {
    return false;
  }
  const bracketed = host.startsWith("[") ? host : `[${host}]`;
  try {
    new URL(`http://${bracketed}`);
    return true;
  } catch {
    return false;
  }
}

function isAllowedRelayUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
  if (parsed.protocol === "http:" || parsed.protocol === "ws:") {
    return LOOPBACK_HOSTS.has(parsed.hostname);
  }
  return false;
}

export const DirectEndpointSchema = z.object({
  host: z.string().trim().min(1).max(255).refine(isValidDirectHost, "Invalid direct endpoint host"),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean().optional(),
});

export const RelayEndpointSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .refine(isAllowedRelayUrl, "Relay URL must use https/wss or loopback http/ws"),
  relayHostId: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
});

export const SubspacePairingOfferSchema = z
  .object({
    v: z.literal(1),
    mode: z.enum(["direct", "relay"]),
    hostName: z.string().trim().min(1).max(120),
    hostPublicKeyB64: z.string().min(1),
    ticket: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    expiresAt: z.number().int().positive(),
    endpoint: DirectEndpointSchema.optional(),
    relay: RelayEndpointSchema.optional(),
  })
  .superRefine((offer, ctx) => {
    try {
      if (base64ToBytes(offer.hostPublicKeyB64).byteLength !== 32) {
        ctx.addIssue({
          code: "custom",
          path: ["hostPublicKeyB64"],
          message: "hostPublicKeyB64 must be a 32-byte X25519 public key",
        });
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["hostPublicKeyB64"],
        message: "hostPublicKeyB64 is not valid base64",
      });
    }
    if (offer.mode === "direct" && offer.endpoint === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "direct pairing offer requires endpoint",
      });
    }
    if (offer.mode === "relay" && offer.relay === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["relay"],
        message: "relay pairing offer requires relay",
      });
    }
  });

export type DirectEndpoint = z.infer<typeof DirectEndpointSchema>;
export type RelayEndpoint = z.infer<typeof RelayEndpointSchema>;
export type SubspacePairingOffer = z.infer<typeof SubspacePairingOfferSchema>;

export function encodePairingCode(offer: SubspacePairingOffer): string {
  const checked = SubspacePairingOfferSchema.parse(offer);
  return bytesToBase64Url(utf8Encode(JSON.stringify(checked)));
}

export function encodePairingUrl(offer: SubspacePairingOffer): string {
  return `${PAIRING_SCHEME}://${PAIRING_HOST}?code=${encodePairingCode(offer)}`;
}

export function isPairingExpired(
  offer: Pick<SubspacePairingOffer, "expiresAt">,
  nowMs = Date.now(),
): boolean {
  return offer.expiresAt <= nowMs;
}

export type ParsePairingResult =
  | { readonly ok: true; readonly offer: SubspacePairingOffer; readonly code: string }
  | { readonly ok: false; readonly reason: "invalid-format" | "invalid-code" };

/** Parses either an `eidolon://pair?code=...` URL or a bare base64url pairing code. */
export function parsePairingInput(rawInput: string): ParsePairingResult {
  const trimmed = rawInput.trim();
  if (trimmed === "") return { ok: false, reason: "invalid-format" };
  let code = trimmed;
  if (trimmed.includes("://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, reason: "invalid-format" };
    }
    const target = `${url.host}${url.pathname}`.replace(/\/+$/, "");
    if (
      url.protocol !== `${PAIRING_SCHEME}:` ||
      (target !== PAIRING_HOST && url.pathname !== `/${PAIRING_HOST}`)
    ) {
      return { ok: false, reason: "invalid-format" };
    }
    const param = url.searchParams.get("code")?.trim() ?? "";
    if (param === "") return { ok: false, reason: "invalid-code" };
    code = param;
  }
  try {
    const json = utf8Decode(base64UrlToBytes(code));
    const parsed = SubspacePairingOfferSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return { ok: false, reason: "invalid-code" };
    return { ok: true, offer: parsed.data, code };
  } catch {
    return { ok: false, reason: "invalid-code" };
  }
}
