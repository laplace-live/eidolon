// How the active persona joins a chat: what the director weighs her by, whether she answers in text
// or voice, and how many rounds her reply may take. withPersona picks whose settings these read,
// but for chats.display, the install's.
import { envFloat, envInt, envOptional } from "./env.ts";
import { logger } from "./logger.ts";
import { pyRepr } from "./py.ts";

export const DEFAULT_CHAT_TALKATIVENESS = 0.5;

const REPLY_MODES = ["auto", "text", "voice"] as const;
export const DEFAULT_CHAT_REPLY_MODE = "auto";

const CHAT_DISPLAYS = ["focus", "normal", "verbose"] as const;
export const DEFAULT_CHAT_DISPLAY = "normal";

export const DEFAULT_CHAT_MAX_ROUNDS = 8;

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

/**
 * The app's chats.display, for a chat that sets none, any case; normal when unset or none of the
 * three, which warns.
 */
export function chatDisplay(): (typeof CHAT_DISPLAYS)[number] {
  const raw = envOptional("CHAT_DISPLAY");
  if (raw === undefined) return DEFAULT_CHAT_DISPLAY;
  const display = CHAT_DISPLAYS.find((known) => known === raw.trim().toLowerCase());
  if (display !== undefined) return display;
  logger.warning(
    `CHAT_DISPLAY=${pyRepr(raw)} is not focus, normal or verbose; using ${DEFAULT_CHAT_DISPLAY}`,
  );
  return DEFAULT_CHAT_DISPLAY;
}

/**
 * Her chat.maxRounds: how many rounds of one reply may call tools; the default when unset, and when
 * below 1, which warns.
 */
export function chatMaxRounds(): number {
  const rounds = envInt("CHAT_MAX_ROUNDS", DEFAULT_CHAT_MAX_ROUNDS);
  if (rounds >= 1) return rounds;
  const raw = pyRepr(envOptional("CHAT_MAX_ROUNDS"));
  logger.warning(`CHAT_MAX_ROUNDS=${raw} is below 1; using default ${DEFAULT_CHAT_MAX_ROUNDS}`);
  return DEFAULT_CHAT_MAX_ROUNDS;
}
