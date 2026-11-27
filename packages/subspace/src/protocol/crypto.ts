import { sha256Hex, utf8Encode } from "./encoding.ts";

/** Derives a domain-separated Relay invite token so the Relay never learns the raw E2EE pairing ticket. */
export function deriveRelayInviteToken(ticket: string): Promise<string> {
  return sha256Hex(utf8Encode(`eidolon-subspace-relay-invite-v1:${ticket}`));
}

/** Derives a domain-separated Relay device token so the Relay never learns the raw E2EE device token. */
export function deriveRelayDeviceToken(deviceToken: string): Promise<string> {
  return sha256Hex(utf8Encode(`eidolon-subspace-relay-device-v1:${deviceToken}`));
}
