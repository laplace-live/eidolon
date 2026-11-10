// The native engine's phase-1 transport over pipedog's connection: first against a connection whose
// events the test fires, then against a real werift peer offering to the signalling server.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import type { AllowedOffer } from "@eidolon/access";
import type { CallTransport, Pcm, PcmSource } from "@eidolon/voice";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import {
  AudioFrame,
  MediaStreamError,
  RemoteStreamTrack,
} from "@pipedog/transport-smallwebrtc/media";
import {
  type RTCDataChannel,
  type RTCIceServer,
  RTCPeerConnection,
} from "@pipedog/transport-smallwebrtc/rtc";
import { RawAudioTrack } from "@pipedog/transport-smallwebrtc/transport";
import { pipedogCallTransport, type SpeakerTrack } from "../../src/native/transport_pipedog.ts";
import { createSignallingServerWith, type SignallingServer } from "../../src/webrtc/signalling.ts";
import { captureLogs, type LogCapture, until } from "../support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

/** An input track whose frames the test queues; `end()` kills it as a closed peer does. */
class FakeInputTrack {
  readonly remote = new RemoteStreamTrack("audio");
  format: [number, number] | null = null;
  recvs = 0;

  setAudioOutputFormat(sampleRate: number, channels: number): void {
    this.format = [sampleRate, channels];
  }

  isEnabled(): boolean {
    return true;
  }

  recv(): Promise<unknown> {
    this.recvs++;
    return this.remote.recv();
  }

  push(frame: AudioFrame): void {
    this.remote._queue.putNowait(frame);
  }

  end(): void {
    this.remote._queue.putNowait(null);
  }
}

/** The part of SmallWebRTCConnection the transport uses, its events fired by the test. */
class FakeConnection {
  readonly #handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  live = true;
  input: FakeInputTrack | null = new FakeInputTrack();
  readonly sent: unknown[] = [];
  readonly outputs: unknown[] = [];
  /** App messages that came before connect(), which it flushes. */
  readonly pending: unknown[] = [];
  disconnects = 0;

  eventHandler(name: string, handler: (...args: unknown[]) => unknown): void {
    this.#handlers.set(name, [...(this.#handlers.get(name) ?? []), handler]);
  }

  fire(name: string, ...args: unknown[]): void {
    for (const handler of this.#handlers.get(name) ?? []) handler(this, ...args);
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

  audioInputTrack(): FakeInputTrack | null {
    return this.input;
  }

  readonly wrapped: string[] = [];

  videoInputTrack(): null {
    this.wrapped.push("camera");
    return null;
  }

  screenVideoInputTrack(): null {
    this.wrapped.push("screen");
    return null;
  }

  replaceAudioTrack(track: unknown): void {
    this.outputs.push(track);
  }
}

/** A Speaker stand-in: a ramp, and how much each pull asked for. */
class RampSource implements PcmSource {
  readonly rate = 24_000;
  readonly pulls: number[] = [];

  pull(samples: number): Pcm {
    this.pulls.push(samples);
    return Int16Array.from({ length: samples }, (_, i) => i + 1);
  }
}

function transportOn(connection: FakeConnection): CallTransport {
  return pipedogCallTransport(connection as unknown as SmallWebRTCConnection);
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

const mono16k = (fill: number) =>
  new AudioFrame({ data: new Int16Array(320).fill(fill), sampleRate: 16_000, layout: "mono" });

describe("a native call's transport on pipedog's connection", () => {
  test("the client's messages reach the call in order, those connect() flushes first", async () => {
    const connection = new FakeConnection();
    connection.pending.push({ type: "client-ready" });
    const transport = transportOn(connection);
    await transport.connect();
    connection.fire("app-message", { type: "send-text" });
    expect(await take(transport.messages, 2)).toEqual([
      { type: "client-ready" },
      { type: "send-text" },
    ]);
  });

  test("send() goes out through sendAppMessage", () => {
    const connection = new FakeConnection();
    transportOn(connection).send({ label: "rtvi-ai", type: "bot-ready" });
    expect(connection.sent).toEqual([{ label: "rtvi-ai", type: "bot-ready" }]);
  });

  test("on connected, the caller's audio decodes at 16 kHz mono and reaches audioIn as copies", async () => {
    const connection = new FakeConnection();
    const transport = transportOn(connection);
    await transport.connect();
    const input = connection.input as FakeInputTrack;
    expect(input.format).toEqual([16_000, 1]);
    expect(connection.wrapped).toEqual(["camera", "screen"]);
    const first = mono16k(3);
    input.push(first);
    input.push(mono16k(4));
    const [a, b] = await take(transport.audioIn, 2);
    expect(a).toEqual(new Int16Array(320).fill(3));
    expect(a?.buffer).not.toBe(first.data.buffer);
    expect(b).toEqual(new Int16Array(320).fill(4));
  });

  test("a frame in another format is resampled to 16 kHz mono first", async () => {
    const connection = new FakeConnection();
    const transport = transportOn(connection);
    await transport.connect();
    const input = connection.input as FakeInputTrack;
    for (let i = 0; i < 10; i++) {
      input.push(
        new AudioFrame({
          data: new Int16Array(960 * 2).fill(1000),
          sampleRate: 48_000,
          layout: "stereo",
        }),
      );
    }
    let samples = 0;
    for await (const pcm of transport.audioIn) {
      samples += pcm.length;
      if (samples >= 2_400) break;
    }
    expect(samples).toBeGreaterThanOrEqual(2_400);
  });

  test("the Speaker plays on RawAudioTrack's 10 ms clock from the first connected", async () => {
    const connection = new FakeConnection();
    const transport = transportOn(connection);
    const source = new RampSource();
    transport.attachSpeaker(source);
    await transport.connect();
    expect(connection.outputs).toHaveLength(1);
    const track = connection.outputs[0] as SpeakerTrack;
    expect(track).toBeInstanceOf(RawAudioTrack);
    const start = performance.now();
    const frames = [await track.recv(), await track.recv(), await track.recv()];
    expect(performance.now() - start).toBeGreaterThanOrEqual(15);
    expect(source.pulls).toEqual([240, 240, 240]);
    expect(frames.map((f) => [f.sampleRate, f.layout.name, f.pts, f.samples])).toEqual([
      [24_000, "mono", 0, 240],
      [24_000, "mono", 240, 240],
      [24_000, "mono", 480, 240],
    ]);
    expect(frames[0]?.data[0]).toBe(1);
  });

  test("while the peer has stopped pinging, her audio waits instead of playing to no one", async () => {
    const connection = new FakeConnection();
    const transport = transportOn(connection);
    const source = new RampSource();
    transport.attachSpeaker(source);
    await transport.connect();
    const track = connection.outputs[0] as SpeakerTrack;
    connection.live = false;
    const silent = await track.recv();
    expect(silent.data.every((s) => s === 0)).toBe(true);
    expect(source.pulls).toEqual([]);
    connection.live = true;
    await track.recv();
    expect(source.pulls).toEqual([240]);
  });

  test("restart_pc: the old tracks stop, and the next connected takes up the new peer's", async () => {
    const connection = new FakeConnection();
    const transport = transportOn(connection);
    const source = new RampSource();
    transport.attachSpeaker(source);
    await transport.connect();
    const oldTrack = connection.outputs[0] as SpeakerTrack;
    connection.fire("disconnected");
    expect(oldTrack.readyState).toBe("ended");
    await expect(oldTrack.recv()).rejects.toBeInstanceOf(MediaStreamError);
    expect(source.pulls).toEqual([]);

    (connection.input as FakeInputTrack).end();
    const fresh = new FakeInputTrack();
    connection.input = fresh;
    connection.fire("connected");
    expect(fresh.format).toEqual([16_000, 1]);
    const newTrack = connection.outputs[1] as SpeakerTrack;
    expect(newTrack).not.toBe(oldTrack);
    await newTrack.recv();
    expect(source.pulls).toEqual([240]);
    fresh.push(mono16k(9));
    expect(await take(transport.audioIn, 1)).toEqual([new Int16Array(320).fill(9)]);
  });

  test("a dead input track parks the reader until the next connected", async () => {
    const connection = new FakeConnection();
    const transport = transportOn(connection);
    await transport.connect();
    const dead = connection.input as FakeInputTrack;
    await until(() => dead.recvs === 1);
    dead.end();
    await until(() =>
      logs
        .messages("WARNING")
        .includes("Media stream error while reading the audio; clearing track."),
    );
    await Bun.sleep(60);
    expect(dead.recvs).toBe(1);
    const fresh = new FakeInputTrack();
    connection.input = fresh;
    connection.fire("connected");
    fresh.push(mono16k(5));
    expect(await take(transport.audioIn, 1)).toEqual([new Int16Array(320).fill(5)]);
  });

  test("the client leaving resolves closed and ends the call's streams", async () => {
    const connection = new FakeConnection();
    const transport = transportOn(connection);
    transport.attachSpeaker(new RampSource());
    await transport.connect();
    const track = connection.outputs[0] as SpeakerTrack;
    connection.fire("closed");
    expect(await transport.closed).toBe("client");
    expect(track.readyState).toBe("ended");
    expect(await ended(transport.messages)).toBe(true);
    expect(await ended(transport.audioIn)).toBe(true);
  });

  test("disconnect(): peerLeft goes out once, closed stays pending, and nothing more is sent", async () => {
    const connection = new FakeConnection();
    const transport = transportOn(connection);
    await transport.connect();
    let closed = false;
    void transport.closed.then(() => {
      closed = true;
    });
    await transport.disconnect();
    await transport.disconnect();
    transport.send({ type: "bot-llm-text" });
    await Bun.sleep(10);
    expect(connection.disconnects).toBe(1);
    expect(connection.sent).toEqual([{ type: "signalling", message: { type: "peerLeft" } }]);
    expect(closed).toBe(false);
    expect(await ended(transport.messages)).toBe(true);
    expect(await ended(transport.audioIn)).toBe(true);
  });

  test("after the client left, disconnect() closes nothing again", async () => {
    const connection = new FakeConnection();
    const transport = transportOn(connection);
    await transport.connect();
    connection.fire("closed");
    await transport.disconnect();
    expect(connection.disconnects).toBe(0);
  });
});

// werift never offers a loopback address as a host candidate, so the peers need another interface.
const hasLanAddress = Object.values(networkInterfaces()).some((addresses) =>
  addresses?.some((a) => a.family === "IPv4" && !a.internal),
);

const PASS_THROUGH_RULES = {
  dropUnreachableCandidates: (sdp: string) => ({ sdp, dropped: [] }),
  candidateReachable: () => true,
  scrubRelayRelatedAddresses: (sdp: string) => sdp,
};

function admission(body: Record<string, unknown>): AllowedOffer {
  return {
    allowed: true,
    user: { mid: null, uname: null, face: null, isLoggedIn: false },
    token: null,
    body,
    requestData: { audioQuality: "medium" },
    opusBitrateBps: 96000,
    clientIp: "127.0.0.1",
    quota: null,
  };
}

/** A 440 Hz tone at `rate`, 10 ms at a time. */
class ToneSource implements PcmSource {
  readonly rate: number;
  #n = 0;

  constructor(rate: number) {
    this.rate = rate;
  }

  pull(samples: number): Pcm {
    return Int16Array.from({ length: samples }, () =>
      Math.round(8000 * Math.sin((2 * Math.PI * 440 * this.#n++) / this.rate)),
    );
  }
}

const loud = (pcm: Int16Array) => pcm.some((s) => Math.abs(s) > 1000);

describe.skipIf(!hasLanAddress)("against a real peer", () => {
  let server: SignallingServer;
  let client: RTCPeerConnection;
  let transports: CallTransport[];
  let connections: SmallWebRTCConnection[];

  beforeEach(() => {
    transports = [];
    connections = [];
    server = createSignallingServerWith(
      {
        ice: {
          serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }),
        },
      },
      {
        startSession: async (connection) => {
          connections.push(connection);
          transports.push(pipedogCallTransport(connection));
        },
        candidates: PASS_THROUGH_RULES,
      },
    );
    client = new RTCPeerConnection({ iceServers: [] as RTCIceServer[] });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  /** The client's call, connected, with the transport the offer built and the text it receives. */
  async function call() {
    const transceiver = client.addTransceiver("audio", { direction: "sendrecv" });
    // As a browser offers: a camera section, which the call never reads.
    client.addTransceiver("video", { direction: "sendrecv" });
    const channel: RTCDataChannel = client.createDataChannel("chat");
    const received: string[] = [];
    channel.on("message", (message: string | Uint8Array) => {
      received.push(typeof message === "string" ? message : new TextDecoder().decode(message));
    });
    await client.setLocalDescription(await client.createOffer());
    const result = await server.offer(
      admission({ sdp: client.localDescription!.sdp, type: "offer" }),
    );
    expect(result.status).toBe(200);
    const answer = result.body as { sdp: string };
    await client.setRemoteDescription({ sdp: answer.sdp, type: "answer" } as never);
    await until(() => client.connectionState === "connected" && transports.length === 1, 8000);
    const transport = transports[0] as CallTransport;
    transport.attachSpeaker(new ToneSource(24_000));
    await transport.connect();
    await until(() => channel.readyState === "open", 8000);
    return { transport, transceiver, channel, received };
  }

  test("messages and audio cross the wire both ways, and disconnect() sends peerLeft", async () => {
    const { transport, transceiver, channel, received } = await call();
    expect(connections[0]?.pc.getTransceivers()[1]?.receiver._enabled).toBe(false);
    const ready = { label: "rtvi-ai", type: "client-ready", id: "c1", data: { version: "2.3.0" } };
    channel.send(JSON.stringify(ready));
    expect(await take(transport.messages, 1)).toEqual([ready]);

    const botReady = { label: "rtvi-ai", type: "bot-ready", id: "c1", data: { version: "2.2.0" } };
    transport.send(botReady);
    // Byte for byte what pipedog sends; the connection itself may have asked to renegotiate first.
    await until(() => received.includes(pyJsonDumps(botReady)), 4000);

    // Her tone reaches the client.
    let heardHer = false;
    for (let i = 0; i < 400 && !heardHer; i++) {
      const frame = await transceiver.receiver.track.recv();
      if (frame instanceof AudioFrame && loud(frame.data)) heardHer = true;
    }
    expect(heardHer).toBe(true);

    // The caller's tone reaches the call, at 16 kHz in 20 ms frames.
    const mic = new RawAudioTrack(16_000);
    const tone = new ToneSource(16_000);
    for (let i = 0; i < 200; i++) mic.addAudioBytes(new Uint8Array(tone.pull(160).buffer));
    transceiver.sender.replaceTrack(mic);
    let heardCaller: Pcm | null = null;
    for await (const pcm of transport.audioIn) {
      if (loud(pcm)) {
        heardCaller = pcm;
        break;
      }
    }
    expect(heardCaller?.length).toBe(320);

    await transport.disconnect();
    const peerLeft = pyJsonDumps({ type: "signalling", message: { type: "peerLeft" } });
    await until(() => received.includes(peerLeft), 4000);
  }, 20_000);

  test("the server closing ends the call as the client's leaving, as pipedog's sessions see it", async () => {
    const { transport } = await call();
    await server.close();
    expect(await transport.closed).toBe("client");
  }, 20_000);
});
