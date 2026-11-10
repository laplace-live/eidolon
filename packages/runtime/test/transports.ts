// What the signalling and loopback tests read of @eidolon/webrtc's peers, and how they stand in
// for a peer's negotiation.
import { spyOn } from "bun:test";
import type { AllowedOffer } from "@eidolon/access";
import type { IceService } from "@eidolon/turn";
import * as webrtc from "@eidolon/webrtc";
import type { RTCPeerConnection as WeriftPeer } from "werift";
import type { AnyCallBinding } from "../src/native/binding.ts";

/** The peer the server builds per caller, as the tests read it. */
export interface Connection {
  readonly pcId: string;
  disconnect(): Promise<void>;
}

/** A trickled candidate as a peer's addIceCandidate takes it. */
export interface Candidate {
  readonly ip: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

export interface ServerDeps {
  startSession(
    connection: Connection,
    admission: AllowedOffer,
    binding?: AnyCallBinding,
  ): Promise<void>;
  candidates?: webrtc.CandidateRules;
  opusCodec?: webrtc.OpusCodec;
}

/** Stands in for a connection's answering and trickling, so no werift peer negotiates. */
export interface ConnectionHooks {
  initialize(connection: Connection, sdp: string): Promise<{ sdp: string; type: string }>;
  renegotiate(
    connection: Connection,
    options: { sdp: string; type: string; restartPc?: boolean },
  ): Promise<void>;
  addIceCandidate(candidate: Candidate | null): Promise<void>;
}

/** What closeWhenDtlsCloses watches: a werift peer's state and DTLS transports. */
export type DtlsPeer = webrtc.DtlsClosable["pc"];

export interface Transport {
  createServer(
    options: { ice: Pick<IceService, "serverPlan"> },
    deps: ServerDeps,
  ): webrtc.SignallingServer<AnyCallBinding>;
  /** The class the server builds a peer of, for spying on its prototype. */
  readonly Connection: { readonly prototype: Connection };
  /** Mocks every connection's answering and trickling; returns what restores them. */
  mock(hooks: ConnectionHooks): () => void;
  /** An error the server answers with its own status. */
  httpError(status: number, detail: string): Error;
  /** The werift peer a connection runs on now. */
  werift(connection: Connection): WeriftPeer;
  /** Makes `peer` the werift peer `connection` runs on, as restart_pc does. */
  replaceWerift(connection: Connection, peer: DtlsPeer): void;
  relayOnly(connection: Connection): boolean;
  opusCodec(connection: Connection): webrtc.OpusCodec;
  iceServers(connection: Connection): { urls: unknown; username: unknown; credential: unknown }[];
}

export const transport: Transport = {
  createServer: (options, deps) =>
    webrtc.createSignallingServerWith<AnyCallBinding>(options, {
      startSession: deps.startSession,
      ...(deps.candidates ? { candidates: deps.candidates } : {}),
      ...(deps.opusCodec ? { opusCodec: deps.opusCodec } : {}),
    }),
  Connection: webrtc.Peer,
  mock(hooks) {
    const proto = webrtc.Peer.prototype;
    const answers = new WeakMap<webrtc.Peer, { sdp: string; type: string }>();
    const spies = [
      spyOn(proto, "initialize").mockImplementation(async function (
        this: webrtc.Peer,
        sdp: string,
      ) {
        answers.set(this, await hooks.initialize(this, sdp));
      }),
      spyOn(proto, "getAnswer").mockImplementation(function (this: webrtc.Peer) {
        const answer = answers.get(this);
        return answer === undefined ? null : { ...answer, pc_id: this.pcId };
      }),
      spyOn(proto, "renegotiate").mockImplementation(function (this: webrtc.Peer, options) {
        return hooks.renegotiate(this, options);
      }),
      spyOn(proto, "addIceCandidate").mockImplementation((candidate) =>
        hooks.addIceCandidate(candidate),
      ),
    ];
    return () => {
      for (const spy of spies) spy.mockRestore();
    };
  },
  httpError: (status, detail) => new webrtc.HttpError(status, detail),
  werift: (connection) => (connection as webrtc.Peer).pc,
  replaceWerift(connection, peer) {
    Object.defineProperty(connection, "pc", { value: peer, configurable: true });
  },
  relayOnly: (connection) => (connection as webrtc.Peer).options.relayOnly,
  opusCodec: (connection) => (connection as webrtc.Peer).options.opusCodec,
  iceServers: (connection) =>
    (connection as webrtc.Peer).options.iceServers.map(({ urls, username, credential }) => ({
      urls,
      username,
      credential,
    })),
};
