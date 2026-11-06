// The microphone, checked before a call. WavMediaManager swallows a failed getUserMedia on its
// first start, before it listens for device errors, so a blocked mic would otherwise surface only
// as an opaque connect failure.

export type MicProblem = "denied" | "busy" | "missing" | "insecure" | "unknown";

const BY_ERROR_NAME = new Map<string, MicProblem>([
  ["NotAllowedError", "denied"],
  ["SecurityError", "denied"],
  ["NotReadableError", "busy"],
  ["NotFoundError", "missing"],
  ["OverconstrainedError", "missing"],
]);

const BY_DEVICE_ERROR_TYPE = new Map<string, MicProblem>([
  ["permissions", "denied"],
  ["in-use", "busy"],
  ["not-found", "missing"],
  ["constraints", "missing"],
  ["undefined-mediadevices", "insecure"],
]);

/** What a getUserMedia rejection means for the viewer. */
export function micProblemOf(error: unknown): MicProblem {
  const name =
    typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  return BY_ERROR_NAME.get(name) ?? "unknown";
}

/** A DeviceError mid-call. WavMediaManager types every one "unknown" and attaches the cause. */
export function deviceProblemOf(error: {
  readonly type: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): MicProblem {
  const cause = error.details?.sourceError;
  const problem = cause === undefined ? "unknown" : micProblemOf(cause);
  return problem !== "unknown" ? problem : (BY_DEVICE_ERROR_TYPE.get(error.type) ?? "unknown");
}

/** Opens the mic once and lets it go: null when a call can use it, else what stands in the way. */
export async function probeMic(
  media: Pick<MediaDevices, "getUserMedia"> | undefined,
): Promise<MicProblem | null> {
  // Browsers leave navigator.mediaDevices undefined outside a secure context.
  if (media === undefined) return "insecure";
  try {
    const stream = await media.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (error) {
    return micProblemOf(error);
  }
}
