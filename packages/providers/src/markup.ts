// The delivery cues a persona's prompt teaches her (Fish Drama 3's `[…]` directions and paired word
// tags), taken out of what a TTS that can't read them would otherwise say aloud.
import type { Markup } from "./catalog.ts";

const PAIRED_TAG = /<\/?(?:whisper|emphasis|soft|fast|slow|stress|forceful)>/gi;
const BRACKETS = /\[[^[\]\n]*\]/g;

/** `text` as a TTS reading `markup` should get it; undefined reads no cues at all. */
export function stripMarkup(text: string, markup: Markup | undefined): string {
  if (markup === "fish-drama") return text;
  let out = text.replace(PAIRED_TAG, "");
  if (markup !== "brackets") out = out.replace(BRACKETS, "");
  return out === text ? text : out.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+/, "");
}
