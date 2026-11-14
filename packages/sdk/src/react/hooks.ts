import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIVE_SWAP_STATES, sameMediaState } from "../call/devices.ts";
import type { NetworkInfo } from "../call/stats.ts";
import type {
  EidolonEventHandler,
  EidolonEventName,
  MediaState,
  TransportState,
} from "../call/types.ts";
import { type WaitState, Watchdog } from "../watchdog.ts";
import { useEidolonClient, useOptionalEidolonClient } from "./provider.tsx";

const FALLBACK_MEDIA_STATE: MediaState = {
  mic: { state: "uninitialized" },
  cam: { state: "uninitialized" },
};

/** Subscribes `handler` to a typed `EidolonClient` event without re-subscribing on inline closures. */
export function useEidolonEvent<E extends EidolonEventName>(
  event: E,
  handler: EidolonEventHandler<E>,
): void {
  const client = useOptionalEidolonClient();
  const handlerRef = useRef<EidolonEventHandler<E>>(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (client === null) return;
    const listener = ((...args: Parameters<EidolonEventHandler<E>>) => {
      (handlerRef.current as (...inner: Parameters<EidolonEventHandler<E>>) => void)(...args);
    }) as EidolonEventHandler<E>;
    return client.on(event, listener);
  }, [client, event]);
}

export function useEidolonTransportState(): TransportState {
  const client = useOptionalEidolonClient();
  const [state, setState] = useState<TransportState>(() => client?.state ?? "disconnected");

  useEffect(() => {
    if (client === null) {
      setState("disconnected");
      return;
    }
    setState(client.state);
    return client.on("transportStateChanged", setState);
  }, [client]);

  return state;
}

export interface EidolonMicControl {
  readonly enableMic: (enabled: boolean) => void;
  readonly isMicEnabled: boolean;
}

export function useEidolonMicControl(): EidolonMicControl {
  const client = useEidolonClient();
  const [isMicEnabled, setIsMicEnabled] = useState<boolean>(() => client.isMicEnabled);

  useEffect(() => {
    setIsMicEnabled(client.isMicEnabled);
    const sync = () => setIsMicEnabled(client.isMicEnabled);
    const offEnabled = client.on("micEnabledUpdated", setIsMicEnabled);
    const offMuteStarted = client.on("userMuteStarted", sync);
    const offMuteStopped = client.on("userMuteStopped", sync);
    const offState = client.on("transportStateChanged", sync);
    const offMic = client.on("micUpdated", sync);
    return () => {
      offEnabled();
      offMuteStarted();
      offMuteStopped();
      offState();
      offMic();
    };
  }, [client]);

  const enableMic = useCallback((enabled: boolean) => client.enableMic(enabled), [client]);

  return useMemo(() => ({ enableMic, isMicEnabled }), [enableMic, isMicEnabled]);
}

export function useEidolonMediaState(): MediaState {
  const client = useOptionalEidolonClient();
  const [mediaState, setMediaState] = useState<MediaState>(
    () => client?.mediaState ?? FALLBACK_MEDIA_STATE,
  );

  useEffect(() => {
    const update = (next: MediaState) => {
      setMediaState((prev) => (sameMediaState(prev, next) ? prev : next));
    };
    if (client === null) {
      update(FALLBACK_MEDIA_STATE);
      return;
    }
    const sync = () => update(client.mediaState);
    sync();
    const offMedia = client.on("mediaStateUpdated", update);
    const offDeviceError = client.on("deviceError", sync);
    const offMic = client.on("micUpdated", sync);
    return () => {
      offMedia();
      offDeviceError();
      offMic();
    };
  }, [client]);

  return mediaState;
}

export function useEidolonMediaTrack(
  trackType: "audio" | "video",
  participantType: "local" | "bot",
): MediaStreamTrack | null {
  const client = useOptionalEidolonClient();
  const readTrack = useCallback((): MediaStreamTrack | null => {
    if (client === null) return null;
    const group = participantType === "local" ? client.tracks().local : client.tracks().bot;
    return (trackType === "audio" ? group?.audio : group?.video) ?? null;
  }, [client, participantType, trackType]);

  const [track, setTrack] = useState<MediaStreamTrack | null>(readTrack);

  useEffect(() => {
    setTrack(readTrack());
    if (client === null) return;
    const matchesParticipant = (participant?: { readonly local?: boolean }) =>
      (participant?.local === true) === (participantType === "local");
    const offStarted = client.on("trackStarted", (next, participant) => {
      if (next.kind === trackType && matchesParticipant(participant)) {
        setTrack(next);
      }
    });
    const offStopped = client.on("trackStopped", (stopped, participant) => {
      if (stopped.kind === trackType && matchesParticipant(participant)) {
        setTrack((prev) => {
          const fallback = readTrack();
          if (fallback && fallback.id !== stopped.id) return fallback;
          return prev && prev.id !== stopped.id ? prev : null;
        });
      }
    });
    const offDisconnected = client.on("disconnected", () => setTrack(null));
    return () => {
      offStarted();
      offStopped();
      offDisconnected();
    };
  }, [client, participantType, readTrack, trackType]);

  return track;
}

export interface UseEidolonNetworkInfoOptions {
  readonly enabled: boolean;
  readonly intervalMs?: number;
}

/** Polls the active ICE candidate pair while `enabled` and the call is live (`connected` or `ready`). */
export function useEidolonNetworkInfo({
  enabled,
  intervalMs = 2000,
}: UseEidolonNetworkInfoOptions): NetworkInfo | null {
  const client = useOptionalEidolonClient();
  const transportState = useEidolonTransportState();
  const isLive = LIVE_SWAP_STATES.has(transportState);
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const prevClientRef = useRef(client);

  useEffect(() => {
    const clientChanged = prevClientRef.current !== client;
    prevClientRef.current = client;
    if (!enabled || !isLive || client === null || clientChanged) {
      setInfo(null);
    }
    if (!enabled || !isLive || client === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (cancelled) return;
      try {
        const snapshot = await client.gatherNetworkInfo();
        if (!cancelled) setInfo(snapshot);
      } catch {
        // Closed peer connections settle on the next transportStateChanged.
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, enabled, intervalMs, isLive]);

  return enabled && isLive ? info : null;
}

export interface EidolonWatchdogControls extends WaitState {
  readonly arm: () => void;
  readonly llmStarted: () => void;
  readonly clear: () => void;
}

/** Post-utterance `thinking` and `stuck` timers with automatic unmount teardown. */
export function useEidolonWatchdog(): EidolonWatchdogControls {
  const [state, setState] = useState<WaitState>({ thinking: false, stuck: false });
  const [watchdog] = useState(() => new Watchdog(setState));

  useEffect(() => () => watchdog.clear(), [watchdog]);

  const arm = useCallback(() => watchdog.arm(), [watchdog]);
  const llmStarted = useCallback(() => watchdog.llmStarted(), [watchdog]);
  const clear = useCallback(() => watchdog.clear(), [watchdog]);

  return useMemo(
    () => ({ thinking: state.thinking, stuck: state.stuck, arm, llmStarted, clear }),
    [arm, clear, llmStarted, state.stuck, state.thinking],
  );
}
