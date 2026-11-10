import { expect, test } from "bun:test";
import { AudioQueue } from "../../src/speech/stream/shared.ts";
import { alnumCount, WordTimeline } from "../../src/speech/stream/timeline.ts";
import { collect, plain } from "./fake.ts";

// 1 ms is 24 samples.
const RATE = 24000;
const samples = (from: number, to: number) =>
  Int16Array.from({ length: to - from }, (_, i) => from + i);
const range = (from: number, to: number) => [...samples(from, to)];

function timeline(): { line: WordTimeline; events: () => Promise<unknown[]> } {
  const out = new AudioQueue();
  const line = new WordTimeline(RATE, out);
  return {
    line,
    events: async () => {
      line.finish();
      return plain(await collect(out));
    },
  };
}

test("letters and digits are what count, in any script", () => {
  expect(alnumCount("[温柔] 你好，World 2026!")).toBe(13);
  expect(alnumCount("……！")).toBe(0);
});

test("timing that comes after its audio ends the segment at once; its words count from the next sample", async () => {
  const { line, events } = timeline();
  line.say(1, "你好。");
  line.say(2, "再见。");
  line.audio(samples(0, 96));
  line.chars(["你", "好", "。", "再", "见"], [0, 1, 2, 3, 3.5]);
  line.audio(samples(96, 120));
  expect(await events()).toEqual([
    { kind: "pcm", seg: 1, pcm: range(0, 96) },
    {
      kind: "words",
      seg: 1,
      words: [
        { chars: 1, startMs: 0 },
        { chars: 2, startMs: 1 },
      ],
    },
    { kind: "seg-end", seg: 1 },
    { kind: "pcm", seg: 2, pcm: range(96, 120) },
    {
      kind: "words",
      seg: 2,
      words: [
        { chars: 1, startMs: 0 },
        { chars: 2, startMs: 0 },
      ],
    },
    { kind: "seg-end", seg: 2 },
    { kind: "end" },
  ]);
});

test("a Latin word counts from its first letter, across messages", async () => {
  const { line, events } = timeline();
  line.say(1, "Hello there.");
  line.chars(["H", "e", "l"], [0, 0.5, 1]);
  line.audio(samples(0, 48));
  line.chars(["l", "o", " ", "t"], [1.5, 2, 2.5, 3]);
  line.audio(samples(48, 96));
  expect(await events()).toEqual([
    { kind: "pcm", seg: 1, pcm: range(0, 48) },
    { kind: "words", seg: 1, words: [{ chars: 3, startMs: 0 }] },
    {
      kind: "words",
      seg: 1,
      words: [
        { chars: 5, startMs: 0 },
        { chars: 6, startMs: 3 },
      ],
    },
    { kind: "pcm", seg: 1, pcm: range(48, 96) },
    { kind: "seg-end", seg: 1 },
    { kind: "end" },
  ]);
});

test("a segment's first letter starts a word, though no space came between the segments", async () => {
  const { line, events } = timeline();
  line.say(1, "Hi.");
  line.say(2, "Yo.");
  line.chars(["H", "i", ".", "Y", "o", "."], [0, 1, 2, 3, 4, 5]);
  line.audio(samples(0, 144));
  expect(await events()).toEqual([
    { kind: "pcm", seg: 1, pcm: range(0, 72) },
    {
      kind: "words",
      seg: 1,
      words: [{ chars: 2, startMs: 0 }],
    },
    { kind: "seg-end", seg: 1 },
    { kind: "pcm", seg: 2, pcm: range(72, 144) },
    { kind: "words", seg: 2, words: [{ chars: 2, startMs: 0 }] },
    { kind: "seg-end", seg: 2 },
    { kind: "end" },
  ]);
});

test("a word spanning two segments credits both; letters past what was said cut nothing", async () => {
  const { line, events } = timeline();
  line.say(1, "ab");
  line.say(2, "cd");
  line.words(["x", "yz", "d", "ef"], [0, 1, 2, 3]);
  line.audio(samples(0, 96));
  expect(await events()).toEqual([
    { kind: "pcm", seg: 1, pcm: range(0, 24) },
    {
      kind: "words",
      seg: 1,
      words: [
        { chars: 1, startMs: 0 },
        { chars: 2, startMs: 1 },
      ],
    },
    { kind: "seg-end", seg: 1 },
    { kind: "pcm", seg: 2, pcm: range(24, 96) },
    {
      kind: "words",
      seg: 2,
      words: [
        { chars: 1, startMs: 0 },
        { chars: 2, startMs: 1 },
      ],
    },
    { kind: "seg-end", seg: 2 },
    { kind: "end" },
  ]);
});

test("a segment with nothing to time ends between its neighbours with no audio", async () => {
  const { line, events } = timeline();
  line.say(1, "好");
  line.say(2, "");
  line.say(3, "的");
  line.chars(["好", "的"], [0, 1]);
  line.audio(samples(0, 48));
  expect(await events()).toEqual([
    { kind: "pcm", seg: 1, pcm: range(0, 24) },
    { kind: "words", seg: 1, words: [{ chars: 1, startMs: 0 }] },
    { kind: "seg-end", seg: 1 },
    { kind: "seg-end", seg: 2 },
    { kind: "pcm", seg: 3, pcm: range(24, 48) },
    { kind: "words", seg: 3, words: [{ chars: 1, startMs: 0 }] },
    { kind: "seg-end", seg: 3 },
    { kind: "end" },
  ]);
});
