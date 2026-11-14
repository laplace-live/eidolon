import { describe, expect, test } from "bun:test";
import type { BotOutputData } from "@laplace.live/eidolon-sdk";
import {
  type BotEntry,
  botRuns,
  EMPTY_TRANSCRIPT,
  reduceTranscript,
  type Transcript,
  type TranscriptEvent,
  userText,
} from "./transcript";

function run(...events: TranscriptEvent[]): Transcript {
  return events.reduce(reduceTranscript, EMPTY_TRANSCRIPT);
}

const said = (text: string, final = true): TranscriptEvent => ({
  type: "user-input",
  data: { text, input_type: "transcription", final },
});

const legacy = (text: string, final = true): TranscriptEvent => ({
  type: "user-transcript",
  data: { text, final },
});

const output = (data: BotOutputData): TranscriptEvent => ({ type: "bot-output", data });

/** A sentence's first message, as the bot sends it once it starts speaking. */
const announce = (segment_id: number, text: string) =>
  output({
    text,
    segment_id,
    output_type: "sentence",
    spoken: false,
    will_be_spoken: true,
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

/** Each entry as one line: pending words in ~tildes~, directions in {braces}, tags as <tag:words>. */
function view(transcript: Transcript): string[] {
  return transcript.entries.map((entry) => {
    if (entry.kind === "selfie") return `selfie ${entry.paths.join(" ")}`;
    if (entry.kind === "user") {
      const { said: words, hearing } = userText(entry);
      const flags = `${entry.key ? " typed" : ""}${entry.failed ? " failed" : ""}`;
      return `you${flags}: ${words}${hearing ? `|${hearing}` : ""}`;
    }
    const text = botRuns(entry)
      .map((run) => {
        const shown =
          run.kind === "cue"
            ? run.emoji
            : run.kind === "direction"
              ? `{${run.text}}`
              : run.tags.length > 0
                ? `<${run.tags.join("+")}:${run.text}>`
                : run.text;
        return run.pending ? `~${shown}~` : shown;
      })
      .join("");
    return `${entry.speaker === null ? "bot" : entry.speaker.name}: ${text}`;
  });
}

/** A group call's label, as the persona's first sample plays. */
const speaking = (persona: string, name: string): TranscriptEvent => ({
  type: "speaker",
  speaker: { persona, name },
});

describe("speech", () => {
  test("interim words stand in until the final, and finals add up until the bot answers", () => {
    const heard = run(said("你", false), said("你好", false), said("你好。"), said("在吗", false));
    expect(view(heard)).toEqual(["you: 你好。|在吗"]);

    const answered = reduceTranscript(heard, announce(1, "在的。"));
    expect(view(reduceTranscript(answered, said("嗯")))).toEqual([
      "you: 你好。|在吗",
      "bot: ~在的。~",
      "you: 嗯",
    ]);
  });

  test("user-input switches off the user-transcription copy of each transcription", () => {
    expect(view(run(legacy("你好")))).toEqual(["you: 你好"]);
    expect(view(run(said("你好"), legacy("你好"), legacy("再见")))).toEqual(["you: 你好"]);
  });

  test("English finals are spaced, CJK ones aren't", () => {
    expect(view(run(said("Hello there."), said("How are you?")))).toEqual([
      "you: Hello there. How are you?",
    ]);
    expect(view(run(said("你好。"), said("在吗", false)))).toEqual(["you: 你好。|在吗"]);
  });

  test("blank transcriptions change nothing", () => {
    expect(run(said(" "), legacy(""))).toEqual({ ...EMPTY_TRANSCRIPT, userInput: true });
  });
});

describe("typed messages", () => {
  test("a typed message is its own entry, and the bot's chat echo of it is skipped", () => {
    const echo: TranscriptEvent = {
      type: "user-input",
      data: { text: "hi", input_type: "chat", final: true },
    };
    const sent = run(said("嗯"), { type: "typed", key: "k1", text: "hi" }, echo, said("还有"));
    expect(view(sent)).toEqual(["you: 嗯", "you typed: hi", "you: 还有"]);
    expect(view(reduceTranscript(sent, { type: "typed-failed", key: "k1" }))[1]).toBe(
      "you typed failed: hi",
    );
  });

  test("typing ends the bot's reply", () => {
    const typed = run(announce(1, "第一句。"), { type: "typed", key: "k", text: "等等" });
    expect(view(reduceTranscript(typed, announce(2, "好的。")))).toEqual([
      "bot: ~第一句。~",
      "you typed: 等等",
      "bot: ~好的。~",
    ]);
  });
});

describe("replies", () => {
  test("a reply's sentences join one entry and read as said once completed", () => {
    const reply = run(
      announce(7, "[温暖，带着怀念] 小时候上美术课<emphasis>老高兴了</emphasis>，"),
      spoke(7, "[温暖，带着怀念] 小时候上美术课<emphasis>老高兴了</emphasis>，"),
      announce(8, "老师会发美术本子。"),
    );
    expect(view(reply)).toEqual([
      "bot: {温暖，带着怀念} 小时候上美术课<emphasis:老高兴了>，~老师会发美术本子。~",
    ]);
  });

  test("a tag pair the sentence splitter cut in two still pairs up", () => {
    expect(
      view(run(announce(1, "<whisper>你先走吧。"), announce(2, "</whisper>我一会儿就来。"))),
    ).toEqual(["bot: ~<whisper:你先走吧。>~~我一会儿就来。~"]);
  });

  test("English sentences are spaced", () => {
    const reply = run(announce(1, "Hi there."), spoke(1, "Hi there."), announce(2, "How are you?"));
    expect(view(reply)).toEqual(["bot: Hi there. ~How are you?~"]);
  });

  test("word-level progress splits a sentence at what has been said, and never goes back", () => {
    const text = "今天天气不错，我们出去走走吧。";
    const halfway = run(announce(3, text), progress(3, text, "今天天气不错，"));
    expect(view(halfway)).toEqual(["bot: 今天天气不错，~我们出去走走吧。~"]);
    expect(reduceTranscript(halfway, progress(3, text, "今天"))).toEqual(halfway);
    expect(view(reduceTranscript(halfway, progress(3, text, " 我们出去")))).toEqual([
      "bot: 今天天气不错，我们出去~走走吧。~",
    ]);
  });

  test("an interruption ends the reply, and what was never said stays pending", () => {
    const cut = run(
      announce(1, "第一句。"),
      spoke(1, "第一句。"),
      announce(2, "第二句。"),
      { type: "interrupted" },
      announce(5, "新的回答。"),
    );
    expect(view(cut)).toEqual(["bot: 第一句。~第二句。~", "bot: ~新的回答。~"]);
  });

  test("a late completion finds its sentence in an earlier reply", () => {
    const late = run(
      announce(1, "A。"),
      { type: "interrupted" },
      announce(2, "B。"),
      spoke(1, "A。"),
    );
    expect(view(late)).toEqual(["bot: A。", "bot: ~B。~"]);
  });

  test("a completion whose announcement never came still shows, as said", () => {
    expect(view(run(said("你好"), spoke(9, "迟到的一句。")))).toEqual([
      "you: 你好",
      "bot: 迟到的一句。",
    ]);
  });

  test("word, token and backchannel output is skipped, and unvoiced text reads as said", () => {
    const skipped = run(
      output({ text: "你", output_type: "word", spoken: true }),
      output({ text: "你", output_type: "token" }),
      output({ text: "嗯嗯", output_type: "backchannel", spoken_status: "new" }),
      output({ text: "", output_type: "sentence", spoken_status: "new", will_be_spoken: true }),
    );
    expect(skipped.entries).toEqual([]);
    const unvoiced = output({
      text: "[note] 只给你看的字",
      output_type: "sentence",
      spoken_status: "new",
      will_be_spoken: false,
    });
    expect(view(run(unvoiced))).toEqual(["bot: {note} 只给你看的字"]);
  });

  test("cues are chips in their place", () => {
    const reply = run(announce(1, "我一般都能得A [chuckling] 嘿嘿 [break] 就觉得挺好的。"));
    expect(view(reply)).toEqual(["bot: ~我一般都能得A ~~😄~~ 嘿嘿 ~~就觉得挺好的。~"]);
  });
});

describe("selfies and resets", () => {
  test("a selfie ends the reply, so the bot's next words start a new entry below it", () => {
    const shot = run(
      announce(1, "等我拍一张。"),
      { type: "selfie", paths: ["/api/selfie/a.png"] },
      announce(2, "拍好啦。"),
    );
    expect(view(shot)).toEqual([
      "bot: ~等我拍一张。~",
      "selfie /api/selfie/a.png",
      "bot: ~拍好啦。~",
    ]);
    expect(reduceTranscript(shot, { type: "selfie", paths: [] })).toBe(shot);
  });

  test("a group call's selfie keeps whose it is", () => {
    const shots = run(
      { type: "selfie", paths: ["/api/selfie/a.png"], persona: "mint" },
      { type: "selfie", paths: ["/api/selfie/b.png"] },
    );
    expect(shots.entries.map((entry) => entry.kind === "selfie" && entry.persona)).toEqual([
      "mint",
      null,
    ]);
  });

  test("ids stay unique and reset empties the transcript", () => {
    const busy = run(said("a"), announce(1, "b"), { type: "selfie", paths: ["/api/selfie/x"] });
    expect(busy.entries.map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(reduceTranscript(busy, { type: "reset" })).toBe(EMPTY_TRANSCRIPT);
  });
});

describe("group calls", () => {
  test("each persona's reply is her own entry under her name, even with no word between", () => {
    const call = run(
      said("你们好"),
      speaking("milky-green", "奶绿"),
      announce(1, "你好呀。"),
      spoke(1, "你好呀。"),
      speaking("mint", "薄荷"),
      announce(2, "我也在。"),
    );
    expect(view(call)).toEqual(["you: 你们好", "奶绿: 你好呀。", "薄荷: ~我也在。~"]);
    expect(call.speaker).toEqual({ persona: "mint", name: "薄荷" });
  });

  test("her label again keeps her reply open, and she keeps her name after the viewer speaks", () => {
    const call = run(
      speaking("milky-green", "奶绿"),
      announce(1, "第一句。"),
      speaking("milky-green", "奶绿"),
      announce(2, "第二句。"),
      said("嗯"),
      announce(3, "还有呢。"),
    );
    expect(view(call)).toEqual(["奶绿: ~第一句。~~第二句。~", "you: 嗯", "奶绿: ~还有呢。~"]);
  });

  test("a late completion lands in the earlier persona's reply", () => {
    const call = run(
      speaking("milky-green", "奶绿"),
      announce(1, "A。"),
      speaking("mint", "薄荷"),
      announce(2, "B。"),
      spoke(1, "A。"),
    );
    expect(view(call)).toEqual(["奶绿: A。", "薄荷: ~B。~"]);
  });

  test("a call with her alone has no labels, and reset forgets the last speaker", () => {
    expect(run(announce(1, "你好。")).entries[0]).toMatchObject({ speaker: null });
    const labeled = run(speaking("mint", "薄荷"), announce(1, "你好。"));
    expect(reduceTranscript(labeled, { type: "reset" })).toBe(EMPTY_TRANSCRIPT);
  });
});

test("botRuns keeps every run's offset unique, so it can key the run", () => {
  for (const reply of [
    run(announce(1, "[温暖] 你好。"), announce(2, "<emphasis>再见</emphasis>。")),
    run(announce(1, "第一句。"), announce(2, "第二句。")),
  ]) {
    const starts = botRuns(reply.entries[0] as BotEntry).map((piece) => piece.start);
    expect(new Set(starts).size).toBe(starts.length);
  }
});
