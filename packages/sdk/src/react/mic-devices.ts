import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { enumerateAudioInputs, LIVE_SWAP_STATES, resolveSelectedMicId } from "../call/devices.ts";
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
  const mountedRef = useRef(true);
  const activeClientRef = useRef(client);
  const swapGenerationRef = useRef(0);
  const inFlightSwapsRef = useRef(new Set<symbol>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activeClientRef.current = client;
    const resetSwapState = () => {
      swapGenerationRef.current += 1;
      inFlightSwapsRef.current.clear();
      setSwapError(null);
    };
    resetSwapState();
    const offResetConnected = client?.on("connected", resetSwapState);
    const offResetDisconnected = client?.on("disconnected", resetSwapState);
    const offDeviceError = client?.on("deviceError", (error) => {
      if (inFlightSwapsRef.current.size > 0) setSwapError(error);
    });

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return () => {
        activeClientRef.current = null;
        swapGenerationRef.current += 1;
        inFlightSwapsRef.current.clear();
        offResetConnected?.();
        offResetDisconnected?.();
        offDeviceError?.();
      };
    }
    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await enumerateAudioInputs(navigator.mediaDevices);
        if (!cancelled) setMics(next);
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
      activeClientRef.current = null;
      swapGenerationRef.current += 1;
      inFlightSwapsRef.current.clear();
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      offResetConnected?.();
      offResetDisconnected?.();
      offDeviceError?.();
      offConnected?.();
      offAvailable?.();
      offTrack?.();
    };
  }, [client]);

  const effectiveMicId = persistedMicId !== undefined ? persistedMicId : localMicId;
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
      const token = Symbol();
      inFlightSwapsRef.current.add(token);
      runLiveMicSwap(client, deviceId, {
        isCurrent: () =>
          mountedRef.current &&
          activeClientRef.current === client &&
          swapGenerationRef.current === generation,
        onError: setSwapError,
        onSettled: () => {
          inFlightSwapsRef.current.delete(token);
        },
      });
    },
    [client, onPersistMicId],
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
