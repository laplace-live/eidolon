import type { Direction } from "@laplace.live/eidolon-sdk/avatar";
import { describe, expect, test } from "vitest";
import {
  CompanionDirector,
  DOZE_MS,
  PICK_UP_MS,
  POKE_REST_MS,
  PULSE_MS,
  REACT_GAP_MS,
} from "./director";
import { type CompanionCall, NO_COMPANION_CALL } from "./protocol";

const CHAT = "0b7f5f2e-3c1d-4e8a-9f60-1a2b3c4d5e6f";
const HERS: CompanionCall = { up: true, live: true, hers: true, micOn: true, callable: false };
const OTHERS: CompanionCall = { ...HERS, hers: false };

const message = (seq: number, text: string) => ({ chat: CHAT, seq, text });

function callDirection(change: Partial<Direction> = {}): Direction {
  return {
    persona: null,
    mood: [],
    pulse: null,
    speaking: false,
    listening: false,
    thinking: false,
    looking: "idle",
    gesture: null,
    ...change,
  };
}

const seqOf = (direction: Direction): number => direction.gesture?.seq ?? 0;

describe("her replies", () => {
  test("a reply's opening direction sets her mood", () => {
    const director = new CompanionDirector(0);
    director.said(message(1, "[开心地] 在呀，就在你屏幕边上！"), 10);
    expect(director.direction(10).mood).toEqual(["happy"]);
  });

  test("a cue lends its mood and nods once, however often the same reply is told", () => {
    const director = new CompanionDirector(0);
    const before = seqOf(director.direction(0));
    director.said(message(2, "[chuckling] 嘿嘿"), 10);
    const after = director.direction(10);
    expect(after.pulse).toBe("happy");
    expect(after.gesture?.name).toBe("nod");
    expect(seqOf(after)).toBe(before + 1);
    director.said(message(2, "[chuckling] 嘿嘿"), 20);
    expect(seqOf(director.direction(20))).toBe(before + 1);
  });

  test("a voice message she said speaks without nodding again; another is made as it plays", () => {
    const director = new CompanionDirector(0);
    director.said(message(3, "[chuckling] 嘿嘿"), 10);
    const nodded = seqOf(director.direction(10));
    director.voice(message(3, "[chuckling] 嘿嘿"), true, 20);
    expect(director.voicing).toEqual({ chat: CHAT, seq: 3 });
    expect(director.direction(20).speaking).toBe(true);
    expect(seqOf(director.direction(20))).toBe(nodded);

    director.voice(message(4, "[难过地] 好吧"), true, 30);
    expect(director.direction(30).mood).toEqual(["sad"]);
    expect(director.direction(30).speaking).toBe(true);
    // The first message's end changes nothing: the second plays now.
    director.voice(message(3, "[chuckling] 嘿嘿"), false, 40);
    expect(director.direction(40).speaking).toBe(true);
    director.voice(message(4, "[难过地] 好吧"), false, 50);
    expect(director.direction(50).speaking).toBe(false);
    expect(director.voicing).toBeNull();
  });

  test("a reply's later cues land at her pace, on the ticks", () => {
    const director = new CompanionDirector(0);
    director.said(message(5, "你好呀朋友们[chuckling]"), 0);
    expect(director.direction(0).pulse).toBeNull();
    for (let at = 100; at <= 2_000; at += 100) director.tick(at);
    expect(seqOf(director.direction(2_000))).toBe(1);
  });
});

describe("taps", () => {
  test("her head: shy and a nod, for PULSE_MS", () => {
    const director = new CompanionDirector(0);
    director.tap("head", 1_000);
    const tapped = director.direction(1_000);
    expect(tapped.pulse).toBe("shy");
    expect(tapped.gesture).toEqual({ name: "nod", seq: 1 });
    director.tick(1_000 + PULSE_MS - 1);
    expect(director.direction(1_000 + PULSE_MS - 1).pulse).toBe("shy");
    director.tick(1_000 + PULSE_MS);
    expect(director.direction(1_000 + PULSE_MS).pulse).toBeNull();
  });

  test("her body: surprised, for PULSE_MS, and no gesture", () => {
    const director = new CompanionDirector(0);
    director.tap("body", 1_000);
    expect(director.direction(1_000).pulse).toBe("surprised");
    expect(director.direction(1_000).gesture).toBeNull();
    expect(director.direction(1_000 + PULSE_MS).pulse).toBeNull();
  });

  test("a second tap within the gap brings nothing new", () => {
    const director = new CompanionDirector(0);
    director.tap("head", 1_000);
    director.tap("body", 1_300);
    const after = director.direction(1_300);
    expect(after.pulse).toBe("shy");
    expect(after.gesture).toEqual({ name: "nod", seq: 1 });
    director.tap("body", 1_000 + REACT_GAP_MS);
    expect(director.direction(1_000 + REACT_GAP_MS).pulse).toBe("surprised");
  });

  test("five pokes within 2 s: a pout and a shake, held, then a rest", () => {
    const director = new CompanionDirector(0);
    for (const at of [1_000, 1_500, 2_000, 2_500]) director.tap("head", at);
    const nods = seqOf(director.direction(2_500));
    director.tap("head", 3_000);
    const poked = director.direction(3_000);
    expect(poked.pulse).toBe("pout");
    expect(poked.gesture).toEqual({ name: "shake", seq: nods + 1 });
    expect(director.direction(3_000 + POKE_REST_MS - 1).pulse).toBe("pout");
    // A sixth in the rest brings nothing, and the pout ends on time.
    director.tap("head", 4_000);
    expect(director.direction(4_000).gesture).toEqual({ name: "shake", seq: nods + 1 });
    expect(director.direction(3_000 + POKE_REST_MS).pulse).toBeNull();
    // After it the count starts over: a tap is one tap.
    director.tap("head", 3_000 + POKE_REST_MS);
    expect(director.direction(3_000 + POKE_REST_MS).pulse).toBe("shy");
  });

  test("pokes count only within POKE_WINDOW_MS: five a second apart are five taps", () => {
    const director = new CompanionDirector(0);
    for (const at of [1_000, 2_000, 3_000, 4_000, 5_000]) director.tap("body", at);
    const fifth = director.direction(5_000);
    expect(fifth.pulse).toBe("surprised");
    expect(fifth.gesture).toBeNull();
  });
});

describe("dozing", () => {
  test("untouched for DOZE_MS she dozes, lazy and still; a tap wakes her surprised", () => {
    const director = new CompanionDirector(0);
    expect(director.dozing(DOZE_MS - 1)).toBe(false);
    expect(director.follows(DOZE_MS - 1)).toBe(true);
    director.tick(DOZE_MS);
    expect(director.dozing(DOZE_MS)).toBe(true);
    expect(director.direction(DOZE_MS).mood).toEqual(["lazy"]);
    expect(director.follows(DOZE_MS)).toBe(false);

    director.tap("head", DOZE_MS + 10);
    expect(director.dozing(DOZE_MS + 10)).toBe(false);
    const woken = director.direction(DOZE_MS + 10);
    expect(woken.pulse).toBe("surprised");
    expect(woken.mood).toEqual([]);
    // Waking is all a tap does then: no nod.
    expect(woken.gesture).toBeNull();
  });

  test("the tap that wakes her is no poke: four more within POKE_WINDOW_MS bring no pout", () => {
    const director = new CompanionDirector(0);
    director.tap("body", DOZE_MS);
    for (const at of [600, 1_200, 1_800, 2_400]) director.tap("body", DOZE_MS + at);
    const fourth = director.direction(DOZE_MS + 2_400);
    expect(fourth.pulse).toBe("surprised");
    expect(fourth.gesture).toBeNull();
  });

  test("every tap puts her dozing off, not only one that wakes her", () => {
    const director = new CompanionDirector(0);
    director.tap("body", 200_000);
    expect(director.dozing(200_000 + DOZE_MS - 1)).toBe(false);
    expect(director.dozing(200_000 + DOZE_MS)).toBe(true);
  });

  test("never while a call is up or a voice message plays", () => {
    const director = new CompanionDirector(0);
    director.call(OTHERS, 0);
    expect(director.dozing(DOZE_MS * 2)).toBe(false);
    director.call(NO_COMPANION_CALL, DOZE_MS * 2);
    expect(director.dozing(DOZE_MS * 2 + 1)).toBe(false);
    expect(director.dozing(DOZE_MS * 3)).toBe(true);

    director.voice(message(6, "嗯"), true, DOZE_MS * 3);
    expect(director.dozing(DOZE_MS * 5)).toBe(false);
  });

  test("a reply, a menu or a pick-up wakes her", () => {
    const director = new CompanionDirector(0);
    director.said(message(7, "[开心地] 在呢"), DOZE_MS);
    expect(director.dozing(DOZE_MS)).toBe(false);
    director.touch(DOZE_MS * 2);
    expect(director.dozing(DOZE_MS * 2 + 1)).toBe(false);
    director.pickUp(DOZE_MS * 3 + 1);
    expect(director.dozing(DOZE_MS * 3 + 2)).toBe(false);
  });
});

describe("calls", () => {
  test("a call of hers directs her, each of its gestures played once under her own numbers", () => {
    const director = new CompanionDirector(0);
    director.tap("head", 10);
    expect(seqOf(director.direction(10))).toBe(1);

    director.call(HERS, 100);
    expect(director.follows(100)).toBe(false);
    director.callDirection(callDirection({ speaking: true, mood: ["gentle"] }));
    expect(director.direction(100)).toMatchObject({ speaking: true, mood: ["gentle"] });

    director.callDirection(callDirection({ gesture: { name: "nod", seq: 4 } }));
    expect(director.direction(200).gesture).toEqual({ name: "nod", seq: 2 });
    director.callDirection(callDirection({ gesture: { name: "nod", seq: 4 }, speaking: true }));
    expect(director.direction(300).gesture).toEqual({ name: "nod", seq: 2 });

    // Her own replies told during the call never come back as gestures once it ends.
    director.said(message(8, "[chuckling] 哈"), 350);
    director.call(NO_COMPANION_CALL, 400);
    const after = director.direction(400);
    expect(after.speaking).toBe(false);
    expect(after.gesture).toEqual({ name: "nod", seq: 2 });
    expect(director.follows(400)).toBe(true);

    director.call(HERS, 500);
    director.callDirection(callDirection({ gesture: { name: "shake", seq: 1 } }));
    expect(director.direction(500).gesture).toEqual({ name: "shake", seq: 3 });
  });

  test("a call's direction is dropped once it ends, and one that comes after is ignored", () => {
    const director = new CompanionDirector(0);
    director.said(message(9, "[开心地] 好呀"), 0);
    director.call(HERS, 10);
    director.callDirection(callDirection({ mood: ["sad"] }));
    expect(director.direction(10).mood).toEqual(["sad"]);
    director.call(NO_COMPANION_CALL, 20);
    director.callDirection(callDirection({ mood: ["angry"] }));
    expect(director.direction(20).mood).toEqual(["happy"]);
    // A new call of hers starts from her own until its first direction comes.
    director.call(HERS, 30);
    expect(director.direction(30).mood).toEqual(["happy"]);
  });

  test("a call of hers stops a voice message's speaking, and none plays during it", () => {
    const director = new CompanionDirector(0);
    director.voice(message(10, "嗯"), true, 0);
    director.call(HERS, 10);
    expect(director.voicing).toBeNull();
    expect(director.direction(10).speaking).toBe(false);
    director.voice(message(11, "[难过地] 唉"), true, 20);
    expect(director.voicing).toBeNull();
    director.call(NO_COMPANION_CALL, 30);
    expect(director.direction(30).mood).toEqual([]);
  });

  test("a call not hers leaves her own direction, and her eyes free", () => {
    const director = new CompanionDirector(0);
    director.said(message(12, "[开心地] 去吧"), 0);
    director.call(OTHERS, 10);
    director.callDirection(callDirection({ speaking: true, mood: ["sad"] }));
    expect(director.direction(10)).toMatchObject({ speaking: false, mood: ["happy"] });
    expect(director.follows(10)).toBe(true);
  });
});

test("a pick-up lends surprised for PICK_UP_MS", () => {
  const director = new CompanionDirector(0);
  director.pickUp(1_000);
  expect(director.direction(1_000).pulse).toBe("surprised");
  expect(director.direction(1_000 + PICK_UP_MS - 1).pulse).toBe("surprised");
  expect(director.direction(1_000 + PICK_UP_MS).pulse).toBeNull();
});
