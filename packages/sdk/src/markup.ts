// Fish Audio delivery cues in the bot's replies: `[…]` cues and directions, and paired word tags
// such as `<whisper>…</whisper>`. TTS never speaks them aloud, so transcripts turn them into chips
// or styled spans and never render them as HTML.

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
  | { readonly kind: "cue"; readonly start: number; readonly name: string; readonly emoji: string }
  | { readonly kind: "direction"; readonly start: number; readonly text: string };

/** Fish's fixed English cues (sounds, emotions, and tones) mapped to emoji chips. */
export const CUE_EMOJI: ReadonlyMap<string, string> = new Map<string, string>([
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

const PAUSES = new Set(["break", "long-break"]);

const MARKUP = /\[([^[\]\n]+)\]|<(\/?)([A-Za-z]+)>/g;

const CUE = /\[[^[\]\n]+\]|<\/?[A-Za-z]+>/g;

const TRAILING_PARTIAL_CUE = /(\[[^[\]\n]*|<\/?[A-Za-z]*)$/;

export function cueEmoji(name: string): string | undefined {
  return CUE_EMOJI.get(name.trim().toLowerCase());
}

export function isPauseCue(name: string): boolean {
  return PAUSES.has(name.trim().toLowerCase());
}

export function isPairedTag(name: string): name is PairedTag {
  return (PAIRED_TAGS as readonly string[]).includes(name);
}

function spacesAt(text: string, from: number): number {
  let end = from;
  while (end < text.length && " \t\u3000".includes(text[end] ?? "")) end++;
  return end - from;
}

export interface ParseMarkupOptions {
  /** Paired tags already open before `source` begins (e.g. carried across spoken/unspoken parts). */
  readonly initialTags?: readonly PairedTag[];
  /** Whether free-form `[directions]` outside `CUE_EMOJI` emit `"direction"` tokens or vanish. */
  readonly directions?: "keep" | "drop";
}

export interface ParseMarkupResult {
  readonly tokens: MarkupToken[];
  readonly openTags: PairedTag[];
}

/**
 * Splits a reply into words, cue chips, and optional directions, returning both the tokens and the
 * paired tags still open at the end of `source`.
 */
export function parseMarkupWithState(
  source: string,
  options: ParseMarkupOptions = {},
): ParseMarkupResult {
  const keepDirections = (options.directions ?? "keep") === "keep";
  const tokens: MarkupToken[] = [];
  const open: PairedTag[] = [...(options.initialTags ?? [])];
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
    const index = match.index ?? 0;
    pushText(index);
    cursor = index + whole.length;
    if (cue !== undefined) {
      const text = cue.trim();
      const name = text.toLowerCase();
      const emoji = CUE_EMOJI.get(name);
      if (emoji !== undefined) {
        tokens.push({ kind: "cue", start: index, name, emoji });
      } else if (keepDirections && text !== "" && !PAUSES.has(name)) {
        tokens.push({ kind: "direction", start: index, text });
      } else {
        // A cue that renders as nothing would otherwise leave its trailing space behind.
        cursor += spacesAt(source, cursor);
      }
      continue;
    }
    const name = (tag ?? "").toLowerCase();
    if (!isPairedTag(name)) continue;
    if (slash) {
      const at = open.lastIndexOf(name);
      if (at !== -1) open.splice(at, 1);
    } else if (!open.includes(name)) {
      open.push(name);
    }
  }
  pushText(source.length);
  return { tokens, openTags: open };
}

export function parseMarkup(source: string, options?: ParseMarkupOptions): MarkupToken[] {
  return parseMarkupWithState(source, options).tokens;
}

/** `text` without delivery cues, `[directions]` or `<tag>`s, collapsed to a single-line preview. */
export function stripCues(text: string): string {
  // Repeat until fixed point so `<<b>script>` cannot leave `<script>` behind.
  let stripped = text;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(CUE, "");
  } while (stripped !== previous);
  return stripped.replace(/\s+/g, " ").trim();
}

/** Drops an unclosed `[cue` or `<tag` at the end of a streaming delta so it never flashes raw. */
export function trimTrailingPartialCue(text: string): string {
  return text.replace(TRAILING_PARTIAL_CUE, "");
}
