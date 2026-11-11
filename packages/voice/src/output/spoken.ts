// What the listener heard of one reply, from the segments its voice was given and the Speaker's
// cursor: a call stores this as her message, never what the mind streamed.
import { type Markup, unreadCues } from "@eidolon/providers";
import type { CursorEvent, JoinSegments } from "../types.ts";

const WORD = /[\p{L}\p{N}]/u;

/** The UTF-16 offset in `text` just past its `chars`-th letter or digit outside `unread` cues. */
export function spokenTo(text: string, chars: number, unread: RegExp | null): number {
  const cues = unread === null ? [] : [...text.matchAll(unread)];
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
    if (WORD.test(char) && ++count === chars) return i;
  }
  return text.length;
}

interface Said {
  readonly text: string;
  heard: boolean;
  /** Letters and digits of the text the voice was sent played so far, from its word timings. */
  chars: number;
}

/** One reply's heard text. Cursor events of other replies are ignored. */
export class SpokenTracker {
  readonly #reply: string;
  readonly #join: JoinSegments;
  readonly #said = new Map<number, Said>();
  #tail = "";
  #frozen = false;
  /** The cues the voice was never sent, which its word counts skip. */
  readonly #unread: RegExp | null;

  /** `markup`: the cues the voice reads, as its model's catalog entry names them. */
  constructor(reply: string, join: JoinSegments, markup?: Markup) {
    this.#reply = reply;
    this.#join = join;
    this.#unread = unreadCues(markup);
  }

  /** Segment `seg`, raw text with cues, went to the voice; it counts once the cursor passes its end. */
  say(seg: number, text: string): void {
    if (this.#frozen) return;
    this.#said.set(seg, { text, heard: false, chars: 0 });
  }

  cursor(event: CursorEvent): void {
    if (this.#frozen || !("tag" in event) || event.tag.reply !== this.#reply) return;
    const said = this.#said.get(event.tag.seg);
    if (said === undefined) return;
    if (event.type === "seg-end") said.heard = true;
    else if (event.type === "words") said.chars = Math.max(said.chars, event.chars);
  }

  /** Segment `seg`'s raw text, once it went to the voice. */
  textOf(seg: number): string | undefined {
    return this.#said.get(seg)?.text;
  }

  /** Whether the cursor has passed the end of every segment said. */
  heardAll(): boolean {
    for (const said of this.#said.values()) if (!said.heard) return false;
    return true;
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
        if (said.chars > 0)
          parts.push(said.text.slice(0, spokenTo(said.text, said.chars, this.#unread)));
      }
    }
    if (all && this.#tail) parts.push(this.#tail);
    return this.#join(parts);
  }
}
