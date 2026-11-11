// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/utils/text/simple_text_aggregator.ts@ce8f8bc and packages/core/src/utils/string.ts@ce8f8bc
//
// Cuts a reply's raw text, cues included, into the sentences its voice says one at a time, with
// SimpleTextAggregator's lookahead. pipedog asks sentencex where a sentence ends; this decides it
// itself, and parts from pipedog only where the contract's D7 allows: a closing quote or bracket
// and repeated end punctuation stay with their sentence (pipedog cuts `“我不去。|”然后`, because
// sentencex skips the closed quote and its fallback splits at the first `。`), nothing ends inside
// an open `[`, and a sentence with no words once cues are stripped (a lone `</whisper>`, which Fish
// answers with no audio) merges into the next.
import { stripMarkup } from "@eidolon/providers";

const SENTENCE_ENDING_PUNCTUATION: ReadonlySet<string> = new Set([
  // Latin script punctuation (most European languages, Filipino, etc.)
  ".",
  "!",
  "?",
  ";",
  "…",
  // East Asian punctuation (Chinese (Traditional & Simplified), Japanese, Korean)
  "。", // Ideographic full stop
  "？", // Full-width question mark
  "！", // Full-width exclamation mark
  "；", // Full-width semicolon
  "．", // Full-width period
  "｡", // Halfwidth ideographic period
  // Indic scripts punctuation (Hindi, Sanskrit, Marathi, Nepali, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Punjabi, Oriya, Assamese)
  "।", // Devanagari danda (single vertical bar)
  "॥", // Devanagari double danda (double vertical bar)
  // Arabic script punctuation (Arabic, Persian, Urdu, Pashto)
  "؟", // Arabic question mark
  "؛", // Arabic semicolon
  "۔", // Urdu full stop
  "؏", // Arabic sign misra (classical texts)
  // Myanmar/Burmese
  "၊", // Myanmar sign little section
  "။", // Myanmar sign section
  // Khmer
  "។", // Khmer sign khan
  "៕", // Khmer sign bariyoosan
  // Lao
  "໌", // Lao cancellation mark (used as period)
  // Tibetan
  "།", // Tibetan mark intersyllabic tsheg
  "༎", // Tibetan mark delimiter tsheg bstar
  // Armenian
  "։", // Armenian full stop
  "՜", // Armenian exclamation mark
  "՞", // Armenian question mark
  // Ethiopic script (Amharic)
  "።", // Ethiopic full stop
  "፧", // Ethiopic question mark
  "፨", // Ethiopic paragraph separator
]);

const LATIN_SENTENCE_ENDING_PUNCTUATION: ReadonlySet<string> = new Set([".", "!", "?", ";", "…"]);

/** Ends a sentence wherever it stands, as pipedog's fallback treats it. */
const UNAMBIGUOUS_SENTENCE_ENDING_PUNCTUATION: ReadonlySet<string> = new Set(
  [...SENTENCE_ENDING_PUNCTUATION].filter((p) => !LATIN_SENTENCE_ENDING_PUNCTUATION.has(p)),
);

/** Closing quotes and brackets, kept with the sentence they close. */
const CLOSERS: ReadonlySet<string> = new Set(["”", "’", "」", "』", "）", ")", "】", '"', "'"]);

// Words that end in a period without ending a sentence. Lowercase, without the period.
const ABBREVIATIONS = new Set([
  // English
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "mt",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "a.m",
  "p.m",
  "u.s",
  "u.k",
  "no",
  "vol",
  "fig",
  "inc",
  "ltd",
  "co",
  "corp",
  "gen",
  "gov",
  "sen",
  "rep",
  "rev",
  "capt",
  "col",
  "lt",
  "sgt",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  // Other European languages
  "z.b",
  "d.h",
  "bzw",
  "ca",
  "sra",
  "srta",
  "dra",
  "p",
  "pp",
  "dott",
  "sig",
  "ing",
  "avv",
  "mme",
  "mlle",
]);

function endsWithAbbreviation(span: string): boolean {
  const trimmed = span.trimEnd();
  if (!trimmed.endsWith(".")) return false;
  const match = /([\p{L}.]+)\.$/u.exec(trimmed);
  if (!match?.[1]) return false;
  const word = match[1].replace(/^\.+/, "");
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  // Dotted acronyms such as "U.S.A." or "N.A.S.A." keep going.
  return /^(\p{L}\.)+\p{L}$/u.test(word);
}

/** A single Latin letter and its period, as in "Albert I. Douglas". */
const INITIAL = /(?<![\p{L}\p{N}])[A-Za-z]\.$/u;

const SPACE_RE = /^\s+$/u;
const ALNUM_RE = /^[\p{L}\p{N}]+$/u;
const WORD_RE = /[\p{L}\p{N}]/u;

/** Python `str.isspace()` for a single character. */
function isSpace(char: string): boolean {
  return SPACE_RE.test(char);
}

/** Python `str.isalnum()` for a single character. */
function isAlnum(char: string): boolean {
  return ALNUM_RE.test(char);
}

/** Python `str.strip(" ")`: strip only ASCII spaces. */
function stripSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === " ") start++;
  while (end > start && text[end - 1] === " ") end--;
  return text.slice(start, end);
}

/** Whether `text` says anything once its cues (`[…]` directions, paired tags) are gone. */
export function hasWords(text: string): boolean {
  return WORD_RE.test(stripMarkup(text, undefined));
}

/**
 * Whether Latin punctuation `text[start, runEnd)`, its closers running to `end`, ends a sentence,
 * as sentencex decides for the common cases: `.`, `!` or `?` before a space, unless the period
 * ends an abbreviation or an initial, or a run such as `...` or `!!` goes on in lowercase or
 * digits; `!` or `?` also straight before a character that isn't ASCII, as in `Hi!你好`. `…` and
 * `;` alone never do.
 */
function latinEnds(text: string, start: number, runEnd: number, end: number): boolean {
  if (!/[.!?]/.test(text.slice(start, runEnd))) return false;
  const next = text[end];
  if (next === undefined) return false;
  if (isSpace(next)) {
    const following = /\S/u.exec(text.slice(end))?.[0];
    if (following === undefined) return false;
    if (runEnd - start > 1 && /[\p{Ll}\p{N}]/u.test(following)) return false;
    const head = text.slice(0, runEnd);
    return !(text[runEnd - 1] === "." && (endsWithAbbreviation(head) || INITIAL.test(head)));
  }
  return text[runEnd - 1] !== "." && !/[A-Za-z0-9]/.test(next);
}

/** Where the first sentence of `text` with words in it ends, after its closers; 0 when none has. */
function sentenceEnd(text: string): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === "[") depth++;
    else if (char === "]") depth = Math.max(0, depth - 1);
    if (!SENTENCE_ENDING_PUNCTUATION.has(char)) {
      i++;
      continue;
    }
    let runEnd = i;
    let unambiguous = false;
    while (runEnd < text.length && SENTENCE_ENDING_PUNCTUATION.has(text[runEnd] as string)) {
      if (UNAMBIGUOUS_SENTENCE_ENDING_PUNCTUATION.has(text[runEnd] as string)) unambiguous = true;
      runEnd++;
    }
    let end = runEnd;
    while (end < text.length && CLOSERS.has(text[end] as string)) end++;
    const ends = depth === 0 && (unambiguous || latinEnds(text, i, runEnd, end));
    if (ends && hasWords(text.slice(0, end))) return end;
    i = runEnd;
  }
  return 0;
}

/**
 * Where the lookahead stands. A clear boundary is checked at the first character after it; an
 * unresolved one is retried only when the following word ends, never at a partial prefix such as
 * "Do" inside "Douglas".
 */
const Lookahead = {
  IDLE: 1,
  AWAITING_CHARACTER: 2,
  AWAITING_WORD: 3,
  IN_WORD: 4,
} as const;
type Lookahead = (typeof Lookahead)[keyof typeof Lookahead];

/** One reply's sentence splitter: `push` the mind's deltas, `flush` at each mind round's end. */
export class Segmenter {
  #text = "";
  #lookahead: Lookahead = Lookahead.IDLE;

  /** The sentences `delta` completes. */
  push(delta: string): string[] {
    const sentences: string[] = [];
    for (const char of delta) {
      this.#text += char;
      const sentence = this.#check(char);
      if (sentence !== null) sentences.push(sentence);
    }
    return sentences;
  }

  /** The sentence still open, or null. Text with no words waits in `held` for the next round's. */
  flush(): string | null {
    this.#lookahead = Lookahead.IDLE;
    if (!hasWords(this.#text)) return null;
    const rest = stripSpaces(this.#text);
    this.#text = "";
    return rest;
  }

  /**
   * After `flush`, what it held back, such as a closing `</whisper>`: never said, but part of the
   * reply.
   */
  get held(): string {
    return this.#text.trim();
  }

  reset(): void {
    this.#text = "";
    this.#lookahead = Lookahead.IDLE;
  }

  /** `char` is already appended; a confirmed boundary returns the sentence before it. */
  #check(char: string): string | null {
    const isPunctuation = SENTENCE_ENDING_PUNCTUATION.has(char);
    let sentence: string | null = null;
    if (this.#advance(char, isPunctuation)) {
      // For "...I. Did?", check the earlier period without the "?", which would end the buffer.
      const candidate = isPunctuation ? this.#text.slice(0, -char.length) : this.#text;
      const end = sentenceEnd(candidate.trimEnd());
      if (end > 0) {
        sentence = stripSpaces(this.#text.slice(0, end));
        this.#text = this.#text.slice(end);
        this.#lookahead = Lookahead.IDLE;
      }
    }
    if (isPunctuation) this.#lookahead = Lookahead.AWAITING_CHARACTER;
    return sentence;
  }

  /** Whether the buffer is ready for a boundary check. */
  #advance(char: string, isPunctuation: boolean): boolean {
    switch (this.#lookahead) {
      case Lookahead.IDLE:
        return false;
      case Lookahead.AWAITING_CHARACTER:
        if (isSpace(char) || isPunctuation || CLOSERS.has(char)) return false;
        this.#lookahead = isAlnum(char) ? Lookahead.IN_WORD : Lookahead.AWAITING_WORD;
        return true;
      case Lookahead.AWAITING_WORD:
        if (isAlnum(char)) this.#lookahead = Lookahead.IN_WORD;
        return false;
      case Lookahead.IN_WORD:
        if (isSpace(char) || isPunctuation) {
          this.#lookahead = Lookahead.IDLE;
          return true;
        }
        return false;
    }
  }
}
