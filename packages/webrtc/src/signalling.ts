// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/src/request_handler.ts@ce8f8bc and packages/transport-smallwebrtc/src/http.ts@ce8f8bc
//
// POST and PATCH /api/offer: per-offer ICE servers and Opus bitrate, and the relay-only candidate
// rules for offers and PATCHes alike.
import type { AllowedOffer } from "@eidolon/access";
import { logger } from "@eidolon/config";
import type { IceService } from "@eidolon/turn";
import { libopusWasmCodec, type OpusCodec, opusCodecAtBitrate } from "./opus.ts";
import { type CandidateRules, closeWhenDtlsCloses, TURN_CANDIDATE_RULES } from "./patches.ts";
import { candidateFromSdp, type IceCandidate, Peer } from "./peer.ts";

/** An HTTP answer for apps/bot to serialize as JSON (it adds CORS). */
export interface SignallingResult {
  readonly status: number;
  readonly body: unknown;
}

export interface SignallingServer<B = never> {
  /**
   * POST /api/offer after the guard admitted it. A new peer starts a call in the background, bound
   * to `binding` when there is one.
   */
  offer(admission: AllowedOffer, binding?: B): Promise<SignallingResult>;
  /**
   * PATCH /api/offer: trickled ICE candidates, the only way the browser's arrive (it offers before
   * gathering). Invalid JSON or a non-object → 400 `{detail: "Invalid WebRTC request: …"}`, a
   * non-string pc_id → 400, an unknown pc_id → 404 `{detail: "Peer connection not found"}`, else
   * 200 `{status: "success"}`. On a relay-only peer, candidates a relay can't reach are dropped
   * first (end-of-candidates kept).
   */
  patch(bodyText: string): Promise<SignallingResult>;
  readonly activeSessions: number;
  /** Disconnects every peer; apps/bot calls it at shutdown. */
  close(): Promise<void>;
}

export interface SignallingDeps<B = never> {
  /** Runs one call to its end. Must never reject. */
  startSession(peer: Peer, admission: AllowedOffer, binding?: B): Promise<void>;
  /** The codec every peer's encoders wrap; libopus-wasm otherwise. */
  opusCodec?: OpusCodec;
  candidates?: CandidateRules;
}

/** An answer other than 200 or 500, as pipedog's HTTPException carried one. */
export class HttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

function invalidRequest(reason: string): SignallingResult {
  return { status: 400, body: { detail: `Invalid WebRTC request: ${reason}` } };
}

/** pipedog http.js's mapping: an HttpError keeps its status, anything else is a 500. */
function failure(e: unknown): SignallingResult {
  if (e instanceof HttpError) return { status: e.status, body: { detail: e.detail } };
  logger.error(`SmallWebRTC signalling error: ${e}`);
  return { status: 500, body: { detail: "Internal Server Error" } };
}

function logDropped(host: string): void {
  logger.debug(`[WebRTC] Dropping unroutable remote candidate: ${host}`);
}

/**
 * The signalling server over werift peers. Browsers advertise LAN, CGNAT, Tailscale and mDNS
 * addresses next to the routable ones. A relay can reach none of them, Cloudflare answers a
 * permission request for one with a bare 401, and werift serializes CreatePermission on one queue
 * per allocation, so each one delays the routable peer's permission: relay-only peers drop them
 * from offers and PATCHes alike.
 */
export function createSignallingServerWith<B = never>(
  options: { ice: Pick<IceService, "serverPlan"> },
  deps: SignallingDeps<B>,
): SignallingServer<B> {
  const rules = deps.candidates ?? TURN_CANDIDATE_RULES;
  /** Every pc_id a peer answered under, restart_pc's old ones included. */
  const peers = new Map<string, Peer>();
  const sessions = new Set<Promise<void>>();

  const withoutUnreachable = (sdp: string): string => {
    const kept = rules.dropUnreachableCandidates(sdp);
    for (const host of kept.dropped) logDropped(host);
    return kept.sdp;
  };

  const forget = (peer: Peer): void => {
    for (const [id, known] of peers) if (known === peer) peers.delete(id);
  };

  /** The peer's answer, under its pc_id from now on, its relay addresses scrubbed. */
  const answered = (peer: Peer): { sdp: string; type: string; pc_id: string } => {
    const answer = peer.getAnswer();
    if (answer === null) throw new Error("SmallWebRTC connection produced no SDP answer");
    peers.set(answer.pc_id, peer);
    return { ...answer, sdp: rules.scrubRelayRelatedAddresses(answer.sdp) };
  };

  const startSession = (peer: Peer, admission: AllowedOffer, binding: B | undefined): void => {
    // The answer goes out first; the call runs on its own.
    const session = Promise.resolve()
      .then(() => deps.startSession(peer, admission, binding))
      .catch((error: unknown) => {
        logger.error(`webrtc_connection_callback failed for peer ${peer.pcId}: ${error}`);
      });
    sessions.add(session);
    void session.finally(() => sessions.delete(session));
  };

  return {
    async offer(admission, binding) {
      const body = admission.body;
      if (body === null) return invalidRequest(`${new Error("expected a JSON object")}`);
      const { sdp, type } = body;
      if (typeof sdp !== "string" || typeof type !== "string") {
        return invalidRequest("sdp and type are required");
      }
      try {
        const existing = typeof body.pc_id === "string" ? peers.get(body.pc_id) : undefined;
        if (existing !== undefined) {
          // A renegotiation, restart_pc included, keeps the ICE servers, codec and policy its
          // peer was built with. Waiting on a TURN mint here would hold a restart's answer while
          // the browser's trickled candidates land on the peer the restart is about to replace.
          logger.info(`Reusing existing connection for pc_id: ${body.pc_id}`);
          const restartPc = Boolean(body.restart_pc);
          await existing.renegotiate({
            sdp: existing.options.relayOnly ? withoutUnreachable(sdp) : sdp,
            type,
            restartPc,
          });
          // restart_pc built a new werift peer; the watch was on the one it replaced.
          if (restartPc) closeWhenDtlsCloses(existing);
          return { status: 200, body: answered(existing) };
        }
        const plan = await options.ice.serverPlan();
        const turn = plan.iceServers.find((server) => server.urls === plan.turnUrl);
        if (!plan.relayOnly && turn !== undefined && !(turn.username && turn.credential)) {
          logger.warning("[WebRTC] TURN server has no credentials; relay-only gathering is off");
        }
        const peer = new Peer({
          iceServers: plan.iceServers,
          opusCodec: opusCodecAtBitrate(
            deps.opusCodec ?? libopusWasmCodec,
            admission.opusBitrateBps,
          ),
          relayOnly: plan.relayOnly,
        });
        await peer.initialize(plan.relayOnly ? withoutUnreachable(sdp) : sdp, type);
        peer.on("closed", () => {
          logger.info(`Discarding peer connection for pc_id: ${peer.pcId}`);
          forget(peer);
        });
        closeWhenDtlsCloses(peer);
        startSession(peer, admission, binding);
        return { status: 200, body: answered(peer) };
      } catch (e) {
        return failure(e);
      }
    },

    async patch(bodyText) {
      let body: Record<string, unknown>;
      try {
        // Request.json()'s parser, so a 400's detail reads as pipedog's handler would word it.
        const parsed: unknown = await new Response(bodyText).json();
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("expected a JSON object");
        }
        body = parsed as Record<string, unknown>;
      } catch (e) {
        return invalidRequest(`${e}`);
      }
      try {
        if (typeof body.pc_id !== "string") return invalidRequest("pc_id is required");
        const peer = peers.get(body.pc_id);
        if (peer === undefined) throw new HttpError(404, "Peer connection not found");
        const trickled = ((body.candidates ?? []) as Record<string, unknown>[]).map((c) => ({
          candidate: c.candidate as string,
          sdpMid: c.sdp_mid as string,
          sdpMLineIndex: c.sdp_mline_index as number,
        }));
        for (const { candidate, sdpMid, sdpMLineIndex } of trickled) {
          if (!candidate) {
            // An empty candidate is an RFC 8840 end-of-candidates marker (Firefox sends one per
            // media line), which werift takes as null.
            await peer.addIceCandidate(null);
            continue;
          }
          if (peer.options.relayOnly && !rules.candidateReachable(candidate)) {
            logDropped(candidateFromSdp(candidate).ip);
            continue;
          }
          const parsed: IceCandidate = { ...candidateFromSdp(candidate), sdpMid, sdpMLineIndex };
          await peer.addIceCandidate(parsed);
        }
        return { status: 200, body: { status: "success" } };
      } catch (e) {
        return failure(e);
      }
    },

    get activeSessions() {
      return sessions.size;
    },

    async close() {
      const all = new Set(peers.values());
      await Promise.all(
        [...all].map((peer) =>
          peer.disconnect().catch((error: unknown) => {
            logger.warning(`[WebRTC] Disconnecting ${peer.pcId} failed: ${error}`);
          }),
        ),
      );
      peers.clear();
    },
  };
}
