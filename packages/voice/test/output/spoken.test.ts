import { describe, expect, test } from "bun:test";
import { SpokenTracker } from "../../src/output/spoken.ts";
import type { CursorEvent, Tag } from "../../src/types.ts";

/** Joins with a visible bar, so each test sees which parts were heard. */
const join = (parts: readonly string[]) => parts.join("|");

const tag = (seg: number, reply = "r1"): Tag => ({ reply, persona: "milky-green", seg });
const segStart = (seg: number, reply?: string): CursorEvent => ({
  type: "seg-start",
  tag: tag(seg, reply),
});
const segEnd = (seg: number, reply?: string): CursorEvent => ({
  type: "seg-end",
  tag: tag(seg, reply),
});
const words = (seg: number, chars: number): CursorEvent => ({
  type: "words",
  tag: tag(seg),
  chars,
});

describe("a voice that marks where each segment ends", () => {
  test("a segment counts once the cursor passes its end, raw text and cues included", () => {
    const tracker = new SpokenTracker("r1", join);
    tracker.say(1, "[开心] 你好。", 1, true);
    tracker.say(2, "今天天气不错。", 1, true);
    expect(tracker.text()).toBe("");
    tracker.cursor(segStart(1));
    expect(tracker.text()).toBe("");
    tracker.cursor(segEnd(1));
    expect(tracker.text()).toBe("[开心] 你好。");
    tracker.cursor(segStart(2));
    tracker.cursor(segEnd(2));
    expect(tracker.text()).toBe("[开心] 你好。|今天天气不错。");
  });

  test("words played of the segment still playing count, counted past cues", () => {
    const tracker = new SpokenTracker("r1", join);
    tracker.say(1, "你好。", 1, true);
    tracker.say(2, "[开心地] 今天<emphasis>天气</emphasis>不错。", 1, true);
    tracker.cursor(segEnd(1));
    tracker.cursor(segStart(2));
    tracker.cursor(words(2, 3));
    expect(tracker.text()).toBe("你好。|[开心地] 今天<emphasis>天");
    tracker.cursor(words(2, 1));
    expect(tracker.text()).toBe("你好。|[开心地] 今天<emphasis>天");
    tracker.cursor(words(2, 6));
    expect(tracker.text()).toBe("你好。|[开心地] 今天<emphasis>天气</emphasis>不错");
  });
});

describe("a voice that marks no boundaries (Fish)", () => {
  test("a segment counts once said and its utterance has started playing", () => {
    const tracker = new SpokenTracker("r1", join);
    tracker.say(1, "你好。", 1, false);
    tracker.say(2, "今天天气不错。", 1, false);
    expect(tracker.text()).toBe("");
    tracker.cursor(segStart(1));
    expect(tracker.text()).toBe("你好。|今天天气不错。");
    tracker.say(3, "我们出去吧。", 1, false);
    expect(tracker.text()).toBe("你好。|今天天气不错。|我们出去吧。");
  });

  test("an utterance in another voice counts from its own first sample", () => {
    const tracker = new SpokenTracker("r1", join);
    tracker.say(1, "你好。", 1, false);
    tracker.cursor(segStart(1));
    tracker.say(2, "[小声] 秘密。", 2, false);
    expect(tracker.text()).toBe("你好。");
    tracker.cursor(segEnd(1));
    tracker.cursor(segStart(2));
    expect(tracker.text()).toBe("你好。|[小声] 秘密。");
  });
});

describe("the tail and a barge-in", () => {
  test("the tail with no words joins once everything said was heard", () => {
    const tracker = new SpokenTracker("r1", join);
    tracker.say(1, "<whisper>悄悄告诉你。", 1, true);
    tracker.attach("</whisper>");
    expect(tracker.text()).toBe("");
    tracker.cursor(segEnd(1));
    expect(tracker.text()).toBe("<whisper>悄悄告诉你。|</whisper>");
  });

  test("after a freeze nothing more counts", () => {
    const tracker = new SpokenTracker("r1", join);
    tracker.say(1, "你好。", 1, true);
    tracker.say(2, "今天天气不错。", 1, true);
    tracker.cursor(segEnd(1));
    tracker.cursor(words(2, 2));
    tracker.freeze();
    tracker.cursor(segEnd(2));
    tracker.say(3, "再见。", 1, false);
    tracker.attach("</whisper>");
    expect(tracker.text()).toBe("你好。|今天");
  });

  test("events of another reply, and of segments never said, change nothing", () => {
    const tracker = new SpokenTracker("r1", join);
    tracker.say(1, "你好。", 1, false);
    tracker.cursor(segStart(1, "r2"));
    tracker.cursor(segEnd(9));
    tracker.cursor({ type: "reply-start", reply: "r1", persona: "milky-green" });
    tracker.cursor({ type: "drained" });
    expect(tracker.text()).toBe("");
  });
});
