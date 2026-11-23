// Try a Line: a reply of hers, pasted, played on Studio's preview the way a call plays it, through
// the SDK's direction, with a made-up mouth in place of her voice, so nothing is billed.
import { parseMarkup } from "@laplace.live/eidolon-sdk";
import {
  type DirectionEvent,
  type MoodTag,
  moodTags,
  soundCueEffect,
} from "@laplace.live/eidolon-sdk/avatar";

/** Her voice's pace in voiced letters a second, which the SDK times a voice's cues by too. */
const LETTERS_PER_SECOND = 4.5;
const MIN_SECONDS = 1;
const MAX_SECONDS = 30;
const VOICED = /[\p{L}\p{N}]/u;

export interface LinePlan {
  readonly text: string;
  /** How long she takes to say it. */
  readonly seconds: number;
  /** What the direction it opens with tags. */
  readonly moods: readonly MoodTag[];
  /** The cues in it that move her face, in order. */
  readonly cues: readonly string[];
}

export function planLine(text: string): LinePlan {
  const tokens = parseMarkup(text);
  let letters = 0;
  const cues: string[] = [];
  for (const token of tokens) {
    if (token.kind === "text") {
      for (const char of token.text) if (VOICED.test(char)) letters++;
    } else if (token.kind === "cue" && soundCueEffect(token.name) !== null) {
      cues.push(token.name);
    }
  }
  const opening = tokens.find((token) => token.kind !== "text" || token.text.trim() !== "");
  return {
    text,
    seconds: Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, letters / LETTERS_PER_SECOND)),
    moods: opening?.kind === "direction" ? moodTags(opening.text) : [],
    cues,
  };
}

/** A line's call events: its start at `at`, and its end, `plan.seconds` later. */
export function lineEvents(
  plan: LinePlan,
  at: number,
): { readonly start: DirectionEvent[]; readonly end: DirectionEvent[] } {
  const done = at + plan.seconds * 1000;
  const segment = { type: "bot-output", segment: 1, text: plan.text } as const;
  return {
    start: [
      { type: "reset", at },
      { type: "bot-started-speaking", at },
      { ...segment, status: "new", at },
    ],
    end: [
      { ...segment, status: "completed", at: done },
      { type: "bot-stopped-speaking", at: done },
    ],
  };
}

/** A syllable's opening, varied so a line doesn't read as a metronome; never quite shut or wide. */
function syllableOpening(index: number): number {
  const spread = Math.abs(Math.sin(index * 12.9898) * 43758.5453) % 1;
  return 0.45 + 0.4 * spread;
}

/** How open her mouth is `t` seconds into a line `seconds` long: a syllable each 1/4.5 s. */
export function syllableLevel(t: number, seconds: number): number {
  if (!(t >= 0 && t < seconds)) return 0;
  const syllable = t * LETTERS_PER_SECOND;
  const index = Math.floor(syllable);
  return syllableOpening(index) * Math.sin(Math.PI * (syllable - index));
}
