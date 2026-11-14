import type { DeviceStatus, MediaState, TransportState } from "./types.ts";

/** Virtual `deviceId` browsers expose for the OS default microphone. */
export const SYSTEM_DEFAULT_MIC_ID = "default";

/** Transport states in which `updateMic` swaps an already-live recorder stream. */
export const LIVE_SWAP_STATES: ReadonlySet<TransportState> = new Set(["connected", "ready"]);

export function sameDeviceStatus(a: DeviceStatus, b: DeviceStatus): boolean {
  if (a.state !== b.state) return false;
  if (a.state === "error" && b.state === "error") {
    return a.reason === b.reason && Object.is(a.details, b.details);
  }
  return true;
}

export function sameMediaState(a: MediaState, b: MediaState): boolean {
  return sameDeviceStatus(a.mic, b.mic) && sameDeviceStatus(a.cam, b.cam);
}

/**
 * Translates a UI `deviceId` for `SmallWebRTCTransport.updateMic`: Firefox and Safari reject
 * `{ exact: "default" }` with `OverconstrainedError`, whereas `""` requests `{ audio: true }`.
 */
export function toLiveMicId(deviceId: string): string {
  return deviceId === SYSTEM_DEFAULT_MIC_ID ? "" : deviceId;
}

/** Enumerates audio inputs without triggering a permission prompt, dropping Windows' `communications` alias. */
export async function enumerateAudioInputs(
  mediaDevices: Pick<MediaDevices, "enumerateDevices"> | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator.mediaDevices,
): Promise<MediaDeviceInfo[]> {
  if (!mediaDevices?.enumerateDevices) return [];
  const devices = await mediaDevices.enumerateDevices();
  return devices.filter(
    (device) =>
      device.kind === "audioinput" &&
      device.deviceId !== "" &&
      device.deviceId !== "communications",
  );
}

/** Resolves the active picker `deviceId`: persisted preference when still present, else `"default"`, else first mic. */
export function resolveSelectedMicId(
  mics: readonly MediaDeviceInfo[],
  persistedMicId: string | null | undefined,
): string | undefined {
  if (persistedMicId && mics.some((mic) => mic.deviceId === persistedMicId)) return persistedMicId;
  if (mics.some((mic) => mic.deviceId === SYSTEM_DEFAULT_MIC_ID)) return SYSTEM_DEFAULT_MIC_ID;
  return mics[0]?.deviceId;
}
