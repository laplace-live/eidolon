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
    readonly onError: (error: Error) => void;
    readonly onSettled?: () => void;
  },
): void {
  if (client === null) return;
  client
    .selectLiveMic(deviceId)
    .catch((error: unknown) => {
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
  const [swapError, setSwapError] = useState<Error | null>(null);
  const mountedRef = useRef(true);
  const swappingRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setSwapError(null);
    const offResetConnected = client?.on("connected", () => setSwapError(null));
    const offResetDisconnected = client?.on("disconnected", () => setSwapError(null));
    const offDeviceError = client?.on("deviceError", (error) => {
      if (swappingRef.current > 0) setSwapError(error);
    });

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return () => {
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
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      offResetConnected?.();
      offResetDisconnected?.();
      offDeviceError?.();
      offConnected?.();
      offAvailable?.();
      offTrack?.();
    };
  }, [client]);

  const selectedMicId = useMemo(
    () => resolveSelectedMicId(mics, persistedMicId),
    [mics, persistedMicId],
  );

  const selectMic = useCallback(
    (deviceId: string) => {
      onPersistMicId?.(deviceId);
      setSwapError(null);
      if (client === null) return;
      swappingRef.current += 1;
      runLiveMicSwap(client, deviceId, {
        onError: (error) => {
          if (mountedRef.current) setSwapError(error);
        },
        onSettled: () => {
          swappingRef.current = Math.max(0, swappingRef.current - 1);
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
