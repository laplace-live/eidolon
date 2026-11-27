// What keeps /call from calling the active persona: what /call shows in its place, and what the
// desktop companion's menu reads to offer Call.
import type { Status } from "@/lib/api";

export type CallBlocker = "off" | "keys" | "roles" | "voice";

/** What keeps /call from calling her, in the order /call shows it; null when nothing does. */
export function callBlocker(status: Pick<Status, "keys" | "call" | "persona">): CallBlocker | null {
  if (
    !status.call.realtime &&
    status.call.roles.some((role) => role.provider === null && role.problem === null)
  ) {
    return "off";
  }
  if (status.keys.some((key) => !key.set)) return "keys";
  if (status.call.roles.some((role) => role.problem !== null)) return "roles";
  // A realtime model speaks in its own voice, so only a call with a voice role needs one.
  if (
    status.persona.voice.id === null &&
    !status.call.realtime &&
    status.persona.voice.provider !== "openai-compatible" &&
    status.persona.voice.provider !== "fish-speech"
  ) {
    return "voice";
  }
  return null;
}
