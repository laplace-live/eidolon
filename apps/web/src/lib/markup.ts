// Fish Audio delivery cues in the bot's replies, written the way personas' prompts ask for them:
// `[…]` directions and cues, and paired word tags such as `<whisper>…</whisper>`. The TTS never
// says them, so the transcript turns them into chips or drops them, and never renders them as HTML.

/** The paired word tags Drama 3 reads; each restyles the words it wraps. */
export const PAIRED_TAGS = [
  "whisper",
  "emphasis",
  "soft",
  "fast",
  "slow",
  "stress",
  "forceful",
] as const;
export type PairedTag = (typeof PAIRED_TAGS)[number];

/** A piece of a reply, at `start` in the parsed text. */
export type MarkupToken =
  | {
      readonly kind: "text";
      readonly start: number;
      readonly text: string;
      /** The paired tags open around these words, outermost first. */
      readonly tags: readonly PairedTag[];
    }
  /** A cue from Fish's fixed vocabulary, shown as its emoji. */
  | { readonly kind: "cue"; readonly start: number; readonly name: string; readonly emoji: string }
  /** A free-form direction, such as `[温柔地安慰]`, shown as written. */
  | { readonly kind: "direction"; readonly start: number; readonly text: string };

// Fish's fixed English cues (sounds, emotions and tones), which Drama 3 still reads; synonyms
// share an emoji, and the chip's label carries the exact word.
const CUE_EMOJI = new Map<string, string>([
  ["chuckling", "😄"],
  ["laughing", "😆"],
  ["sighing", "😮‍💨"],
  ["gasping", "😯"],
  ["panting", "🥵"],
  ["yawning", "🥱"],
  ["groaning", "😩"],
  ["snoring", "😴"],
  ["sobbing", "😭"],
  ["crying loudly", "😭"],
  ["happy", "😊"],
  ["excited", "🤩"],
  ["delighted", "😃"],
  ["satisfied", "😋"],
  ["relaxed", "😎"],
  ["grateful", "🙏"],
  ["proud", "🥹"],
  ["moved", "🥹"],
  ["calm", "😌"],
  ["curious", "🤨"],
  ["empathetic", "🥺"],
  ["sympathetic", "🥺"],
  ["compassionate", "🤗"],
  ["surprised", "😲"],
  ["embarrassed", "😳"],
  ["nostalgic", "🥲"],
  ["lonely", "😔"],
  ["regretful", "😣"],
  ["disappointed", "😞"],
  ["uncertain", "😕"],
  ["confused", "😕"],
  ["doubtful", "🤔"],
  ["worried", "😟"],
  ["hopeful", "🤞"],
  ["optimistic", "🌞"],
  ["sarcastic", "😏"],
  ["confident", "😎"],
  ["determined", "😤"],
  ["indifferent", "😐"],
  ["sad", "😢"],
  ["angry", "😠"],
  ["frustrated", "😖"],
  ["unhappy", "🙁"],
  ["in a hurry tone", "⏱️"],
  ["shouting", "📢"],
  ["screaming", "😱"],
  ["whispering", "🤫"],
  ["soft tone", "🥰"],
]);

/** Pauses land as silence, so they show as nothing. */
const PAUSES = new Set(["break", "long-break"]);

const MARKUP = /\[([^[\]\n]+)\]|<(\/?)([A-Za-z]+)>/g;

function isPairedTag(name: string): name is PairedTag {
  return (PAIRED_TAGS as readonly string[]).includes(name);
}

/** The length of the spaces at `from`, short of a line break. */
function spacesAt(text: string, from: number): number {
  let end = from;
  while (end < text.length && " \t\u3000".includes(text[end]!)) end++;
  return end - from;
}

/**
 * Splits a reply into words, cue chips and directions. Paired tags restyle the words between
 * them, unknown tags and pauses vanish, and anything that isn't markup stays text.
 */
export function parseMarkup(source: string): MarkupToken[] {
  const tokens: MarkupToken[] = [];
  const open: PairedTag[] = [];
  let cursor = 0;
  const pushText = (end: number) => {
    if (end > cursor) {
      tokens.push({
        kind: "text",
        start: cursor,
        text: source.slice(cursor, end),
        tags: [...open],
      });
    }
  };

  for (const match of source.matchAll(MARKUP)) {
    const [whole, cue, slash, tag] = match;
    pushText(match.index);
    cursor = match.index + whole.length;
    if (cue !== undefined) {
      const text = cue.trim();
      const name = text.toLowerCase();
      const emoji = CUE_EMOJI.get(name);
      if (emoji !== undefined) tokens.push({ kind: "cue", start: match.index, name, emoji });
      else if (text !== "" && !PAUSES.has(name)) {
        tokens.push({ kind: "direction", start: match.index, text });
      } else {
        // A cue that shows as nothing would leave the space after it behind.
        cursor += spacesAt(source, cursor);
      }
      continue;
    }
    const name = tag!.toLowerCase();
    if (!isPairedTag(name)) continue;
    if (slash) {
      const at = open.lastIndexOf(name);
      if (at !== -1) open.splice(at, 1);
    } else if (!open.includes(name)) {
      open.push(name);
    }
  }
  pushText(source.length);
  return tokens;
}
