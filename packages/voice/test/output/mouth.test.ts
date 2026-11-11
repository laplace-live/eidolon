// The Mouth on a scripted speech stream and the real Speaker, with the test pulling audio and
// handing the cursor's events back as the Floor does.
import { describe, expect, test } from "bun:test";
import { AsyncQueue } from "@eidolon/config";
import { type Markup, select } from "@eidolon/providers";
import type { SpeechStream, Utterance, UtteranceAudio } from "@eidolon/providers/speech-stream";
import { resampler } from "../../src/dsp/resampler/index.ts";
import {
  Mouth,
  type MouthEvent,
  type SpeechNote,
  type SpokenReply,
  voiceTraits,
} from "../../src/output/mouth.ts";
import { createSpeaker } from "../../src/output/speaker.ts";
import type { CursorEvent, Speaker, Tag } from "../../src/types.ts";
import { FakeClock } from "../input/clock.ts";

/** Joins with a visible bar, so each test sees which parts were heard. */
const join = (parts: readonly string[]) => parts.join("|");

/** Lets the Mouth read the audio the test scripted. */
const settle = () => Bun.sleep(0);

/** An utterance that records what it was given; the test scripts its audio. */
class FakeUtterance implements Utterance {
  readonly audio = new AsyncQueue<UtteranceAudio>();
  readonly voice: string | null;
  readonly said: string[] = [];
  readonly ids: number[] = [];
  ended = false;
  cancelled = false;

  constructor(voice: string | null) {
    this.voice = voice;
  }

  say(segment: { readonly id: number; readonly text: string }): void {
    this.ids.push(segment.id);
    this.said.push(segment.text);
  }

  end(): void {
    this.ended = true;
  }

  cancel(): void {
    this.cancelled = true;
    this.audio.drop();
  }

  pcm(seg: number, samples: number | Int16Array, value = 1): void {
    const pcm = typeof samples === "number" ? new Int16Array(samples).fill(value) : samples;
    this.audio.push({ kind: "pcm", seg, pcm });
  }

  words(seg: number, words: readonly { chars: number; startMs: number }[]): void {
    this.audio.push({ kind: "words", seg, words });
  }

  segEnd(seg: number): void {
    this.audio.push({ kind: "seg-end", seg });
  }

  finish(last: UtteranceAudio = { kind: "end" }): void {
    this.audio.push(last);
    this.audio.close();
  }
}

class FakeSpeech implements SpeechStream {
  readonly sampleRate: number;
  readonly utterances: FakeUtterance[] = [];
  closed = false;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  utterance(voice: string | null): FakeUtterance {
    const utterance = new FakeUtterance(voice);
    this.utterances.push(utterance);
    return utterance;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const keyOf = (tag: Tag) => `${tag.reply}/${tag.seg}`;

function harness(o: { readonly markup?: Markup; readonly sampleRate?: number } = {}) {
  const clock = new FakeClock();
  const cursor: CursorEvent[] = [];
  const real = createSpeaker((event) => cursor.push(event));
  const enqueued: Int16Array[] = [];
  /** What reached the Speaker's queue, in order: each stretch of audio, and each segment's end. */
  const queued: string[] = [];
  const speaker: Speaker = {
    ...real,
    enqueue(tag, pcm) {
      enqueued.push(pcm);
      if (pcm.length > 0) queued.push(`audio ${tag.seg}`);
      real.enqueue(tag, pcm);
    },
    markSegEnd(tag) {
      queued.push(`end ${tag.seg}`);
      real.markSegEnd(tag);
    },
  };
  const speech = new FakeSpeech(o.sampleRate ?? 24_000);
  const posted: MouthEvent[] = [];
  const mouth = new Mouth({
    persona: "milky-green",
    speech,
    markup: o.markup,
    speaker,
    join,
    clock,
    post: (event) => posted.push(event),
  });
  const replies = new Map<string, SpokenReply>();
  const texts = new Map<string, string>();
  const notes: string[] = [];

  /** Each note as a short line, a progress note as the text it reaches. */
  const line = (note: SpeechNote): string => {
    switch (note.type) {
      case "segment":
        texts.set(keyOf(note.tag), note.text);
        return `segment ${note.tag.seg} ${note.text}`;
      case "segment-started":
        return `new ${note.tag.seg}`;
      case "segment-progress":
        return `progress ${note.tag.seg} ${texts.get(keyOf(note.tag))?.slice(0, note.spokenTo)}`;
      case "segment-ended":
        return `done ${note.tag.seg}`;
      case "tts-error":
        return `tts-error ${note.message}`;
      case "unspoken":
        return `unspoken ${note.text}`;
      default:
        return note.type;
    }
  };
  const takeFrom = (reply: SpokenReply) => {
    for (const note of reply.take()) notes.push(line(note));
  };

  return {
    clock,
    speaker,
    speech,
    mouth,
    posted,
    notes,
    enqueued,
    queued,
    begin(id = "r1", audio = true): SpokenReply {
      const reply = mouth.begin(id, { audio });
      replies.set(id, reply);
      return reply;
    },
    take(): void {
      for (const reply of replies.values()) takeFrom(reply);
    },
    /** Pulls `ms` of audio, handing each cursor event to its reply and taking its notes. */
    play(ms: number): number[] {
      const out: number[] = [];
      for (let t = 0; t < ms; t += 10) {
        out.push(...speaker.pull(240));
        for (const event of cursor.splice(0)) {
          const id = "tag" in event ? event.tag.reply : null;
          const reply = id === null ? undefined : replies.get(id);
          if (reply === undefined) continue;
          reply.cursor(event);
          takeFrom(reply);
        }
      }
      return out;
    },
  };
}

function sine(length: number, phase = 0): Int16Array {
  return Int16Array.from({ length }, (_, i) => Math.round(8000 * Math.sin((i + phase) / 7)));
}

function concat(parts: readonly Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("segments", () => {
  test("sentences go to her voice as they complete, and a round's rest at its flush", () => {
    const h = harness();
    const reply = h.begin();
    reply.push("你好。今天");
    reply.push("天气");
    const [utterance] = h.speech.utterances as [FakeUtterance];
    expect(utterance.said).toEqual(["你好。"]);
    reply.flush();
    expect([utterance.said, utterance.ids, utterance.voice]).toEqual([
      ["你好。", "今天天气"],
      [1, 2],
      null,
    ]);
    h.take();
    expect(h.notes).toEqual(["segment 1 你好。", "tts-started", "segment 2 今天天气"]);
  });

  test("notes waiting post one speech event, and the next note after a take posts again", async () => {
    const h = harness();
    const reply = h.begin();
    reply.push("你好。今天");
    reply.flush();
    expect(h.posted).toEqual([{ type: "speech", reply: "r1" }]);
    expect(reply.take().map((note) => note.type)).toEqual(["segment", "tts-started", "segment"]);
    expect(reply.take()).toEqual([]);
    void reply.heard();
    (h.speech.utterances[0] as FakeUtterance).finish();
    await settle();
    expect(h.posted).toHaveLength(2);
    expect(reply.take()).toEqual([{ type: "tts-stopped" }]);
  });
});

describe("a voice that marks where each segment ends", () => {
  test("its audio plays under each segment's tag, and the cursor's passing is what was heard", async () => {
    const h = harness();
    const reply = h.begin();
    reply.push("你好。今天天气不错。");
    const heard = reply.heard();
    const [utterance] = h.speech.utterances as [FakeUtterance];
    expect([utterance.said, utterance.ended]).toEqual([["你好。", "今天天气不错。"], true]);
    utterance.pcm(1, 240);
    utterance.segEnd(1);
    utterance.pcm(2, 480);
    utterance.words(2, [
      { chars: 2, startMs: 0 },
      { chars: 4, startMs: 10 },
    ]);
    utterance.segEnd(2);
    utterance.finish();
    await settle();
    h.take();
    h.play(30);
    expect(h.notes).toEqual([
      "segment 1 你好。",
      "tts-started",
      "segment 2 今天天气不错。",
      "tts-stopped",
      "new 1",
      "done 1",
      "new 2",
      "progress 2 今天",
      "progress 2 今天天气",
      "done 2",
    ]);
    expect(await heard).toEqual({ text: "你好。|今天天气不错。", complete: true });
  });

  test.each<[Markup | undefined, string, number, string]>([
    [undefined, "[开心] 你<emphasis>好</emphasis>今天。", 2, "[开心] 你<emphasis>好"],
    ["brackets", "[开心] 你<emphasis>好</emphasis>今天。", 3, "[开心] 你"],
    ["fish-drama", "[开心] 你好。", 2, "[开心"],
  ])(
    "with markup %p, played words count past only the cues it never reads",
    async (markup, text, chars, reached) => {
      const h = harness({ markup });
      const reply = h.begin();
      reply.push(text);
      void reply.heard();
      const [utterance] = h.speech.utterances as [FakeUtterance];
      utterance.pcm(1, 480);
      utterance.words(1, [{ chars, startMs: 0 }]);
      await settle();
      h.play(10);
      expect(h.notes.at(-1)).toBe(`progress 1 ${reached}`);
    },
  );

  test("a voice switch lets the old utterance play out and queues the new voice's after it", async () => {
    const h = harness();
    const reply = h.begin();
    reply.push("你好。");
    reply.switchVoice("voice-b");
    const [first, second] = h.speech.utterances as [FakeUtterance, FakeUtterance];
    expect([first.said, first.ended, second.voice, second.said]).toEqual([
      ["你好。"],
      true,
      "voice-b",
      [],
    ]);
    reply.push("[小声] 秘密。");
    const heard = reply.heard();
    expect(second.said).toEqual(["[小声] 秘密。"]);
    second.pcm(2, 240, 2);
    second.segEnd(2);
    second.finish();
    await settle();
    first.pcm(1, 240, 1);
    first.segEnd(1);
    first.finish();
    await settle();
    expect(h.play(20)).toEqual([...new Array(240).fill(1), ...new Array(240).fill(2)]);
    expect(await heard).toEqual({ text: "你好。|[小声] 秘密。", complete: true });
    const next = h.begin("r2");
    next.push("再见。");
    next.flush();
    expect(h.speech.utterances[2]?.voice).toBe("voice-b");
  });

  test("a cancel freezes what was heard, resolves heard at once and stops her voice", async () => {
    const h = harness();
    const reply = h.begin();
    reply.push("你好。今天天气不错。");
    reply.flush();
    const [utterance] = h.speech.utterances as [FakeUtterance];
    utterance.pcm(1, 240);
    utterance.segEnd(1);
    utterance.pcm(2, 480);
    utterance.words(2, [{ chars: 2, startMs: 0 }]);
    await settle();
    h.play(20);
    h.speaker.clear();
    reply.cancel();
    expect(utterance.cancelled).toBe(true);
    expect(await reply.heard()).toEqual({ text: "你好。|今天", complete: false });
    reply.push("我们出去吧。");
    reply.flush();
    reply.switchVoice("voice-b");
    expect([h.speech.utterances.length, reply.take()]).toEqual([1, []]);
  });

  test("a reply with nothing to say is heard at once; wordless last text joins as its tail", async () => {
    const h = harness();
    expect(await h.begin("r1").heard()).toEqual({ text: "", complete: true });
    expect(h.speech.utterances).toEqual([]);
    const reply = h.begin("r2");
    reply.push("<whisper>悄悄告诉你。</whisper>");
    const heard = reply.heard();
    const [utterance] = h.speech.utterances as [FakeUtterance];
    expect(utterance.said).toEqual(["<whisper>悄悄告诉你。"]);
    utterance.pcm(1, 240);
    utterance.segEnd(1);
    utterance.finish();
    await settle();
    h.play(10);
    expect(await heard).toEqual({ text: "<whisper>悄悄告诉你。|</whisper>", complete: true });
  });
});

describe("a voice at another rate (Fish)", () => {
  test("its audio reaches the Speaker at 24 kHz, each segment's under its tag and all of it before its end", async () => {
    const h = harness({ sampleRate: 44_100 });
    const reply = h.begin();
    reply.push("你好。今天天气不错。");
    const heard = reply.heard();
    const [utterance] = h.speech.utterances as [FakeUtterance];
    const chunks = [sine(1000), sine(2000, 1000), sine(1410, 3000)];
    utterance.pcm(1, chunks[0] as Int16Array);
    utterance.segEnd(1);
    utterance.pcm(2, chunks[1] as Int16Array);
    utterance.pcm(2, chunks[2] as Int16Array);
    utterance.segEnd(2);
    utterance.finish();
    await settle();
    const reference = resampler().createStream(44_100, 24_000);
    const expected = concat([
      reference.processSamples(chunks[0] as Int16Array),
      reference.flushSamples(),
      reference.processSamples(chunks[1] as Int16Array),
      reference.processSamples(chunks[2] as Int16Array),
      reference.flushSamples(),
    ]);
    reference.destroy();
    expect(expected).toHaveLength(2400);
    expect(concat(h.enqueued)).toEqual(expected);
    expect(h.queued).toEqual([
      "audio 1",
      "audio 1",
      "end 1",
      "audio 2",
      "audio 2",
      "audio 2",
      "end 2",
    ]);
    h.take();
    const said = h.notes.length;
    h.play(30);
    expect(h.notes.slice(said)).toEqual(["new 1", "done 1", "new 2"]);
    h.play(100);
    expect(h.notes.slice(said + 3)).toEqual(["done 2"]);
    expect(await heard).toEqual({ text: "你好。|今天天气不错。", complete: true });
  });
});

describe("failures", () => {
  test("her voice's failure is a tts-error note", async () => {
    const h = harness();
    const reply = h.begin();
    reply.push("你好。");
    reply.flush();
    (h.speech.utterances[0] as FakeUtterance).finish({
      kind: "error",
      message: "Fish Audio server error during synthesis",
    });
    await settle();
    h.take();
    expect(h.notes.at(-1)).toBe("tts-error Fish Audio server error during synthesis");
  });

  test("no audio 15 s after an utterance's first segment is a tts-error note", () => {
    const h = harness();
    const reply = h.begin();
    reply.push("你好。今天");
    reply.flush();
    h.clock.advance(14_999);
    h.take();
    expect(h.notes.at(-1)).toBe("segment 2 今天");
    h.clock.advance(1);
    h.take();
    expect(h.notes.at(-1)).toBe("tts-error No speech audio arrived within 15 seconds");
    reply.cancel();
    expect(h.clock.pending).toBe(0);
  });

  test("audio within 15 s stops the stall timer", async () => {
    const h = harness();
    const reply = h.begin();
    reply.push("你好。");
    reply.flush();
    (h.speech.utterances[0] as FakeUtterance).pcm(1, 240);
    await settle();
    expect(h.clock.pending).toBe(0);
  });

  test("a segment said after audio came owes audio of its own", async () => {
    const h = harness();
    const reply = h.begin();
    reply.push("你好。");
    reply.flush();
    (h.speech.utterances[0] as FakeUtterance).pcm(1, 240);
    await settle();
    reply.push("今天好。");
    reply.flush();
    h.clock.advance(15_000);
    h.take();
    expect(h.notes.at(-1)).toBe("tts-error No speech audio arrived within 15 seconds");
    reply.cancel();
  });

  test("once her speech has ended, 15 s without audio before its end is a tts-error note", async () => {
    const stall = "tts-error No speech audio arrived within 15 seconds";
    // Nothing after her speech ends; audio 10 s after it, then nothing; audio, then the end.
    for (const after of ["nothing", "audio", "end"] as const) {
      const h = harness();
      const reply = h.begin();
      reply.push("你好。");
      reply.flush();
      const utterance = h.speech.utterances[0] as FakeUtterance;
      utterance.pcm(1, 240);
      await settle();
      const heard = reply.heard();
      expect(utterance.ended).toBe(true);
      if (after !== "nothing") {
        h.clock.advance(10_000);
        utterance.pcm(1, 240);
        await settle();
      }
      h.clock.advance(14_999);
      if (after === "end") {
        utterance.segEnd(1);
        utterance.finish();
        await settle();
        expect(h.clock.pending).toBe(0);
        h.play(40);
        expect(await heard).toEqual({ text: "你好。", complete: true });
      } else {
        h.take();
        expect(h.notes).not.toContain(stall);
        h.clock.advance(1);
        h.take();
        expect(h.notes.at(-1)).toBe(stall);
        reply.cancel();
        expect(await heard).toMatchObject({ complete: false });
      }
      expect(h.clock.pending).toBe(0);
    }
  });
});

describe("a reply without audio (send-text without audio_response)", () => {
  test("speaks nothing, reports each segment, hears all it was given, and switches her voice", async () => {
    const h = harness();
    const reply = h.begin("r1", false);
    reply.push("你好。");
    reply.push("今天");
    reply.flush();
    reply.switchVoice("voice-b");
    reply.push("[笑]");
    expect(await reply.heard()).toEqual({ text: "你好。今天[笑]", complete: true });
    const cut = h.begin("r2", false);
    cut.push("你好");
    cut.cancel();
    expect(await cut.heard()).toEqual({ text: "你好", complete: false });
    h.take();
    expect([h.speech.utterances, h.notes]).toEqual([[], ["unspoken 你好。", "unspoken 今天"]]);
    const next = h.begin("r3");
    next.push("嗯。");
    next.flush();
    expect(h.speech.utterances[0]?.voice).toBe("voice-b");
  });
});

test("closing her Mouth cancels what she is saying and closes her speech stream", async () => {
  const h = harness();
  const reply = h.begin();
  reply.push("你好。");
  reply.flush();
  await h.mouth.close();
  expect(await reply.heard()).toEqual({ text: "", complete: false });
  expect([h.speech.utterances[0]?.cancelled, h.speech.closed]).toEqual([true, true]);
});

test.each<[Record<string, string>, ReturnType<typeof voiceTraits>]>([
  [{ TTS_PROVIDER: "fish" }, { markup: "fish-drama" }],
  [{ TTS_PROVIDER: "fish", TTS_MODEL: "s2-pro" }, { markup: "brackets" }],
  [{ TTS_PROVIDER: "elevenlabs", TTS_MODEL: "eleven_v3" }, { markup: "brackets" }],
  [{ TTS_PROVIDER: "minimax" }, { markup: undefined }],
])("voiceTraits for %p", (variables, traits) => {
  const selection = select("voice", (name) => variables[name]);
  expect(selection).not.toBeNull();
  expect(voiceTraits(selection as NonNullable<typeof selection>)).toEqual(traits);
});
