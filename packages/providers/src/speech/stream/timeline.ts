// Which segment each stretch of an utterance's audio speaks, from the times a provider gives its
// characters or words (ElevenLabs, Cartesia, Soniox). The timed characters are matched to the
// segments said by counting letters and digits, so punctuation, spacing and cue stripping on
// either side never shift them. A segment ends where the next one's first word starts, or with
// the utterance.
import type { AudioQueue } from "./shared.ts";

const ALNUM = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;
/** Scripts written without spaces, where each character is a word of its own. */
const OWN_WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function alnumCount(text: string): number {
  let count = 0;
  for (const char of text) if (ALNUM.test(char)) count++;
  return count;
}

interface Segment {
  readonly id: number;
  readonly alnum: number;
  timed: number;
  /** The sample its audio starts at. */
  start: number;
  sounded: boolean;
  /** Timed, not yet reported: its letters by the end of a word, and where that word starts. */
  words: { chars: number; at: number }[];
}

export class WordTimeline {
  readonly #rate: number;
  readonly #out: AudioQueue;
  readonly #segments: Segment[] = [];
  /** The segment the next timed letter belongs to. */
  #timing = 0;
  /** The segment audio goes to. */
  #playing = 0;
  #delivered = 0;
  /** The sample each segment from `#playing` on ends at: where the next one's first word starts. */
  readonly #cuts: number[] = [];
  #lastCut = 0;
  #wordStart: number | null = null;

  constructor(rate: number, out: AudioQueue) {
    this.#rate = rate;
    this.#out = out;
  }

  /** How much audio has gone out. */
  get deliveredMs(): number {
    return (this.#delivered * 1000) / this.#rate;
  }

  /** A segment sent, with the text the provider got. */
  say(id: number, text: string): void {
    this.#segments.push({
      id,
      alnum: alnumCount(text),
      timed: 0,
      start: this.#delivered,
      sounded: false,
      words: [],
    });
  }

  /** Each character's start, in ms from the utterance's first sample. */
  chars(chars: readonly string[], startsMs: readonly number[]): void {
    const count = Math.min(chars.length, startsMs.length);
    for (let i = 0; i < count; i++) {
      const char = chars[i] as string;
      const at = this.#sample(startsMs[i] as number);
      if (SPACE.test(char)) {
        this.#wordStart = null;
        continue;
      }
      const own = OWN_WORD.test(char);
      const letters = alnumCount(char);
      // Segments go without the spaces around them, so a segment's first letter starts a word.
      if (own || this.#wordStart === null || (letters > 0 && this.#timedThrough())) {
        this.#wordStart = at;
      }
      this.#credit(letters, this.#wordStart);
      if (own) this.#wordStart = null;
    }
    this.#settle();
  }

  /** Whether the segment being timed has all its letters, and another follows it. */
  #timedThrough(): boolean {
    const segment = this.#segments[this.#timing];
    return (
      segment !== undefined &&
      segment.timed === segment.alnum &&
      this.#segments[this.#timing + 1] !== undefined
    );
  }

  /** Each word's start, in ms from the utterance's first sample. */
  words(words: readonly string[], startsMs: readonly number[]): void {
    const count = Math.min(words.length, startsMs.length);
    for (let i = 0; i < count; i++) {
      this.#credit(alnumCount(words[i] as string), this.#sample(startsMs[i] as number));
    }
    this.#settle();
  }

  audio(pcm: Int16Array): void {
    let from = 0;
    while (from < pcm.length && this.#segments[this.#playing] !== undefined) {
      let take = pcm.length - from;
      const cut = this.#cuts[0];
      if (cut !== undefined) {
        if (cut <= this.#delivered) {
          this.#cuts.shift();
          this.#advance();
          continue;
        }
        take = Math.min(take, cut - this.#delivered);
      }
      const segment = this.#segments[this.#playing] as Segment;
      this.#out.push({ kind: "pcm", seg: segment.id, pcm: pcm.subarray(from, from + take) });
      this.#delivered += take;
      segment.sounded = true;
      from += take;
      this.#reportWords();
    }
  }

  /** The provider is done with the utterance: every segment left ends, then the utterance. */
  finish(): void {
    while (this.#segments[this.#playing] !== undefined) this.#advance();
    this.#out.finish({ kind: "end" });
  }

  #sample(ms: number): number {
    return Math.round((ms * this.#rate) / 1000);
  }

  #credit(letters: number, at: number): void {
    let left = letters;
    while (left > 0) {
      const segment = this.#segments[this.#timing];
      if (segment === undefined) return;
      if (segment.timed === segment.alnum) {
        // More letters than were said: the provider read the text differently.
        if (this.#segments[this.#timing + 1] === undefined) return;
        // Done, or with nothing to time: it ends where this letter's word starts.
        this.#lastCut = Math.max(this.#lastCut, at);
        this.#cuts.push(this.#lastCut);
        this.#timing++;
        continue;
      }
      const take = Math.min(left, segment.alnum - segment.timed);
      segment.timed += take;
      left -= take;
      const last = segment.words.at(-1);
      if (last !== undefined && last.at === at) last.chars = segment.timed;
      else segment.words.push({ chars: segment.timed, at });
    }
  }

  /** Ends the segments whose cut the audio has already passed. */
  #settle(): void {
    while (this.#cuts[0] !== undefined && this.#cuts[0] <= this.#delivered) {
      this.#cuts.shift();
      this.#advance();
    }
    this.#reportWords();
  }

  #advance(): void {
    const segment = this.#segments[this.#playing] as Segment;
    this.#reportWords();
    this.#out.push({ kind: "seg-end", seg: segment.id });
    this.#playing++;
    const next = this.#segments[this.#playing];
    if (next !== undefined) next.start = this.#delivered;
  }

  /** The playing segment's timed words, once its audio has begun and so has a start. */
  #reportWords(): void {
    const segment = this.#segments[this.#playing];
    if (segment === undefined || !segment.sounded || segment.words.length === 0) return;
    this.#out.push({
      kind: "words",
      seg: segment.id,
      words: segment.words.map(({ chars, at }) => ({
        chars,
        startMs: (Math.max(0, at - segment.start) * 1000) / this.#rate,
      })),
    });
    segment.words = [];
  }
}
