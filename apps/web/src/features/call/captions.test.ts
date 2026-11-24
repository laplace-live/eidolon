import type { BotOutputData } from "@laplace.live/eidolon-sdk";
import { expect, test } from "vitest";
import { captionOf, latestSelfie } from "./captions";
import {
  EMPTY_TRANSCRIPT,
  reduceTranscript,
  type Transcript,
  type TranscriptEvent,
} from "./transcript";

function run(...events: TranscriptEvent[]): Transcript {
  return events.reduce(reduceTranscript, EMPTY_TRANSCRIPT);
}

const said = (text: string, final = true): TranscriptEvent => ({
  type: "user-input",
  data: { text, input_type: "transcription", final },
});

const output = (data: BotOutputData): TranscriptEvent => ({ type: "bot-output", data });

/** A sentence's first message, as the bot sends it once it starts speaking. */
const announce = (segment_id: number, text: string, will_be_spoken = true) =>
  output({
    text,
    segment_id,
    output_type: "sentence",
    spoken: false,
    will_be_spoken,
    spoken_status: "new",
    spoken_progress: { accumulated_text: "", remaining_text: text },
  });

/** The message that the sentence has been said, which a TTS without word timings sends whole. */
const spoke = (segment_id: number, text: string) =>
  output({
    text,
    segment_id,
    output_type: "sentence",
    spoken: true,
    will_be_spoken: true,
    spoken_status: "completed",
    spoken_progress: { accumulated_text: text, remaining_text: "" },
  });

const progress = (segment_id: number, text: string, accumulated: string) =>
  output({
    text,
    segment_id,
    output_type: "sentence",
    will_be_spoken: true,
    spoken_status: "in-progress",
    spoken_progress: {
      accumulated_text: accumulated,
      remaining_text: text.slice(accumulated.length),
    },
  });

/** A group call's label, as the persona's first sample plays. */
const speaking = (persona: string, name: string): TranscriptEvent => ({
  type: "speaker",
  speaker: { persona, name },
});

const SENTENCE = "[温暖，带着怀念] 小时候上美术课<emphasis>老高兴了</emphasis>，";

test("nothing said, no caption", () => {
  expect(captionOf(EMPTY_TRANSCRIPT, false)).toBeNull();
});

test("the viewer's words as they are heard, until her first sentence takes their place", () => {
  const heard = run(said("你好", false), said("你好。"), said("在吗", false));
  expect(captionOf(heard, false)).toEqual({
    kind: "you",
    said: "你好。",
    hearing: "在吗",
    live: true,
  });
  expect(captionOf(run(said("Hello there."), said("How", false)), false)).toMatchObject({
    said: "Hello there.",
    hearing: " How",
  });
  expect(captionOf(reduceTranscript(heard, announce(1, "在的。")), true)).toEqual({
    kind: "her",
    speaker: null,
    text: "在的。",
    live: true,
  });
});

test("her sentence without its direction or tags, live while she speaks and kept after", () => {
  const announced = run(announce(7, SENTENCE));
  const text = "小时候上美术课老高兴了，";
  expect(captionOf(announced, true)).toEqual({ kind: "her", speaker: null, text, live: true });
  expect(captionOf(run(announce(7, SENTENCE), spoke(7, SENTENCE)), false)).toEqual({
    kind: "her",
    speaker: null,
    text,
    live: false,
  });
});

test("her second sentence takes the first's place once it is announced, not before", () => {
  const first = run(announce(1, "第一句。"), progress(1, "第一句。", "第一"));
  expect(captionOf(first, true)).toMatchObject({ text: "第一句。" });
  expect(captionOf(run(announce(1, "第一句。"), spoke(1, "第一句。")), true)).toMatchObject({
    text: "第一句。",
  });
  const second = run(announce(1, "第一句。"), spoke(1, "第一句。"), announce(2, "第二句。"));
  expect(captionOf(second, true)).toMatchObject({ text: "第二句。" });
});

test("cues are taken out and the spaces they leave collapsed", () => {
  const cued = run(announce(1, "我一般都能得A [chuckling] 嘿嘿 [break] 就觉得挺好的。"));
  expect(captionOf(cued, true)).toMatchObject({ text: "我一般都能得A 嘿嘿 就觉得挺好的。" });
});

test("text she won't say is passed over for the sentence before it", () => {
  const noted = run(announce(1, "你好呀。"), announce(2, "[note] 只给你看的字", false));
  expect(captionOf(noted, true)).toMatchObject({ kind: "her", text: "你好呀。" });
  expect(captionOf(run(announce(2, "[note] 只给你看的字", false)), true)).toBeNull();
  expect(captionOf(run(announce(1, "[笑]")), true)).toBeNull();
});

test("a group call's caption says who said it", () => {
  const call = run(said("你们好"), speaking("mint", "薄荷"), announce(1, "我也在。"));
  expect(captionOf(call, true)).toEqual({
    kind: "her",
    speaker: { persona: "mint", name: "薄荷" },
    text: "我也在。",
    live: true,
  });
});

test("a typed line is a caption, never one still being heard", () => {
  const typed = run(announce(1, "在的。"), { type: "typed", key: "k1", text: "看得到我吗" });
  expect(captionOf(typed, true)).toEqual({
    kind: "you",
    said: "看得到我吗",
    hearing: "",
    live: false,
  });
});

/** A photo landing, on a group call with whose it is. */
const selfie = (path: string, persona?: string): TranscriptEvent => ({
  type: "selfie",
  paths: [path],
  persona,
});

test("a photo leaves her caption, and is the call's newest", () => {
  expect(latestSelfie(EMPTY_TRANSCRIPT)).toBeNull();
  const shot = run(
    selfie("/api/selfie/a.png"),
    announce(1, "等我拍一张。"),
    selfie("/api/selfie/b.png", "mint"),
  );
  expect(captionOf(shot, false)).toMatchObject({ kind: "her", text: "等我拍一张。" });
  expect(latestSelfie(shot)).toMatchObject({ paths: ["/api/selfie/b.png"], persona: "mint" });
  expect(latestSelfie(run(said("拍一张")))).toBeNull();
});
