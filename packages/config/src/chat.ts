// How the active persona joins a chat: what the director weighs her by, and whether she answers in
// text or voice. withPersona picks whose settings these read.
import { envFloat, envOptional } from "./env.ts";
import { logger } from "./logger.ts";
import { pyRepr } from "./py.ts";

export const DEFAULT_CHAT_TALKATIVENESS = 0.5;

const REPLY_MODES = ["auto", "text", "voice"] as const;
export const DEFAULT_CHAT_REPLY_MODE = "auto";

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

/** Her chat.replyMode, any case; auto when unset or none of the three, which warns. */
export function chatReplyMode(): (typeof REPLY_MODES)[number] {
  const raw = envOptional("CHAT_REPLY_MODE");
  if (raw === undefined) return DEFAULT_CHAT_REPLY_MODE;
  const mode = REPLY_MODES.find((known) => known === raw.trim().toLowerCase());
  if (mode !== undefined) return mode;
  logger.warning(
    `CHAT_REPLY_MODE=${pyRepr(raw)} is not auto, text or voice; using ${DEFAULT_CHAT_REPLY_MODE}`,
  );
  return DEFAULT_CHAT_REPLY_MODE;
}
