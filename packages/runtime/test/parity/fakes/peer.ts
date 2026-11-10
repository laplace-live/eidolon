// The caller: a real werift peer that offers as a browser does (an audio and a camera section and
// the "chat" channel), pings once a second as small-webrtc's client does, says WAV-like audio
// through its mic as Opus, and keeps every message the bot sends and when her audio is loud.
import { AudioFrame } from "@pipedog/transport-smallwebrtc/media";
import {
  type RTCDataChannel,
  type RTCIceServer,
  RTCPeerConnection,
  type RTCRtpTransceiver,
} from "@pipedog/transport-smallwebrtc/rtc";
import { RawAudioTrack } from "@pipedog/transport-smallwebrtc/transport";
import type { SignallingServer } from "../../../src/webrtc/signalling.ts";
import { admission } from "../../support.ts";

/** A message the bot sent, and when it arrived (ms since the peer was made). */
export interface Received {
  readonly t: number;
  readonly message: Readonly<Record<string, unknown>>;
}

const MIC_RATE = 16_000;
/** A 10 ms frame of the bot's audio this loud counts as audible. */
const AUDIBLE = 500;

export class TwinPeer {
  readonly #startedAt = performance.now();
  readonly #pc = new RTCPeerConnection({ iceServers: [] as RTCIceServer[] });
  readonly #audio: RTCRtpTransceiver;
  readonly #channel: RTCDataChannel;
  readonly #mic = new RawAudioTrack(MIC_RATE);
  readonly received: Received[] = [];
  /** [start, end] ms of each run of audible bot audio. */
  readonly audible: [number, number][] = [];
  #pings: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #nextId = 0;

  constructor() {
    this.#audio = this.#pc.addTransceiver("audio", { direction: "sendrecv" });
    this.#pc.addTransceiver("video", { direction: "sendrecv" });
    this.#channel = this.#pc.createDataChannel("chat");
    this.#channel.on("message", (data: string | Uint8Array) => {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      this.received.push({ t: this.now(), message: JSON.parse(text) });
    });
  }

  now(): number {
    return performance.now() - this.#startedAt;
  }

  /** Offers to `server` and waits until the call is connected and the channel open. */
  async dial(server: SignallingServer): Promise<string> {
    await this.#pc.setLocalDescription(await this.#pc.createOffer());
    const result = await server.offer(
      admission({ sdp: this.#pc.localDescription!.sdp, type: "offer" }),
    );
    if (result.status !== 200) throw new Error(`offer failed: ${JSON.stringify(result.body)}`);
    const answer = result.body as { sdp: string; pc_id: string };
    await this.#pc.setRemoteDescription({ sdp: answer.sdp, type: "answer" } as never);
    await this.#until(() => this.#channel.readyState === "open", 10_000, "the channel to open");
    this.#audio.sender.replaceTrack(this.#mic);
    this.#pings = setInterval(() => {
      if (this.#channel.readyState === "open") this.#channel.send(`ping: ${Date.now()}`);
    }, 1000);
    void this.#listen();
    return answer.pc_id;
  }

  /** An RTVI message from the client, as client-js frames it; returns its id. */
  rtvi(type: string, data?: Readonly<Record<string, unknown>>): string {
    const id = `twin-${++this.#nextId}`;
    this.#channel.send(JSON.stringify({ label: "rtvi-ai", type, id, data }));
    return id;
  }

  /** Says `pcm` (16 kHz mono) through the mic; resolves once it has all gone out. */
  async say(pcm: Int16Array): Promise<void> {
    const frame = MIC_RATE / 100;
    const whole = pcm.length - (pcm.length % frame);
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, whole * 2).slice();
    await this.#mic.addAudioBytes(bytes);
  }

  /** The bot's RTVI messages, in order. */
  get rtviMessages(): Received[] {
    return this.received.filter((r) => r.message.label === "rtvi-ai");
  }

  count(type: string): number {
    return this.rtviMessages.filter((r) => r.message.type === type).length;
  }

  /** Resolves once the bot has sent `n` messages of `type`. */
  async waitFor(type: string, n = 1, timeoutMs = 20_000): Promise<void> {
    await this.#until(() => this.count(type) >= n, timeoutMs, `${n}× ${type}`);
  }

  /** Resolves once the bot has sent nothing for `quietMs`. */
  async quiet(quietMs: number, timeoutMs = 30_000): Promise<void> {
    await this.#until(
      () => this.now() - (this.received.at(-1)?.t ?? 0) >= quietMs,
      timeoutMs,
      `${quietMs} ms without a message`,
    );
  }

  /** Resolves once her audio, heard since `since` (ms), has been silent for `silentMs`. */
  async audioEnded(since: number, silentMs: number, timeoutMs = 30_000): Promise<void> {
    await this.#until(
      () => {
        const last = this.audible.at(-1);
        return last !== undefined && last[1] >= since && this.now() - last[1] >= silentMs;
      },
      timeoutMs,
      `her audio to end for ${silentMs} ms`,
    );
  }

  /** Hangs up, as closing the browser tab does. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#pings !== null) clearInterval(this.#pings);
    this.#mic.stop();
    await this.#pc.close();
  }

  async #listen(): Promise<void> {
    const track = this.#audio.receiver.track;
    let run: [number, number] | null = null;
    while (!this.#closed) {
      let frame: unknown;
      try {
        frame = await track.recv();
      } catch {
        return;
      }
      if (!(frame instanceof AudioFrame)) continue;
      const loud = frame.data.some((sample: number) => Math.abs(sample) > AUDIBLE);
      const t = this.now();
      if (loud) {
        if (run !== null && t - run[1] <= 100) run[1] = t;
        else {
          run = [t, t];
          this.audible.push(run);
        }
      }
    }
  }

  async #until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!check()) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(5);
    }
  }
}
