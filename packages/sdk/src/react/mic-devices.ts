import { useCallback, useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
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
      if (client !== null) {
        void client.selectLiveMic(deviceId);
      }
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
    }),
    [canLiveSwap, mics, selectMic, selectedMicId],
  );
}
