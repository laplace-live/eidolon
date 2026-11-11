import { logger } from "@eidolon/config";
import {
  candidateReachable,
  dropUnreachableCandidates,
  type ServerIcePlan,
  scrubRelayRelatedAddresses,
} from "@eidolon/turn";
import {
  IceServer,
  type SmallWebRTCConnection,
  type SmallWebRTCConnectionOptions,
} from "@pipedog/transport-smallwebrtc/connection";
import type { OpusCodec } from "@pipedog/transport-smallwebrtc/opus";
import {
  SmallWebRTCPatchRequest,
  SmallWebRTCRequest,
  SmallWebRTCRequestHandler,
} from "@pipedog/transport-smallwebrtc/request_handler";
import { candidateFromSdp } from "@pipedog/transport-smallwebrtc/rtc";
import { Connection } from "werift";
import { opusCodecAtBitrate } from "./opus.ts";

// werift queries stun.l.google.com when a connection has no STUN server (ice.ts,
// applyStunTurnServersFromOptions), where aiortc and browsers gather no server-reflexive candidate
// at all. That candidate is this host's public IP, and where UDP to Google is blocked its 5 s
// timeout stalls every answer. Only a STUN server the plan names may be queried. @eidolon/webrtc's
// patches.ts patches the same werift under the same symbol, so whichever loads first patches.
const PATCHED = Symbol.for("eidolon.werift.patched");
const ice = Connection.prototype as Connection & Record<symbol, unknown>;
if (ice[PATCHED] !== true) {
  ice[PATCHED] = true;
  const gatherCandidates = ice.gatherCandidates;
  ice.gatherCandidates = function (this: Connection) {
    if (this.options.stunServer === undefined) this.stunServer = undefined;
    return gatherCandidates.call(this);
  };
}

/** The SDP rules for relay-only connections. */
export interface CandidateRules {
  dropUnreachableCandidates(sdp: string): { sdp: string; dropped: string[] };
  candidateReachable(candidate: string): boolean;
  scrubRelayRelatedAddresses(sdp: string): string;
}

export const TURN_CANDIDATE_RULES: CandidateRules = {
  dropUnreachableCandidates,
  candidateReachable,
  scrubRelayRelatedAddresses,
};

/** What one offer's connection is built with, if the offer creates one. */
export interface ConnectionPlan {
  readonly iceServers: IceServer[];
  readonly options: Omit<SmallWebRTCConnectionOptions, "iceServers">;
  readonly relayOnly: boolean;
  /** A TURN URL is configured without a username or credential, so werift won't relay. */
  readonly turnWithoutCredentials: boolean;
}

export function connectionPlan(
  plan: ServerIcePlan,
  opusBitrateBps: number,
  opusBase: OpusCodec,
): ConnectionPlan {
  const turn = plan.iceServers.find((server) => server.urls === plan.turnUrl);
  return {
    iceServers: plan.iceServers.map(
      (server) =>
        new IceServer({
          urls: server.urls,
          username: server.username,
          credential: server.credential,
        }),
    ),
    options: {
      opusCodec: opusCodecAtBitrate(opusBase, opusBitrateBps),
      // Media never crosses Cloudflare's HTTP proxy, so the origin stays hidden only if every
      // candidate we advertise is a TURN relay. werift's "relay" policy gathers nothing but the
      // relay candidate once the TURN server has a username and credential.
      ...(plan.relayOnly ? { werift: { iceTransportPolicy: "relay" } } : {}),
    },
    relayOnly: plan.relayOnly,
    turnWithoutCredentials:
      !plan.relayOnly && turn !== undefined && !(turn.username && turn.credential),
  };
}

function logDropped(host: string): void {
  logger.debug(`[WebRTC] Dropping unroutable remote candidate: ${host}`);
}

/** The part of a pipedog connection that closeWhenDtlsCloses reads. */
export interface DtlsClosable {
  readonly pc: {
    readonly native: {
      readonly connectionState: string;
      readonly dtlsTransports: readonly {
        readonly state: string;
        readonly onStateChange: { subscribe(handler: (state: string) => void): unknown };
      }[];
    };
  };
  disconnect(): Promise<void>;
}

// aiortc closes a peer once every DTLS transport has closed, so a browser's pc.close() (its DTLS
// close_notify) ends the session at once. werift derives the connection state from ICE alone, so
// the session would run on, holding its STT and TTS sockets, until ICE consent expires ~30 s later.
export function closeWhenDtlsCloses(connection: DtlsClosable): void {
  const peer = connection.pc.native;
  let closing = false;
  for (const transport of peer.dtlsTransports) {
    transport.onStateChange.subscribe((state) => {
      if (closing || state !== "closed" || peer.connectionState === "closed") return;
      if (!peer.dtlsTransports.every((t) => t.state === "closed")) return;
      closing = true;
      connection.disconnect().catch((error: unknown) => {
        logger.warning(`[WebRTC] Closing a peer whose DTLS closed failed: ${error}`);
      });
    });
  }
}

/**
 * pipedog's handler, with per-offer connection options and the relay-only candidate rules.
 *
 * Browsers advertise LAN, CGNAT, Tailscale and mDNS addresses next to the routable ones. A relay
 * can reach none of them, Cloudflare answers a permission request for one with a bare 401, and
 * werift serializes CreatePermission on one queue per allocation, so each one delays the
 * routable peer's permission. Relay-only connections drop them from offers and PATCHes alike.
 */
export class EidolonRequestHandler extends SmallWebRTCRequestHandler {
  readonly #rules: CandidateRules;
  readonly #relayOnly = new WeakSet<SmallWebRTCConnection>();

  constructor(rules: CandidateRules = TURN_CANDIDATE_RULES) {
    super();
    this.#rules = rules;
  }

  /**
   * Answers `request`. Only an offer that builds a connection resolves a plan: a renegotiation,
   * restart_pc included, keeps the ICE servers, codec and policy its connection was built with.
   * Waiting on a TURN mint there would hold a restart's answer while the browser's trickled
   * candidates land on the peer the restart is about to replace.
   */
  async handleOffer(
    request: SmallWebRTCRequest,
    resolvePlan: () => Promise<ConnectionPlan>,
    onConnection: (connection: SmallWebRTCConnection) => void,
  ): Promise<{ sdp: string; type: string; pc_id: string }> {
    // handleWebRequest looks the pc_id up before its first await, so with no await before that
    // call, the connection found here is the one it renegotiates.
    const existing = request.pcId ? this._pcsMap.get(request.pcId) : undefined;
    if (existing !== undefined) {
      const offer = this.#relayOnly.has(existing) ? this.#withoutUnreachable(request) : request;
      const answer = await super.handleWebRequest(offer, onConnection);
      // restart_pc built a new werift peer; the watch was on the one it replaced.
      if (request.restartPc) closeWhenDtlsCloses(existing);
      return { ...answer, sdp: this.#rules.scrubRelayRelatedAddresses(answer.sdp) };
    }
    const plan = await resolvePlan();
    if (plan.turnWithoutCredentials) {
      logger.warning("[WebRTC] TURN server has no credentials; relay-only gathering is off");
    }
    const offer = plan.relayOnly ? this.#withoutUnreachable(request) : request;
    // handleWebRequest constructs a new connection from these two fields before its first
    // await, so nothing may await between here and that call: a concurrent offer would swap them.
    this._iceServers = plan.iceServers;
    this._connectionOptions = plan.options;
    const answer = await super.handleWebRequest(offer, (connection) => {
      if (plan.relayOnly) this.#relayOnly.add(connection);
      closeWhenDtlsCloses(connection);
      onConnection(connection);
    });
    return { ...answer, sdp: this.#rules.scrubRelayRelatedAddresses(answer.sdp) };
  }

  override async handlePatchRequest(request: SmallWebRTCPatchRequest): Promise<void> {
    const connection = this._pcsMap.get(request.pcId);
    if (connection === undefined || !this.#relayOnly.has(connection)) {
      await super.handlePatchRequest(request);
      return;
    }
    const candidates = request.candidates.filter((c) => {
      // An empty candidate is the end-of-candidates signal and must always pass through.
      if (!c.candidate || this.#rules.candidateReachable(c.candidate)) return true;
      logDropped(candidateFromSdp(c.candidate).ip);
      return false;
    });
    await super.handlePatchRequest(new SmallWebRTCPatchRequest({ pcId: request.pcId, candidates }));
  }

  #withoutUnreachable(request: SmallWebRTCRequest): SmallWebRTCRequest {
    const { sdp, dropped } = this.#rules.dropUnreachableCandidates(request.sdp);
    for (const host of dropped) logDropped(host);
    return new SmallWebRTCRequest({
      sdp,
      type: request.type,
      pcId: request.pcId,
      restartPc: request.restartPc,
      requestData: request.requestData,
    });
  }
}
