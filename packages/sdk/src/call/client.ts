// EidolonClient: wraps PipecatClient, SmallWebRTCTransport, and WavMediaManager with typed RTVI
// events and offer requests.

import {
  type BotCapabilities,
  type MediaState,
  type MediaSupport,
  type Participant,
  PipecatClient,
  RTVIEvent,
  type SendTextOptions,
  type Tracks,
  type TransportState,
} from "@pipecat-ai/client-js";
import { SmallWebRTCTransport, WavMediaManager } from "@pipecat-ai/small-webrtc-transport";
import type { FetchLike } from "../chat/client.ts";
import { LIVE_SWAP_STATES, SYSTEM_DEFAULT_MIC_ID, toLiveMicId } from "./devices.ts";
import { parseBotReadyData, parseErrorMessage, parseServerMessage } from "./rtvi.ts";
import { type FetchIceServersOptions, fetchIceServers, toApiRequest } from "./signalling.ts";
import { gatherNetworkInfo, type NetworkInfo, readPeerConnection } from "./stats.ts";
import type {
  EidolonBotReadyData,
  EidolonConnectOptions,
  EidolonEventHandler,
  EidolonEventName,
} from "./types.ts";

export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

export interface EidolonClientOptions {
  readonly iceServers?: readonly RTCIceServer[];
  readonly enableMic?: boolean;
  readonly disconnectOnBotDisconnect?: boolean;
  readonly fetch?: FetchLike;
}

const PASS_THROUGH_EVENTS: readonly EidolonEventName[] = [
  "connected",
  "disconnected",
  "botStarted",
  "botConnected",
  "botDisconnected",
  "serverResponse",
  "metrics",
  "botStartedSpeaking",
  "botStoppedSpeaking",
  "botInterrupted",
  "userStartedSpeaking",
  "userStoppedSpeaking",
  "userMuteStarted",
  "userMuteStopped",
  "userTranscript",
  "userInput",
  "botOutput",
  "botLlmStarted",
  "botLlmStopped",
  "botTtsStarted",
  "botTtsStopped",
  "llmFunctionCallStarted",
  "llmFunctionCallInProgress",
  "llmFunctionCallStopped",
  "participantConnected",
  "participantLeft",
  "trackStopped",
  "localAudioLevel",
  "remoteAudioLevel",
  "availableMicsUpdated",
  "availableSpeakersUpdated",
  "micUpdated",
  "speakerUpdated",
  "deviceError",
  "mediaSupportUpdated",
  "unsupportedFeature",
];

function effectiveMediaState(raw: MediaState, transportState: TransportState): MediaState {
  // WavMediaManager never fires onMicUpdated on initial acquisition, leaving PipecatClient's mic
  // state stuck at "uninitialized" throughout a live call.
  if (raw.mic.state === "uninitialized" && LIVE_SWAP_STATES.has(transportState)) {
    return { ...raw, mic: { state: "granted" } };
  }
  return raw;
}

export class EidolonClient {
  readonly #transport: SmallWebRTCTransport;
  readonly #client: PipecatClient;
  readonly #fetch: FetchLike | undefined;
  readonly #listeners = new Map<EidolonEventName, Set<(...args: any[]) => void>>();

  constructor(options: EidolonClientOptions = {}) {
    this.#fetch = options.fetch;
    this.#transport = new SmallWebRTCTransport({
      iceServers: [...(options.iceServers ?? DEFAULT_ICE_SERVERS)],
      // Raw 24 kHz PCM capture avoids Chromium's WebRTC APM eating quiet syllables.
      // https://github.com/pipecat-ai/pipecat/issues/4065
      mediaManager: new WavMediaManager(),
    });
    this.#client = new PipecatClient({
      transport: this.#transport,
      enableMic: options.enableMic ?? true,
      enableCam: false,
      ...(options.disconnectOnBotDisconnect === undefined
        ? {}
        : { disconnectOnBotDisconnect: options.disconnectOnBotDisconnect }),
    });
    this.#wireEvents();
  }

  get rawClient(): PipecatClient {
    return this.#client;
  }

  get rawTransport(): SmallWebRTCTransport {
    return this.#transport;
  }

  get state(): TransportState {
    return this.#client.state;
  }

  get connected(): boolean {
    return this.#client.connected;
  }

  get version(): string {
    return this.#client.version;
  }

  get maxMessageSize(): number {
    return this.#transport.maxMessageSize;
  }

  get iceServers(): RTCIceServer[] {
    return this.#transport.iceServers;
  }

  set iceServers(servers: RTCIceServer[]) {
    this.#transport.iceServers = servers;
  }

  get mediaState(): MediaState {
    return effectiveMediaState(this.#client.mediaState, this.#client.state);
  }

  get mediaSupport(): MediaSupport {
    return this.#client.mediaSupport;
  }

  get botCapabilities(): BotCapabilities | undefined {
    return this.#client.botCapabilities;
  }

  get isMicEnabled(): boolean {
    return this.#client.isMicEnabled;
  }

  enableMic(enable: boolean): void {
    this.#client.enableMic(enable);
  }

  tracks(): Tracks {
    return this.#client.tracks();
  }

  getPeerConnection(): RTCPeerConnection | null {
    return readPeerConnection(this.#transport);
  }

  async gatherNetworkInfo(): Promise<NetworkInfo | null> {
    const pc = this.getPeerConnection();
    return pc === null ? null : gatherNetworkInfo(pc);
  }

  /** Fetches fresh ICE servers from `${baseUrl}/api/ice-servers` and installs them on the transport. */
  async refreshIceServers(
    baseUrl: string,
    options: Omit<FetchIceServersOptions, "fetch"> = {},
  ): Promise<RTCIceServer[]> {
    const servers = await fetchIceServers(baseUrl, {
      ...options,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
    });
    this.#transport.iceServers = servers;
    return servers;
  }

  /**
   * Applies a persisted mic `deviceId` before `connect()`, awaiting `SmallWebRTCTransport.updateMic`
   * directly (which `PipecatClient.updateMic` drops) and skipping `"default"` or unplugged ids.
   */
  async applyMicPreference(persistedMicId: string | null | undefined): Promise<void> {
    if (!persistedMicId || persistedMicId === SYSTEM_DEFAULT_MIC_ID) return;
    try {
      const mics = await this.#client.getAllMics();
      if (!mics.some((mic) => mic.deviceId === persistedMicId)) return;
      await this.#transport.updateMic(persistedMicId);
    } catch {
      // Surfaced through connect() when fatal.
      await this.#client.initDevices().catch(() => {});
    }
  }

  /** Swaps the live microphone mid-call; a no-op outside `connected` / `ready` so settings never open the mic. */
  async selectLiveMic(deviceId: string): Promise<void> {
    if (!LIVE_SWAP_STATES.has(this.#client.state)) return;
    await this.#transport.updateMic(toLiveMicId(deviceId));
  }

  initDevices(): Promise<void> {
    return this.#client.initDevices();
  }

  async connect(options: EidolonConnectOptions): Promise<EidolonBotReadyData> {
    const data = await this.#client.connect({
      webrtcRequestParams: toApiRequest(options),
    });
    return parseBotReadyData(data);
  }

  disconnect(): Promise<void> {
    return this.#client.disconnect();
  }

  sendText(content: string, options?: SendTextOptions): Promise<string> {
    return this.#client.sendText(content, options);
  }

  sendClientMessage(msgType: string, data?: unknown): void {
    this.#client.sendClientMessage(msgType, data);
  }

  on<E extends EidolonEventName>(event: E, handler: EidolonEventHandler<E>): () => void {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(handler);
    this.#listeners.set(event, set);
    return () => this.off(event, handler);
  }

  off<E extends EidolonEventName>(event: E, handler: EidolonEventHandler<E>): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.#listeners.delete(event);
  }

  #emit<E extends EidolonEventName>(event: E, ...args: Parameters<EidolonEventHandler<E>>): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) listener(...args);
  }

  #wireEvents(): void {
    for (const event of PASS_THROUGH_EVENTS) {
      this.#client.on(event as RTVIEvent, (...args: unknown[]) => {
        this.#emit(event, ...(args as Parameters<EidolonEventHandler<typeof event>>));
      });
    }

    // Overriding SmallWebRTCTransport's default DailyMediaManager with WavMediaManager drops its
    // internal replaceTrack callback, so live mic swaps must forward new local audio tracks onto
    // the audio transceiver's RTCRtpSender here.
    this.#client.on(
      RTVIEvent.TrackStarted,
      (track: MediaStreamTrack, participant?: Participant) => {
        if (participant?.local === true && track.kind === "audio") {
          const pc = this.getPeerConnection();
          const sender = pc?.getTransceivers()[0]?.sender;
          sender?.replaceTrack(track).catch(() => {});
        }
        this.#emit("trackStarted", track, participant);
      },
    );

    this.#client.on(RTVIEvent.TransportStateChanged, (state: TransportState) => {
      this.#emit("transportStateChanged", state);
      this.#emit("mediaStateUpdated", this.mediaState);
    });

    this.#client.on(RTVIEvent.MediaStateUpdated, (raw: MediaState) => {
      this.#emit("mediaStateUpdated", effectiveMediaState(raw, this.#client.state));
    });

    this.#client.on(RTVIEvent.BotReady, (data) => {
      this.#emit("botReady", parseBotReadyData(data));
    });

    this.#client.on(RTVIEvent.ServerMessage, (raw: unknown) => {
      this.#emit("serverMessage", parseServerMessage(raw));
    });

    this.#client.on(RTVIEvent.Error, (message) => {
      this.#emit("error", parseErrorMessage(message));
    });

    this.#client.on(RTVIEvent.MessageError, (message) => {
      this.#emit("messageError", parseErrorMessage(message));
    });
  }
}
