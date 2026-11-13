import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  enumerateAudioInputs,
  LIVE_SWAP_STATES,
  resolveSelectedMicId,
  SYSTEM_DEFAULT_MIC_ID,
} from "../call/devices.ts";
import { useEidolonTransportState } from "./hooks.ts";
import { useOptionalEidolonClient } from "./provider.tsx";

export interface UseEidolonMicDevicesOptions {
  readonly persistedMicId?: string | null;
  readonly onPersistMicId?: (deviceId: string) => void;
}

export interface EidolonMicDevices {
  readonly mics: readonly MediaDeviceInfo[];
  readonly selectedMicId: string | undefined;
  readonly selectMic: (deviceId: string) => void;
  readonly canLiveSwap: boolean;
  readonly hasMicChoice: boolean;
  readonly swapError: Error | null;
}

export function runLiveMicSwap(
  client: { selectLiveMic(deviceId: string): Promise<void> } | null,
  deviceId: string,
  callbacks: {
    readonly isCurrent?: () => boolean;
    readonly onError: (error: Error) => void;
    readonly onSettled?: () => void;
  },
): void {
  if (client === null) return;
  const isCurrent = callbacks.isCurrent ?? (() => true);
  client
    .selectLiveMic(deviceId)
    .catch((error: unknown) => {
      if (!isCurrent()) return;
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    })
    .finally(() => {
      callbacks.onSettled?.();
    });
}

function sameMics(a: readonly MediaDeviceInfo[], b: readonly MediaDeviceInfo[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (mic, i) =>
        mic.deviceId === b[i]?.deviceId &&
        mic.label === b[i]?.label &&
        mic.groupId === b[i]?.groupId &&
        mic.kind === b[i]?.kind,
    )
  );
}

/** Enumerates microphones without triggering a permission prompt and swaps live only mid-call. */
export function useEidolonMicDevices({
  persistedMicId,
  onPersistMicId,
}: UseEidolonMicDevicesOptions = {}): EidolonMicDevices {
  const client = useOptionalEidolonClient();
  const transportState = useEidolonTransportState();
  const canLiveSwap = client !== null && LIVE_SWAP_STATES.has(transportState);
  const [mics, setMics] = useState<readonly MediaDeviceInfo[]>([]);
  const [localMicId, setLocalMicId] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<Error | null>(null);
  const activeClientRef = useRef(client);
  const micsRef = useRef(mics);
  const pendingPreConnectMicRef = useRef<string | null>(null);
  const swapGenerationRef = useRef(0);
  const inFlightSwapsRef = useRef(new Set<symbol>());

  useEffect(() => {
    micsRef.current = mics;
  }, [mics]);

  const effectiveMicId = persistedMicId !== undefined ? persistedMicId : localMicId;

  useEffect(() => {
    client?.setPreferredMic(effectiveMicId);
  }, [client, effectiveMicId]);

  const startTrackedSwap = useCallback(
    (targetClient: NonNullable<typeof client>, deviceId: string, generation: number) => {
      const token = Symbol();
      inFlightSwapsRef.current.add(token);
      runLiveMicSwap(targetClient, deviceId, {
        isCurrent: () =>
          activeClientRef.current === targetClient && swapGenerationRef.current === generation,
        onError: setSwapError,
        onSettled: () => {
          inFlightSwapsRef.current.delete(token);
        },
      });
    },
    [],
  );

  useEffect(() => {
    activeClientRef.current = client;
    pendingPreConnectMicRef.current = null;
    const resetSwapState = () => {
      swapGenerationRef.current += 1;
      inFlightSwapsRef.current.clear();
      setSwapError(null);
    };
    resetSwapState();
    const onConnected = () => {
      resetSwapState();
      if (client === null) return;
      const pending = pendingPreConnectMicRef.current;
      pendingPreConnectMicRef.current = null;
      if (pending === null) return;
      if (
        pending !== SYSTEM_DEFAULT_MIC_ID &&
        micsRef.current.length > 0 &&
        !micsRef.current.some((mic) => mic.deviceId === pending)
      ) {
        return;
      }
      const currentApplied =
        client.appliedMicId ?? (client.selectedMic.deviceId || SYSTEM_DEFAULT_MIC_ID);
      if (currentApplied === pending) return;
      startTrackedSwap(client, pending, ++swapGenerationRef.current);
    };
    const onDisconnected = () => {
      pendingPreConnectMicRef.current = null;
      resetSwapState();
    };
    const offResetConnected = client?.on("connected", onConnected);
    const offResetDisconnected = client?.on("disconnected", onDisconnected);
    const offDeviceError = client?.on("deviceError", (error) => {
      if (inFlightSwapsRef.current.size > 0) setSwapError(error);
    });
    const teardownSwapListeners = () => {
      activeClientRef.current = null;
      pendingPreConnectMicRef.current = null;
      swapGenerationRef.current += 1;
      inFlightSwapsRef.current.clear();
      offResetConnected?.();
      offResetDisconnected?.();
      offDeviceError?.();
    };

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return teardownSwapListeners;
    }
    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await enumerateAudioInputs(navigator.mediaDevices);
        if (!cancelled) setMics((prev) => (sameMics(prev, next) ? prev : next));
      } catch {
        // Non-HTTPS or blocked mediaDevices leaves `mics` empty.
      }
    };

    void refresh();
    const onDeviceChange = () => {
      void refresh();
    };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    // Granting getUserMedia permission reveals deviceIds without firing a DOM devicechange event.
    const offConnected = client?.on("connected", onDeviceChange);
    const offAvailable = client?.on("availableMicsUpdated", onDeviceChange);
    const offTrack = client?.on("trackStarted", (track, participant) => {
      if (participant?.local === true && track.kind === "audio") void refresh();
    });
    return () => {
      cancelled = true;
      teardownSwapListeners();
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      offConnected?.();
      offAvailable?.();
      offTrack?.();
    };
  }, [client, startTrackedSwap]);

  const selectedMicId = useMemo(
    () => resolveSelectedMicId(mics, effectiveMicId),
    [mics, effectiveMicId],
  );

  const selectMic = useCallback(
    (deviceId: string) => {
      setLocalMicId(deviceId);
      onPersistMicId?.(deviceId);
      const generation = ++swapGenerationRef.current;
      setSwapError(null);
      if (client === null) return;
      client.setPreferredMic(deviceId);
      pendingPreConnectMicRef.current = LIVE_SWAP_STATES.has(client.state) ? null : deviceId;
      startTrackedSwap(client, deviceId, generation);
    },
    [client, onPersistMicId, startTrackedSwap],
  );

  return useMemo(
    () => ({
      mics,
      selectedMicId,
      selectMic,
      canLiveSwap,
      hasMicChoice: mics.length > 1,
      swapError,
    }),
    [canLiveSwap, mics, selectMic, selectedMicId, swapError],
  );
}
