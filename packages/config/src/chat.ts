// How the active persona joins a group chat: what the director weighs her by. withPersona picks
// whose settings these read.
import { envFloat, envOptional } from "./env.ts";

export const DEFAULT_CHAT_TALKATIVENESS = 0.5;

/** The topics her chat.interests names, split at commas and 、; none when unset. */
export function chatInterests(): string[] {
  return (envOptional("CHAT_INTERESTS") ?? "")
    .split(/[,，、]/)
    .map((topic) => topic.trim())
    .filter((topic) => topic !== "");
}

/** Her chat.talkativeness, clamped to 0–1; the default when unset or not a number. */
export function chatTalkativeness(): number {
  const value = envFloat("CHAT_TALKATIVENESS", DEFAULT_CHAT_TALKATIVENESS);
  return Number.isNaN(value) ? DEFAULT_CHAT_TALKATIVENESS : Math.min(1, Math.max(0, value));
}
