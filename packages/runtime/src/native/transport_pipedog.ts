// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/src/transport.ts@ce8f8bc
//
// A native call's transport until @eidolon/webrtc: the SmallWebRTCConnection pipedog's signalling
// built for the offer, taken over where pipedog's SmallWebRTCClient takes it, so HTTP, SDP, ICE,
// the data channel and restart_pc are what a pipedog call gets. The only file under src/native that
// imports pipedog.
import { AsyncQueue, errorText, logger } from "@eidolon/config";
import type { CallTransport, Pcm, PcmSource } from "@eidolon/voice";
import {
  createTask,
  rethrowIfCancelled,
  sleep,
  type Task,
  TimeoutError,
  time,
  waitFor,
} from "@pipedog/asyncio";
import type {
  SmallWebRTCConnection,
  SmallWebRTCTrack,
} from "@pipedog/transport-smallwebrtc/connection";
import { AudioFrame, AudioResampler, MediaStreamError } from "@pipedog/transport-smallwebrtc/media";
import { RawAudioTrack } from "@pipedog/transport-smallwebrtc/transport";

/** The Ear's rate, which Opus decodes the caller's audio to. */
const AUDIO_IN_RATE = 16_000;
const RECV_TIMEOUT_SECS = 2.0;

/** RawAudioTrack's drift-free 10 ms clock, its samples pulled from the call's Speaker. */
export class SpeakerTrack extends RawAudioTrack {
  readonly #source: PcmSource;
  readonly #live: () => boolean;

  /** `live`: whether the peer still pings; until it does again, her audio waits. */
  constructor(source: PcmSource, live: () => boolean) {
    super(source.rate);
    this.#source = source;
    this.#live = live;
  }

  override async recv(): Promise<AudioFrame> {
    // As aiortc's AudioStreamTrack: once stopped, its sender's loop ends instead of pulling on.
    if (this.readyState !== "live") throw new MediaStreamError();
    if (this._rawTimestamp > 0) {
      const wait = this._rawStart + this._rawTimestamp / this._sampleRate - time();
      if (wait > 0) await sleep(wait);
      if (this.readyState !== "live") throw new MediaStreamError();
    }
    const samples = this.#live()
      ? this.#source.pull(this._samplesPer10ms)
      : new Int16Array(this._samplesPer10ms);
    const frame = AudioFrame.fromNdarray(samples, { layout: "mono", sampleRate: this._sampleRate });
    frame.pts = this._rawTimestamp;
    frame.timeBase = 1 / this._sampleRate;
    this._rawTimestamp += this._samplesPer10ms;
    return frame;
  }
}

/** `connection` as a native call's transport. Built before `connect()`, as pipedog's client is. */
export function pipedogCallTransport(connection: SmallWebRTCConnection): CallTransport {
  return new PipedogCallTransport(connection);
}

class PipedogCallTransport implements CallTransport {
  readonly #connection: SmallWebRTCConnection;
  readonly #audio = new AsyncQueue<Pcm>();
  readonly #messages = new AsyncQueue<unknown>();
  readonly closed: Promise<"client">;
  #leave: () => void = () => {};
  #speaker: PcmSource | null = null;
  #input: SmallWebRTCTrack | null = null;
  #output: SpeakerTrack | null = null;
  #reader: Task<void> | null = null;
  /** We disconnected: the peer's close that follows isn't the client leaving. */
  #closing = false;
  #over = false;

  constructor(connection: SmallWebRTCConnection) {
    this.#connection = connection;
    this.closed = new Promise((resolve) => {
      this.#leave = () => resolve("client");
    });
    connection.eventHandler("connected", () => this.#connected());
    // restart_pc, or the peer's ICE dropping: the tracks come back with the next "connected".
    connection.eventHandler("disconnected", () => this.#dropTracks());
    connection.eventHandler("closed", () => this.#closed());
    connection.eventHandler("app-message", (_connection: unknown, message: unknown) =>
      this.#messages.push(message),
    );
  }

  get audioIn(): AsyncIterable<Pcm> {
    return this.#audio;
  }

  get messages(): AsyncIterable<unknown> {
    return this.#messages;
  }

  attachSpeaker(source: PcmSource): void {
    this.#speaker = source;
  }

  send(message: Readonly<Record<string, unknown>>): void {
    if (!this.#closing) this.#connection.sendAppMessage(message);
  }

  async connect(): Promise<void> {
    this.#reader ??= createTask(() => this.#read(), "eidolon-call-audio-in");
    await this.#connection.connect();
  }

  async disconnect(): Promise<void> {
    if (this.#closing || this.#over) return;
    this.#closing = true;
    try {
      await this.#connection.disconnect();
    } finally {
      this.#end();
    }
  }

  #connected(): void {
    if (this.#over) return;
    const input = this.#connection.audioInputTrack();
    input?.setAudioOutputFormat(AUDIO_IN_RATE, 1);
    this.#input = input;
    // Wrapping a receiver turns it off until something reads it: a camera the client sends is
    // dropped as it arrives, as in pipedog's calls, instead of depayloaded and asked for keyframes.
    this.#connection.videoInputTrack();
    this.#connection.screenVideoInputTrack();
    if (this.#speaker !== null) {
      this.#output = new SpeakerTrack(this.#speaker, () => this.#connection.isConnected());
      this.#connection.replaceAudioTrack(this.#output);
    }
  }

  #dropTracks(): void {
    this.#output?.stop();
    this.#output = null;
    this.#input = null;
  }

  #closed(): void {
    const left = !this.#closing;
    this.#end();
    if (left) this.#leave();
  }

  #end(): void {
    if (this.#over) return;
    this.#over = true;
    this.#dropTracks();
    this.#reader?.cancel();
    this.#audio.close();
    this.#messages.close();
  }

  /** pipedog's readAudioFrame: the input track's frames at 16 kHz mono, whichever track is current. */
  async #read(): Promise<void> {
    let resampler: AudioResampler | null = null;
    try {
      for (;;) {
        const track = this.#input;
        if (track === null) {
          await sleep(0.01);
          continue;
        }
        let frame: unknown = null;
        try {
          frame = await waitFor(() => track.recv(), RECV_TIMEOUT_SECS);
        } catch (e) {
          if (e instanceof TimeoutError) {
            if (this.#connection.isConnected() && this.#input?.isEnabled()) {
              logger.warning("Timeout: No audio frame received within the specified time.");
            }
          } else if (e instanceof MediaStreamError) {
            // A dead track would throw at once forever: wait for the next "connected" instead.
            logger.warning("Media stream error while reading the audio; clearing track.");
            if (this.#input === track) this.#input = null;
          } else {
            throw e;
          }
        }
        if (!(frame instanceof AudioFrame)) {
          await sleep(0.01);
          continue;
        }
        let frames = [frame];
        if (frame.sampleRate !== AUDIO_IN_RATE || frame.layout.name !== "mono") {
          resampler ??= new AudioResampler("s16", "mono", AUDIO_IN_RATE);
          frames = await resampler.resample(frame);
        }
        for (const pcm of frames) this.#audio.push(pcm.data.slice());
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`[voice] Receiving the caller's audio failed: ${errorText(e)}`, e);
    }
  }
}
