// werift's three corrections for a call's peer (docs/typescript.md, "What keeps it working").
import { logger } from "@eidolon/config";
import {
  candidateReachable,
  dropUnreachableCandidates,
  scrubRelayRelatedAddresses,
} from "@eidolon/turn";

/** The part of a peer closeWhenDtlsCloses reads. */
export interface DtlsClosable {
  readonly pc: {
    readonly connectionState: string;
    readonly dtlsTransports: readonly {
      readonly state: string;
      readonly onStateChange: { subscribe(handler: (state: string) => void): unknown };
    }[];
  };
  disconnect(): Promise<void>;
}

// 1. aiortc closes a peer once every DTLS transport has closed, so a browser's pc.close() (its DTLS
// close_notify) ends the call at once. werift derives the connection state from ICE alone, so the
// call would run on, holding its STT and TTS sockets, until ICE consent expires ~30 s later.
export function closeWhenDtlsCloses(peer: DtlsClosable): void {
  const pc = peer.pc;
  let closing = false;
  for (const transport of pc.dtlsTransports) {
    transport.onStateChange.subscribe((state) => {
      if (closing || state !== "closed" || pc.connectionState === "closed") return;
      if (!pc.dtlsTransports.every((t) => t.state === "closed")) return;
      closing = true;
      peer.disconnect().catch((error: unknown) => {
        logger.warning(`[WebRTC] Closing a peer whose DTLS closed failed: ${error}`);
      });
    });
  }
}

/**
 * 2. Media never crosses Cloudflare's HTTP proxy, so the origin stays hidden only if every
 * candidate the answer advertises is a TURN relay. werift's "relay" policy gathers nothing but the
 * relay candidate, once the TURN server has a username and credential.
 */
export function icePolicy(relayOnly: boolean): { readonly iceTransportPolicy?: "relay" } {
  return relayOnly ? { iceTransportPolicy: "relay" } : {};
}

/** The SDP rules for relay-only peers. */
export interface CandidateRules {
  dropUnreachableCandidates(sdp: string): { sdp: string; dropped: string[] };
  candidateReachable(candidate: string): boolean;
  /**
   * 3. werift fills a relay candidate's `raddr` with the TURN server's XOR-MAPPED-ADDRESS, this
   * host's public IP: every answer is scrubbed to `raddr 0.0.0.0 rport 0`.
   */
  scrubRelayRelatedAddresses(sdp: string): string;
}

export const TURN_CANDIDATE_RULES: CandidateRules = {
  dropUnreachableCandidates,
  candidateReachable,
  scrubRelayRelatedAddresses,
};
