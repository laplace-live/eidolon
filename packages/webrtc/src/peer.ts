// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/src/connection.ts@ce8f8bc, packages/transport-smallwebrtc/src/rtc.ts@ce8f8bc and packages/transport-smallwebrtc/src/transport.ts@ce8f8bc
//
// One caller's werift peer connection, as pipedog's SmallWebRTCConnection ran one (the answer,
// trickled candidates, restart_pc, the states a call sees), and a call's transport over it.
import { AsyncQueue, errorText, logger } from "@eidolon/config";
import type { ServerIceServer } from "@eidolon/turn";
import { RTCPeerConnection, RTCRtpCodecParameters, UdpTransport, useH264, useVP8 } from "werift";
import { AudioIn } from "./audio_in.ts";
import { AudioOut, type PcmSource } from "./audio_out.ts";
import { Channel, SIGNALLING_TYPE } from "./channel.ts";
import { OPUS_RTP_CLOCK_RATE, type OpusCodec } from "./opus.ts";
import { icePolicy } from "./patches.ts";

// werift's ICE sockets have no "error" listener. A UDP socket reports ICMP errors from earlier
// sends (`recvmsg ECONNREFUSED` on Linux under Bun, for a STUN check to a candidate nobody listens
// on) as an "error" event, which without a listener is an uncaught exception that kills the
// process. The symbol keeps a second evaluation of this module from patching again.
const UDP_PATCHED = Symbol.for("eidolon.werift.udp-patched");
const udp = UdpTransport.prototype as unknown as { init: (this: UdpTransport) => Promise<void> };
const udpInit = udp.init as typeof udp.init & { [UDP_PATCHED]?: boolean };
if (udpInit[UDP_PATCHED] !== true) {
  const init = async function (this: UdpTransport): Promise<void> {
    this.socket.on("error", (e: Error) => logger.debug(`ICE UDP socket error: ${e.message}`));
    return udpInit.call(this);
  };
  (init as { [UDP_PATCHED]?: boolean })[UDP_PATCHED] = true;
  udp.init = init;
}

/**
 * The SCTP DATA chunk payload, so the worst-case datagram (SCTP 28 + DTLS/GCM ~29 + UDP 8 + IPv6
 * 40) fits a 1280-byte MTU, IPv6's minimum and Tailscale's default, with ~75 bytes to spare.
 */
const SCTP_MAX_CHUNK_SIZE = 1100;
/** The SCTP DATA chunk header plus the SCTP common header. */
const SCTP_OVERHEAD = 12 + 16;
/** A peer still connecting after this long is closed. */
const CONNECTION_TIMEOUT_MS = 60_000;
/** A ping this recent means the client is still there. */
const LIVENESS_MS = 3_000;

export interface PeerOptions {
  readonly iceServers: readonly ServerIceServer[];
  /** Encodes her audio and decodes the caller's; a restart's new peer keeps it. */
  readonly opusCodec: OpusCodec;
  /** Gathers and accepts relay candidates only. */
  readonly relayOnly: boolean;
}

/** A remote ICE candidate, as aiortc's RTCIceCandidate holds one. */
export interface IceCandidate {
  readonly component: number;
  readonly foundation: string;
  readonly ip: string;
  readonly port: number;
  readonly priority: number;
  readonly protocol: string;
  readonly type: string;
  readonly relatedAddress: string | null;
  readonly relatedPort: number | null;
  readonly tcpType: string | null;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

/** An `a=candidate` value, with or without the `candidate:` prefix. */
export function candidateFromSdp(sdp: string): IceCandidate {
  const bits = sdp
    .replace(/^(a=)?candidate:/, "")
    .trim()
    .split(/\s+/);
  if (bits.length < 8) throw new Error("SDP does not have enough properties");
  let relatedAddress: string | null = null;
  let relatedPort: number | null = null;
  let tcpType: string | null = null;
  for (let i = 8; i + 1 < bits.length; i += 2) {
    const [key, value] = [bits[i]!, bits[i + 1]!];
    if (key === "raddr") relatedAddress = value;
    else if (key === "rport") relatedPort = Number(value);
    else if (key === "tcptype") tcpType = value;
  }
  return {
    foundation: bits[0]!,
    component: Number(bits[1]),
    protocol: bits[2]!,
    priority: Number(bits[3]),
    ip: bits[4]!,
    port: Number(bits[5]),
    type: bits[7]!,
    relatedAddress,
    relatedPort,
    tcpType,
    sdpMid: null,
    sdpMLineIndex: null,
  };
}

/** The SDP of a candidate, without the `candidate:` prefix. */
export function candidateToSdp(c: IceCandidate): string {
  let sdp = `${c.foundation} ${c.component} ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`;
  if (c.relatedAddress !== null) sdp += ` raddr ${c.relatedAddress}`;
  if (c.relatedPort !== null) sdp += ` rport ${c.relatedPort}`;
  if (c.tcpType !== null) sdp += ` tcptype ${c.tcpType}`;
  return sdp;
}

interface PeerEvents {
  /** ICE and DTLS are up, and the call has asked to connect. */
  readonly connected: [];
  /** restart_pc, or ICE dropping: what came over the old peer stops until the next connected. */
  readonly disconnected: [];
  readonly closed: [];
  readonly "app-message": [message: unknown];
}

let peers = 0;

/** One caller's connection, which outlives restart_pc by building a new werift peer. */
export class Peer {
  readonly options: PeerOptions;
  readonly #name = `SmallWebRTCConnection#${peers++}`;
  readonly #listeners: { [E in keyof PeerEvents]: ((...args: PeerEvents[E]) => void)[] } = {
    connected: [],
    disconnected: [],
    closed: [],
    "app-message": [],
  };
  #pc!: RTCPeerConnection;
  #pcId!: string;
  #answer: { readonly sdp: string; readonly type: string } | null = null;
  #channel!: Channel;
  #audioIn: AudioIn | null = null;
  #audioOut: AudioOut | null = null;
  #unsubscribe: (() => void)[] = [];
  #connecting: ReturnType<typeof setTimeout> | null = null;
  readonly #pendingCandidates = new Set<Promise<void>>();
  /** App messages that came before connect(). */
  #pendingMessages: unknown[] = [];
  #connectInvoked = false;

  constructor(options: PeerOptions) {
    this.options = options;
    this.#build();
  }

  /** The werift peer connection; restart_pc replaces it. */
  get pc(): RTCPeerConnection {
    return this.#pc;
  }

  get pcId(): string {
    return this.#pcId;
  }

  on<E extends keyof PeerEvents>(event: E, listener: (...args: PeerEvents[E]) => void): void {
    this.#listeners[event].push(listener);
  }

  /** Answers the caller's offer, once ICE has gathered every candidate the answer carries. */
  async initialize(sdp: string, type: string): Promise<void> {
    await this.#answerOffer(sdp, type);
  }

  /** A new offer on this connection; `restartPc` answers it on a new werift peer. */
  async renegotiate(options: { sdp: string; type: string; restartPc?: boolean }): Promise<void> {
    logger.debug(`Renegotiating ${this.#pcId}`);
    if (options.restartPc) {
      this.#emit("disconnected");
      logger.debug("Closing old peer connection");
      // The old peer's closing is no hang-up.
      for (const unsubscribe of this.#unsubscribe) unsubscribe();
      await this.#close();
      this.#build();
    }
    await this.#answerOffer(options.sdp, options.type);
  }

  getAnswer(): { sdp: string; type: string; pc_id: string } | null {
    if (this.#answer === null) return null;
    return { sdp: this.#answer.sdp, type: this.#answer.type, pc_id: this.#pcId };
  }

  /**
   * A trickled candidate, or null for end-of-candidates. Resolving an mDNS (`.local`) host
   * candidate can take about a second, so those are added in the background, and an
   * end-of-candidates waits behind them.
   */
  async addIceCandidate(candidate: IceCandidate | null): Promise<void> {
    logger.debug(`Adding remote candidate: ${candidate ? candidate.ip : candidate}`);
    const pc = this.#pc;
    const add = (): Promise<void> =>
      pc.addIceCandidate(
        candidate === null
          ? null
          : {
              candidate: `candidate:${candidateToSdp(candidate)}`,
              sdpMid: candidate.sdpMid ?? undefined,
              sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
            },
      );
    const background = (run: () => Promise<void>): void => {
      const added = run()
        .catch((error: unknown) => {
          logger.warning(`RTCPeerConnection: cannot add ICE candidate: ${errorText(error)}`);
        })
        .finally(() => this.#pendingCandidates.delete(added));
      this.#pendingCandidates.add(added);
    };
    if (candidate?.ip.endsWith(".local")) {
      background(add);
    } else if (candidate === null && this.#pendingCandidates.size > 0) {
      const pending = [...this.#pendingCandidates];
      background(async () => {
        await Promise.allSettled(pending);
        await add();
      });
    } else {
      await add();
    }
  }

  /**
   * The call is ready: "connected" now if the peer is, else when it is, and the app messages that
   * came first. Later messages reach "app-message" as they come.
   */
  async connect(): Promise<void> {
    this.#connectInvoked = true;
    if (this.#pc.connectionState === "connected") this.#emit("connected");
    const pending = this.#pendingMessages;
    this.#pendingMessages = [];
    for (const message of pending) this.#emit("app-message", message);
  }

  /** Connected, and the client has pinged within 3 s (or never pings). */
  isConnected(): boolean {
    if (!this.#connectInvoked) return false;
    const pinged = this.#channel.lastPing;
    if (pinged === null) return this.#pc.connectionState === "connected";
    return performance.now() - pinged < LIVENESS_MS;
  }

  sendAppMessage(message: unknown): void {
    this.#channel.send(message);
  }

  /** Decodes the caller's audio to `onPcm` until the returned stop, or the peer's end. */
  receiveAudio(onPcm: (pcm: Int16Array) => void): () => void {
    const transceiver = this.#pc.getTransceivers()[0];
    if (transceiver === undefined) {
      logger.warning("No audio transceiver is available");
      return () => {};
    }
    if (this.#audioIn === null) {
      this.#audioIn = new AudioIn(this.options.opusCodec);
      this.#audioIn.listen(transceiver);
    }
    const audioIn = this.#audioIn;
    audioIn.start(onPcm);
    return () => audioIn.pause();
  }

  /** Sends `source` until the returned stop, or the peer's end; `live` as AudioOut.play's. */
  playAudio(source: PcmSource, live: () => boolean): () => void {
    const transceiver = this.#pc.getTransceivers()[0];
    if (transceiver === undefined) {
      logger.warning("Audio transceiver not found. Cannot replace audio track.");
      return () => {};
    }
    this.#audioOut ??= new AudioOut(transceiver.sender, this.options.opusCodec);
    return this.#audioOut.play(source, live);
  }

  /** Tells the client the bot left (peerLeft), then closes. */
  async disconnect(): Promise<void> {
    this.sendAppMessage({ type: SIGNALLING_TYPE, message: { type: "peerLeft" } });
    await this.#close();
  }

  #build(): void {
    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers.map((server) => ({
        urls: server.urls,
        ...(server.username !== null ? { username: server.username } : {}),
        ...(server.credential !== null ? { credential: server.credential } : {}),
      })),
      // With the balanced policy, the screen share's transceiver is left off the bundled
      // transport, so its packets never reach it.
      bundlePolicy: "max-bundle",
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: OPUS_RTP_CLOCK_RATE,
            channels: 2,
            parameters: "minptime=10;useinbandfec=1",
          }),
        ],
        // Never read, but offered, so the client's camera and screen sections are answered.
        video: [useVP8(), useH264()],
      },
      sctp: { mtu: SCTP_MAX_CHUNK_SIZE + SCTP_OVERHEAD },
      ...icePolicy(this.options.relayOnly),
    });
    logger.debug("Initializing new peer connection");
    this.#pc = pc;
    this.#pcId = `${this.#name}-${crypto.randomUUID().replaceAll("-", "")}`;
    this.#answer = null;
    this.#channel = new Channel((message) => this.#appMessage(message));
    this.#audioIn = null;
    this.#audioOut = null;
    this.#pendingMessages = [];
    this.#unsubscribe = [
      pc.onDataChannel.subscribe((channel) => this.#channel.attach(channel)),
      pc.connectionStateChange.subscribe((state) => this.#stateChanged(state)),
      pc.iceConnectionStateChange.subscribe((state) => {
        logger.debug(`ICE connection state is ${state}, connection is ${pc.connectionState}`);
      }),
      pc.iceGatheringStateChange.subscribe((state) => {
        logger.debug(`ICE gathering state is ${state}`);
      }),
    ].map((subscription) => () => subscription.unSubscribe());
  }

  async #answerOffer(sdp: string, type: string): Promise<void> {
    const pc = this.#pc;
    await pc.setRemoteDescription({ sdp, type: type as "offer" });
    // The answering side doesn't take the transceivers to sendrecv on its own: the camera's audio
    // and video send and receive, the rest only receive.
    pc.getTransceivers().forEach((transceiver, i) => {
      transceiver.setDirection(i < 2 ? "sendrecv" : "recvonly");
    });
    logger.debug("Creating answer");
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== "complete") {
      await pc.iceGatheringStateChange.watch((state) => state === "complete");
    }
    const local = pc.localDescription;
    this.#answer = local === null ? null : { sdp: local.sdp, type: local.type };
  }

  #stateChanged(state: string): void {
    if (state === "connecting") this.#watchConnecting();
    else this.#stopWatchingConnecting();
    if (state === "connected") this.#channel.peerConnected();
    // Until the call is ready, it learns of the connection from connect().
    if (state === "connected" && !this.#connectInvoked) return;
    logger.debug(`Connection state changed to: ${state}`);
    if (state === "connected" || state === "disconnected" || state === "closed") this.#emit(state);
    if (state === "failed") {
      logger.warning("Connection failed, closing peer connection.");
      void this.#close();
    }
  }

  #watchConnecting(): void {
    this.#stopWatchingConnecting();
    this.#connecting = setTimeout(() => {
      logger.warning("Timeout establishing the connection to the remote peer. Closing.");
      void this.#close();
    }, CONNECTION_TIMEOUT_MS);
  }

  #stopWatchingConnecting(): void {
    if (this.#connecting !== null) clearTimeout(this.#connecting);
    this.#connecting = null;
  }

  #appMessage(message: unknown): void {
    if (this.#connectInvoked) {
      this.#emit("app-message", message);
      return;
    }
    logger.debug("Client not connected. Queuing app-message.");
    this.#pendingMessages.push(message);
  }

  async #close(): Promise<void> {
    this.#pendingMessages = [];
    this.#stopWatchingConnecting();
    this.#audioIn?.stop();
    this.#audioOut?.stop();
    this.#channel.close();
    try {
      await this.#pc.close();
    } catch (error) {
      logger.warning(`[WebRTC] Closing a peer failed: ${errorText(error)}`);
    }
  }

  #emit<E extends keyof PeerEvents>(event: E, ...args: PeerEvents[E]): void {
    for (const listener of [...this.#listeners[event]]) {
      try {
        listener(...args);
      } catch (error) {
        logger.error(`[WebRTC] A "${event}" listener failed: ${errorText(error)}`, error);
      }
    }
  }
}

/**
 * A call's transport: `@eidolon/voice`'s CallTransport, matched by shape, since only
 * packages/runtime may import the voice engine. Built before `connect()`.
 */
export interface PeerCall {
  /** 16 kHz mono, from whichever werift peer is current. */
  readonly audioIn: AsyncIterable<Int16Array>;
  attachSpeaker(source: PcmSource): void;
  readonly messages: AsyncIterable<unknown>;
  send(message: Readonly<Record<string, unknown>>): void;
  connect(): Promise<void>;
  /** Resolves when the peer closes, the server's shutdown included, but not after disconnect(). */
  readonly closed: Promise<"client">;
  /** Sends peerLeft, then closes. */
  disconnect(): Promise<void>;
}

/** `peer` as a call's transport. */
export function peerCallTransport(peer: Peer): PeerCall {
  return new PeerCallTransport(peer);
}

class PeerCallTransport implements PeerCall {
  readonly #peer: Peer;
  readonly #audio = new AsyncQueue<Int16Array>();
  readonly #messages = new AsyncQueue<unknown>();
  readonly #left = Promise.withResolvers<"client">();
  readonly closed = this.#left.promise;
  #speaker: PcmSource | null = null;
  #stopIn: (() => void) | null = null;
  #stopOut: (() => void) | null = null;
  /** We disconnected: the peer's close that follows isn't the client leaving. */
  #closing = false;
  #over = false;

  constructor(peer: Peer) {
    this.#peer = peer;
    peer.on("connected", () => this.#connected());
    peer.on("disconnected", () => this.#stopAudio());
    peer.on("closed", () => this.#closed());
    peer.on("app-message", (message) => this.#messages.push(message));
  }

  get audioIn(): AsyncIterable<Int16Array> {
    return this.#audio;
  }

  get messages(): AsyncIterable<unknown> {
    return this.#messages;
  }

  attachSpeaker(source: PcmSource): void {
    this.#speaker = source;
  }

  send(message: Readonly<Record<string, unknown>>): void {
    if (!this.#closing) this.#peer.sendAppMessage(message);
  }

  connect(): Promise<void> {
    return this.#peer.connect();
  }

  async disconnect(): Promise<void> {
    if (this.#closing || this.#over) return;
    this.#closing = true;
    try {
      await this.#peer.disconnect();
    } finally {
      this.#end();
    }
  }

  #connected(): void {
    if (this.#over) return;
    this.#stopAudio();
    this.#stopIn = this.#peer.receiveAudio((pcm) => this.#audio.push(pcm));
    const speaker = this.#speaker;
    // While the client sends no ping, her audio waits instead of playing to no one (D10).
    if (speaker !== null) {
      this.#stopOut = this.#peer.playAudio(speaker, () => this.#peer.isConnected());
    }
  }

  #stopAudio(): void {
    this.#stopIn?.();
    this.#stopOut?.();
    this.#stopIn = null;
    this.#stopOut = null;
  }

  #closed(): void {
    const left = !this.#closing;
    this.#end();
    if (left) this.#left.resolve("client");
  }

  #end(): void {
    if (this.#over) return;
    this.#over = true;
    this.#stopAudio();
    this.#audio.close();
    this.#messages.close();
  }
}
