// What the listener heard of one reply, from the segments its voice was given and the Speaker's
// cursor: a call stores this as her message, never what the mind streamed.
import type { CursorEvent, JoinSegments } from "../types.ts";

// The cues stripMarkup (@eidolon/providers) takes out for a voice that reads none: a word count
// over the text a voice was sent skips them.
const CUE = /<\/?(?:whisper|emphasis|soft|fast|slow|stress|forceful)>|\[[^[\]\n]*\]/giu;
const WORD = /[\p{L}\p{N}]/u;

/** `text` through its `chars`-th letter or digit outside cues; cues before it stay. */
function wordPrefix(text: string, chars: number): string {
  const cues = [...text.matchAll(CUE)];
  let cue = 0;
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const at = cues[cue];
    if (at !== undefined && i === at.index) {
      i += at[0].length;
      cue++;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i) as number);
    i += char.length;
    if (WORD.test(char) && ++count === chars) return text.slice(0, i);
  }
  return text;
}

interface Said {
  readonly text: string;
  readonly utterance: number;
  readonly exact: boolean;
  heard: boolean;
  /** Letters and digits outside cues played so far, from a word provider's timings. */
  chars: number;
}

/** One reply's heard text. Cursor events of other replies are ignored. */
export class SpokenTracker {
  readonly #reply: string;
  readonly #join: JoinSegments;
  readonly #said = new Map<number, Said>();
  /** Boundary-less utterances whose first sample has been pulled. */
  readonly #playing = new Set<number>();
  #tail = "";
  #frozen = false;

  constructor(reply: string, join: JoinSegments) {
    this.#reply = reply;
    this.#join = join;
  }

  /**
   * Segment `seg`, raw text with cues, went to the voice in `utterance`. `exact` when its provider
   * marks where its audio ends; otherwise it counts as heard once its utterance has started
   * playing, and that utterance's audio carries the seg of a segment said in it.
   */
  say(seg: number, text: string, utterance: number, exact: boolean): void {
    if (this.#frozen) return;
    const heard = !exact && this.#playing.has(utterance);
    this.#said.set(seg, { text, utterance, exact, heard, chars: 0 });
  }

  cursor(event: CursorEvent): void {
    if (this.#frozen || !("tag" in event) || event.tag.reply !== this.#reply) return;
    const said = this.#said.get(event.tag.seg);
    if (said === undefined) return;
    if (event.type === "seg-end") said.heard = true;
    else if (event.type === "words") said.chars = Math.max(said.chars, event.chars);
    else if (!said.exact) {
      this.#playing.add(said.utterance);
      for (const other of this.#said.values()) {
        if (other.utterance === said.utterance) other.heard = true;
      }
    }
  }

  /** The reply's wordless last text, such as a closing `</whisper>`, which was never said. */
  attach(text: string): void {
    if (!this.#frozen) this.#tail = text;
  }

  /** At a barge-in: what was heard until now is all that ever will be. */
  freeze(): void {
    this.#frozen = true;
  }

  /** Every heard segment, the played words of one still playing, and the tail once all is heard. */
  text(): string {
    const parts: string[] = [];
    let all = true;
    for (const said of this.#said.values()) {
      if (said.heard) parts.push(said.text);
      else {
        all = false;
        if (said.chars > 0) parts.push(wordPrefix(said.text, said.chars));
      }
    }
    if (all && this.#tail) parts.push(this.#tail);
    return this.#join(parts);
  }
}
