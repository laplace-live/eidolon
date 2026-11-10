// The Group Chats card's talkativeness: what the slider shows for a draft, as the director reads it.

/** @eidolon/config's DEFAULT_CHAT_TALKATIVENESS: hers while neither her file nor the environment sets one. */
export const DEFAULT_TALKATIVENESS = 0.5;

/** The slider's step. */
export const TALKATIVENESS_STEP = 0.05;

function parsed(text: string | null): number | null {
  if (text === null || text.trim() === "") return null;
  const value = Number(text.normalize("NFKC").trim());
  return Number.isNaN(value) ? null : value;
}

/**
 * Her talkativeness as a draft leaves it: the draft's, else the environment's she inherits, else the
 * default, clamped to 0–1 as the bot clamps it. A value that isn't a number counts as unset.
 */
export function talkativenessOf(draft: string, envValue: string | null): number {
  const value = parsed(draft) ?? parsed(envValue) ?? DEFAULT_TALKATIVENESS;
  return Math.min(1, Math.max(0, value));
}
