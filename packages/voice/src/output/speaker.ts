// The call's one output queue: every reply's audio in order, each stretch tagged with its reply,
// persona and segment, pulled by the transport's clock. What the play cursor passes is posted as it
// passes it, so the call's state follows what was heard rather than what was sent.
import type { CursorEvent, Pcm, Speaker, Tag } from "../types.ts";

const RATE = 24_000;

type Item =
  | { readonly kind: "pcm"; readonly tag: Tag; readonly pcm: Pcm; offset: number }
  | { readonly kind: "seg-end"; readonly tag: Tag };

interface Word {
  readonly chars: number;
  readonly atSample: number;
}

interface TagState {
  /** Samples of the tag's audio pulled so far. */
  played: number;
  /** Words not yet reached, by `atSample`. */
  words: Word[];
  ended: boolean;
}

function keyOf(tag: Tag): string {
  return `${tag.reply}\u0000${tag.persona}\u0000${tag.seg}`;
}

/**
 * The Speaker, posting each cursor event to `post` from inside `pull`. `reply-start` comes at a
 * reply's first item, and again when its audio resumes after the queue drained; `seg-start` at a
 * tag's first item; `words` once a word's first sample has been pulled; `seg-end` at the point
 * `markSegEnd` marked, even after the queue drained; `drained` when a queue that was playing
 * empties. `clear` posts nothing.
 */
export function createSpeaker(post: (event: CursorEvent) => void): Speaker {
  const queue: Item[] = [];
  const tags = new Map<string, TagState>();
  /** Samples pulled per reply, kept after `clear` for a realtime truncate. */
  const played = new Map<string, number>();
  let speaking = false;
  let replyAtCursor: string | null = null;
  let tagAtCursor: string | null = null;

  function stateOf(tag: Tag): TagState {
    const key = keyOf(tag);
    let state = tags.get(key);
    if (state === undefined) {
      state = { played: 0, words: [], ended: false };
      tags.set(key, state);
    }
    return state;
  }

  /** The cursor reaches `tag`'s audio, or with `audio` false, its end mark. */
  function reach(tag: Tag, audio: boolean): void {
    if (replyAtCursor !== tag.reply || (audio && !speaking)) {
      speaking = true;
      replyAtCursor = tag.reply;
      post({ type: "reply-start", reply: tag.reply, persona: tag.persona });
    }
    const key = keyOf(tag);
    if (tagAtCursor !== key) {
      tagAtCursor = key;
      post({ type: "seg-start", tag });
    }
  }

  function postWords(tag: Tag, state: TagState): void {
    while (state.words.length > 0 && (state.words[0] as Word).atSample < state.played) {
      post({ type: "words", tag, chars: (state.words.shift() as Word).chars });
    }
  }

  function playedMs(key: string): number {
    return Math.floor(((played.get(key) ?? 0) * 1000) / RATE);
  }

  return {
    rate: RATE,

    enqueue(tag, pcm) {
      if (pcm.length > 0) queue.push({ kind: "pcm", tag, pcm, offset: 0 });
    },

    markSegEnd(tag) {
      queue.push({ kind: "seg-end", tag });
    },

    markWords(tag, words) {
      const state = stateOf(tag);
      if (state.ended) return;
      state.words.push(...words);
      state.words.sort((a, b) => a.atSample - b.atSample);
    },

    pull(samples) {
      const out = new Int16Array(samples);
      let filled = 0;
      while (queue.length > 0) {
        const item = queue[0] as Item;
        if (item.kind === "seg-end") {
          reach(item.tag, false);
          const state = stateOf(item.tag);
          postWords(item.tag, state);
          state.words = [];
          state.ended = true;
          post({ type: "seg-end", tag: item.tag });
          queue.shift();
          continue;
        }
        if (filled === samples) break;
        reach(item.tag, true);
        const take = Math.min(samples - filled, item.pcm.length - item.offset);
        out.set(item.pcm.subarray(item.offset, item.offset + take), filled);
        item.offset += take;
        filled += take;
        const state = stateOf(item.tag);
        state.played += take;
        played.set(item.tag.reply, (played.get(item.tag.reply) ?? 0) + take);
        postWords(item.tag, state);
        if (item.offset === item.pcm.length) queue.shift();
      }
      if (speaking && queue.length === 0) {
        speaking = false;
        post({ type: "drained" });
      }
      return out;
    },

    clear() {
      const head = queue[0];
      const reply = head === undefined ? null : head.tag.reply;
      queue.length = 0;
      tags.clear();
      speaking = false;
      replyAtCursor = null;
      tagAtCursor = null;
      return { reply, playedMs: reply === null ? 0 : playedMs(reply) };
    },

    playedMs,

    isSpeaking() {
      return speaking;
    },
  };
}
