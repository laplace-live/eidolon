// A native call's transport: first over a peer whose events the test fires, then over a real werift
// peer offering to the signalling server as small-webrtc's client does.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type RTCDataChannel,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpTransceiver,
  useVP8,
} from "werift";
import { AudioIn } from "../src/audio_in.ts";
import { AudioOut, type PcmSource } from "../src/audio_out.ts";
import { libopusWasmCodec } from "../src/opus.ts";
import { type Peer, type PeerCall, peerCallTransport } from "../src/peer.ts";
import { createSignallingServerWith, type SignallingServer } from "../src/signalling.ts";
import {
  admission,
  CAN_DIAL,
  captureLogs,
  type LogCapture,
  loud,
  ToneSource,
  until,
} from "./support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

/** The part of a Peer the transport uses, its events fired by the test. */
class FakePeer {
  readonly #listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  live = true;
  readonly sent: unknown[] = [];
  /** App messages that came before connect(), which it delivers. */
  readonly pending: unknown[] = [];
  disconnects = 0;
  /** What receiveAudio was handed, while it receives. */
  onPcm: ((pcm: Int16Array) => void) | null = null;
  /** What playAudio was handed, while it plays. */
  playing: { source: PcmSource; live: () => boolean } | null = null;
  plays = 0;

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }

  async connect(): Promise<void> {
    this.fire("connected");
    for (const message of this.pending.splice(0)) this.fire("app-message", message);
  }

  async disconnect(): Promise<void> {
    this.disconnects++;
    this.sent.push({ type: "signalling", message: { type: "peerLeft" } });
    this.fire("closed");
  }

  sendAppMessage(message: unknown): void {
    this.sent.push(message);
  }

  isConnected(): boolean {
    return this.live;
  }

  receiveAudio(onPcm: (pcm: Int16Array) => void): () => void {
    this.onPcm = onPcm;
    return () => {
      this.onPcm = null;
    };
  }

  playAudio(source: PcmSource, live: () => boolean): () => void {
    this.plays++;
    this.playing = { source, live };
    return () => {
      this.playing = null;
    };
  }
}

function transportOn(peer: FakePeer): PeerCall {
  return peerCallTransport(peer as unknown as Peer);
}

async function take<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const taken: T[] = [];
  if (count === 0) return taken;
  for await (const item of iterable) {
    taken.push(item);
    if (taken.length === count) break;
  }
  return taken;
}

async function ended(iterable: AsyncIterable<unknown>): Promise<boolean> {
  for await (const _ of iterable) return false;
  return true;
}

describe("a native call's transport on a peer", () => {
  test("the client's messages reach the call in order, those connect() delivers first", async () => {
    const peer = new FakePeer();
    peer.pending.push({ type: "client-ready" });
    const transport = transportOn(peer);
    await transport.connect();
    peer.fire("app-message", { type: "send-text" });
    expect(await take(transport.messages, 2)).toEqual([
      { type: "client-ready" },
      { type: "send-text" },
    ]);
  });

  test("send() goes out through sendAppMessage", () => {
    const peer = new FakePeer();
    transportOn(peer).send({ label: "rtvi-ai", type: "bot-ready" });
    expect(peer.sent).toEqual([{ label: "rtvi-ai", type: "bot-ready" }]);
  });

  test("on connected, the caller's audio reaches audioIn, and the Speaker plays while she pings", async () => {
    const peer = new FakePeer();
    const transport = transportOn(peer);
    const speaker = new ToneSource(24_000);
    transport.attachSpeaker(speaker);
    await transport.connect();
    peer.onPcm?.(new Int16Array(320).fill(3));
    peer.onPcm?.(new Int16Array(320).fill(4));
    expect(await take(transport.audioIn, 2)).toEqual([
      new Int16Array(320).fill(3),
      new Int16Array(320).fill(4),
    ]);
    expect(peer.playing?.source).toBe(speaker);
    expect(peer.playing?.live()).toBe(true);
    peer.live = false;
    expect(peer.playing?.live()).toBe(false);
  });

  test("restart_pc: what came over the old peer stops, and the next connected takes up the new", async () => {
    const peer = new FakePeer();
    const transport = transportOn(peer);
    transport.attachSpeaker(new ToneSource(24_000));
    await transport.connect();
    peer.fire("disconnected");
    expect(peer.onPcm).toBeNull();
    expect(peer.playing).toBeNull();
    peer.fire("connected");
    expect(peer.plays).toBe(2);
    peer.onPcm?.(new Int16Array(320).fill(9));
    expect(await take(transport.audioIn, 1)).toEqual([new Int16Array(320).fill(9)]);
  });

  test("the client leaving resolves closed and ends the call's streams", async () => {
    const peer = new FakePeer();
    const transport = transportOn(peer);
    transport.attachSpeaker(new ToneSource(24_000));
    await transport.connect();
    peer.fire("closed");
    expect(await transport.closed).toBe("client");
    expect(peer.playing).toBeNull();
    expect(await ended(transport.messages)).toBe(true);
    expect(await ended(transport.audioIn)).toBe(true);
  });

  test("disconnect(): peerLeft goes out once, closed stays pending, and nothing more is sent", async () => {
    const peer = new FakePeer();
    const transport = transportOn(peer);
    await transport.connect();
    let closed = false;
    void transport.closed.then(() => {
      closed = true;
    });
    await transport.disconnect();
    await transport.disconnect();
    transport.send({ type: "bot-llm-text" });
    await Bun.sleep(10);
    expect(peer.disconnects).toBe(1);
    expect(peer.sent).toEqual([{ type: "signalling", message: { type: "peerLeft" } }]);
    expect(closed).toBe(false);
    expect(await ended(transport.messages)).toBe(true);
    expect(await ended(transport.audioIn)).toBe(true);
  });

  test("after the client left, disconnect() closes nothing again", async () => {
    const peer = new FakePeer();
    const transport = transportOn(peer);
    await transport.connect();
    peer.fire("closed");
    await transport.disconnect();
    expect(peer.disconnects).toBe(0);
  });
});

const OPUS = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48_000,
  channels: 2,
  parameters: "minptime=10;useinbandfec=1",
});

/** small-webrtc's client, on werift: an audio and a camera section, the "chat" channel. */
class Client {
  readonly pc = new RTCPeerConnection({
    iceServers: [],
    codecs: { audio: [OPUS], video: [useVP8()] },
  });
  readonly audio: RTCRtpTransceiver;
  readonly channel: RTCDataChannel;
  readonly received: string[] = [];
  /** Her audio, decoded at 16 kHz. */
  readonly heard: Int16Array[] = [];
  #mic: AudioOut | null = null;

  constructor() {
    this.audio = this.pc.addTransceiver("audio", { direction: "sendrecv" });
    this.pc.addTransceiver("video", { direction: "sendrecv" });
    this.channel = this.pc.createDataChannel("chat");
    this.channel.onMessage.subscribe((data) => this.received.push(String(data)));
  }

  /** Offers to `server` and takes its answer; returns the pc_id. */
  async offer(server: SignallingServer, fields: Record<string, unknown> = {}): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await until(() => this.pc.iceGatheringState === "complete", 5000);
    const result = await server.offer(
      admission({ sdp: this.pc.localDescription?.sdp, type: "offer", ...fields }),
    );
    expect(result.status).toBe(200);
    const answer = result.body as { sdp: string; pc_id: string };
    await this.pc.setRemoteDescription({ sdp: answer.sdp, type: "answer" });
    const her = new AudioIn(libopusWasmCodec);
    her.listen(this.audio);
    her.start((pcm) => this.heard.push(pcm));
    return answer.pc_id;
  }

  /** Says `source` through the mic as Opus. */
  speak(source: PcmSource): void {
    this.#mic ??= new AudioOut(this.audio.sender, libopusWasmCodec);
    this.#mic.play(source, () => true);
  }

  async close(): Promise<void> {
    this.#mic?.stop();
    await this.pc.close();
  }
}

describe.skipIf(!CAN_DIAL)("against a real peer", () => {
  let server: SignallingServer;
  let peers: Peer[];
  let transports: PeerCall[];
  let clients: Client[];

  beforeEach(() => {
    peers = [];
    transports = [];
    clients = [];
    server = createSignallingServerWith(
      { ice: { serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }) } },
      {
        startSession: async (peer) => {
          peers.push(peer);
          transports.push(peerCallTransport(peer));
        },
        candidates: {
          dropUnreachableCandidates: (sdp) => ({ sdp, dropped: [] }),
          candidateReachable: () => true,
          scrubRelayRelatedAddresses: (sdp) => sdp,
        },
      },
    );
  });

  afterEach(async () => {
    for (const client of clients) await client.close();
    await server.close();
    await Bun.sleep(20);
  });

  /** A client's call, connected, with the transport its offer built, playing a tone. */
  async function call() {
    const client = new Client();
    clients.push(client);
    await client.offer(server);
    await until(() => transports.length === 1, 4000);
    const transport = transports[0] as PeerCall;
    // Sent before the channel opens: it waits for the channel.
    transport.send({ label: "rtvi-ai", type: "bot-ready", id: "early" });
    transport.attachSpeaker(new ToneSource(24_000));
    await transport.connect();
    await until(() => client.channel.readyState === "open", 8000);
    return { client, transport };
  }

  test("messages and audio cross the wire both ways, and disconnect() sends peerLeft", async () => {
    const { client, transport } = await call();
    await until(() => client.received.length > 0, 4000);
    expect(JSON.parse(client.received[0] as string)).toEqual({
      label: "rtvi-ai",
      type: "bot-ready",
      id: "early",
    });
    // Pings and the signalling envelope never reach the call.
    client.channel.send("ping: 1");
    client.channel.send(JSON.stringify({ type: "signalling", message: { type: "trackStatus" } }));
    const ready = { label: "rtvi-ai", type: "client-ready", id: "c1", data: { version: "2.3.0" } };
    client.channel.send(JSON.stringify(ready));
    expect(await take(transport.messages, 1)).toEqual([ready]);

    // Her tone reaches the client.
    await until(() => client.heard.some(loud), 8000);

    // The caller's tone reaches the call, at 16 kHz in 20 ms frames.
    client.speak(new ToneSource(48_000));
    let heardCaller: Int16Array | null = null;
    for await (const pcm of transport.audioIn) {
      if (loud(pcm)) {
        heardCaller = pcm;
        break;
      }
    }
    expect(heardCaller?.length).toBe(320);

    await transport.disconnect();
    const peerLeft = JSON.stringify({ type: "signalling", message: { type: "peerLeft" } });
    await until(() => client.received.includes(peerLeft), 4000);
  }, 20_000);

  test("the server closing ends the call as the client's leaving", async () => {
    const { transport } = await call();
    await server.close();
    expect(await transport.closed).toBe("client");
  }, 20_000);

  test("a client that stops pinging for 3 s has her audio wait, unread", async () => {
    const { client } = await call();
    client.channel.send("ping: 1");
    await Bun.sleep(100);
    expect(peers[0]?.isConnected()).toBe(true);
    await Bun.sleep(3_000);
    expect(peers[0]?.isConnected()).toBe(false);
    const heard = client.heard.length;
    await until(() => client.heard.length >= heard + 10, 4000);
    expect(client.heard.slice(heard + 5).some(loud)).toBe(false);
  }, 20_000);

  test("restart_pc: the call goes on over the new peer, its candidates trickled to the old pc_id", async () => {
    const { client, transport } = await call();
    const pcId = peers[0]!.pcId;
    const restarted = new Client();
    clients.push(restarted);
    const newId = await restarted.offer(server, { pc_id: pcId, restart_pc: true });
    expect(newId).not.toBe(pcId);
    // The old peer closed as it was replaced: the browser hanging it up now ends nothing.
    await client.close();
    expect(transports).toHaveLength(1);
    await until(() => restarted.channel.readyState === "open", 8000);
    const again = { label: "rtvi-ai", type: "send-text", id: "c2", data: { content: "hi" } };
    restarted.channel.send(JSON.stringify(again));
    expect(await take(transport.messages, 1)).toEqual([again]);
    await until(() => restarted.heard.some(loud), 8000);
    expect(
      await server.patch(JSON.stringify({ pc_id: pcId, candidates: [{ candidate: "" }] })),
    ).toEqual({ status: 200, body: { status: "success" } });
  }, 30_000);
});
