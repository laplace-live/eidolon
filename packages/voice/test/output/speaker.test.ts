import { describe, expect, test } from "bun:test";
import { createSpeaker } from "../../src/output/speaker.ts";
import type { CursorEvent, Speaker, Tag } from "../../src/types.ts";

const tag = (reply: string, seg: number, persona = "milky-green"): Tag => ({ reply, persona, seg });

/** `length` samples counting up from `from`, so a test can see which ones came out. */
function ramp(length: number, from = 1): Int16Array {
  return Int16Array.from({ length }, (_, i) => from + i);
}

/** A Speaker and the events it posted, each as a short string. */
function speaker(): { speaker: Speaker; events: string[] } {
  const events: string[] = [];
  const post = (event: CursorEvent) => {
    if (event.type === "drained") events.push("drained");
    else if (event.type === "reply-start")
      events.push(`reply-start ${event.reply} ${event.persona}`);
    else if (event.type === "words") events.push(`words ${event.tag.seg} ${event.chars}`);
    else events.push(`${event.type} ${event.tag.reply}/${event.tag.seg}`);
  };
  return { speaker: createSpeaker(post), events };
}

describe("pull", () => {
  test("is silence at 24 kHz while nothing is queued, and posts nothing", () => {
    const { speaker: s, events } = speaker();
    expect(s.rate).toBe(24_000);
    expect(s.pull(240)).toEqual(new Int16Array(240));
    expect([events, s.isSpeaking()]).toEqual([[], false]);
  });

  test("plays the queue in order and pads its end with silence", () => {
    const { speaker: s, events } = speaker();
    s.enqueue(tag("r1", 1), ramp(200));
    s.enqueue(tag("r1", 1), ramp(100, 201));
    s.markSegEnd(tag("r1", 1));
    expect(s.pull(240)).toEqual(ramp(240));
    expect(events).toEqual(["reply-start r1 milky-green", "seg-start r1/1"]);
    expect(s.isSpeaking()).toBe(true);
    const tail = s.pull(240);
    expect([tail.subarray(0, 60), tail.subarray(60)]).toEqual([ramp(60, 241), new Int16Array(180)]);
    expect(events.slice(2)).toEqual(["seg-end r1/1", "drained"]);
    expect(s.isSpeaking()).toBe(false);
  });

  test("passes a segment's end in the pull that plays its last sample", () => {
    const { speaker: s, events } = speaker();
    s.enqueue(tag("r1", 1), ramp(240));
    s.markSegEnd(tag("r1", 1));
    s.enqueue(tag("r1", 2), ramp(240));
    s.markSegEnd(tag("r1", 2));
    s.pull(240);
    expect(events).toEqual(["reply-start r1 milky-green", "seg-start r1/1", "seg-end r1/1"]);
    s.pull(240);
    expect(events.slice(3)).toEqual(["seg-start r1/2", "seg-end r1/2", "drained"]);
  });

  test("starts and ends a segment that has no audio where its mark stands", () => {
    const { speaker: s, events } = speaker();
    s.markSegEnd(tag("r1", 1));
    expect(s.pull(240)).toEqual(new Int16Array(240));
    expect(events).toEqual([
      "reply-start r1 milky-green",
      "seg-start r1/1",
      "seg-end r1/1",
      "drained",
    ]);
  });

  test("starts the next reply, with its persona, where its audio begins", () => {
    const { speaker: s, events } = speaker();
    s.enqueue(tag("r1", 1), ramp(100));
    s.markSegEnd(tag("r1", 1));
    s.enqueue(tag("r2", 1, "friend"), ramp(100));
    s.pull(240);
    expect(events).toEqual([
      "reply-start r1 milky-green",
      "seg-start r1/1",
      "seg-end r1/1",
      "reply-start r2 friend",
      "seg-start r2/1",
      "drained",
    ]);
  });

  test("starts a reply again when its audio resumes after the queue drained", () => {
    const { speaker: s, events } = speaker();
    s.enqueue(tag("r1", 1), ramp(100));
    s.pull(240);
    s.pull(240);
    s.enqueue(tag("r1", 1), ramp(100));
    s.pull(240);
    expect(events).toEqual([
      "reply-start r1 milky-green",
      "seg-start r1/1",
      "drained",
      "reply-start r1 milky-green",
      "drained",
    ]);
  });

  test("ends a segment marked after its audio drained, without starting the reply again", () => {
    const { speaker: s, events } = speaker();
    s.enqueue(tag("r1", 1), ramp(100));
    s.pull(240);
    s.markSegEnd(tag("r1", 1));
    s.pull(240);
    expect(events).toEqual([
      "reply-start r1 milky-green",
      "seg-start r1/1",
      "drained",
      "seg-end r1/1",
    ]);
    expect(s.isSpeaking()).toBe(false);
  });
});

describe("words", () => {
  test("post once their first sample has been pulled, in order of time", () => {
    const { speaker: s, events } = speaker();
    s.enqueue(tag("r1", 1), ramp(600));
    s.markWords(tag("r1", 1), [
      { chars: 4, atSample: 300 },
      { chars: 2, atSample: 0 },
    ]);
    s.pull(240);
    expect(events.slice(2)).toEqual(["words 1 2"]);
    s.pull(240);
    expect(events.slice(3)).toEqual(["words 1 4"]);
  });

  test("that their segment's audio never reached are dropped at its end, and later ones ignored", () => {
    const { speaker: s, events } = speaker();
    s.enqueue(tag("r1", 1), ramp(240));
    s.markWords(tag("r1", 1), [
      { chars: 2, atSample: 100 },
      { chars: 5, atSample: 900 },
    ]);
    s.markSegEnd(tag("r1", 1));
    s.pull(240);
    s.markWords(tag("r1", 1), [{ chars: 7, atSample: 0 }]);
    s.enqueue(tag("r1", 2), ramp(240));
    s.pull(240);
    expect(events.filter((event) => event.startsWith("words"))).toEqual(["words 1 2"]);
  });
});

describe("clear", () => {
  test("drops the queue at once, posts nothing, and says which reply it cut and how far it played", () => {
    const { speaker: s, events } = speaker();
    s.enqueue(tag("r1", 1), ramp(480));
    s.enqueue(tag("r1", 2), ramp(480));
    s.pull(240);
    s.pull(240);
    s.pull(240);
    const posted = events.length;
    expect(s.clear()).toEqual({ reply: "r1", playedMs: 30 });
    expect([events.length, s.isSpeaking()]).toEqual([posted, false]);
    expect(s.pull(240)).toEqual(new Int16Array(240));
    expect(events.length).toBe(posted);
    expect(s.playedMs("r1")).toBe(30);
  });

  test("cuts nothing once the queue has drained", () => {
    const { speaker: s } = speaker();
    s.enqueue(tag("r1", 1), ramp(240));
    s.pull(240);
    expect(s.clear()).toEqual({ reply: null, playedMs: 0 });
  });

  test("leaves the next reply to start afresh", () => {
    const { speaker: s, events } = speaker();
    s.enqueue(tag("r1", 1), ramp(480));
    s.pull(240);
    s.clear();
    s.enqueue(tag("r2", 1), ramp(240));
    expect(s.pull(240)).toEqual(ramp(240));
    expect(events.slice(2)).toEqual(["reply-start r2 milky-green", "seg-start r2/1", "drained"]);
  });
});

test("playedMs counts each reply's pulled audio, 0 for one never played", () => {
  const { speaker: s } = speaker();
  s.enqueue(tag("item-1", 1), ramp(2400));
  s.enqueue(tag("item-2", 1), ramp(1200));
  for (let i = 0; i < 12; i++) s.pull(240);
  expect([s.playedMs("item-1"), s.playedMs("item-2"), s.playedMs("item-3")]).toEqual([100, 20, 0]);
});
