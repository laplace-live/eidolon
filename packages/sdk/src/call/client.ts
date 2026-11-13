// EidolonClient: wraps PipecatClient, SmallWebRTCTransport, and WavMediaManager with typed RTVI
// events and offer requests.

import {
  type BotCapabilities,
  type DeviceStatus,
  type MediaState,
  type MediaSupport,
  type Participant,
  PipecatClient,
  RTVIError,
  RTVIEvent,
  type SendTextOptions,
  type Tracks,
  type TransportState,
} from "@pipecat-ai/client-js";
import { SmallWebRTCTransport, WavMediaManager } from "@pipecat-ai/small-webrtc-transport";
import type { FetchLike } from "../chat/client.ts";
import { LIVE_SWAP_STATES, SYSTEM_DEFAULT_MIC_ID, sameMediaState, toLiveMicId } from "./devices.ts";
import {
  normalizeDeviceErrorReason,
  parseBotReadyData,
  parseErrorMessage,
  parseServerMessage,
} from "./rtvi.ts";
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

function connectionCancelledError(): DOMException {
  return new DOMException("Connection cancelled", "AbortError");
}

function effectiveMediaState(
  raw: MediaState,
  transportState: TransportState,
  hasLiveMic: boolean,
): MediaState {
  if (raw.mic.state === "error" && raw.mic.reason === "unknown") {
    const reason = normalizeDeviceErrorReason("unknown", raw.mic.details);
    if (reason !== "unknown") {
      return { ...raw, mic: { ...raw.mic, reason } };
    }
  }
  // WavMediaManager.initialize never fires onMicUpdated on initial acquisition, leaving PipecatClient's
  // mic state stuck at "uninitialized" throughout a live call once capture succeeds:
  // https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/lib/src/media-mgmt/mediaManager.ts
  if (raw.mic.state === "uninitialized" && LIVE_SWAP_STATES.has(transportState) && hasLiveMic) {
    return { ...raw, mic: { state: "granted" } };
  }
  return raw;
}

interface InternalWavRecorder {
  getStatus?: () => string;
  begin?: (deviceId?: string) => Promise<unknown>;
  end?: () => Promise<unknown>;
  listenForDeviceChange?: (callback: null) => unknown;
  listenForDeviceErrors?: (callback: null) => unknown;
  deviceSelection?: { deviceId?: string } | null;
  processor?: { context?: { state?: string; close?: () => Promise<void> } } | null;
  stream?: MediaStream | null;
}

interface InternalWavStreamPlayer {
  context?: { state?: string; close?: () => Promise<void> } | null;
  analyser?: unknown;
  stream?: { disconnect?: () => void } | null;
}

interface InternalPipecatClient {
  _setMediaState?: (patch: Partial<MediaState>) => void;
  _resolveLingeringInitializing?: (fallback: DeviceStatus) => void;
}

function resetInitializingMediaState(client: PipecatClient): void {
  (client as unknown as InternalPipecatClient)._setMediaState?.({
    mic: { state: "initializing" },
    cam: { state: "initializing" },
  });
}

function resolveLingeringInitializing(client: PipecatClient, fallback: DeviceStatus): void {
  (client as unknown as InternalPipecatClient)._resolveLingeringInitializing?.(fallback);
}

function connectWithoutAutoInit(
  client: PipecatClient,
  params: Parameters<PipecatClient["connect"]>[0],
): ReturnType<PipecatClient["connect"]> {
  const origNeedsInit = client.needsInit;
  Reflect.set(client, "needsInit", () => false);
  try {
    return client.connect(params);
  } finally {
    Reflect.set(client, "needsInit", origNeedsInit);
  }
}

function readRecorderOf(target: WavMediaManager): InternalWavRecorder | undefined {
  return Reflect.get(target, "_wavRecorder") as InternalWavRecorder | undefined;
}

function readPlayerOf(target: WavMediaManager): InternalWavStreamPlayer | undefined {
  return Reflect.get(target, "_wavStreamPlayer") as InternalWavStreamPlayer | undefined;
}

async function stopRecorderInstance(
  recorder: InternalWavRecorder | undefined,
  priorStream?: MediaStream | null,
  priorContext?: { state?: string; close?: () => Promise<void> },
  options?: { readonly keepDeviceListeners?: boolean },
): Promise<void> {
  const stream = recorder?.stream ?? priorStream ?? null;
  const context = recorder?.processor?.context ?? priorContext;
  if (!options?.keepDeviceListeners) {
    recorder?.listenForDeviceChange?.(null);
    recorder?.listenForDeviceErrors?.(null);
  }
  if (recorder?.getStatus?.() !== "ended") {
    await recorder?.end?.().catch(() => {});
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  if (recorder?.stream) recorder.stream = null;
  if (context && context.state !== "closed") {
    await context.close?.().catch(() => {});
  }
}

async function closePlayerInstance(player: InternalWavStreamPlayer | undefined): Promise<void> {
  const context = player?.context;
  if (player?.stream) {
    player.stream.disconnect?.();
    player.stream = null;
  }
  if (player) {
    player.analyser = null;
    player.context = null;
  }
  if (context && context.state !== "closed") {
    await context.close?.().catch(() => {});
  }
}

interface BridgedMediaManager {
  readonly isMicEnabled: boolean;
  readonly isDisconnecting: boolean;
  markDisconnecting(): void;
  clearDeviceSelection(): void;
  runPreConnectMic<T>(fn: () => Promise<T>): Promise<T>;
  tracks(): Tracks;
  initialize(): Promise<void>;
  connect(): Promise<void>;
  updateMic(micId: string): Promise<void>;
  disconnect(): Promise<void>;
}

interface InFlightLifecycle {
  readonly epoch: number;
  readonly inner: WavMediaManager;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
}

// Wraps WavMediaManager / WavRecorder with hangup/redial isolation and muted-track sync:
// https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/lib/src/media-mgmt/mediaManager.ts
// https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/lib/src/wavtools/lib/wav_recorder.js
function createBridgedMediaManager(
  onLocalAudioTrack: (track: MediaStreamTrack) => void,
  onAutoMicFallback?: (appliedMicId: string | null) => void,
): WavMediaManager & BridgedMediaManager {
  const raw = new WavMediaManager();
  const proto = WavMediaManager.prototype;
  let activeInner: WavMediaManager = raw;
  let disconnectEpoch = 0;
  let activeDisconnects = 0;
  let markedEpoch: number | null = null;
  let lifecycleToken = 0;
  let preConnectMicDepth = 0;
  let explicitMicSelectionGen = 0;
  let pendingMicOp: Promise<void> = Promise.resolve();
  const cancelWaiters = new Set<() => void>();
  const inFlightInners = new Map<WavMediaManager, InFlightLifecycle>();
  const activeMicWork = new Map<
    symbol,
    { readonly epoch: number; readonly settled: Promise<void> }
  >();
  const sessionEpochs = new WeakMap<WavMediaManager, number>();
  const RecorderCtor = (Reflect.get(raw, "_wavRecorder") as object | undefined)?.constructor;
  const PlayerCtor = (Reflect.get(raw, "_wavStreamPlayer") as object | undefined)?.constructor;

  const isCanceled = (epoch: number) =>
    epoch !== disconnectEpoch || activeDisconnects > 0 || markedEpoch !== null;

  const bumpDisconnectEpoch = () => {
    disconnectEpoch += 1;
    for (const wake of [...cancelWaiters]) wake();
    cancelWaiters.clear();
  };

  const waitUnlessCanceled = (promise: Promise<void>, epoch: number): Promise<void> => {
    if (isCanceled(epoch)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        cancelWaiters.delete(done);
        resolve();
      };
      cancelWaiters.add(done);
      promise.then(done, done);
    });
  };

  const trackMicWork = <T>(epoch: number, fn: () => Promise<T>): Promise<T> => {
    const id = Symbol();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((r) => {
      resolveSettled = r;
    });
    activeMicWork.set(id, { epoch, settled });
    const cleanup = () => {
      activeMicWork.delete(id);
      resolveSettled();
    };
    const result = fn();
    result.then(cleanup, cleanup);
    return result;
  };

  const hasEpochMicWork = (epoch: number) => {
    for (const op of activeMicWork.values()) {
      if (op.epoch === epoch) return true;
    }
    return false;
  };

  const waitForEpochMicWork = async (epoch: number): Promise<void> => {
    while (!isCanceled(epoch)) {
      const sameEpoch: Promise<void>[] = [];
      for (const op of activeMicWork.values()) {
        if (op.epoch === epoch) sameEpoch.push(op.settled);
      }
      if (sameEpoch.length === 0) return;
      await waitUnlessCanceled(
        Promise.all(sameEpoch).then(() => {}),
        epoch,
      );
    }
  };

  const isolateSuspendedInner = () => {
    const inFlight = inFlightInners.get(activeInner);
    const currentRecorder = readRecorderOf(activeInner);
    const currentPlayer = readPlayerOf(activeInner);
    if (
      inFlight !== undefined &&
      inFlight.epoch !== disconnectEpoch &&
      RecorderCtor !== undefined &&
      PlayerCtor !== undefined &&
      currentRecorder?.constructor === RecorderCtor &&
      currentPlayer?.constructor === PlayerCtor
    ) {
      // Isolate a suspended attempt on its old WavMediaManager so redial runs immediately without
      // the older resume mutating the replacement's _wavRecorder, _wavStreamPlayer, or _initialized.
      const nextInner = new WavMediaManager();
      for (const key of [
        "_options",
        "_callbacks",
        "_micEnabled",
        "_camEnabled",
        "_supportsScreenShare",
        "_recorderChunkSize",
        "_userAudioCallback",
      ]) {
        Reflect.set(nextInner, key, Reflect.get(activeInner, key));
      }
      const nextRecorder = Reflect.get(nextInner, "_wavRecorder") as object;
      const deviceSelection = Reflect.get(currentRecorder as object, "deviceSelection");
      if (deviceSelection !== undefined) {
        Reflect.set(nextRecorder, "deviceSelection", deviceSelection);
      }
      Reflect.set(activeInner, "_callbacks", {});
      Reflect.set(activeInner, "_userAudioCallback", undefined);
      bindInner(nextInner);
      activeInner = nextInner;
    }
  };

  const claimLifecycle = (epoch: number) => {
    isolateSuspendedInner();
    const inner = activeInner;
    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    const entry: InFlightLifecycle = { epoch, inner, settled, resolve };
    inFlightInners.set(inner, entry);
    return {
      token: ++lifecycleToken,
      inner,
      entry,
      recorder: readRecorderOf(inner),
      player: readPlayerOf(inner),
    };
  };

  const releaseLifecycle = (entry: InFlightLifecycle) => {
    if (inFlightInners.get(entry.inner) === entry) {
      inFlightInners.delete(entry.inner);
    }
    entry.resolve();
  };

  const cleanupAttempt = async (attempt: {
    readonly token: number;
    readonly inner: WavMediaManager;
    readonly recorder: InternalWavRecorder | undefined;
    readonly player: InternalWavStreamPlayer | undefined;
  }) => {
    const ownsActive = attempt.inner === activeInner && attempt.token === lifecycleToken;
    const isolatedFromActive = attempt.inner !== activeInner;
    if (ownsActive || isolatedFromActive) {
      sessionEpochs.delete(attempt.inner);
      Reflect.set(attempt.inner, "_initialized", false);
      await stopRecorderInstance(attempt.recorder ?? readRecorderOf(attempt.inner));
      await closePlayerInstance(attempt.player ?? readPlayerOf(attempt.inner));
    }
  };

  const syncMicTrack = () => {
    const track = proto.tracks.call(activeInner).local.audio;
    if (track) track.enabled = Boolean(Reflect.get(activeInner, "_micEnabled"));
  };

  const updateMicInternal = (
    micId: string,
    isAutoFallback: boolean,
    expectedSelectionGen: number,
  ): Promise<void> => {
    // WavMediaManager.updateMic has no queue or teardown guard: if disconnect() runs while
    // getUserMedia is awaiting, begin() finishes later and leaves capture live after hangup.
    const epoch = disconnectEpoch;
    const runUpdateOn = async (
      target: WavMediaManager,
      recorder: InternalWavRecorder | undefined,
      cleanupOnAbort: (reason: "canceled" | "failed") => Promise<void>,
    ) => {
      if (micId === "" && recorder && "deviceSelection" in recorder) {
        // WavRecorder.end() preserves deviceSelection across calls so begin("") leaves selectedMic
        // pointing at a prior call's hardware device until listDevices() settles:
        // https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/lib/src/wavtools/lib/wav_recorder.js
        recorder.deviceSelection = null;
      }
      let beginError: unknown;
      const origBegin = recorder?.begin;
      const hadOwnBegin = recorder ? Object.hasOwn(recorder, "begin") : false;
      if (recorder && typeof origBegin === "function") {
        recorder.begin = async function (this: unknown, ...args: [string?]) {
          try {
            return await origBegin.apply(this, args);
          } catch (error) {
            beginError = error;
            throw error;
          }
        };
      }
      // WavMediaManager.updateMic catches and discards WavRecorder.begin() rejections:
      // https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/lib/src/media-mgmt/mediaManager.ts
      try {
        await proto.updateMic.call(target, micId);
      } finally {
        if (recorder && origBegin !== undefined) {
          if (hadOwnBegin) recorder.begin = origBegin;
          else Reflect.deleteProperty(recorder, "begin");
        }
      }
      if (isCanceled(epoch) || target !== activeInner) {
        await cleanupOnAbort("canceled");
        return;
      }
      if (beginError !== undefined) {
        await cleanupOnAbort("failed");
        throw beginError;
      }
      const track = proto.tracks.call(target).local.audio;
      if (!track || track.readyState === "ended") {
        await cleanupOnAbort("failed");
        throw new Error("Could not start media stream");
      }
      syncMicTrack();
      // While muted, WavMediaManager.updateMic skips _startRecording (and with it onTrackStarted),
      // leaving the previous stopped track on RTCRtpSender.
      if (!overrides.isMicEnabled) onLocalAudioTrack(track);
    };
    if (preConnectMicDepth > 0) {
      // Keep pre-connect capture off pendingMicOp so an unanswered permission prompt never
      // blocks disconnect() or an awaited redial; claimLifecycle() isolates and cleans it up.
      return (async () => {
        if (isCanceled(epoch)) return;
        isolateSuspendedInner();
        let existing = inFlightInners.get(activeInner);
        while (!isCanceled(epoch) && existing !== undefined && existing.epoch === epoch) {
          await waitUnlessCanceled(existing.settled, epoch);
          isolateSuspendedInner();
          existing = inFlightInners.get(activeInner);
        }
        if (isCanceled(epoch)) return;
        const attempt = claimLifecycle(epoch);
        try {
          await runUpdateOn(attempt.inner, attempt.recorder, () => cleanupAttempt(attempt));
        } finally {
          releaseLifecycle(attempt.entry);
        }
      })();
    }
    const run = async () => {
      if (isCanceled(epoch)) return;
      if (isAutoFallback && explicitMicSelectionGen !== expectedSelectionGen) return;
      isolateSuspendedInner();
      let existing = inFlightInners.get(activeInner);
      while (!isCanceled(epoch) && existing !== undefined && existing.epoch === epoch) {
        await waitUnlessCanceled(existing.settled, epoch);
        isolateSuspendedInner();
        existing = inFlightInners.get(activeInner);
      }
      if (isCanceled(epoch)) return;
      if (isAutoFallback && explicitMicSelectionGen !== expectedSelectionGen) return;
      const target = activeInner;
      const recorder = readRecorderOf(target);
      await runUpdateOn(target, recorder, async (reason) => {
        if (target !== activeInner || readRecorderOf(target) === recorder) {
          // WavMediaManager.initialize() registers device-change and device-error listeners once
          // per call; keep them attached when a live swap fails so retries and unplug fallback still fire:
          // https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/lib/src/media-mgmt/mediaManager.ts
          await stopRecorderInstance(readRecorderOf(target) ?? recorder, undefined, undefined, {
            keepDeviceListeners:
              reason === "failed" && target === activeInner && !isCanceled(epoch),
          });
        }
      });
    };
    const next = trackMicWork(epoch, () => pendingMicOp.then(run, run));
    pendingMicOp = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const overrides: BridgedMediaManager = {
    get isDisconnecting() {
      return activeDisconnects > 0 || markedEpoch !== null;
    },
    get isMicEnabled() {
      return Boolean(Reflect.get(activeInner, "_micEnabled"));
    },
    markDisconnecting() {
      if (markedEpoch === null) {
        bumpDisconnectEpoch();
        markedEpoch = disconnectEpoch;
      }
    },
    clearDeviceSelection() {
      isolateSuspendedInner();
      const recorder = readRecorderOf(activeInner);
      if (recorder && "deviceSelection" in recorder) {
        recorder.deviceSelection = null;
      }
    },
    runPreConnectMic<T>(fn: () => Promise<T>): Promise<T> {
      preConnectMicDepth += 1;
      try {
        return fn();
      } finally {
        preConnectMicDepth -= 1;
      }
    },
    tracks() {
      return proto.tracks.call(activeInner);
    },
    async initialize() {
      const epoch = disconnectEpoch;
      if (isCanceled(epoch)) {
        throw connectionCancelledError();
      }
      isolateSuspendedInner();
      let existing = inFlightInners.get(activeInner);
      while (!isCanceled(epoch) && existing !== undefined && existing.epoch === epoch) {
        await waitUnlessCanceled(existing.settled, epoch);
        isolateSuspendedInner();
        existing = inFlightInners.get(activeInner);
      }
      if (isCanceled(epoch)) {
        throw connectionCancelledError();
      }
      const attempt = claimLifecycle(epoch);
      try {
        if (Reflect.get(attempt.inner, "_initialized") === true) {
          if (attempt.inner === activeInner) {
            sessionEpochs.set(attempt.inner, epoch);
            syncMicTrack();
          }
          return;
        }
        sessionEpochs.set(attempt.inner, epoch);
        try {
          await proto.initialize.call(attempt.inner);
        } catch (error) {
          await cleanupAttempt(attempt);
          throw error;
        }
        if (isCanceled(epoch) || attempt.inner !== activeInner) {
          await cleanupAttempt(attempt);
          throw connectionCancelledError();
        }
        // WavMediaManager leaves getUserMedia's track enabled when _micEnabled is false, which sends
        // live audio over RTCRtpSender because Eidolon's server ignores signalling trackStatus frames.
        syncMicTrack();
      } finally {
        releaseLifecycle(attempt.entry);
      }
    },
    async connect() {
      const epoch = disconnectEpoch;
      if (isCanceled(epoch)) {
        throw connectionCancelledError();
      }
      if (hasEpochMicWork(epoch)) {
        await waitForEpochMicWork(epoch);
        if (isCanceled(epoch)) {
          throw connectionCancelledError();
        }
      }
      isolateSuspendedInner();
      let existing = inFlightInners.get(activeInner);
      while (!isCanceled(epoch) && existing !== undefined && existing.epoch === epoch) {
        await waitUnlessCanceled(existing.settled, epoch);
        if (hasEpochMicWork(epoch)) {
          await waitForEpochMicWork(epoch);
        }
        isolateSuspendedInner();
        existing = inFlightInners.get(activeInner);
      }
      if (isCanceled(epoch)) {
        throw connectionCancelledError();
      }
      const attempt = claimLifecycle(epoch);
      try {
        sessionEpochs.set(attempt.inner, epoch);
        try {
          await proto.connect.call(attempt.inner);
        } catch (error) {
          await cleanupAttempt(attempt);
          throw error;
        }
        if (isCanceled(epoch) || attempt.inner !== activeInner) {
          await cleanupAttempt(attempt);
          throw connectionCancelledError();
        }
        syncMicTrack();
      } finally {
        releaseLifecycle(attempt.entry);
      }
    },
    updateMic(micId: string) {
      explicitMicSelectionGen += 1;
      return updateMicInternal(micId, false, explicitMicSelectionGen);
    },
    async disconnect() {
      if (markedEpoch === null) bumpDisconnectEpoch();
      markedEpoch = null;
      activeDisconnects += 1;
      try {
        await pendingMicOp;
        const target = activeInner;
        sessionEpochs.delete(target);
        const recorder = readRecorderOf(target);
        const player = readPlayerOf(target);
        const priorStream = recorder?.stream;
        const priorContext = recorder?.processor?.context;
        await proto.disconnect.call(target);
        // applyMicPreference opens _wavRecorder via updateMic before initialize() flips _initialized,
        // so baseDisconnect() returns early; WavRecorder.end() also clears this.stream without stopping tracks.
        await stopRecorderInstance(recorder, priorStream, priorContext);
        await closePlayerInstance(player);
      } finally {
        activeDisconnects -= 1;
      }
    },
  };

  function bindInner(inner: WavMediaManager): void {
    // WavMediaManager.initialize() binds _handleAvailableDevicesUpdated to the inner instance
    // before _wavStreamPlayer.connect() settles, and its unplug fallback invokes `this.updateMic("")`
    // fire-and-forget without awaiting:
    // https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/lib/src/media-mgmt/mediaManager.ts
    Reflect.set(inner, "updateMic", (micId: string) => {
      const fallbackEpoch = disconnectEpoch;
      if (
        inner !== activeInner ||
        isCanceled(fallbackEpoch) ||
        sessionEpochs.get(inner) !== fallbackEpoch
      ) {
        return Promise.resolve();
      }
      const selectionGen = explicitMicSelectionGen;
      return trackMicWork(fallbackEpoch, async () => {
        let inflight = inFlightInners.get(inner);
        while (
          !isCanceled(fallbackEpoch) &&
          inflight !== undefined &&
          inflight.epoch === fallbackEpoch
        ) {
          await waitUnlessCanceled(inflight.settled, fallbackEpoch);
          inflight = inFlightInners.get(inner);
        }
        if (
          inner !== activeInner ||
          isCanceled(fallbackEpoch) ||
          sessionEpochs.get(inner) !== fallbackEpoch ||
          explicitMicSelectionGen !== selectionGen
        ) {
          return;
        }
        try {
          await updateMicInternal(micId, true, selectionGen);
          if (
            inner === activeInner &&
            !isCanceled(fallbackEpoch) &&
            sessionEpochs.get(inner) === fallbackEpoch &&
            explicitMicSelectionGen === selectionGen
          ) {
            onAutoMicFallback?.(micId || SYSTEM_DEFAULT_MIC_ID);
          }
        } catch {
          if (
            inner === activeInner &&
            !isCanceled(fallbackEpoch) &&
            sessionEpochs.get(inner) === fallbackEpoch &&
            explicitMicSelectionGen === selectionGen
          ) {
            onAutoMicFallback?.(null);
          }
        }
      });
    });
  }
  bindInner(raw);

  return new Proxy(raw as WavMediaManager & BridgedMediaManager, {
    get(_target, prop) {
      if (Object.hasOwn(overrides, prop)) {
        return Reflect.get(overrides, prop, overrides);
      }
      const value = Reflect.get(activeInner, prop, activeInner);
      return typeof value === "function" ? value.bind(activeInner) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(activeInner, prop, value, activeInner);
    },
  });
}

export class EidolonClient {
  readonly #mediaManager: BridgedMediaManager;
  readonly #transport: SmallWebRTCTransport;
  readonly #client: PipecatClient;
  readonly #fetch: FetchLike | undefined;
  readonly #listeners = new Map<EidolonEventName, Set<(...args: any[]) => void>>();
  readonly #sentRunImmediately = new Map<string, boolean>();
  #pendingQueuedSends = 0;
  #connectEpoch = 0;
  #lastDisconnectEpoch = 0;
  #activeConnectAttempt: number | null = null;
  #cancelTransportConnect: (() => void) | null = null;
  #preferredMicId: string | null = null;
  #appliedMicId: string | null = null;
  #attemptedPreConnectMicId: string | null = null;
  #botAudioTrack: MediaStreamTrack | undefined;
  #botVideoTrack: MediaStreamTrack | undefined;
  #lastEmittedMediaState: MediaState | undefined;

  constructor(options: EidolonClientOptions = {}) {
    this.#fetch = options.fetch;
    const mediaManager = createBridgedMediaManager(
      (track) => this.#replaceSenderTrack(track),
      (appliedMicId) => {
        if (!mediaManager.isDisconnecting) {
          this.#appliedMicId = appliedMicId !== null && this.#hasLiveMic() ? appliedMicId : null;
        }
      },
    );
    this.#mediaManager = mediaManager;
    this.#transport = new SmallWebRTCTransport({
      iceServers: [...(options.iceServers ?? DEFAULT_ICE_SERVERS)],
      // Raw 24 kHz PCM capture avoids Chromium's WebRTC APM eating quiet syllables.
      // https://github.com/pipecat-ai/pipecat/issues/4065
      mediaManager,
    });
    // SmallWebRTCTransport._connect returns early without throwing when aborted, after which
    // PipecatClient.connect still calls sendReadyMessage() and flips state back to "ready":
    // https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/transports/small-webrtc-transport/src/smallWebRTCTransport.ts
    // https://github.com/pipecat-ai/pipecat-client-web/blob/main/client-js/client/client.ts
    const baseSendReady = this.#transport.sendReadyMessage.bind(this.#transport);
    this.#transport.sendReadyMessage = () => {
      if (this.#transport.state !== "connected" || this.#mediaManager.isDisconnecting) return;
      baseSendReady();
    };
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
    return effectiveMediaState(this.#client.mediaState, this.#client.state, this.#hasLiveMic());
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

  get selectedMic(): PipecatClient["selectedMic"] {
    return this.#client.selectedMic;
  }

  enableMic(enable: boolean): void {
    this.#client.enableMic(enable);
    const track = this.#client.tracks().local.audio;
    if (track) track.enabled = this.#client.isMicEnabled;
  }

  tracks(): Tracks {
    // SmallWebRTCTransport.tracks() delegates to WavMediaManager.tracks(), which returns only
    // local tracks and leaves remote bot tracks in _incomingTracks.
    const base = this.#client.tracks();
    if (this.#botAudioTrack === undefined && this.#botVideoTrack === undefined) return base;
    return {
      ...base,
      bot: {
        ...base.bot,
        ...(this.#botAudioTrack === undefined ? {} : { audio: this.#botAudioTrack }),
        ...(this.#botVideoTrack === undefined ? {} : { video: this.#botVideoTrack }),
      },
    };
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

  /** Microphone `deviceId` most recently applied to the active call session, or `null` when none was applied. */
  get appliedMicId(): string | null {
    return this.#appliedMicId;
  }

  /** Records a preferred microphone `deviceId` for the next `connect()` without opening capture while idle. */
  setPreferredMic(deviceId: string | null | undefined): void {
    this.#preferredMicId = deviceId ?? null;
    this.#attemptedPreConnectMicId = null;
  }

  /**
   * Applies a persisted mic `deviceId` before `connect()`, awaiting `SmallWebRTCTransport.updateMic`
   * directly (which `PipecatClient.updateMic` drops), normalizing `"default"` to `""`, and skipping
   * unplugged hardware ids.
   */
  async applyMicPreference(persistedMicId: string | null | undefined): Promise<void> {
    this.#preferredMicId = persistedMicId ?? null;
    if (!persistedMicId || this.#mediaManager.isDisconnecting) {
      return;
    }
    const disconnectSnapshot = this.#lastDisconnectEpoch;
    const isStale = () =>
      this.#lastDisconnectEpoch !== disconnectSnapshot || this.#mediaManager.isDisconnecting;
    try {
      this.#attemptedPreConnectMicId = persistedMicId;
      if (persistedMicId !== SYSTEM_DEFAULT_MIC_ID) {
        const mics = await this.#client.getAllMics();
        if (isStale()) return;
        if (!mics.some((mic) => mic.deviceId === persistedMicId)) {
          this.#mediaManager.clearDeviceSelection();
          return;
        }
      }
      await this.#mediaManager.runPreConnectMic(() =>
        this.#transport.updateMic(toLiveMicId(persistedMicId)),
      );
      if (!isStale()) {
        this.#appliedMicId = this.#hasLiveMic() ? persistedMicId : null;
      }
    } catch {
      if (isStale()) return;
      if (!this.#hasLiveMic()) {
        this.#appliedMicId = null;
      }
      // Surfaced through connect() when fatal.
      await this.#client.initDevices().catch(() => {});
    } finally {
      if (isStale() && this.#connectEpoch === this.#lastDisconnectEpoch) {
        await this.#teardownStaleInit();
      }
    }
  }

  /** Swaps the live microphone mid-call; a no-op outside `connected` / `ready` so settings never open the mic. */
  async selectLiveMic(deviceId: string): Promise<void> {
    this.#preferredMicId = deviceId;
    if (!LIVE_SWAP_STATES.has(this.#client.state) || this.#mediaManager.isDisconnecting) return;
    const disconnectSnapshot = this.#lastDisconnectEpoch;
    try {
      await this.#transport.updateMic(toLiveMicId(deviceId));
    } catch (error) {
      if (this.#lastDisconnectEpoch === disconnectSnapshot && !this.#hasLiveMic()) {
        this.#appliedMicId = null;
      }
      throw error;
    }
    if (this.#lastDisconnectEpoch === disconnectSnapshot && !this.#mediaManager.isDisconnecting) {
      this.#appliedMicId = this.#hasLiveMic() ? deviceId : null;
    }
  }

  initDevices(): Promise<void> {
    return this.#client.initDevices();
  }

  async connect(options: EidolonConnectOptions): Promise<EidolonBotReadyData> {
    const requestParams = { webrtcRequestParams: toApiRequest(options) };
    if (
      this.#client.state === "authenticating" ||
      this.#client.state === "connecting" ||
      this.#client.state === "connected" ||
      this.#client.state === "ready"
    ) {
      return parseBotReadyData(await this.#client.connect(requestParams));
    }
    if (this.#activeConnectAttempt !== null) {
      throw new RTVIError(
        "Attempt to call connect when client already started. Please call disconnect() before starting again.",
      );
    }
    const attempt = ++this.#connectEpoch;
    this.#activeConnectAttempt = attempt;
    try {
      if (
        this.#preferredMicId &&
        this.#appliedMicId !== this.#preferredMicId &&
        this.#attemptedPreConnectMicId !== this.#preferredMicId
      ) {
        await this.applyMicPreference(this.#preferredMicId);
        if (this.#connectEpoch !== attempt) {
          if (this.#connectEpoch === this.#lastDisconnectEpoch) {
            await this.#teardownStaleInit();
          }
          throw connectionCancelledError();
        }
      }
      // PipecatClient.connect() awaits initDevices() outside its inner try/catch, leaving the
      // outer promise pending forever if AudioWorklet setup rejects; it also lacks a post-init
      // cancellation check if disconnect() ran while the permission prompt was open:
      // https://github.com/pipecat-ai/pipecat-client-web/blob/main/client-js/client/client.ts
      if (this.#client.needsInit()) {
        try {
          await this.initDevices();
        } catch (error) {
          if (this.#connectEpoch !== attempt) {
            if (this.#connectEpoch === this.#lastDisconnectEpoch) {
              await this.#teardownStaleInit();
            } else if (
              this.#activeConnectAttempt !== null &&
              this.#client.state === "initializing"
            ) {
              resetInitializingMediaState(this.#client);
            }
            throw connectionCancelledError();
          }
          this.#activeConnectAttempt = null;
          await this.disconnect();
          throw error;
        }
        if (this.#connectEpoch !== attempt) {
          if (this.#connectEpoch === this.#lastDisconnectEpoch) {
            await this.#teardownStaleInit();
          }
          throw connectionCancelledError();
        }
      }
      const pending = connectWithoutAutoInit(this.#client, requestParams);
      let rejectCancel!: (reason: unknown) => void;
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancel = reject;
      });
      const cancel = () => {
        rejectCancel(connectionCancelledError());
      };
      this.#cancelTransportConnect = cancel;
      void pending.catch(() => {});
      try {
        return parseBotReadyData(await Promise.race([pending, cancelled]));
      } catch (error) {
        if (this.#connectEpoch === attempt) {
          await this.#mediaManager.disconnect();
        }
        throw error;
      } finally {
        if (this.#cancelTransportConnect === cancel) {
          this.#cancelTransportConnect = null;
        }
      }
    } finally {
      if (this.#activeConnectAttempt === attempt) {
        this.#activeConnectAttempt = null;
      }
    }
  }

  async disconnect(): Promise<void> {
    this.#connectEpoch += 1;
    this.#lastDisconnectEpoch = this.#connectEpoch;
    this.#activeConnectAttempt = null;
    this.#appliedMicId = null;
    this.#attemptedPreConnectMicId = null;
    const cancelTransport = this.#cancelTransportConnect;
    this.#cancelTransportConnect = null;
    resolveLingeringInitializing(this.#client, { state: "uninitialized" });
    this.#mediaManager.markDisconnecting();
    try {
      await this.#client.disconnect();
    } finally {
      // SmallWebRTCTransport.stop() returns early when pc is null, skipping mediaManager.disconnect():
      // https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/transports/small-webrtc-transport/src/smallWebRTCTransport.ts
      await this.#mediaManager.disconnect();
      cancelTransport?.();
    }
  }

  async #teardownStaleInit(): Promise<void> {
    this.#mediaManager.markDisconnecting();
    try {
      if (this.#client.state !== "disconnected") {
        await this.#client.disconnect();
      }
    } finally {
      await this.#mediaManager.disconnect();
    }
  }

  async sendText(content: string, options?: SendTextOptions): Promise<string> {
    const runImmediately = options?.run_immediately !== false;
    if (!runImmediately) this.#pendingQueuedSends++;
    try {
      const msgId = await this.#client.sendText(content, options);
      if (this.#sentRunImmediately.size >= 128) {
        const oldest = this.#sentRunImmediately.keys().next().value;
        if (oldest !== undefined) this.#sentRunImmediately.delete(oldest);
      }
      this.#sentRunImmediately.set(msgId, runImmediately);
      return msgId;
    } finally {
      if (!runImmediately) this.#pendingQueuedSends--;
    }
  }

  /** Whether a sent text turn requested immediate interruption (`run_immediately !== false`). */
  wasTextSentImmediately(msgId?: string): boolean {
    if (msgId !== undefined) {
      const recorded = this.#sentRunImmediately.get(msgId);
      if (recorded !== undefined) return recorded;
    }
    return this.#pendingQueuedSends === 0;
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

  #hasLiveMic(): boolean {
    const audio = this.#client.tracks().local.audio;
    return audio !== undefined && audio.readyState !== "ended";
  }

  #replaceSenderTrack(track: MediaStreamTrack): void {
    const pc = this.getPeerConnection();
    const sender = pc?.getTransceivers()[0]?.sender;
    sender?.replaceTrack(track).catch(() => {});
  }

  #emitMediaStateIfChanged(next: MediaState): void {
    if (this.#lastEmittedMediaState && sameMediaState(this.#lastEmittedMediaState, next)) return;
    this.#lastEmittedMediaState = next;
    this.#emit("mediaStateUpdated", next);
  }

  #wireEvents(): void {
    for (const event of PASS_THROUGH_EVENTS) {
      this.#client.on(event as RTVIEvent, (...args: unknown[]) => {
        this.#emit(event, ...(args as Parameters<EidolonEventHandler<typeof event>>));
      });
    }

    // Overriding SmallWebRTCTransport's default DailyMediaManager with WavMediaManager drops its
    // internal replaceTrack callback, so live mic swaps must forward new local audio tracks onto
    // the audio transceiver's RTCRtpSender here:
    // https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/transports/small-webrtc-transport/src/smallWebRTCTransport.ts
    this.#client.on(
      RTVIEvent.TrackStarted,
      (track: MediaStreamTrack, participant?: Participant) => {
        if (participant?.local === true && this.#mediaManager.isDisconnecting) {
          track.stop();
          return;
        }
        if (participant?.local === true) {
          if (track.kind === "audio") {
            track.enabled = this.#client.isMicEnabled;
            this.#replaceSenderTrack(track);
          }
        } else if (track.kind === "audio") {
          this.#botAudioTrack = track;
        } else if (track.kind === "video") {
          this.#botVideoTrack = track;
        }
        this.#emit("trackStarted", track, participant);
        if (participant?.local === true && track.kind === "audio") {
          this.#emitMediaStateIfChanged(this.mediaState);
        }
      },
    );

    this.#client.on(
      RTVIEvent.TrackStopped,
      (track: MediaStreamTrack, participant?: Participant) => {
        if (participant?.local !== true) {
          if (
            track.kind === "audio" &&
            (!this.#botAudioTrack || this.#botAudioTrack.id === track.id)
          ) {
            this.#botAudioTrack = undefined;
          } else if (
            track.kind === "video" &&
            (!this.#botVideoTrack || this.#botVideoTrack.id === track.id)
          ) {
            this.#botVideoTrack = undefined;
          }
        }
        this.#emit("trackStopped", track, participant);
      },
    );

    this.#client.on(RTVIEvent.Disconnected, () => {
      this.#appliedMicId = null;
      this.#attemptedPreConnectMicId = null;
      this.#botAudioTrack = undefined;
      this.#botVideoTrack = undefined;
      this.#lastEmittedMediaState = undefined;
      this.#sentRunImmediately.clear();
      this.#emit("disconnected");
    });

    this.#client.on(RTVIEvent.TransportStateChanged, (state: TransportState) => {
      this.#emit("transportStateChanged", state);
      this.#emitMediaStateIfChanged(this.mediaState);
    });

    this.#client.on(RTVIEvent.MediaStateUpdated, (raw: MediaState) => {
      const next = effectiveMediaState(raw, this.#client.state, this.#hasLiveMic());
      this.#lastEmittedMediaState = next;
      this.#emit("mediaStateUpdated", next);
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
