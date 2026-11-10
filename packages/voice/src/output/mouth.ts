// A persona's voice in a call: each reply's text cut into sentences and spoken through her speech
// stream, one utterance per voice, its audio queued on the Speaker in the order it was said, and
// what the listener heard of it followed as the Speaker's cursor plays it.
import { logger } from "@eidolon/config";
import { type Markup, modelInfo, type Selection, unreadCues } from "@eidolon/providers";
import {
  SPEECH_STALL_MS,
  SPEECH_STALLED,
  type SpeechStream,
  type Utterance,
  type UtteranceAudio,
} from "@eidolon/providers/speech-stream";
import { type RubatoStream, resampler } from "../dsp/resampler/index.ts";
import type {
  Clock,
  CursorEvent,
  Heard,
  JoinSegments,
  ReplySpeech,
  Speaker,
  Tag,
} from "../types.ts";
import { Segmenter } from "./segmenter.ts";
import { SpokenTracker, spokenTo } from "./spoken.ts";

/** What a reply's speech has to tell the client, in the order it happened. */
export type SpeechNote =
  /** A segment went to her voice, cues and all: `bot-transcription`. */
  | { readonly type: "segment"; readonly tag: Tag; readonly text: string }
  /** A segment of a reply without audio: `bot-transcription`, and a `bot-output` "new" only. */
  | { readonly type: "unspoken"; readonly text: string }
  /** The reply's first segment went to her voice: `bot-tts-started`. */
  | { readonly type: "tts-started" }
  /** The listener starts hearing the segment: its `bot-output` "new". */
  | { readonly type: "segment-started"; readonly tag: Tag }
  /** Its played words reach `spokenTo`, a UTF-16 offset into its text. */
  | { readonly type: "segment-progress"; readonly tag: Tag; readonly spokenTo: number }
  /** The listener has heard all of it: "completed". */
  | { readonly type: "segment-ended"; readonly tag: Tag }
  /** All of the reply's audio has come and she says nothing more: `bot-tts-stopped`. */
  | { readonly type: "tts-stopped" }
  /** Her voice failed, or owed audio and sent none for 15 s: the caller cancels the speech. */
  | { readonly type: "tts-error"; readonly message: string };

/** Posted to the call's mailbox when a reply's speech has notes waiting and none were before. */
export interface MouthEvent {
  readonly type: "speech";
  readonly reply: string;
}

/** One reply as her Mouth speaks it. Only the Floor calls `push`, `flush`, `cursor` and `cancel`. */
export interface SpokenReply extends ReplySpeech {
  /** A cursor event of the Speaker's, in the order the Floor handles them; others' are ignored. */
  cursor(event: CursorEvent): void;
  /**
   * The notes since the last take, oldest first. Taking them right after `cursor` keeps them in
   * order with what the Floor says about the same event; the `speech` event brings the rest.
   */
  take(): SpeechNote[];
}

export interface MouthOptions {
  readonly persona: string;
  /** Opened in her persona scope. */
  readonly speech: SpeechStream;
  /** The cues her voice model reads (`voiceTraits`): her played words count past the others. */
  readonly markup: Markup | undefined;
  /** Whether her voice marks where each segment's audio ends (`voiceTraits`). */
  readonly boundaries: boolean;
  readonly speaker: Speaker;
  readonly join: JoinSegments;
  readonly clock: Clock;
  readonly post: (event: MouthEvent) => void;
}

/** What `MouthOptions` takes from her voice role's selection. */
export function voiceTraits(selection: Selection): Pick<MouthOptions, "markup" | "boundaries"> {
  return {
    markup: modelInfo(selection.provider.id, "tts", selection.model)?.markup,
    // Fish's audio carries no segment boundaries.
    boundaries: selection.provider.id !== "fish",
  };
}

/** A persona's voice for one call: her replies one at a time, in the voice she last chose. */
export class Mouth {
  readonly #options: MouthOptions;
  /** `change_voice_style`'s choice, kept for the rest of the call; null is her selection's. */
  readonly #voice: { current: string | null } = { current: null };
  readonly #live = new Set<Reply>();

  constructor(options: MouthOptions) {
    this.#options = options;
  }

  /**
   * Reply `reply`'s speech; with `audio` false (`send-text` without `audio_response`), its segments
   * are only reported.
   */
  begin(reply: string, options: { readonly audio?: boolean } = {}): SpokenReply {
    const spoken: Reply = new Reply(this.#options, this.#voice, reply, options.audio ?? true, () =>
      this.#live.delete(spoken),
    );
    this.#live.add(spoken);
    return spoken;
  }

  /** Cancels what she is still saying, then closes her speech stream, flushing its meter. */
  async close(): Promise<void> {
    for (const reply of [...this.#live]) reply.cancel();
    await this.#options.speech.close();
  }
}

interface Said {
  readonly text: string;
  readonly voiced: Voiced;
}

class Reply implements SpokenReply {
  readonly #o: MouthOptions;
  readonly #voice: { current: string | null };
  readonly #id: string;
  readonly #audio: boolean;
  readonly #settled: () => void;
  readonly #segmenter = new Segmenter();
  readonly #tracker: SpokenTracker;
  readonly #unread: RegExp | null;
  readonly #done = Promise.withResolvers<Heard>();
  readonly #said = new Map<number, Said>();
  /** Segments, and boundary-less utterances' first, whose end the cursor has yet to pass. */
  readonly #unpassed = new Set<number>();
  /** Utterances whose audio hasn't all been queued, oldest first; only the first's is queued. */
  #voices: Voiced[] = [];
  /** The utterance her next segment goes to. */
  #current: Voiced | null = null;
  #notes: SpeechNote[] = [];
  /** With `audio` false, all that was pushed. */
  #pushed = "";
  #nextSeg = 1;
  #nextUtterance = 1;
  #ttsStarted = false;
  #ttsStopped = false;
  #ended = false;
  #cancelled = false;
  #resolved = false;

  constructor(
    o: MouthOptions,
    voice: { current: string | null },
    id: string,
    audio: boolean,
    settled: () => void,
  ) {
    this.#o = o;
    this.#voice = voice;
    this.#id = id;
    this.#audio = audio;
    this.#settled = settled;
    this.#tracker = new SpokenTracker(id, o.join, o.markup);
    this.#unread = unreadCues(o.markup);
  }

  push(delta: string): void {
    if (this.#cancelled) return;
    if (this.#ended) {
      logger.warning(`[voice] Text came after reply ${this.#id}'s speech ended; it isn't spoken`);
      return;
    }
    if (!this.#audio) this.#pushed += delta;
    for (const sentence of this.#segmenter.push(delta)) this.#say(sentence);
  }

  flush(): void {
    if (this.#ended || this.#cancelled) return;
    const rest = this.#segmenter.flush();
    if (rest !== null) this.#say(rest);
  }

  switchVoice(voice: string): void {
    this.#voice.current = voice;
    if (!this.#audio || this.#ended || this.#cancelled) return;
    this.flush();
    this.#current?.end();
    this.#current = this.#open();
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#tracker.freeze();
    this.#notes = [];
    for (const voiced of this.#voices) voiced.cancel();
    this.#voices = [];
    this.#current = null;
    this.#resolve(false);
  }

  // Bound, so it can be handed on as it stands (`heard: speech.heard`).
  readonly heard = (): Promise<Heard> => {
    if (!this.#ended && !this.#cancelled) {
      this.flush();
      if (this.#audio) {
        this.#tracker.attach(this.#segmenter.held);
        this.#current?.end();
        this.#current = null;
      }
      this.#ended = true;
      this.#settle();
    }
    return this.#done.promise;
  };

  cursor(event: CursorEvent): void {
    if (this.#cancelled || !("tag" in event) || event.tag.reply !== this.#id) return;
    this.#tracker.cursor(event);
    const { tag } = event;
    const said = this.#said.get(tag.seg);
    if (said === undefined) return;
    if (this.#o.boundaries) {
      if (event.type === "seg-start") {
        this.#note({ type: "segment-started", tag });
      } else if (event.type === "words") {
        const to = spokenTo(said.text, event.chars, this.#unread);
        this.#note({ type: "segment-progress", tag, spokenTo: to });
      } else {
        this.#note({ type: "segment-ended", tag });
        this.#passed(tag.seg);
      }
    } else if (event.type === "seg-start" && !said.voiced.playing) {
      // Its utterance's first sample: every segment said in it counts as heard, as each said later.
      said.voiced.playing = true;
      for (const seg of said.voiced.segs) this.#heardWhole(seg);
    } else if (event.type === "seg-end") {
      this.#passed(tag.seg);
    }
  }

  take(): SpeechNote[] {
    const notes = this.#notes;
    this.#notes = [];
    return notes;
  }

  #say(text: string): void {
    if (!this.#audio) {
      this.#note({ type: "unspoken", text });
      return;
    }
    const seg = this.#nextSeg++;
    const voiced = this.#current ?? this.#open();
    this.#current = voiced;
    this.#said.set(seg, { text, voiced });
    this.#note({ type: "segment", tag: this.#tag(seg), text });
    if (!this.#ttsStarted) {
      this.#ttsStarted = true;
      this.#note({ type: "tts-started" });
    }
    const { boundaries } = this.#o;
    const first = voiced.said(seg);
    this.#tracker.say(seg, text, voiced.id, boundaries);
    if (boundaries || first) this.#unpassed.add(seg);
    if (!boundaries && voiced.playing) this.#heardWhole(seg);
    voiced.utterance.say({ id: seg, text });
  }

  #open(): Voiced {
    const { speech, speaker } = this.#o;
    const rate = speech.sampleRate;
    const voiced = new Voiced(
      this.#nextUtterance++,
      speech.utterance(this.#voice.current),
      rate === speaker.rate ? null : resampler().createStream(rate, speaker.rate),
      this.#o.clock,
      () => this.#stalled(),
    );
    this.#voices.push(voiced);
    void this.#read(voiced);
    return voiced;
  }

  async #read(voiced: Voiced): Promise<void> {
    for await (const item of voiced.utterance.audio) {
      if (this.#cancelled) return;
      voiced.arrived(item);
      voiced.items.push(item);
      this.#pump();
    }
    if (this.#cancelled) return;
    voiced.arrived(null);
    voiced.over = true;
    this.#pump();
  }

  /** Queues the first utterance's audio, and each next one's once all of it is queued. */
  #pump(): void {
    const { speaker } = this.#o;
    for (;;) {
      const voiced = this.#voices[0];
      if (voiced === undefined || this.#cancelled) return;
      const item = voiced.items.shift();
      if (item === undefined) {
        if (!voiced.over) return;
        this.#finish(voiced, null);
        continue;
      }
      switch (item.kind) {
        case "pcm": {
          const seg = (item.seg ?? voiced.first) as number;
          voiced.last = seg;
          speaker.enqueue(this.#tag(seg), voiced.resample(item.pcm));
          break;
        }
        case "words": {
          const words = item.words.map((word) => ({
            chars: word.chars,
            atSample: Math.round((word.startMs * speaker.rate) / 1000),
          }));
          speaker.markWords(this.#tag(item.seg), words);
          break;
        }
        case "seg-end":
          speaker.markSegEnd(this.#tag(item.seg));
          break;
        case "end":
          this.#finish(voiced, null);
          break;
        case "error":
          this.#finish(voiced, item.message);
          break;
      }
    }
  }

  /** All of the first utterance's audio is queued, or its voice failed with `error`. */
  #finish(voiced: Voiced, error: string | null): void {
    const { speaker, boundaries } = this.#o;
    this.#voices.shift();
    const tail = voiced.close(error !== null);
    if (error !== null) {
      this.#note({ type: "tts-error", message: error });
    } else {
      if (voiced.last !== null) speaker.enqueue(this.#tag(voiced.last), tail);
      if (!boundaries && voiced.first !== null) speaker.markSegEnd(this.#tag(voiced.first));
    }
    this.#settle();
  }

  #stalled(): void {
    if (this.#cancelled) return;
    this.#note({ type: "tts-error", message: SPEECH_STALLED });
  }

  #heardWhole(seg: number): void {
    const tag = this.#tag(seg);
    this.#note({ type: "segment-started", tag });
    this.#note({ type: "segment-ended", tag });
  }

  #passed(seg: number): void {
    this.#unpassed.delete(seg);
    this.#settle();
  }

  /** Once the speech has ended: `tts-stopped` when all its audio is queued, heard when played. */
  #settle(): void {
    if (!this.#ended || this.#cancelled || this.#voices.length > 0) return;
    if (this.#ttsStarted && !this.#ttsStopped) {
      this.#ttsStopped = true;
      this.#note({ type: "tts-stopped" });
    }
    if (this.#unpassed.size === 0) this.#resolve(true);
  }

  #resolve(complete: boolean): void {
    if (this.#resolved) return;
    this.#resolved = true;
    this.#settled();
    const text = this.#audio ? this.#tracker.text() : this.#pushed;
    this.#done.resolve({ text, complete });
  }

  #note(note: SpeechNote): void {
    this.#notes.push(note);
    if (this.#notes.length === 1) this.#o.post({ type: "speech", reply: this.#id });
  }

  #tag(seg: number): Tag {
    return { reply: this.#id, persona: this.#o.persona, seg };
  }
}

/** One utterance of a reply, and its audio until all of it is queued. */
class Voiced {
  readonly id: number;
  readonly utterance: Utterance;
  readonly items: UtteranceAudio[] = [];
  /** Its audio has ended: no more items come. */
  over = false;
  readonly segs: number[] = [];
  /** The first segment said in it, whose tag a boundary-less utterance's audio carries. */
  first: number | null = null;
  /** The segment its latest audio was queued under, which the resampler's tail joins. */
  last: number | null = null;
  /** A boundary-less utterance the cursor has reached. */
  playing = false;
  readonly #resampler: RubatoStream | null;
  readonly #clock: Clock;
  readonly #stalled: () => void;
  #cancelStall: (() => void) | null = null;
  #ending = false;

  constructor(
    id: number,
    utterance: Utterance,
    resampler: RubatoStream | null,
    clock: Clock,
    stalled: () => void,
  ) {
    this.id = id;
    this.utterance = utterance;
    this.#resampler = resampler;
    this.#clock = clock;
    this.#stalled = stalled;
  }

  /** Segment `seg` goes to it, which owes audio; whether it is the first. */
  said(seg: number): boolean {
    this.segs.push(seg);
    if (this.#cancelStall === null) this.#owe();
    if (this.first !== null) return false;
    this.first = seg;
    return true;
  }

  /** No more segments: it owes its end. */
  end(): void {
    this.#ending = true;
    this.utterance.end();
    this.#owe();
  }

  /**
   * An item of its audio, null once that has ended. Before `end`, audio pays what a segment owed;
   * after it, each item starts the wait for the end over, and the end pays it.
   */
  arrived(item: UtteranceAudio | null): void {
    if (this.#ending && item !== null && item.kind !== "end" && item.kind !== "error") this.#owe();
    else this.#stopStall();
  }

  resample(pcm: Int16Array): Int16Array {
    return this.#resampler === null ? pcm : this.#resampler.processSamples(pcm);
  }

  /** Stops its stall timer and frees its resampler: the audio the resampler held, unless `drop`. */
  close(drop: boolean): Int16Array {
    this.#stopStall();
    const tail =
      this.#resampler === null || drop ? new Int16Array(0) : this.#resampler.flushSamples();
    this.#resampler?.destroy();
    return tail;
  }

  cancel(): void {
    this.utterance.cancel();
    this.close(true);
  }

  /** The rule the speech clients share: owed audio that doesn't come for this long has stalled. */
  #owe(): void {
    this.#stopStall();
    this.#cancelStall = this.#clock.setTimer(SPEECH_STALL_MS, () => {
      this.#cancelStall = null;
      this.#stalled();
    });
  }

  #stopStall(): void {
    this.#cancelStall?.();
    this.#cancelStall = null;
  }
}
